import {
    Context, Handler, ObjectId, PERM, Types, UserModel, ValidationError, db, param,
} from 'hydrooj';

const PLUGIN_ID = 'rating-season';
const PAGE_SIZE = 100;

const collConfig = db.collection('domain.ratingSeason.config' as any);
const collSeason = db.collection('domain.ratingSeason.season' as any);
const collRatingChange = db.collection('domain.contestRating.change' as any);

interface SeasonConfig {
    _id: string;
    domainId: string;
    enabled: boolean;
    activeSeasonId: string;
    updatedAt?: Date;
    updatedBy?: number;
}

interface SeasonDoc {
    _id: string;
    domainId: string;
    seasonId: string;
    title: string;
    startsAt: Date;
    endsAt?: Date | null;
    archived: boolean;
    createdAt: Date;
    updatedAt: Date;
    updatedBy?: number;
}

const DEFAULT_CONFIG = {
    enabled: true,
    activeSeasonId: '',
};

const RATING_TIERS = [
    { min: 0, title: '启航灰', color: '#64748b' },
    { min: 1200, title: '新芽绿', color: '#16a34a' },
    { min: 1400, title: '破题蓝', color: '#2563eb' },
    { min: 1600, title: '星桥紫', color: '#7c3aed' },
    { min: 1900, title: '火炬橙', color: '#f97316' },
    { min: 2200, title: '传奇红', color: '#dc2626' },
];

function runtimeEnabled() {
    const pluginSwitch = (globalThis as any).Hydro?.model?.pluginSwitch;
    return pluginSwitch?.isEnabledSync?.(PLUGIN_ID) !== false;
}

function idText(value: any) {
    return value?.toHexString?.() || value?.toString?.() || String(value);
}

function scopedId(domainId: string, id: string) {
    return `${domainId}:${id}`;
}

function dayStart(date?: Date | null) {
    const next = date ? new Date(date) : new Date();
    next.setHours(0, 0, 0, 0);
    return next;
}

function dayEnd(date?: Date | null) {
    if (!date) return null;
    const next = new Date(date);
    next.setHours(23, 59, 59, 999);
    return next;
}

function dateInput(date?: Date | null) {
    if (!date) return '';
    const next = new Date(date);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
}

function safeUrl(handler: any, name: string, fallback: string, args?: any) {
    try {
        return handler.url(name, args);
    } catch (e) {
        return fallback;
    }
}

function seasonIdFromTitle(title: string) {
    const clean = String(title || '').trim().toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return clean || idText(new ObjectId());
}

function normalizeConfig(domainId: string, raw?: Partial<SeasonConfig> | null): SeasonConfig {
    return {
        _id: domainId,
        domainId,
        enabled: raw?.enabled ?? DEFAULT_CONFIG.enabled,
        activeSeasonId: raw?.activeSeasonId ?? DEFAULT_CONFIG.activeSeasonId,
        updatedAt: raw?.updatedAt,
        updatedBy: raw?.updatedBy,
    };
}

function ratingMeta(rating: number) {
    let tier = RATING_TIERS[0];
    for (const item of RATING_TIERS) {
        if (rating >= item.min) tier = item;
    }
    return tier;
}

async function getConfig(domainId: string) {
    return normalizeConfig(domainId, await collConfig.findOne({ _id: domainId }) as SeasonConfig | null);
}

