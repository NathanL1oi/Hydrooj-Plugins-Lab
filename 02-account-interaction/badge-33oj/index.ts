import {
    Context, UserModel, SettingModel, Handler, NotFoundError, param, PRIV, Types, paginate, query
} from 'hydrooj';
import { UserBadgeModel, BadgeModel } from './model';

class UserBadgeManageHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, page = 1, uid = this.user._id) {
        const [ddocs, dpcount] = await this.paginate(
            await UserBadgeModel.getMulti(uid),
            page,
            20
        );
        for (const ddoc of ddocs) {
            ddoc.badge = await BadgeModel.get(ddoc.badgeId);
        }
        const udoc = await UserModel.getById(domainId, uid);
        this.response.template = 'badge_mybadge.html';
        this.response.body = { ddocs, dpcount, page, udoc }
    }

    @param('badgeId', Types.PositiveInt)
    async postEnable(domainId: string, badgeId: number) {
        await UserBadgeModel.sel(this.user._id, badgeId);
        this.response.redirect = this.url('badge_mybadge');
    }

    async postReset(domainId: string) {
        await UserBadgeModel.unsetUserBadge(this.user._id);
        this.response.redirect = this.url('badge_mybadge');
    }
}

class BadgeManageHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, page = 1) {
        const [ddocs, dpcount] = await this.paginate(
            await BadgeModel.getMulti(),
            page,
            20
        );
        this.response.template = 'badge_manage.html';
        this.response.body = { ddocs, dpcount, page };
    }
}

class BadgeAddHandler extends Handler {
    async get(domainId: string) {
        this.response.template = 'badge_add.html';
    }

    @param('short', Types.String)
    @param('title', Types.String)
    @param('backgroundColor', Types.String)
    @param('fontColor', Types.String)
    @param('content', Types.Content)
    @param('users', Types.NumericArray, true)
    async post(domainId: string, short: string, title: string, backgroundColor: string, fontColor: string, content: string, users: [number]) {
      const badgeId = await BadgeModel.add(short, title, backgroundColor, fontColor, content, users);
      this.response.redirect = this.url('badge_detail', { id: badgeId });
    }
}

class BadgeEditHandler extends Handler {
    @param('id', Types.PositiveInt)
    async get(domainId: string, id: number) {
        const badge = await BadgeModel.get(id);
        if (!badge) throw new NotFoundError(`徽章 ${id} 不存在！`);
        this.response.template = 'badge_edit.html';
        this.response.body = { badge }
    }

    @param('id', Types.PositiveInt)
    @param('short', Types.String)
    @param('title', Types.String)
    @param('backgroundColor', Types.String)
    @param('fontColor', Types.String)
    @param('content', Types.Content)
    @param('users', Types.NumericArray, true)
    async postUpdate(domainId: string, id: number, short: string, title: string, backgroundColor: string, fontColor: string, content: string, users: [number]) {
        const users_old = (await BadgeModel.get(id)).users;
        await BadgeModel.edit(id, short, title, backgroundColor, fontColor, content, users, users_old);
        this.response.redirect = this.url('badge_detail', { id });
    }

    @param('id', Types.PositiveInt)
    async postDelete(domainId: string, id: number) {
      await BadgeModel.del(id);
      this.response.redirect = this.url('badge_manage');
    }
}

class BadgeDetailHandler extends Handler {
    @param('id', Types.PositiveInt, true)
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, id: number, page = 1) {
        const badge = await BadgeModel.get(id);
        if (!badge) throw new NotFoundError(`徽章 ${id} 不存在！`);
        const userIds = badge.users?.sort((a, b) => a - b) || [];
        const [dudocs, upcount] = await this.paginate(
            UserModel.getMulti({ _id: { $in: userIds } }),
            page,
            20
        );

        const udict = await UserModel.getList(domainId, dudocs.map((x) => x._id));
        const udocs = dudocs.map((x) => udict[x._id]);

        this.response.template = 'badge_detail.html';
        this.response.body = { badge, udocs, upcount, page };
    }
}

class BadgeShowHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, page = 1) {
        const [dudocs, upcount] = await this.paginate(
            UserModel.getMulti({ badge: { $exists: true, $ne: "" } }),
            page,
            'ranking'
        );
        const udict = await UserModel.getList(domainId, dudocs.map((x) => x._id));
        const udocs = dudocs.map((x) => udict[x._id]);
        this.response.template = 'badge_show.html'; // 返回此页面
        this.response.body = { udocs, upcount, page };
    }
}

export async function apply(ctx: Context) {
    ctx.inject(['setting'], (c) => {
        c.setting.AccountSetting(
            SettingModel.Setting('setting_storage', 'badgeId', 0, 'number', 'badgeId', null, 3)
        );
    });

    ctx.on('handler/after/UserDetail#get', async (h) => {
        const uid = h.response.body.udoc?._id;
        if (!uid) {
            h.response.body.udoc.badges = [];
            return;
        }
        try {
            const cursor = await UserBadgeModel.getMulti(uid);
            const ddocs = await cursor.toArray();
            for (const ddoc of ddocs) {
                ddoc.badge = await BadgeModel.get(ddoc.badgeId);
            }
            h.response.body.badges = ddocs;
        } catch (error) {
            h.response.body.badges = [];
        }
    });
    ctx.on('handler/after/ContestScoreboard#get', async (h) => {
	// const uids = Object.keys(h.response.body.udict).map(id => parseInt(id));
	const udict = h.response?.body?.udict;
    	if (!udict) return;

    	const uids = Object.keys(udict).map(id => parseInt(id));
    	if (!uids.length) return;
	const usersWithBadge = await UserModel.getMulti({ _id: { $in: uids } }, ['_id', 'badgeId', 'badge']).toArray();
	const badgeIds = Array.from(new Set(
        Object.values(usersWithBadge).map(u => u.badgeId).filter(Boolean)
    	));
    	if (badgeIds.length) {
    	    // 2. 从 BadgeModel 拿到实际的勋章详情
    	    // const badges = await BadgeModel._getMulti({_id: {$in: badgeIds}}).toArray();
	    // const badgeMap = {};
	    // for (const b of badges) {
	    //     badgeMap[b._id.toString()] = b; // 转换为字符串索引更稳妥
	    // }
	    
	    const userBadgeMap = {};
	    for (const u of usersWithBadge) {
	        userBadgeMap[u._id.toString()] = u;
	    }
	    // 3. 缝合数据
	    for (const uid in h.response.body.udict) {
	        const userDoc = userBadgeMap[uid];
	        const bId = userDoc?.badgeId;
	        const badge = userDoc?.badge;
	        if (bId && badge) {
	            // 这里的赋值要根据你的 user.render_inline 宏来决定
	            // 通常需要把勋章的 ID 给 .badge，把勋章的名字给 .badgeName
	            h.response.body.udict[uid].badge = badge;
	            h.response.body.udict[uid].badgeId = bId;
	            // 如果你的 CSS 依赖颜色，也可以加上：
	            // h.response.body.udict[uid].badgeColor = targetBadge.color;
	        }
	    }
    	}
    });
    ctx.Route('badge_show', '/badge/show', BadgeShowHandler);
    ctx.Route('badge_manage', '/badge/manage', BadgeManageHandler, PRIV.PRIV_SET_PERM);
    ctx.Route('badge_add', '/badge/add', BadgeAddHandler, PRIV.PRIV_SET_PERM);
    ctx.Route('badge_mybadge', '/badge/mybadge', UserBadgeManageHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('badge_detail', '/badge/:id', BadgeDetailHandler);
    ctx.Route('badge_edit', '/badge/:id/edit', BadgeEditHandler, PRIV.PRIV_SET_PERM);
    ctx.injectUI('UserDropdown', 'badge_mybadge', { icon: 'crown', displayName: '我的徽章' });
    ctx.i18n.load('zh', {
        badge_show: '展示徽章',
        badge_manage: '管理徽章',
        badge_add: '添加徽章',
        badge_mybadge: '我的徽章',
        badge_detail: '徽章详情',
        badge_edit: '编辑徽章',
    });
}
