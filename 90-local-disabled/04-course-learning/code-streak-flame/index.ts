import {
    Context, Handler, PERM, PRIV, RecordModel, STATUS, Time, Types, UserModel, db, param,
} from 'hydrooj';

const PLUGIN_ID = 'code-streak-flame';
const PAGE_SIZE = 100;

const collConfig = db.collection('domain.codeStreak.config' as any);

interface StreakConfig {
    _id: string;
    domainId: string;
    enabled: boolean;
    requireAccepted: boolean;
    windowDays: number;
    updatedAt?: Date;
    updatedBy?: number;
}

interface DayStat {
    date: string;
    submissions: number;
    accepts: number;
}

const DEFAULT_CONFIG = {
    enabled: true,
    requireAccepted: false,
    windowDays: 90,
};

function runtimeEnabled() {
    const pluginSwitch = (globalThis as any).Hydro?.model?.pluginSwitch;
    return pluginSwitch?.isEnabledSync?.(PLUGIN_ID) !== false;
}

function normalizeConfig(domainId: string, raw?: Partial<StreakConfig> | null): StreakConfig {
    return {
        _id: domainId,
        domainId,
        enabled: raw?.enabled ?? DEFAULT_CONFIG.enabled,
        requireAccepted: raw?.requireAccepted ?? DEFAULT_CONFIG.requireAccepted,
        windowDays: Math.min(365, Math.max(14, Number(raw?.windowDays ?? DEFAULT_CONFIG.windowDays) || DEFAULT_CONFIG.windowDays)),
        updatedAt: raw?.updatedAt,
        updatedBy: raw?.updatedBy,
    };
}

async function getConfig(domainId: string) {
    return normalizeConfig(domainId, await collConfig.findOne({ _id: domainId }) as StreakConfig | null);
}

async function setConfig(domainId: string, patch: Partial<StreakConfig>, uid: number) {
    const next = { ...normalizeConfig(domainId, { ...(await getConfig(domainId)), ...patch }), updatedAt: new Date(), updatedBy: uid };
    await collConfig.updateOne({ _id: domainId }, { $set: next, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
    return next;
}

function dayKey(date: Date) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function keyToDate(key: string) {
    const [y, m, d] = key.split('-').map((i) => Number(i));
    return new Date(y, m - 1, d);
}

function addDays(key: string, offset: number) {
    const date = keyToDate(key);
    date.setDate(date.getDate() + offset);
    return dayKey(date);
}

function recordDayKey(record: any) {
    return dayKey(record?._id?.getTimestamp?.() || record?.createdAt || new Date());
}

function dateText(key: string) {
    return key ? key.slice(5) : '';
}

function safeUrl(handler: any, name: string, fallback: string, args?: any) {
    try {
        return handler.url(name, args);
    } catch (e) {
        return fallback;
    }
}

async function collectRecords(domainId: string, config: StreakConfig, uids?: number[]) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - config.windowDays + 1);
    const query: any = {
        _id: { $gte: Time.getObjectID(start) },
        domainId,
        contest: { $nin: [RecordModel.RECORD_PRETEST, RecordModel.RECORD_GENERATE] },
        uid: uids?.length ? { $in: uids } : { $gt: 1 },
    };
    if (config.requireAccepted) query.status = STATUS.STATUS_ACCEPTED;
    return await RecordModel.coll.find(query)
        .project({ _id: 1, uid: 1, status: 1 })
        .sort({ _id: 1 })
        .toArray() as any[];
}

function buildDayMaps(records: any[]) {
    const byUid = new Map<number, Map<string, DayStat>>();
    for (const record of records) {
        const uid = Number(record.uid);
        if (!uid) continue;
        const date = recordDayKey(record);
        if (!byUid.has(uid)) byUid.set(uid, new Map());
        const dayMap = byUid.get(uid)!;
        const row = dayMap.get(date) || { date, submissions: 0, accepts: 0 };
        row.submissions++;
        if (record.status === STATUS.STATUS_ACCEPTED) row.accepts++;
        dayMap.set(date, row);
    }
    return byUid;
}