async function setConfig(domainId: string, patch: Partial<SeasonConfig>, uid: number) {
    const next = { ...normalizeConfig(domainId, { ...(await getConfig(domainId)), ...patch }), updatedAt: new Date(), updatedBy: uid };
    await collConfig.updateOne({ _id: domainId }, { $set: next, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
    return next;
}

async function getActiveSeason(domainId: string, config?: SeasonConfig) {
    const cfg = config || await getConfig(domainId);
    if (cfg.activeSeasonId) {
        const doc = await collSeason.findOne({ _id: scopedId(domainId, cfg.activeSeasonId) }) as SeasonDoc | null;
        if (doc) return doc;
    }
    return await collSeason.find({ domainId, archived: false }).sort({ startsAt: -1 }).limit(1).next() as SeasonDoc | null;
}

async function listSeasons(domainId: string) {
    return await collSeason.find({ domainId }).sort({ startsAt: -1, createdAt: -1 }).limit(30).toArray() as SeasonDoc[];
}

function seasonQuery(domainId: string, season: SeasonDoc) {
    const ratedAt: any = {};
    if (season.startsAt) ratedAt.$gte = dayStart(season.startsAt);
    const end = dayEnd(season.endsAt || null);
    if (end) ratedAt.$lte = end;
    return { domainId, ...(Object.keys(ratedAt).length ? { ratedAt } : {}) };
}

async function buildSeasonRows(domainId: string, season: SeasonDoc) {
    const changes = await collRatingChange.find(seasonQuery(domainId, season))
        .sort({ uid: 1, ratedAt: 1, contestId: 1 })
        .toArray() as any[];
    const byUid = new Map<number, any>();
    for (const row of changes) {
        const uid = Number(row.uid);
        if (!uid) continue;
        const current = byUid.get(uid) || {
            uid,
            contests: 0,
            startRating: Number(row.oldRating) || 0,
            lastRating: Number(row.oldRating) || 0,
            positive: 0,
            negative: 0,
            bestRank: 0,
            lastContestTitle: '',
            lastRatedAt: null,
        };
        current.contests++;
        current.lastRating = Number(row.newRating) || current.lastRating;
        current.positive += Math.max(0, Number(row.delta) || 0);
        current.negative += Math.min(0, Number(row.delta) || 0);
        current.bestRank = current.bestRank ? Math.min(current.bestRank, Number(row.rank) || current.bestRank) : Number(row.rank) || 0;
        current.lastContestTitle = row.contestTitle || row.contestId || '';
        current.lastRatedAt = row.ratedAt || current.lastRatedAt;
        byUid.set(uid, current);
    }
    const rows = Array.from(byUid.values()).map((row) => {
        const delta = row.lastRating - row.startRating;
        const meta = ratingMeta(row.lastRating);
        return {
            ...row,
            delta,
            seasonScore: delta,
            title: meta.title,
            color: meta.color,
        };
    }).sort((a, b) => b.seasonScore - a.seasonScore || b.contests - a.contests || b.lastRating - a.lastRating || a.uid - b.uid);
    rows.forEach((row, index) => { row.rank = index + 1; });
    return rows;
}

async function buildUserSeason(domainId: string, uid: number) {
    const config = await getConfig(domainId);
    if (!config.enabled) return null;
    const season = await getActiveSeason(domainId, config);
    if (!season) return { config, season: null, row: null };
    const rows = await buildSeasonRows(domainId, season);
    return { config, season, row: rows.find((item) => item.uid === uid) || null };
}

async function ensureIndexes(collection: any, ...indexes: any[]) {
    try {
        await db.ensureIndexes(collection, ...indexes);
    } catch (e: any) {
        console.warn('[rating-season] failed to ensure indexes:', e?.message || e);
    }
}

class DomainRatingSeasonHandler extends Handler {
    async prepare() {
        this.checkPerm(PERM.PERM_EDIT_DOMAIN);
    }

    async buildBody(domainId: string, messages: string[] = []) {
        const config = await getConfig(domainId);
        const seasons = await listSeasons(domainId);
        const activeSeason = await getActiveSeason(domainId, config);
        return {
            page_name: 'domain_rating_season',
            config,
            seasons,
            activeSeason,
            activeSeasonForm: activeSeason ? {
                ...activeSeason,
                startsAtText: dateInput(activeSeason.startsAt),
                endsAtText: dateInput(activeSeason.endsAt || null),
            } : null,
            messages,
            rankingUrl: safeUrl(this, 'rating_season_ranking', '/ranking/rating-season'),
        };
    }

    async get({ domainId }: any) {
        this.response.template = 'domain_rating_season.html';
        this.response.body = await this.buildBody(domainId);
    }

    @param('enabled', Types.String, true)
    async postSaveConfig({ domainId }: any, enabled = '') {
        await setConfig(domainId, { enabled: enabled === 'true' || enabled === 'on' || enabled === '1' }, this.user._id);
        this.response.template = 'domain_rating_season.html';
        this.response.body = await this.buildBody(domainId, ['赛季设置已保存。']);
    }

    @param('seasonId', Types.String, true)
    @param('title', Types.String)
    @param('startsAt', Types.Date)
    @param('endsAt', Types.Date, true)
    async postSaveSeason({ domainId }: any, seasonId = '', title: string, startsAt: Date, endsAt?: Date) {
        const cleanTitle = String(title || '').trim();
        if (!cleanTitle) throw new ValidationError('title');
        const nextSeasonId = seasonId || seasonIdFromTitle(cleanTitle);
        const now = new Date();
        const doc: SeasonDoc = {
            _id: scopedId(domainId, nextSeasonId),
            domainId,
            seasonId: nextSeasonId,
            title: cleanTitle,
            startsAt: dayStart(startsAt),
            endsAt: endsAt ? dayEnd(endsAt) : null,
            archived: false,
            createdAt: now,
            updatedAt: now,
            updatedBy: this.user._id,
        };
        const patch = {
            domainId: doc.domainId,
            seasonId: doc.seasonId,
            title: doc.title,
            startsAt: doc.startsAt,
            endsAt: doc.endsAt,
            archived: doc.archived,
            updatedAt: doc.updatedAt,
            updatedBy: doc.updatedBy,
        };
        await collSeason.updateOne(
            { _id: doc._id },
            { $set: patch, $setOnInsert: { _id: doc._id, createdAt: now } },
            { upsert: true },
        );
        await setConfig(domainId, { activeSeasonId: nextSeasonId }, this.user._id);
        this.response.template = 'domain_rating_season.html';
        this.response.body = await this.buildBody(domainId, [`赛季「${cleanTitle}」已保存并设为当前赛季。`]);
    }

    @param('seasonId', Types.String)
    async postActivateSeason({ domainId }: any, seasonId: string) {
        const doc = await collSeason.findOne({ _id: scopedId(domainId, seasonId) }) as SeasonDoc | null;
        if (!doc) throw new ValidationError('seasonId');
        await collSeason.updateOne({ _id: doc._id }, { $set: { archived: false, updatedAt: new Date(), updatedBy: this.user._id } });
        await setConfig(domainId, { activeSeasonId: seasonId }, this.user._id);
        this.response.template = 'domain_rating_season.html';
        this.response.body = await this.buildBody(domainId, [`已切换到赛季「${doc.title}」。`]);
    }

    @param('seasonId', Types.String)
    async postArchiveSeason({ domainId }: any, seasonId: string) {
        const doc = await collSeason.findOne({ _id: scopedId(domainId, seasonId) }) as SeasonDoc | null;
        if (!doc) throw new ValidationError('seasonId');
        await collSeason.updateOne({ _id: doc._id }, { $set: { archived: true, updatedAt: new Date(), updatedBy: this.user._id } });
        const config = await getConfig(domainId);
        if (config.activeSeasonId === seasonId) await setConfig(domainId, { activeSeasonId: '' }, this.user._id);
        this.response.template = 'domain_rating_season.html';
        this.response.body = await this.buildBody(domainId, [`赛季「${doc.title}」已归档。`]);
    }
}

class RatingSeasonRankingHandler extends Handler {
    @param('seasonId', Types.String, true)
    @param('page', Types.PositiveInt, true)
    async get({ domainId }: any, seasonId = '', page = 1) {
        const config = await getConfig(domainId);
        const seasons = await listSeasons(domainId);
        const activeSeason = seasonId
            ? await collSeason.findOne({ _id: scopedId(domainId, seasonId) }) as SeasonDoc | null
            : await getActiveSeason(domainId, config);
        const allRows = activeSeason ? await buildSeasonRows(domainId, activeSeason) : [];
        const total = allRows.length;
        const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
        const rows = allRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
        const udict = await UserModel.getListForRender(domainId, rows.map((item) => item.uid), this.user.hasPerm(PERM.PERM_VIEW_DISPLAYNAME) ? ['displayName'] : []);
        this.response.template = 'rating_season_ranking.html';
        this.response.body = {
            page_name: 'rating_season_ranking',
            config,
            seasons,
            activeSeason,
            rows,
            udict,
            page,
            pageCount,
            total,
            rpRankingUrl: safeUrl(this, 'ranking', '/ranking'),
            ratingRankingUrl: safeUrl(this, 'contest_rating_ranking', '/ranking/contest-rating'),
            manageUrl: this.user.hasPerm(PERM.PERM_EDIT_DOMAIN) ? safeUrl(this, 'domain_rating_season', '/domain/rating-season') : '',
        };
    }
}

export async function apply(ctx: Context) {
    await ensureIndexes(
        collConfig,
        { key: { domainId: 1 }, name: 'rating_season_config_domain', unique: true },
    );
    await ensureIndexes(
        collSeason,
        { key: { domainId: 1, seasonId: 1 }, name: 'rating_season_unique', unique: true },
        { key: { domainId: 1, startsAt: -1 }, name: 'rating_season_time' },
    );

    (globalThis as any).Hydro = (globalThis as any).Hydro || {};
    (globalThis as any).Hydro.model = (globalThis as any).Hydro.model || {};
    (globalThis as any).Hydro.model.ratingSeason = {
        getConfig,
        getActiveSeason,
        buildSeasonRows,
        buildUserSeason,
    };

    ctx.Route('domain_rating_season', '/domain/rating-season', DomainRatingSeasonHandler, PERM.PERM_EDIT_DOMAIN);
    ctx.Route('rating_season_ranking', '/ranking/rating-season', RatingSeasonRankingHandler, PERM.PERM_VIEW_RANKING);
    ctx.injectUI('DomainManage', 'domain_rating_season', { family: 'Contest', icon: 'statistics' }, PERM.PERM_EDIT_DOMAIN);

    ctx.on('handler/after/UserDetail#get', async (handler: any) => {
        if (!runtimeEnabled()) return;
        const domainId = handler.args?.domainId || handler.domain?._id;
        const uid = Number(handler.args?.uid);
        if (!domainId || !uid) return;
        handler.response.body.ratingSeason = await buildUserSeason(domainId, uid);
        handler.response.body.ratingSeasonRankingUrl = safeUrl(handler, 'rating_season_ranking', '/ranking/rating-season');
    });

    ctx.i18n.load('zh', {
        domain_rating_season: 'Rating 赛季',
        rating_season_ranking: '赛季榜',
    });
    ctx.i18n.load('en', {
        domain_rating_season: 'Rating Season',
        rating_season_ranking: 'Season Ranking',
    });
}
