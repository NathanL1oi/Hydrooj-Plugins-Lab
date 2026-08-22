import {
    ContestModel, Context, Handler, ObjectId, PERM, Types, UserModel, ValidationError, db, param,
} from 'hydrooj';
import { ContestDetailBaseHandler } from 'hydrooj/src/handler/contest';

const PLUGIN_ID = 'contest-rating-arena';
const PAGE_SIZE = 100;

const collConfig = db.collection('domain.contestRating.config' as any);
const collUser = db.collection('domain.contestRating.user' as any);
const collChange = db.collection('domain.contestRating.change' as any);
const collContest = db.collection('domain.contestRating.contest' as any);

interface RatingConfig {
    _id: string;
    domainId: string;
    enabled: boolean;
    showInNav: boolean;
    initialRating: number;
    minParticipants: number;
    growthFactor: number;
    publishOnlyAfterEnd: boolean;
    updatedAt?: Date;
    updatedBy?: number;
}

interface RatingUserDoc {
    _id: string;
    domainId: string;
    uid: number;
    rating: number;
    maxRating: number;
    minRating: number;
    ratedCount: number;
    lastDelta: number;
    lastRank: number;
    lastContestId: string;
    lastRatedAt?: Date;
    updatedAt?: Date;
}

interface RankedParticipant {
    uid: number;
    rank: number;
    score: number;
    accept: number;
    time: number;
}

interface RatingRow extends RankedParticipant {
    oldRating: number;
    newRating: number;
    delta: number;
    seed: number;
    performanceRating: number;
    title: string;
    color: string;
}

interface RatingChangeView {
    contestId: string;
    contestTitle: string;
    ratedAt?: Date;
    oldRating: number;
    newRating: number;
    delta: number;
    rank: number;
    title: string;
    color: string;
}

const RATING_TIERS = [
    { min: 0, title: '启航灰', color: '#64748b', hint: '开始读题和调试' },
    { min: 1080, title: '新芽绿', color: '#16a34a', hint: '能稳定完成基础题' },
    { min: 1200, title: '破题蓝', color: '#2563eb', hint: '有清晰的算法思路' },
    { min: 1350, title: '星桥紫', color: '#7c3aed', hint: '开始攻克综合题' },
    { min: 1550, title: '火炬橙', color: '#f97316', hint: '赛场发挥很亮眼' },
    { min: 1800, title: '传奇红', color: '#dc2626', hint: '高水平稳定输出' },
];

const DEFAULT_CONFIG: Omit<RatingConfig, '_id' | 'domainId'> = {
    enabled: false,
    showInNav: true,
    initialRating: 1000,
    minParticipants: 2,
    growthFactor: 170,
    publishOnlyAfterEnd: true,
};

const configCache = new Map<string, RatingConfig>();

function runtimeEnabled() {
    const pluginSwitch = (globalThis as any).Hydro?.model?.pluginSwitch;
    return pluginSwitch?.isEnabledSync?.(PLUGIN_ID) !== false;
}

function idText(value: any) {
    return value?.toHexString?.() || value?.toString?.() || String(value);
}

function scopedId(domainId: string, ...parts: any[]) {
    return [domainId, ...parts.map(idText)].join(':');
}

function normalizeConfig(domainId: string, raw?: Partial<RatingConfig> | null): RatingConfig {
    return {
        _id: domainId,
        domainId,
        enabled: raw?.enabled ?? DEFAULT_CONFIG.enabled,
        showInNav: raw?.showInNav ?? DEFAULT_CONFIG.showInNav,
        initialRating: Math.max(1, Number(raw?.initialRating ?? DEFAULT_CONFIG.initialRating) || DEFAULT_CONFIG.initialRating),
        minParticipants: Math.max(2, Number(raw?.minParticipants ?? DEFAULT_CONFIG.minParticipants) || DEFAULT_CONFIG.minParticipants),
        growthFactor: Math.min(300, Math.max(80, Number(raw?.growthFactor ?? DEFAULT_CONFIG.growthFactor) || DEFAULT_CONFIG.growthFactor)),
        publishOnlyAfterEnd: raw?.publishOnlyAfterEnd ?? DEFAULT_CONFIG.publishOnlyAfterEnd,
        updatedAt: raw?.updatedAt,
        updatedBy: raw?.updatedBy,
    };
}

