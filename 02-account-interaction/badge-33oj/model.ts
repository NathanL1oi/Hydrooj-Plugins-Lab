import { db, UserModel } from 'hydrooj';
import { deleteUserCache } from 'hydrooj/src/model/user';

const collbd = db.collection('badge');
const collubd = db.collection('user.badge');

interface UserBadge {
    _id: ObjectId;
    owner: number;
    badgeId: number;
    getAt: Date;
}

interface Badge {
    _id: number;
    short: string;
    title: string;
    backgroundColor: string;
    fontColor: string;
    content: string;
    users: number[];
    createAt: Date;
}

declare module 'hydrooj' {
    interface Model {
        userBadge: typeof UserBadgeModel;
        badge: typeof BadgeModel;
    }
    interface Collections {
        userBadge: UserBadge;
        badge: Badge;
    }
}

class UserBadgeModel {
    static coll = collubd;

    static async add(userId: number, badgeId: number): Promise<string> {
        const result = await UserBadgeModel.coll.insertOne({
            owner: userId,
            badgeId: badgeId,
            getAt: new Date()
        })
        return result.insertedId;
    }

    static async getMulti(userId: number): Promise<UserBadge[]> {
        return await UserBadgeModel.coll.find({ owner: userId }).sort({ badgeId: 1 });
    }

    static async del(userId: number, badgeId: number): Promise<number> {
        if ((await UserModel.coll.findOne({ _id: userId })).badgeId === badgeId) {  
            await UserBadgeModel.unsetUserBadge(userId);
        }
        return (await UserBadgeModel.coll.deleteOne({ owner: userId, badgeId: badgeId })).deletedCount;
    }

    static async sel(userId: number, badgeId: number): Promise<number> {
        const userBadgeId = await UserBadgeModel.coll.findOne({ owner: userId, badgeId: badgeId });
        if (userBadgeId) {
            const badge: Badge = await BadgeModel.coll.findOne({ _id: badgeId });
            const badgeid: number = badge._id;
            const payload: string = badge.short + badge.backgroundColor + badge.fontColor + '#' + badge.title;
            return await UserBadgeModel.setUserBadge(userId, badgeid, payload);
        } else {
            return 0;
        }
    }

    static async setUserBadge(userId: number, badgeId: number, badge: String): Promise<number> {
        const result = await UserModel.setById(userId, { badgeId: badgeId, badge: badge });
        return result;
    }

    static async unsetUserBadge(userId: number): Promise<number> {
        const result = await UserModel.setById(userId, undefined, { badgeId: '', badge: '' });
        return result._id;
    }
}

class BadgeModel {
    static coll = collbd;
    static _getMulti(params: Filter<Udoc> = {}, projection?: (keyof Udoc)[]) {
        return projection ? BadgeModel.coll.find(params).project<Udoc>(buildProjection(projection)) : BadgeModel.coll.find(params);
    }

    static async getMulti(): Promise<Badge[]> {
        return await BadgeModel.coll.find({});
    }

    static async add(short: string, title: string, backgroundColor: string, fontColor: string, content: string, users: [number], badgeId?: number): Promise<number> {
        if (typeof badgeId !== 'number') {
            const [badge] = await BadgeModel.coll.find({}).sort({ _id: -1 }).limit(1).toArray();
            badgeId = Math.max((badge?._id || 0) + 1, 1);
        };
        const result = await BadgeModel.coll.insertOne({
            _id: badgeId,
            short: short,
            title: title,
            backgroundColor: backgroundColor,
            fontColor: fontColor,
            content: content,
            users: users,
            createAt: new Date()
        });
        if (users) {
            for (const userId of users) {
                await UserBadgeModel.add(userId, badgeId);
            }
        }
        return result.insertedId;
    }

    static async get(badgeId: number): Promise<Badge> {
        return await BadgeModel.coll.findOne({ _id: badgeId });
    }

    static async edit(badgeId: number, short: string, title: string, backgroundColor: string, fontColor: string, content: string, users: [number], users_old: [number]): Promise<number> {
        const result = await BadgeModel.coll.updateOne({ _id: badgeId }, { $set: { short, title, backgroundColor, fontColor, content, users } });
        if (users_old) {
            for (const userId of users_old) {
                if (!users || !users.includes(userId))
                    await UserBadgeModel.del(userId, badgeId);
            }
        }
        if (users) {
            for (const userId of users) {
                if (!users_old || !users_old.includes(userId))
                    await UserBadgeModel.add(userId, badgeId);
            }
        }
        const badge: string = short + backgroundColor + fontColor + '#' + title;
        await BadgeModel.resetBadge(badgeId, badge);
        return result.modifiedCount;
    }

    static async del(badgeId: number): Promise<number> {
        const result = await BadgeModel.coll.deleteOne({ _id: badgeId });
        await UserBadgeModel.coll.deleteMany({ badgeId: badgeId });
        await BadgeModel.unsetBadge(badgeId);
        return result.deletedCount;
    }

    static async resetBadge(badgeId: number, badge: String): Promise<number> {
        const result = (await UserModel.coll.updateMany({ badgeId }, { $set: { badge } })).modifiedCount;
        if (result) {
            await deleteUserCache(true);
        }
        return result;
    }

    static async unsetBadge(badgeId: number): Promise<number> {
        const result = (await UserModel.coll.updateMany({ badgeId }, { $unset: { badgeId: '', badge: '' } })).modifiedCount;
        if (result) {
            await deleteUserCache(true);
        }
        return result;
    }
}

global.Hydro.model.userBadge = UserBadgeModel;
global.Hydro.model.badge = BadgeModel;

export { UserBadgeModel, BadgeModel, UserBadge, Badge };