function calcStreak(uid: number, dayMap: Map<string, DayStat>, config: StreakConfig) {
    const today = dayKey(new Date());
    const yesterday = addDays(today, -1);
    const anchor = dayMap.has(today) ? today : dayMap.has(yesterday) ? yesterday : '';
    let current = 0;
    if (anchor) {
        for (let key = anchor; dayMap.has(key); key = addDays(key, -1)) current++;
    }
    const days = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));
    let best = 0;
    let run = 0;
    let prev = '';
    let submissions = 0;
    let accepts = 0;
    for (const item of days) {
        run = prev && addDays(prev, 1) === item.date ? run + 1 : 1;
        best = Math.max(best, run);
        submissions += item.submissions;
        accepts += item.accepts;
        prev = item.date;
    }
    const heatmap: Array<DayStat & { active: boolean, label: string }> = [];
    let start = today;
    for (let i = 0; i < 34; i++) start = addDays(start, -1);
    for (let i = 0, key = start; i < 35; i++, key = addDays(key, 1)) {
        const row = dayMap.get(key) || { date: key, submissions: 0, accepts: 0 };
        heatmap.push({ ...row, active: row.submissions > 0 || row.accepts > 0, label: dateText(key) });
    }
    return {
        uid,
        current,
        best,
        activeDays: days.length,
        submissions,
        accepts,
        lastActiveDate: days.length ? days[days.length - 1].date : '',
        activeToday: dayMap.has(today),
        modeText: config.requireAccepted ? 'AC 点亮' : '提交点亮',
        heatmap,
    };
}

async function buildUserStreak(domainId: string, uid: number, config?: StreakConfig) {
    const cfg = config || await getConfig(domainId);
    if (!cfg.enabled) return { config: cfg, stat: null };
    const records = await collectRecords(domainId, cfg, [uid]);
    const byUid = buildDayMaps(records);
    return { config: cfg, stat: calcStreak(uid, byUid.get(uid) || new Map(), cfg) };
}

async function buildRanking(domainId: string, config?: StreakConfig) {
    const cfg = config || await getConfig(domainId);
    if (!cfg.enabled) return { config: cfg, rows: [] };
    const records = await collectRecords(domainId, cfg);
    const byUid = buildDayMaps(records);
    const rows = Array.from(byUid.entries()).map(([uid, dayMap]) => calcStreak(uid, dayMap, cfg))
        .sort((a, b) => b.current - a.current || b.best - a.best || b.activeDays - a.activeDays || b.accepts - a.accepts || a.uid - b.uid);
    rows.forEach((row, index) => { (row as any).rank = index + 1; });
    return { config: cfg, rows };
}

async function ensureIndexes(collection: any, ...indexes: any[]) {
    try {
        await db.ensureIndexes(collection, ...indexes);
    } catch (e: any) {
        console.warn('[code-streak-flame] failed to ensure indexes:', e?.message || e);
    }
}

class DomainCodeStreakHandler extends Handler {
    async prepare() {
        this.checkPerm(PERM.PERM_EDIT_DOMAIN);
    }

    async get({ domainId }: any) {
        const config = await getConfig(domainId);
        this.response.template = 'domain_code_streak.html';
        this.response.body = {
            page_name: 'domain_code_streak',
            config,
            rankingUrl: safeUrl(this, 'code_streak_ranking', '/ranking/streak'),
            messages: [],
        };
    }