async function getConfig(domainId: string) {
    if (configCache.has(domainId)) return configCache.get(domainId)!;
    const doc = await collConfig.findOne({ _id: domainId }) as RatingConfig | null;
    const config = normalizeConfig(domainId, doc);
    configCache.set(domainId, config);
    return config;
}

async function setConfig(domainId: string, patch: Partial<RatingConfig>, uid: number) {
    const config = normalizeConfig(domainId, { ...(await getConfig(domainId)), ...patch });
    const next = { ...config, updatedAt: new Date(), updatedBy: uid };
    await collConfig.updateOne(
        { _id: domainId },
        { $set: next, $setOnInsert: { createdAt: new Date() } },
        { upsert: true },
    );
    configCache.set(domainId, next);
    return next;
}

function ratingMeta(rating: number) {
    let tier = RATING_TIERS[0];
    for (const item of RATING_TIERS) {
        if (rating >= item.min) tier = item;
    }
    return tier;
}

function ratingChangeView(row: any): RatingChangeView {
    const oldRating = Math.round(Number(row.oldRating) || 0);
    const newRating = Math.round(Number(row.newRating) || 0);
    const delta = Math.round(Number(row.delta) || 0);
    const meta = ratingMeta(newRating);
    const contestId = idText(row.contestId || '');
    return {
        contestId,
        contestTitle: row.contestTitle || contestId || 'Contest',
        ratedAt: row.ratedAt,
        oldRating,
        newRating,
        delta,
        rank: Number(row.rank) || 0,
        title: meta.title,
        color: meta.color,
    };
}

function winProbability(opponentRating: number, playerRating: number) {
    return 1 / (1 + 10 ** ((playerRating - opponentRating) / 400));
}

function seedForRating(contestants: Array<{ oldRating: number }>, rating: number, excludeIndex: number) {
    let seed = 1;
    for (let i = 0; i < contestants.length; i++) {
        if (i === excludeIndex) continue;
        seed += winProbability(contestants[i].oldRating, rating);
    }
    return seed;
}

function ratingToRank(contestants: Array<{ oldRating: number }>, targetRank: number, excludeIndex: number) {
    let low = 1;
    let high = 8000;
    for (let i = 0; i < 32; i++) {
        const mid = Math.floor((low + high) / 2);
        const seed = seedForRating(contestants, mid, excludeIndex);
        if (seed > targetRank) low = mid;
        else high = mid;
    }
    return Math.floor((low + high) / 2);
}

function ratingRanks(contestants: RankedParticipant[]) {
    if (!contestants.length) return [];
    const ranks = contestants.map((item) => item.rank);
    let lastIndex = 0;
    let lastRank = ranks[0];
    for (let i = 1; i < ranks.length; i++) {
        if (ranks[i] <= lastRank) continue;
        for (let j = lastIndex; j < i; j++) ranks[j] = i;
        lastIndex = i;
        lastRank = ranks[i];
    }
    for (let j = lastIndex; j < ranks.length; j++) ranks[j] = ranks.length;
    return ranks;
}

function friendlyDelta(delta: number, item: RankedParticipant & { oldRating: number }, participantCount: number, config: RatingConfig) {
    const growth = config.growthFactor / 100;
    const smallContestBoost = Math.min(1.3, 1 + Math.max(0, 20 - participantCount) * 0.015);
    if (delta > 0) {
        const earlyRatingBoost = item.oldRating < 1200 ? 1.14 : item.oldRating < 1350 ? 1.08 : 1;
        const topHalfBonus = item.rank <= Math.ceil(participantCount / 2)
            ? Math.min(16, Math.max(0, 1200 - item.oldRating) / 18)
            : 0;
        return Math.min(260, delta * growth * smallContestBoost * earlyRatingBoost + topHalfBonus);
    }
    if (delta < 0) {
        const earlyProtection = item.oldRating < 1200 ? 0.55 : item.oldRating < 1350 ? 0.75 : 1;
        return Math.max(-110, delta * earlyProtection);
    }
    return 0;
}

