import {
    Context, db, DomainModel, Handler, PERM, UserModel,
} from 'hydrooj';

const token = db.collection('token');
const history = db.collection('onlineuser.history' as any);

const ACTIVE_SECONDS = 300;
const RECENT_SECONDS = 24 * 60 * 60;
const ONE_HOUR_SECONDS = 60 * 60;
const REFRESH_SECONDS = 30;
const HISTORY_SLOT_SECONDS = 5 * 60;
const TOUCH_INTERVAL_SECONDS = 60;
const HISTORY_KEEP_SECONDS = 8 * 24 * 60 * 60;

const touchCache = new Map<string, number>();
let lastPruneAt = 0;

interface ActivityStat {
    uid: number;
    online: boolean;
    firstActiveAt?: Date;
    lastActiveAt?: Date;
    activeSlots: number;
    hits: number;
}

function pad(n: number) {
    return String(n).padStart(2, '0');
}

function timeText(value: Date) {
    return `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

function dateTimeText(value: Date) {
    const now = new Date();
    const sameDay = value.getFullYear() === now.getFullYear()
        && value.getMonth() === now.getMonth()
        && value.getDate() === now.getDate();
    if (sameDay) return timeText(value);
    return `${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function agoText(value: Date) {
    const seconds = Math.max(0, Math.floor((Date.now() - value.getTime()) / 1000));
    if (seconds < 60) return '刚刚';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    return `${hours} 小时前`;
}

function mergeStat(map: Map<number, ActivityStat>, uid: number) {
    if (!map.has(uid)) {
        map.set(uid, {
            uid,
            online: false,
            activeSlots: 0,
            hits: 0,
        });
    }
    return map.get(uid)!;
}

function mergeLastActive(stat: ActivityStat, value?: Date | string | number) {
    if (!value) return;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return;
    if (!stat.lastActiveAt || date > stat.lastActiveAt) stat.lastActiveAt = date;
}

function mergeFirstActive(stat: ActivityStat, value?: Date | string | number) {
    if (!value) return;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return;
    if (!stat.firstActiveAt || date < stat.firstActiveAt) stat.firstActiveAt = date;
}

async function touchOnlineHistory(handler: any) {
    const uid = Number(handler.user?._id);
    const domainId = String(handler.args?.domainId || handler.domain?._id || '');
    if (!domainId || !uid || uid <= 1) return;

    const now = Date.now();
    const cacheKey = `${domainId}:${uid}`;
    const lastTouch = touchCache.get(cacheKey) || 0;
    if (now - lastTouch < TOUCH_INTERVAL_SECONDS * 1000) return;
    touchCache.set(cacheKey, now);

    const slot = Math.floor(now / (HISTORY_SLOT_SECONDS * 1000));
    const slotStart = new Date(slot * HISTORY_SLOT_SECONDS * 1000);
    const docId = `${domainId}:${uid}:${slot}`;
    await history.updateOne(
        { _id: docId },
        {
            $setOnInsert: {
                _id: docId,
                domainId,
                uid,
                slot,
                firstActiveAt: slotStart,
            },
            $max: { lastActiveAt: new Date(now) },
            $inc: { hits: 1 },
        },
        { upsert: true },
    );
}

async function pruneOldHistory() {
    const now = Date.now();
    if (now - lastPruneAt < ONE_HOUR_SECONDS * 1000) return;
    lastPruneAt = now;
    await history.deleteMany({
        lastActiveAt: { $lt: new Date(now - HISTORY_KEEP_SECONDS * 1000) },
    });
}

class OnlineUserHandler extends Handler {
    async prepare() {
        this.checkPerm(PERM.PERM_EDIT_DOMAIN);
    }

    async get({ domainId }: any) {
        const now = Date.now();
        const onlineSince = new Date(now - ACTIVE_SECONDS * 1000);
        const recentSince = new Date(now - RECENT_SECONDS * 1000);

        const [onlineSessions, recentSessions, historyRows] = await Promise.all([
            token.aggregate([
                { $match: { updateAt: { $gte: onlineSince }, uid: { $gt: 1 } } },
                { $group: { _id: '$uid', lastActiveAt: { $max: '$updateAt' } } },
            ]).toArray() as Promise<any[]>,
            token.aggregate([
                { $match: { updateAt: { $gte: recentSince }, uid: { $gt: 1 } } },
                { $group: { _id: '$uid', lastActiveAt: { $max: '$updateAt' } } },
            ]).toArray() as Promise<any[]>,
            history.aggregate([
                { $match: { domainId, lastActiveAt: { $gte: recentSince }, uid: { $gt: 1 } } },
                {
                    $group: {
                        _id: '$uid',
                        firstActiveAt: { $min: '$firstActiveAt' },
                        lastActiveAt: { $max: '$lastActiveAt' },
                        activeSlots: { $sum: 1 },
                        hits: { $sum: '$hits' },
                    },
                },
            ]).toArray() as Promise<any[]>,
        ]);

        const stats = new Map<number, ActivityStat>();
        for (const doc of historyRows) {
            const uid = Number(doc._id);
            if (!uid) continue;
            const stat = mergeStat(stats, uid);
            mergeFirstActive(stat, doc.firstActiveAt);
            mergeLastActive(stat, doc.lastActiveAt);
            stat.activeSlots += Number(doc.activeSlots || 0);
            stat.hits += Number(doc.hits || 0);
        }
        for (const doc of recentSessions) {
            const uid = Number(doc._id);
            if (!uid) continue;
            const stat = mergeStat(stats, uid);
            mergeFirstActive(stat, doc.lastActiveAt);
            mergeLastActive(stat, doc.lastActiveAt);
        }
        for (const doc of onlineSessions) {
            const uid = Number(doc._id);
            if (!uid) continue;
            const stat = mergeStat(stats, uid);
            stat.online = true;
            mergeFirstActive(stat, doc.lastActiveAt);
            mergeLastActive(stat, doc.lastActiveAt);
        }

        const candidateUids = Array.from(stats.keys());
        const domainUsers = candidateUids.length
            ? await DomainModel.getMultiUserInDomain(domainId, { uid: { $in: candidateUids } })
                .project({ uid: 1 })
                .toArray() as any[]
            : [];
        const domainUidSet = new Set(domainUsers.map((doc) => Number(doc.uid)));
        const uids = candidateUids.filter((uid) => domainUidSet.has(uid));
        const udict = uids.length ? await UserModel.getList(domainId, uids) : {};

        const rows = uids
            .map((uid) => {
                const stat = stats.get(uid)!;
                const udoc = udict[uid];
                if (!udoc || !stat.lastActiveAt) return null;
                const activeMinutes = stat.activeSlots
                    ? stat.activeSlots * (HISTORY_SLOT_SECONDS / 60)
                    : 1;
                return {
                    udoc,
                    online: stat.online,
                    statusText: stat.online ? 'Online' : 'Offline',
                    statusClass: stat.online ? 'is-online' : 'is-offline',
                    lastActiveAt: stat.lastActiveAt,
                    lastActiveText: dateTimeText(stat.lastActiveAt),
                    agoText: agoText(stat.lastActiveAt),
                    activeMinutes,
                    hits: stat.hits,
                };
            })
            .filter(Boolean)
            .sort((a: any, b: any) => {
                if (a.online !== b.online) return a.online ? -1 : 1;
                return b.lastActiveAt.getTime() - a.lastActiveAt.getTime();
            });

        const onlineCount = rows.filter((row: any) => row.online).length;
        const activeLastHourCount = rows.filter((row: any) => (
            row.lastActiveAt.getTime() >= now - ONE_HOUR_SECONDS * 1000
        )).length;

        this.response.body = {
            activeSeconds: ACTIVE_SECONDS,
            activeLastHourCount,
            domainId,
            onlineCount,
            recentCount: rows.length,
            recentHours: 24,
            refreshSeconds: REFRESH_SECONDS,
            rows,
            slotMinutes: HISTORY_SLOT_SECONDS / 60,
            udocs: rows.map((row: any) => row.udoc),
        };
        this.response.template = 'onlineuser.html';
    }
}

export const description = 'Show recent online users and last 24h activity';

export async function apply(ctx: Context) {
    await db.ensureIndexes(
        history,
        { key: { domainId: 1, uid: 1, lastActiveAt: -1 }, name: 'domain_uid_lastActiveAt' },
        { key: { domainId: 1, lastActiveAt: -1 }, name: 'domain_lastActiveAt' },
        { key: { lastActiveAt: -1 }, name: 'lastActiveAt' },
    );

    ctx.on('handler/before', async (handler: any) => {
        try {
            await touchOnlineHistory(handler);
            await pruneOldHistory();
        } catch (error) {
            console.warn('[onlineuser-bpjudge] failed to update online history:', error);
        }
    });

    ctx.Route('onlineuser', '/onlineuser', OnlineUserHandler, PERM.PERM_EDIT_DOMAIN);
    ctx.Route('domain_onlineuser', '/domain/onlineuser', OnlineUserHandler, PERM.PERM_EDIT_DOMAIN);
    ctx.injectUI('DomainManage', 'domain_onlineuser', { family: 'User', icon: 'user' }, PERM.PERM_EDIT_DOMAIN);
    ctx.i18n.load('zh', {
        'Active Last Hour': '近 1 小时活跃',
        'Auto refresh every {0}s': '每 {0} 秒自动刷新',
        'Current Domain': '当前域',
        'Current Online': '当前在线',
        'Estimated Active Time': '活跃估算',
        Hits: '记录',
        'Last Seen': '最后活跃',
        'No Recent Online Users': '最近一天暂无在线记录',
        Offline: '离线',
        Online: '在线',
        'Online User': '最近在线',
        'Only domain managers can view this page.': '仅域管理员可查看',
        'Recent 24h active users: {0}': '最近 24 小时有 {0} 位用户活跃',
        'Recent Online': '最近在线',
        'Recent Window': '统计窗口',
        'Refresh Now': '立即刷新',
        Status: '状态',
        domain_onlineuser: '最近在线',
        onlineuser: '最近在线',
    });
    ctx.i18n.load('zh_TW', {
        'Active Last Hour': '近 1 小時活躍',
        'Auto refresh every {0}s': '每 {0} 秒自動重新整理',
        'Current Domain': '目前域',
        'Current Online': '目前在線',
        'Estimated Active Time': '活躍估算',
        Hits: '記錄',
        'Last Seen': '最後活躍',
        'No Recent Online Users': '最近一天暫無在線記錄',
        Offline: '離線',
        Online: '在線',
        'Online User': '最近在線',
        'Only domain managers can view this page.': '僅域管理員可查看',
        'Recent 24h active users: {0}': '最近 24 小時有 {0} 位使用者活躍',
        'Recent Online': '最近在線',
        'Recent Window': '統計窗口',
        'Refresh Now': '立即重新整理',
        Status: '狀態',
        domain_onlineuser: '最近在線',
        onlineuser: '最近在線',
    });
}