    @param('enabled', Types.String, true)
    @param('requireAccepted', Types.String, true)
    @param('windowDays', Types.Int, true)
    async post({ domainId }: any, enabled = '', requireAccepted = '', windowDays = 90) {
        const config = await setConfig(domainId, {
            enabled: enabled === 'true' || enabled === 'on' || enabled === '1',
            requireAccepted: requireAccepted === 'true' || requireAccepted === 'on' || requireAccepted === '1',
            windowDays: Number(windowDays) || DEFAULT_CONFIG.windowDays,
        }, this.user._id);
        this.response.template = 'domain_code_streak.html';
        this.response.body = {
            page_name: 'domain_code_streak',
            config,
            rankingUrl: safeUrl(this, 'code_streak_ranking', '/ranking/streak'),
            messages: ['火苗设置已保存。'],
        };
    }
}

class CodeStreakHomeHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }

    async get({ domainId }: any) {
        const result = await buildUserStreak(domainId, this.user._id);
        this.response.template = 'code_streak_home.html';
        this.response.body = {
            page_name: 'code_streak_home',
            ...result,
            rankingUrl: safeUrl(this, 'code_streak_ranking', '/ranking/streak'),
        };
    }
}

class CodeStreakRankingHandler extends Handler {
    @param('page', Types.PositiveInt, true)
    async get({ domainId }: any, page = 1) {
        const { config, rows: allRows } = await buildRanking(domainId);
        const total = allRows.length;
        const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
        const rows = allRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
        const udict = await UserModel.getListForRender(domainId, rows.map((item) => item.uid), this.user.hasPerm(PERM.PERM_VIEW_DISPLAYNAME) ? ['displayName'] : []);
        this.response.template = 'code_streak_ranking.html';
        this.response.body = {
            page_name: 'code_streak_ranking',
            config,
            rows,
            udict,
            page,
            pageCount,
            total,
            personalUrl: this.user.hasPriv(PRIV.PRIV_USER_PROFILE) ? safeUrl(this, 'code_streak_home', '/streak') : '',
            manageUrl: this.user.hasPerm(PERM.PERM_EDIT_DOMAIN) ? safeUrl(this, 'domain_code_streak', '/domain/code-streak') : '',
        };
    }
}

export async function apply(ctx: Context) {
    await ensureIndexes(collConfig, { key: { domainId: 1 }, name: 'code_streak_config_domain', unique: true });

    (globalThis as any).Hydro = (globalThis as any).Hydro || {};
    (globalThis as any).Hydro.model = (globalThis as any).Hydro.model || {};
    (globalThis as any).Hydro.model.codeStreak = {
        getConfig,
        buildUserStreak,
        buildRanking,
    };

    ctx.Route('domain_code_streak', '/domain/code-streak', DomainCodeStreakHandler, PERM.PERM_EDIT_DOMAIN);
    ctx.Route('code_streak_home', '/streak', CodeStreakHomeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('code_streak_ranking', '/ranking/streak', CodeStreakRankingHandler, PERM.PERM_VIEW_RANKING);
    ctx.injectUI('DomainManage', 'domain_code_streak', { family: 'Training', icon: 'award' }, PERM.PERM_EDIT_DOMAIN);

    ctx.on('handler/after/UserDetail#get', async (handler: any) => {
        if (!runtimeEnabled()) return;
        const domainId = handler.args?.domainId || handler.domain?._id;
        const uid = Number(handler.args?.uid);
        if (!domainId || !uid) return;
        handler.response.body.codeStreak = await buildUserStreak(domainId, uid);
        handler.response.body.codeStreakRankingUrl = safeUrl(handler, 'code_streak_ranking', '/ranking/streak');
        handler.response.body.codeStreakHomeUrl = safeUrl(handler, 'code_streak_home', '/streak');
    });

    ctx.i18n.load('zh', {
        domain_code_streak: '训练火苗',
        code_streak_home: '我的训练火苗',
        code_streak_ranking: '火苗榜',
    });
    ctx.i18n.load('en', {
        domain_code_streak: 'Code Streak',
        code_streak_home: 'My Streak',
        code_streak_ranking: 'Streak Ranking',
    });
}