function calculateRatingRows(contestants: Array<RankedParticipant & { oldRating: number }>, config: RatingConfig): RatingRow[] {
    if (!contestants.length) return [];
    const actualRanks = ratingRanks(contestants);
    const raw = contestants.map((item, index) => {
        const seed = seedForRating(contestants, item.oldRating, index);
        const targetRank = Math.sqrt(seed * actualRanks[index]);
        const performanceRating = ratingToRank(contestants, targetRank, index);
        return {
            ...item,
            seed,
            performanceRating,
            delta: (performanceRating - item.oldRating) / 2,
        };
    });

    const sumDelta = raw.reduce((sum, item) => sum + item.delta, 0);
    const globalCorrection = Math.floor(-sumDelta / raw.length) - 1;
    for (const item of raw) item.delta += globalCorrection;

    const topCount = Math.min(raw.length, Math.max(1, Math.round(Math.sqrt(raw.length)) * 4));
    const top = [...raw].sort((a, b) => b.oldRating - a.oldRating || a.uid - b.uid).slice(0, topCount);
    const topSum = top.reduce((sum, item) => sum + item.delta, 0);
    const topCorrection = Math.min(0, Math.max(-10, Math.floor(-topSum / topCount)));
    for (const item of raw) item.delta += topCorrection;

    return raw.map((item) => {
        const delta = Math.round(friendlyDelta(item.delta, item, raw.length, config));
        const newRating = Math.max(0, Math.round(item.oldRating + delta));
        const meta = ratingMeta(newRating);
        return {
            ...item,
            delta,
            newRating,
            title: meta.title,
            color: meta.color,
        };
    });
}

function canManageContest(handler: any) {
    return handler.user?.hasPerm?.(PERM.PERM_EDIT_CONTEST)
        || handler.user?.own?.(handler.tdoc, PERM.PERM_EDIT_CONTEST_SELF);
}

function contestDone(tdoc: any, tsdoc?: any) {
    try {
        return ContestModel.isDone(tdoc, tsdoc);
    } catch {
        return tdoc?.endAt ? new Date(tdoc.endAt).getTime() <= Date.now() : false;
    }
}

async function rankedParticipants(domainId: string, tid: ObjectId, tdoc: any): Promise<RankedParticipant[]> {
    const rule = ContestModel.RULES?.[tdoc.rule];
    if (!rule?.ranked) throw new ValidationError('rule', tdoc.rule, 'Unsupported contest rule');
    const cursor = ContestModel.getMultiStatus(domainId, {
        docId: tid,
        uid: { $gt: 1 },
        attend: { $exists: true },
    })
        .project({ uid: 1, score: 1, accept: 1, time: 1, unrank: 1, attend: 1 })
        .sort(rule.statusSort || { _id: 1 });
    const ranked = await rule.ranked(tdoc, cursor);
    const rows: RankedParticipant[] = [];
    for (const [rank, tsdoc] of ranked as any[]) {
        const uid = Number(tsdoc?.uid);
        const actualRank = Number(rank);
        if (!uid || !actualRank || tsdoc?.unrank) continue;
        rows.push({
            uid,
            rank: actualRank,
            score: Number(tsdoc.score) || 0,
            accept: Number(tsdoc.accept) || 0,
            time: Number(tsdoc.time) || 0,
        });
    }
    return rows;
}

async function currentRatingMap(domainId: string, uids: number[], initialRating: number) {
    const docs = await collUser.find({ domainId, uid: { $in: uids } }).toArray() as RatingUserDoc[];
    const map = new Map<number, RatingUserDoc>();
    for (const doc of docs) map.set(Number(doc.uid), doc);
    for (const uid of uids) {
        if (map.has(uid)) continue;
        map.set(uid, {
            _id: scopedId(domainId, uid),
            domainId,
            uid,
            rating: initialRating,
            maxRating: initialRating,
            minRating: initialRating,
            ratedCount: 0,
            lastDelta: 0,
            lastRank: 0,
            lastContestId: '',
        });
    }
    return map;
}

async function buildPreview(domainId: string, tid: ObjectId, tdoc: any, config: RatingConfig) {
    const ranked = await rankedParticipants(domainId, tid, tdoc);
    const ratingMap = await currentRatingMap(domainId, ranked.map((item) => item.uid), config.initialRating);
    const contestants = ranked.map((item) => ({
        ...item,
        oldRating: ratingMap.get(item.uid)?.rating ?? config.initialRating,
    }));
    const rows = calculateRatingRows(contestants, config)
        .sort((a, b) => a.rank - b.rank || b.score - a.score || a.uid - b.uid);
    return {
        rows,
        participantCount: rows.length,
        rated: rows.length >= config.minParticipants,
    };
}

async function buildPublishedRows(domainId: string, tid: ObjectId) {
    const rows = await collChange.find({ domainId, contestId: idText(tid) })
        .sort({ rank: 1, uid: 1 })
        .toArray() as any[];
    return rows.map((row) => {
        const meta = ratingMeta(Number(row.newRating) || 0);
        return {
            uid: Number(row.uid),
            rank: Number(row.rank) || 0,
            score: Number(row.score) || 0,
            accept: Number(row.accept) || 0,
            oldRating: Number(row.oldRating) || 0,
            newRating: Number(row.newRating) || 0,
            delta: Number(row.delta) || 0,
            seed: Number(row.seed) || 0,
            performanceRating: Number(row.performanceRating) || 0,
            title: meta.title,
            color: meta.color,
        } as RatingRow;
    });
}

async function publishPreview(domainId: string, tid: ObjectId, tdoc: any, rows: RatingRow[], operator: number) {
    const now = new Date();
    const contestId = idText(tid);
    const contestTitle = tdoc.title || contestId;
    for (const row of rows) {
        await collChange.updateOne(
            { _id: scopedId(domainId, contestId, row.uid) },
            {
                $set: {
                    _id: scopedId(domainId, contestId, row.uid),
                    domainId,
                    contestId,
                    contestTitle,
                    uid: row.uid,
                    rank: row.rank,
                    score: row.score,
                    accept: row.accept,
                    oldRating: row.oldRating,
                    newRating: row.newRating,
                    delta: row.delta,
                    seed: row.seed,
                    performanceRating: row.performanceRating,
                    ratedAt: now,
                    operator,
                },
            },
            { upsert: true },
        );
        await collUser.updateOne(
            { _id: scopedId(domainId, row.uid) },
            {
                $set: {
                    _id: scopedId(domainId, row.uid),
                    domainId,
                    uid: row.uid,
                    rating: row.newRating,
                    lastDelta: row.delta,
                    lastRank: row.rank,
                    lastContestId: contestId,
                    lastRatedAt: now,
                    updatedAt: now,
                },
                $max: { maxRating: Math.max(row.oldRating, row.newRating) },
                $min: { minRating: Math.min(row.oldRating, row.newRating) },
                $inc: { ratedCount: 1 },
                $setOnInsert: { createdAt: now },
            },
            { upsert: true },
        );
    }
    await collContest.updateOne(
        { _id: scopedId(domainId, contestId) },
        {
            $set: {
                _id: scopedId(domainId, contestId),
                domainId,
                contestId,
                contestTitle,
                participantCount: rows.length,
                publishedAt: now,
                publishedBy: operator,
            },
            $setOnInsert: { createdAt: now },
        },
        { upsert: true },
    );
}

async function publishContestRating(domainId: string, tid: ObjectId, tdoc: any, config: RatingConfig, operator: number, tsdoc?: any) {
    if (!config.enabled) throw new ValidationError('contestRating', null, 'Contest Rating is disabled.');
    if (config.publishOnlyAfterEnd && !contestDone(tdoc, tsdoc)) {
        throw new ValidationError('contestRating', null, 'Contest is not finished.');
    }
    const publishedDoc = await collContest.findOne({ _id: scopedId(domainId, tid), publishedAt: { $exists: true } });
    if (publishedDoc) throw new ValidationError('contestRating', null, 'Rating has already been published.');
    const preview = await buildPreview(domainId, tid, tdoc, config);
    if (preview.rows.length < config.minParticipants) {
        throw new ValidationError('contestRating', preview.rows.length, `At least ${config.minParticipants} ranked participants are required.`);
    }
    await publishPreview(domainId, tid, tdoc, preview.rows, operator);
    return preview;
}

async function rebuildUserRating(domainId: string, uid: number) {
    const changes = await collChange.find({ domainId, uid })
        .sort({ ratedAt: 1, contestId: 1 })
        .toArray() as any[];
    if (!changes.length) {
        await collUser.deleteOne({ _id: scopedId(domainId, uid) });
        return;
    }
    let maxRating = Number(changes[0].oldRating) || 0;
    let minRating = maxRating;
    for (const change of changes) {
        maxRating = Math.max(maxRating, Number(change.oldRating) || 0, Number(change.newRating) || 0);
        minRating = Math.min(minRating, Number(change.oldRating) || 0, Number(change.newRating) || 0);
    }
    const last = changes[changes.length - 1];
    await collUser.updateOne(
        { _id: scopedId(domainId, uid) },
        {
            $set: {
                _id: scopedId(domainId, uid),
                domainId,
                uid,
                rating: Number(last.newRating) || 0,
                maxRating,
                minRating,
                ratedCount: changes.length,
                lastDelta: Number(last.delta) || 0,
                lastRank: Number(last.rank) || 0,
                lastContestId: last.contestId || '',
                lastRatedAt: last.ratedAt,
                updatedAt: new Date(),
            },
            $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true },
    );
}

async function withdrawContestRating(domainId: string, tid: ObjectId) {
    const contestId = idText(tid);
    const publishedDoc = await collContest.findOne({ _id: scopedId(domainId, contestId), publishedAt: { $exists: true } }) as any;
    if (!publishedDoc) throw new ValidationError('contestRating', null, 'Rating has not been published.');
    const later = await collContest.find({
        domainId,
        publishedAt: { $gt: publishedDoc.publishedAt },
    }).sort({ publishedAt: 1 }).limit(1).next() as any;
    if (later) {
        throw new ValidationError('contestRating', later.contestTitle || later.contestId, 'Only the latest published contest rating can be withdrawn.');
    }
    const changes = await collChange.find({ domainId, contestId }).toArray() as any[];
    const uids = Array.from(new Set(changes.map((row) => Number(row.uid)).filter(Boolean)));
    await Promise.all([
        collChange.deleteMany({ domainId, contestId }),
        collContest.deleteOne({ _id: scopedId(domainId, contestId) }),
    ]);
    for (const uid of uids) await rebuildUserRating(domainId, uid);
}

async function userDict(domainId: string, uids: number[], canViewDisplayName: boolean) {
    const unique = Array.from(new Set(uids.filter(Boolean)));
    if (!unique.length) return {};
    return await UserModel.getListForRender(domainId, unique, canViewDisplayName ? ['displayName'] : []);
}

class DomainContestRatingHandler extends Handler {
    async prepare() {
        this.checkPerm(PERM.PERM_EDIT_DOMAIN);
    }

    @param('page', Types.PositiveInt, true)
    async get({ domainId }: any, page = 1) {
        const config = await getConfig(domainId);
        const [userCount, contestCount, contestPageData] = await Promise.all([
            collUser.countDocuments({ domainId }),
            collContest.countDocuments({ domainId, publishedAt: { $exists: true } }),
            this.paginate(
                ContestModel.getMulti(domainId, {}).sort({ endAt: -1, beginAt: -1 }),
                page,
                30,
            ) as Promise<[any[], number, number]>,
        ]);
        const [tdocs, contestPageCount, contestTotal] = contestPageData;
        const contestIds = tdocs.map((tdoc) => idText(tdoc.docId));
        const publishedDocs = contestIds.length
            ? await collContest.find({ domainId, contestId: { $in: contestIds } }).toArray() as any[]
            : [];
        const latestPublished = await collContest.find({ domainId, publishedAt: { $exists: true } })
            .sort({ publishedAt: -1 })
            .limit(1)
            .next() as any;
        const publishedMap = new Map(publishedDocs.map((doc) => [doc.contestId, doc]));
        const contests = tdocs.map((tdoc) => {
            const contestId = idText(tdoc.docId);
            const published = publishedMap.get(contestId);
            const done = contestDone(tdoc);
            const supported = !!ContestModel.RULES?.[tdoc.rule]?.ranked;
            const canPublish = config.enabled
                && !published
                && supported
                && (!config.publishOnlyAfterEnd || done);
            return {
                docId: tdoc.docId,
                contestId,
                title: tdoc.title || contestId,
                rule: tdoc.rule,
                beginAt: tdoc.beginAt,
                endAt: tdoc.endAt,
                attend: Number(tdoc.attend) || 0,
                done,
                supported,
                published,
                canPublish,
                canWithdraw: !!published && latestPublished?._id === published._id,
                ratingUrl: this.url('contest_rating_contest', { tid: tdoc.docId }),
            };
        });
        this.response.template = 'domain_contest_rating.html';
        this.response.body = {
            page_name: 'domain_contest_rating',
            config,
            userCount,
            contestCount,
            contests,
            contestPage: page,
            contestPageCount,
            contestTotal,
            ratingTiers: RATING_TIERS,
            rankingUrl: this.url('contest_rating_ranking'),
        };
    }

    @param('enabled', Types.Boolean, true)
    @param('showInNav', Types.Boolean, true)
    @param('initialRating', Types.Int, true)
    @param('minParticipants', Types.Int, true)
    @param('growthFactor', Types.Int, true)
    @param('publishOnlyAfterEnd', Types.Boolean, true)
    async post(
        { domainId }: any,
        enabled = false,
        showInNav = false,
        initialRating = DEFAULT_CONFIG.initialRating,
        minParticipants = DEFAULT_CONFIG.minParticipants,
        growthFactor = DEFAULT_CONFIG.growthFactor,
        publishOnlyAfterEnd = false,
    ) {
        if (this.request.body?.operation) return;
        await setConfig(domainId, {
            enabled,
            showInNav,
            initialRating: Math.max(1, Number(initialRating) || DEFAULT_CONFIG.initialRating),
            minParticipants: Math.max(2, Number(minParticipants) || DEFAULT_CONFIG.minParticipants),
            growthFactor: Math.min(300, Math.max(80, Number(growthFactor) || DEFAULT_CONFIG.growthFactor)),
            publishOnlyAfterEnd,
        }, this.user._id);
        this.back({ message: 'Contest Rating settings saved.' });
    }

    @param('contestId', Types.ObjectId)
    async postPublishContest({ domainId }: any, contestId: ObjectId) {
        const config = await getConfig(domainId);
        const tdoc = await ContestModel.get(domainId, contestId);
        await publishContestRating(domainId, contestId, tdoc, config, this.user._id);
        this.back({ message: 'Contest Rating published.' });
    }

    @param('contestId', Types.ObjectId)
    async postWithdrawContest({ domainId }: any, contestId: ObjectId) {
        await withdrawContestRating(domainId, contestId);
        this.back({ message: 'Contest Rating withdrawn.' });
    }
}

class ContestRatingRankingHandler extends Handler {
    @param('page', Types.PositiveInt, true)
    async get({ domainId }: any, page = 1) {
        const config = await getConfig(domainId);
        const query = { domainId, ratedCount: { $gt: 0 } };
        const [rows, upcount, total] = await this.paginate(
            collUser.find(query).sort({ rating: -1, uid: 1 }),
            page,
            PAGE_SIZE,
        ) as [RatingUserDoc[], number, number];
        const udict = await userDict(domainId, rows.map((item) => item.uid), this.user.hasPerm(PERM.PERM_VIEW_DISPLAYNAME));
        const decorated = rows.map((row, index) => {
            const meta = ratingMeta(row.rating);
            return {
                ...row,
                rank: (page - 1) * PAGE_SIZE + index + 1,
                title: meta.title,
                color: meta.color,
            };
        });
        this.response.template = 'contest_rating_ranking.html';
        this.response.body = {
            page_name: 'contest_rating_ranking',
            config,
            rows: decorated,
            udict,
            page,
            upcount,
            total,
            rpRankingUrl: this.url('ranking'),
            ratingTiers: RATING_TIERS,
        };
    }
}

class ContestRatingHandler extends ContestDetailBaseHandler {
    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: ObjectId) {
        const config = await getConfig(domainId);
        const canManage = canManageContest(this);
        const publishedDoc = await collContest.findOne({ _id: scopedId(domainId, tid) }) as any;
        const published = !!publishedDoc?.publishedAt;
        const latestPublished = published
            ? await collContest.find({ domainId, publishedAt: { $exists: true } }).sort({ publishedAt: -1 }).limit(1).next() as any
            : null;
        const canWithdraw = canManage && published && latestPublished?._id === publishedDoc._id;
        let rows: RatingRow[] = [];
        let preview = false;
        let message = '';
        if (published) {
            rows = await buildPublishedRows(domainId, tid);
        } else if (canManage && config.enabled) {
            const result = await buildPreview(domainId, tid, this.tdoc, config);
            rows = result.rows;
            preview = true;
            if (!result.rated) message = `At least ${config.minParticipants} ranked participants are required.`;
        } else if (!config.enabled) {
            message = 'Contest Rating is disabled in this domain.';
        } else {
            message = 'Rating changes have not been published yet.';
        }
        const udict = await userDict(domainId, rows.map((item) => item.uid), this.user.hasPerm(PERM.PERM_VIEW_DISPLAYNAME));
        const ownerUdoc = await UserModel.getById(domainId, this.tdoc.owner);
        this.response.template = 'contest_rating_contest.html';
        this.response.body = {
            page_name: 'contest_rating_contest',
            tdoc: this.tdoc,
            tsdoc: this.tsdocAsPublic(),
            owner_udoc: ownerUdoc,
            config,
            canManage,
            published,
            publishedDoc,
            canWithdraw,
            preview,
            rows,
            udict,
            message,
            isDone: contestDone(this.tdoc, this.tsdoc),
            ratingTiers: RATING_TIERS,
        };
    }

    @param('tid', Types.ObjectId)
    async postPublish(domainId: string, tid: ObjectId) {
        if (!canManageContest(this)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
        const config = await getConfig(domainId);
        await publishContestRating(domainId, tid, this.tdoc, config, this.user._id, this.tsdoc);
        this.response.redirect = this.url('contest_rating_contest', { tid });
    }

    @param('tid', Types.ObjectId)
    async postWithdraw(domainId: string, tid: ObjectId) {
        if (!canManageContest(this)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
        await withdrawContestRating(domainId, tid);
        this.response.redirect = this.url('contest_rating_contest', { tid });
    }
}

function contestRatingVisible(handler: any) {
    if (!runtimeEnabled()) return false;
    const domainId = handler.domain?._id || handler.args?.domainId || 'system';
    const config = configCache.get(domainId);
    return handler.user?.hasPerm?.(PERM.PERM_VIEW_CONTEST) && config?.enabled;
}

export async function apply(ctx: Context) {
    await db.ensureIndexes(
        collConfig,
        { key: { domainId: 1 }, name: 'contest_rating_config_domain', unique: true },
    );
    await db.ensureIndexes(
        collUser,
        { key: { domainId: 1, uid: 1 }, name: 'contest_rating_user_uid', unique: true },
        { key: { domainId: 1, rating: -1, uid: 1 }, name: 'contest_rating_rank' },
    );
    await db.ensureIndexes(
        collChange,
        { key: { domainId: 1, contestId: 1, uid: 1 }, name: 'contest_rating_change_unique', unique: true },
        { key: { domainId: 1, uid: 1, ratedAt: -1 }, name: 'contest_rating_change_user' },
        { key: { domainId: 1, contestId: 1, rank: 1 }, name: 'contest_rating_change_contest' },
    );
    await db.ensureIndexes(
        collContest,
        { key: { domainId: 1, contestId: 1 }, name: 'contest_rating_contest_unique', unique: true },
        { key: { domainId: 1, publishedAt: -1 }, name: 'contest_rating_contest_time' },
    );

    ctx.Route('domain_contest_rating', '/domain/contest-rating', DomainContestRatingHandler, PERM.PERM_EDIT_DOMAIN);
    ctx.Route('contest_rating_ranking', '/ranking/contest-rating', ContestRatingRankingHandler, PERM.PERM_VIEW_RANKING);
    ctx.Route('contest_rating_contest', '/contest/:tid/rating', ContestRatingHandler, PERM.PERM_VIEW_CONTEST);

    ctx.injectUI('DomainManage', 'domain_contest_rating', { family: 'Contest', icon: 'statistics' }, PERM.PERM_EDIT_DOMAIN);
    ctx.injectUI('ContestDetail', 'contest_rating_contest', (handler: any) => ({
        icon: 'statistics',
        displayName: 'Rating',
        args: { tid: handler.args?.tid || '' },
    }), contestRatingVisible);

    ctx.on('handler/create/http', async (handler: any) => {
        if (!runtimeEnabled()) return;
        const domainId = handler.domain?._id || handler.args?.domainId || 'system';
        const config = await getConfig(domainId);
        handler.UiContext = handler.UiContext || {};
        handler.UiContext.contestRating = {
            enabled: config.enabled,
            showInNav: config.showInNav,
            rankingUrl: handler.url?.('contest_rating_ranking') || '/ranking/contest-rating',
        };
    });

    ctx.on('handler/after/UserDetail#get', async (handler: any) => {
        if (!runtimeEnabled()) return;
        const domainId = handler.args?.domainId || handler.domain?._id;
        const uid = Number(handler.args?.uid);
        if (!domainId || !uid) return;
        const [config, rating, changes] = await Promise.all([
            getConfig(domainId),
            collUser.findOne({ domainId, uid }) as Promise<RatingUserDoc | null>,
            collChange.find({ domainId, uid })
                .project({
                    contestId: 1,
                    contestTitle: 1,
                    ratedAt: 1,
                    oldRating: 1,
                    newRating: 1,
                    delta: 1,
                    rank: 1,
                })
                .sort({ ratedAt: 1, contestId: 1 })
                .toArray() as Promise<any[]>,
        ]);
        if (!config.enabled) return;
        const history = changes.map(ratingChangeView);
        const changedHistory = history.filter((row) => row.oldRating !== row.newRating || row.delta !== 0);
        handler.response.body.contestRatingConfig = config;
        handler.response.body.contestRating = rating ? {
            ...rating,
            ...ratingMeta(rating.rating),
        } : null;
        handler.response.body.contestRatingHistory = changedHistory;
        handler.response.body.contestRatingChanges = [...changedHistory].reverse().slice(0, 12);
    });

    ctx.i18n.load('zh', {
        domain_contest_rating: '竞技 Rating 设置',
        contest_rating_ranking: 'Rating榜',
        contest_rating_contest: '比赛 Rating',
    });
    ctx.i18n.load('en', {
        domain_contest_rating: 'Contest Rating Settings',
        contest_rating_ranking: 'Rating',
        contest_rating_contest: 'Contest Rating',
    });
}
