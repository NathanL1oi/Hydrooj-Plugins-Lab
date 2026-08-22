const {
    ContestModel,
    ForbiddenError,
    Handler,
    NotFoundError,
    ObjectId,
    PERM,
    PRIV,
    ProblemModel,
    RecordModel,
    UserModel,
    ValidationError,
    db,
} = require('hydrooj');
const { ContestDetailBaseHandler } = require('hydrooj/src/handler/contest');
const { ProblemDetailHandler } = require('hydrooj/src/handler/problem');

const PLUGIN_ID = 'contest-vp-mode';
const VP_VIEW_ID = 'vp';
const HOUR = 60 * 60 * 1000;
const collVp = db.collection('contest.vp.session');

function domainIdOf(handler) {
    return String(handler.args?.domainId || handler.domain?._id || 'system');
}

function tidOf(handler) {
    const raw = handler.args?.tid || handler.request?.params?.tid;
    if (raw?.toHexString) return raw;
    if (ObjectId.isValid(String(raw))) return new ObjectId(String(raw));
    throw new ValidationError('tid');
}

function idText(value) {
    return value?.toHexString?.() || value?.toString?.() || String(value);
}

function asDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}

function contestLengthMs(tdoc) {
    const flexibleHours = Number(tdoc?.duration || 0);
    if (Number.isFinite(flexibleHours) && flexibleHours > 0) return Math.floor(flexibleHours * HOUR);
    const begin = asDate(tdoc?.beginAt);
    const end = asDate(tdoc?.endAt);
    if (!begin || !end) return 0;
    return Math.max(0, end.getTime() - begin.getTime());
}

function formatDurationHours(ms) {
    const hours = ms / HOUR;
    return Number.isInteger(hours) ? String(hours) : hours.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function vpEndAt(tdoc, tsdoc) {
    const start = asDate(tsdoc?.vpStartAt || tsdoc?.startAt);
    const length = contestLengthMs(tdoc);
    if (!start || !length) return null;
    return new Date(start.getTime() + length);
}

function isVpStatus(tsdoc) {
    return !!(tsdoc?.vp || tsdoc?.virtual || tsdoc?.vpStartAt);
}

function isVpLikeStatus(tdoc, tsdoc) {
    if (isVpStatus(tsdoc)) return true;
    const start = asDate(tsdoc?.startAt);
    const end = asDate(tdoc?.endAt);
    return !!(start && end && end <= start);
}

function isVpOngoing(tdoc, tsdoc, now = new Date()) {
    if (!isVpLikeStatus(tdoc, tsdoc)) return false;
    const start = asDate(tsdoc.vpStartAt || tsdoc.startAt);
    const end = vpEndAt(tdoc, tsdoc);
    return !!(start && end && start <= now && now < end);
}

function isVpEnded(tdoc, tsdoc, now = new Date()) {
    if (!isVpLikeStatus(tdoc, tsdoc)) return false;
    const end = vpEndAt(tdoc, tsdoc);
    return !!(end && end <= now);
}

function isContestEnded(tdoc) {
    return ContestModel.isDone ? ContestModel.isDone(tdoc) : asDate(tdoc?.endAt) <= new Date();
}

function tdocForVpScoring(tdoc, tsdoc) {
    if (!isVpLikeStatus(tdoc, tsdoc)) return tdoc;
    const startAt = asDate(tsdoc?.vpStartAt || tsdoc?.startAt);
    const endAt = asDate(tsdoc?.vpEndAt) || vpEndAt(tdoc, tsdoc);
    if (!startAt || !endAt) return tdoc;
    return {
        ...tdoc,
        beginAt: startAt,
        endAt,
        lockAt: null,
        unlocked: true,
    };
}

function canManageContest(handler, tdoc = handler.tdoc) {
    return handler.user?.own?.(tdoc)
        || handler.user?.hasPerm?.(PERM.PERM_EDIT_CONTEST)
        || handler.user?.hasPerm?.(PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD);
}

async function assertRankingVisible(handler, tdoc = handler.tdoc, viewId = 'default') {
    if (!tdoc || tdoc.rule === 'homework') return;
    if (!isContestEnded(tdoc)) return;
    if (canManageContest(handler, tdoc)) return;
    const isVpView = viewId === VP_VIEW_ID;
    if (isVpLikeStatus(tdoc, handler.tsdoc)) {
        if (!isVpEnded(tdoc, handler.tsdoc)) {
            throw new ForbiddenError(isVpView ? 'VP 结束后才能查看 VP 排名。' : 'VP 结束后才能查看比赛排名。');
        }
        return;
    }
    const eligibility = await checkVpEligibility(handler, tdoc, handler.tsdoc);
    if (eligibility.ok) {
        throw new ForbiddenError(isVpView ? '完成 VP 后才能查看 VP 排名。' : '完成 VP 后才能查看比赛排名。');
    }
}

function rankingVisibleFromState(handler, tdoc, tsdoc, eligibility) {
    if (canManageContest(handler, tdoc)) return true;
    if (isVpLikeStatus(tdoc, tsdoc)) return isVpEnded(tdoc, tsdoc);
    return !eligibility?.ok;
}

function intersects(left, right) {
    const set = new Set(left || []);
    return (right || []).some((item) => set.has(item));
}

async function userGroupNames(domainId, uid) {
    const groups = await UserModel.listGroup(domainId, uid);
    return (groups || []).map((group) => group.name).filter(Boolean);
}

async function checkVpEligibility(handler, tdoc, tsdoc) {
    if (!handler.user?.hasPriv?.(PRIV.PRIV_USER_PROFILE)) {
        return { ok: false, reason: '请先登录后再开启 VP。' };
    }
    if (!handler.user?.hasPerm?.(PERM.PERM_ATTEND_CONTEST)) {
        return { ok: false, reason: '当前账号没有参赛权限。' };
    }
    if (tdoc.rule === 'homework') {
        return { ok: false, reason: '作业不开放 VP。' };
    }
    if (!isContestEnded(tdoc)) {
        return { ok: false, reason: '比赛结束后才能开启 VP。' };
    }
    if (tsdoc?.attend && !isVpStatus(tsdoc)) {
        return { ok: false, reason: '你已经参加过这场比赛，不能再开启 VP。' };
    }
    if (contestLengthMs(tdoc) <= 0) {
        return { ok: false, reason: '比赛时长异常，无法创建 VP 时间窗。' };
    }
    const assignedGroups = Array.isArray(tdoc.assign) ? tdoc.assign.filter(Boolean) : [];
    const groups = await userGroupNames(tdoc.domainId, handler.user._id);
    if (assignedGroups.length && !intersects(assignedGroups, groups)) {
        return { ok: false, reason: '你不属于本场比赛允许参赛的小组。', groups, assignedGroups };
    }
    return { ok: true, reason: '', groups, assignedGroups };
}

function publicVpState(handler, tdoc, tsdoc, eligibility = null) {
    const now = new Date();
    const vp = isVpLikeStatus(tdoc, tsdoc);
    const startAt = vp ? asDate(tsdoc.vpStartAt || tsdoc.startAt) : null;
    const endAt = vp ? vpEndAt(tdoc, tsdoc) : null;
    const active = vp && startAt && endAt && startAt <= now && now < endAt;
    const ended = vp && endAt && endAt <= now;
    const canStart = !!eligibility?.ok && !vp;
    const canViewRanking = rankingVisibleFromState(handler, tdoc, tsdoc, eligibility);
    return {
        enabled: true,
        tid: tdoc.docId,
        pageUrl: handler.url('contest_vp', { tid: tdoc.docId }),
        problemUrl: handler.url('contest_problemlist', { tid: tdoc.docId }),
        officialScoreboardUrl: handler.url('contest_scoreboard', { tid: tdoc.docId }),
        scoreboardUrl: handler.url('contest_scoreboard_view', { tid: tdoc.docId, view: VP_VIEW_ID }),
        canViewRanking,
        rankingLockedReason: canViewRanking ? '' : (active ? 'VP 结束后可查看排名。' : '完成 VP 后可查看排名。'),
        canStart,
        active,
        ended,
        vp,
        startAt,
        endAt,
        remainingSeconds: active ? Math.max(0, Math.floor((endAt.getTime() - now.getTime()) / 1000)) : 0,
        reason: eligibility?.reason || '',
    };
}

function applyVpContestWindow(handler) {
    if (!handler?.tdoc || !handler?.tsdoc || !isVpOngoing(handler.tdoc, handler.tsdoc)) return false;
    const startAt = asDate(handler.tsdoc.vpStartAt || handler.tsdoc.startAt);
    const endAt = asDate(handler.tsdoc.vpEndAt) || vpEndAt(handler.tdoc, handler.tsdoc);
    if (!startAt || !endAt) return false;
    handler.tdoc = tdocForVpScoring(handler.tdoc, handler.tsdoc);
    handler.tsdoc = {
        ...handler.tsdoc,
        attend: 1,
        startAt,
        endAt,
        vp: true,
        vpStartAt: handler.tsdoc.vpStartAt || startAt,
        vpEndAt: handler.tsdoc.vpEndAt || endAt,
    };
    if (handler.response?.body) {
        handler.response.body.tdoc = handler.tdoc;
        handler.response.body.tsdoc = handler.tsdoc;
    }
    return true;
}

function ensureVirtualPatch() {
    if (ContestModel.__contestVpModePatched) return;
    const originalIsOngoing = ContestModel.isOngoing;
    ContestModel.isOngoing = function patchedIsOngoing(tdoc, tsdoc) {
        return originalIsOngoing.call(this, tdoc, tsdoc) || isVpOngoing(tdoc, tsdoc);
    };
    const originalUpdateStatus = ContestModel.updateStatus;
    if (typeof originalUpdateStatus === 'function') {
        ContestModel.updateStatus = async function patchedUpdateStatus(domainId, tid, uid, ...args) {
            const result = await originalUpdateStatus.call(this, domainId, tid, uid, ...args);
            if (!isVpStatus(result)) return result;
            const tdoc = await ContestModel.get(domainId, tid);
            return await recalculateVpStatus(domainId, tdoc, result) || result;
        };
    }
    const originalRecalcStatus = ContestModel.recalcStatus;
    if (typeof originalRecalcStatus === 'function') {
        ContestModel.recalcStatus = async function patchedRecalcStatus(domainId, tid, ...args) {
            const result = await originalRecalcStatus.call(this, domainId, tid, ...args);
            await recalculateVpStatuses(domainId, tid);
            return result;
        };
    }
    ContestModel.__contestVpModePatched = { originalIsOngoing, originalUpdateStatus, originalRecalcStatus };
}

function ensureProblemHandlerPatch() {
    if (ProblemDetailHandler.__contestVpModePatched) return;
    const originalPrepare = ProblemDetailHandler.prototype._prepare;
    ProblemDetailHandler.prototype._prepare = async function patchedVpProblemPrepare(...args) {
        const result = await originalPrepare.apply(this, args);
        applyVpContestWindow(this);
        return result;
    };
    ProblemDetailHandler.__contestVpModePatched = { originalPrepare };
}

function objectIdAt(date) {
    const seconds = Math.floor(date.getTime() / 1000).toString(16).padStart(8, '0').slice(-8);
    return new ObjectId(`${seconds}0000000000000000`);
}

function ridMillis(rid) {
    return rid?.getTimestamp?.()?.getTime?.() || 0;
}

function journalFromRecord(rdoc) {
    return {
        rid: rdoc._id,
        pid: rdoc.pid,
        status: rdoc.status,
        score: rdoc.score,
        subtasks: rdoc.subtasks,
        lang: rdoc.lang,
        time: rdoc.time,
        memory: rdoc.memory,
    };
}

async function withVpRecordBackfill(tdoc, tsdoc) {
    if (!isVpLikeStatus(tdoc, tsdoc)) return tsdoc;
    const pids = tdoc.pids || [];
    const start = asDate(tsdoc.vpStartAt || tsdoc.startAt);
    const end = vpEndAt(tdoc, tsdoc);
    if (!pids.length || !start || !end) return tsdoc;
    const records = await RecordModel.getMulti(tdoc.domainId, {
        uid: tsdoc.uid,
        pid: { $in: pids },
        _id: { $gte: objectIdAt(start), $lt: objectIdAt(end) },
        $or: [
            { contest: tdoc.docId },
            { contest: { $exists: false } },
        ],
    }).project({
        _id: 1,
        pid: 1,
        status: 1,
        score: 1,
        subtasks: 1,
        lang: 1,
        time: 1,
        memory: 1,
    }).toArray();
    if (!records.length) return tsdoc;
    const merged = new Map();
    for (const item of tsdoc.journal || []) {
        if (item?.rid) merged.set(idText(item.rid), item);
    }
    for (const rdoc of records) {
        if (!merged.has(idText(rdoc._id))) merged.set(idText(rdoc._id), journalFromRecord(rdoc));
    }
    return {
        ...tsdoc,
        journal: Array.from(merged.values()).sort((a, b) => ridMillis(a.rid) - ridMillis(b.rid)),
    };
}

function normalizeVpJournal(tdoc, tsdoc) {
    if (!isVpLikeStatus(tdoc, tsdoc)) return (tsdoc.journal || []).filter((item) => (tdoc.pids || []).includes(item.pid));
    const start = asDate(tsdoc.vpStartAt || tsdoc.startAt);
    const end = asDate(tsdoc.vpEndAt) || vpEndAt(tdoc, tsdoc);
    if (!start || !end) return [];
    const result = [];
    for (const item of tsdoc.journal || []) {
        if (!(tdoc.pids || []).includes(item.pid)) continue;
        const at = item.rid?.getTimestamp?.() || asDate(item.rid);
        if (!at || at < start || at >= end) continue;
        result.push(item);
    }
    return result;
}

function restoreRealRid(value) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
        for (const item of value) restoreRealRid(item);
        return value;
    }
    if (value.realRid) {
        value.rid = value.realRid;
        delete value.realRid;
    }
    for (const item of Object.values(value)) restoreRealRid(item);
    return value;
}

function buildVpScoreDoc(tdoc, tsdoc) {
    if (!ContestModel.RULES[tdoc.rule]) return tsdoc;
    const journal = normalizeVpJournal(tdoc, tsdoc);
    const scoringTdoc = tdocForVpScoring(tdoc, tsdoc);
    const stats = ContestModel.RULES[tdoc.rule].stat(scoringTdoc, journal);
    restoreRealRid(stats);
    return {
        ...tsdoc,
        ...stats,
        journal: restoreRealRid(journal),
        vp: isVpLikeStatus(tdoc, tsdoc),
        unrank: false,
    };
}

async function recalculateVpStatus(domainId, tdoc, tsdoc) {
    if (!tdoc || !tsdoc?.journal || !isVpLikeStatus(tdoc, tsdoc)) return null;
    if (!ContestModel.RULES[tdoc.rule]) return null;
    const journal = normalizeVpJournal(tdoc, tsdoc);
    const scoringTdoc = tdocForVpScoring(tdoc, tsdoc);
    const stats = ContestModel.RULES[tdoc.rule].stat(scoringTdoc, journal);
    restoreRealRid(stats);
    const marker = isVpStatus(tsdoc) ? { vp: true, unrank: true } : {};
    await ContestModel.setStatus(domainId, tdoc.docId, tsdoc.uid, { journal, ...stats, ...marker });
    return { ...tsdoc, journal, ...stats, ...marker };
}

async function recalculateVpStatuses(domainId, tid) {
    const tdoc = await ContestModel.get(domainId, tid);
    if (!tdoc) return;
    const tsdocs = await ContestModel.getMultiStatus(domainId, {
        docId: tdoc.docId,
        $or: [
            { vp: true },
            { virtual: true },
            { vpStartAt: { $exists: true } },
            { startAt: { $gte: tdoc.endAt } },
        ],
    }).toArray();
    await Promise.all(tsdocs.map((tsdoc) => recalculateVpStatus(domainId, tdoc, tsdoc)));
}

async function recalculateVpRecord(rdoc) {
    if (!rdoc?.contest) return;
    const [tdoc, tsdoc] = await Promise.all([
        ContestModel.get(rdoc.domainId, rdoc.contest),
        ContestModel.getStatus(rdoc.domainId, rdoc.contest, rdoc.uid),
    ]);
    await recalculateVpStatus(rdoc.domainId, tdoc, tsdoc);
}

function comparable(value) {
    if (value === undefined || value === null) return 0;
    if (value instanceof Date) return value.getTime();
    if (value?.getTimestamp) return value.getTimestamp().getTime();
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
}

function compareByStatusSort(sort) {
    const entries = Object.entries(sort || {});
    return (a, b) => {
        for (const [field, directionRaw] of entries) {
            const direction = Number(directionRaw) < 0 ? -1 : 1;
            const av = comparable(a[field]);
            const bv = comparable(b[field]);
            if (av < bv) return direction < 0 ? 1 : -1;
            if (av > bv) return direction < 0 ? -1 : 1;
        }
        return Number(a.uid || 0) - Number(b.uid || 0);
    };
}

function insertVpTypeColumn(rows, docsByUid) {
    if (!rows?.length) return rows;
    const header = rows[0];
    const userIndex = header.findIndex((cell) => cell.type === 'user');
    const rankIndex = header.findIndex((cell) => cell.type === 'rank');
    if (userIndex < 0) return rows;
    header.splice(userIndex + 1, 0, { type: 'vp_type', value: '类型' });
    let vpRank = 0;
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const userCell = row.find((cell) => cell.type === 'user');
        const tsdoc = docsByUid.get(Number(userCell?.raw || 0));
        const isVp = isVpLikeStatus(null, tsdoc);
        if (isVp) {
            vpRank++;
            if (rankIndex >= 0) {
                row[rankIndex].value = `VP ${vpRank}`;
                row[rankIndex].style = 'font-weight:700;color:#1d4ed8;background:#eff6ff;';
            }
        }
        row.splice(userIndex + 1, 0, {
            type: 'vp_type',
            value: isVp ? 'VP' : '正式',
            hover: isVp ? 'Virtual Participation' : 'Official Participation',
            style: isVp
                ? 'font-weight:700;color:#1d4ed8;background:#eff6ff;text-align:center;'
                : 'color:#64748b;background:#f8fafc;text-align:center;',
        });
    }
    return rows;
}

async function renderVpScoreboard(handler, tdoc, groups) {
    const rule = ContestModel.RULES[tdoc.rule];
    if (!rule) throw new ValidationError('rule');
    const [pdict, rawTsdocs] = await Promise.all([
        ProblemModel.getList(tdoc.domainId, tdoc.pids, true, true, ProblemModel.PROJECTION_CONTEST_DETAIL),
        ContestModel.getMultiStatus(tdoc.domainId, { docId: tdoc.docId, attend: { $gte: 1 } }).toArray(),
    ]);
    const enrichedTsdocs = await Promise.all(rawTsdocs
        .filter((tsdoc) => tsdoc.attend)
        .map((tsdoc) => withVpRecordBackfill(tdoc, tsdoc)));
    const scoreDocs = enrichedTsdocs
        .map((tsdoc) => buildVpScoreDoc(tdoc, tsdoc))
        .sort(compareByStatusSort(rule.statusSort));
    const docsByUid = new Map(scoreDocs.map((tsdoc) => [Number(tsdoc.uid), tsdoc]));
    const config = {
        isExport: false,
        showDisplayName: handler.user.hasPerm(PERM.PERM_VIEW_USER_PRIVATE_INFO),
        vp: true,
    };
    const [rows, udict] = await rule.scoreboard(config, handler.translate.bind(handler), tdoc, pdict, scoreDocs);
    insertVpTypeColumn(rows, docsByUid);
    handler.response.body = {
        tdoc: { ...tdoc, unlocked: true },
        tsdoc: handler.tsdocAsPublic ? handler.tsdocAsPublic() : handler.tsdoc,
        rows,
        udict,
        pdict,
        page_name: 'contest_scoreboard',
        groups,
        availableViews: handler.ctx.scoreboard.getAvailableViews(tdoc.rule),
    };
    handler.response.pjax = 'partials/scoreboard.html';
    handler.response.template = 'contest_scoreboard.html';
}

function wrapScoreboardView(view) {
    if (!view || view.__contestVpModeGuarded) return;
    const originalDisplay = view.display;
    view.display = async function guardedScoreboardDisplay(args) {
        await assertRankingVisible(this, args?.tdoc || this.tdoc, view.id);
        return originalDisplay.call(this, args);
    };
    view.__contestVpModeGuarded = true;
}

async function exposeVpProblemMode(handler) {
    const tdoc = handler.tdoc;
    const body = handler.response?.body;
    if (!tdoc || tdoc.rule === 'homework' || !body || body.fragments) return;
    const tsdoc = await ContestModel.getStatus(domainIdOf(handler), tdoc.docId, handler.user._id);
    if (!isVpOngoing(tdoc, tsdoc)) return;
    body.mode = 'contest';
    if (body.page_name !== 'contest_detail_problem_submit') body.page_name = 'contest_detail_problem';
    body.tsdoc = {
        ...(body.tsdoc || {}),
        attend: 1,
        startAt: body.tsdoc?.startAt || tsdoc.vpStartAt || tsdoc.startAt,
        endAt: body.tsdoc?.endAt || tsdoc.vpEndAt || vpEndAt(tdoc, tsdoc),
        detail: body.tsdoc?.detail || tsdoc.detail || {},
    };
    handler.UiContext.contestVP = publicVpState(handler, tdoc, tsdoc, null);
}

function guardScoreboardService(scoreboard) {
    if (!scoreboard || scoreboard.__contestVpModeGuarded) return;
    for (const view of Object.values(scoreboard.views || {})) wrapScoreboardView(view);
    const originalAddView = scoreboard.addView.bind(scoreboard);
    scoreboard.addView = function guardedAddView(id, name, args, options) {
        const guardedOptions = options?.display ? {
            ...options,
            display: async function guardedDisplay(displayArgs) {
                await assertRankingVisible(this, displayArgs?.tdoc || this.tdoc, id);
                return options.display.call(this, displayArgs);
            },
        } : options;
        return originalAddView(id, name, args, guardedOptions);
    };
    scoreboard.__contestVpModeGuarded = true;
}

class ContestVpHandler extends ContestDetailBaseHandler {
    async prepare() {
        if (!this.tdoc) throw new NotFoundError('contest');
    }

    async get() {
        const domainId = domainIdOf(this);
        const tid = tidOf(this);
        const [owner, eligibility] = await Promise.all([
            UserModel.getById(domainId, this.tdoc.owner),
            checkVpEligibility(this, this.tdoc, this.tsdoc),
        ]);
        this.response.template = 'contest_vp.html';
        this.response.body = {
            page_name: 'contest_vp',
            tdoc: this.tdoc,
            tsdoc: this.tsdoc,
            owner_udoc: owner,
            tid,
            eligibility,
            vpState: publicVpState(this, this.tdoc, this.tsdoc, eligibility),
            durationText: formatDurationHours(contestLengthMs(this.tdoc)),
        };
    }

    async postStart() {
        const domainId = domainIdOf(this);
        const tid = tidOf(this);
        const latestStatus = await ContestModel.getStatus(domainId, tid, this.user._id);
        const eligibility = await checkVpEligibility(this, this.tdoc, latestStatus);
        if (!eligibility.ok) throw new ForbiddenError(eligibility.reason || '无法开启 VP。');
        const startAt = new Date();
        const endAt = new Date(startAt.getTime() + contestLengthMs(this.tdoc));
        await ContestModel.setStatus(domainId, tid, this.user._id, {
            attend: 1,
            startAt,
            endAt,
            vpStartAt: startAt,
            vpEndAt: endAt,
            vp: true,
            unrank: true,
            subscribe: 0,
        });
        await collVp.updateOne(
            { domainId, tid, uid: this.user._id },
            {
                $set: {
                    domainId,
                    tid,
                    uid: this.user._id,
                    startAt,
                    endAt,
                    updatedAt: new Date(),
                },
                $setOnInsert: { createdAt: new Date() },
            },
            { upsert: true },
        );
        this.response.redirect = this.url('contest_problemlist', { tid });
    }
}

async function apply(ctx) {
    ensureVirtualPatch();
    ensureProblemHandlerPatch();
    await collVp.createIndex({ domainId: 1, tid: 1, uid: 1 }, { unique: true, name: 'contest_vp_session_unique' }).catch(() => null);

    ctx.Route('contest_vp', '/contest/:tid/vp', ContestVpHandler, PERM.PERM_VIEW_CONTEST);

    ctx.on('handler/after/ContestDetail#get', async (handler) => {
        if (!handler.tdoc || handler.tdoc.rule === 'homework') return;
        if (!isContestEnded(handler.tdoc) && !isVpLikeStatus(handler.tdoc, handler.tsdoc)) return;
        const eligibility = await checkVpEligibility(handler, handler.tdoc, handler.tsdoc);
        handler.UiContext.contestVP = publicVpState(handler, handler.tdoc, handler.tsdoc, eligibility);
    });
    ctx.on('handler/after/ProblemDetail#get', exposeVpProblemMode);
    ctx.on('handler/after/ProblemSubmit#get', exposeVpProblemMode);
    ctx.on('record/judge', recalculateVpRecord);
    ctx.on('handler/after/CodeforcesScoreSetting#post', async (handler) => {
        if (handler.tdoc?.docId) await recalculateVpStatuses(domainIdOf(handler), handler.tdoc.docId);
    });

    await ctx.inject(['scoreboard'], ({ scoreboard }) => {
        guardScoreboardService(scoreboard);
        scoreboard.addView(VP_VIEW_ID, 'VP 排名', { tdoc: 'tdoc', groups: 'groups' }, {
            async display({ tdoc, groups }) {
                if (!ContestModel.canShowScoreboard.call(this, tdoc, true)) throw new ForbiddenError('Scoreboard hidden');
                if (!isContestEnded(tdoc) && !this.user.own(tdoc)) this.checkPerm(PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD);
                await renderVpScoreboard(this, tdoc, groups);
            },
            supportedRules: ['*'],
        });
    });

    ctx.i18n.load('zh', {
        contest_vp: 'VP 虚拟参赛',
        'VP Standings': 'VP 排名',
        'VP Ranking': 'VP 排名',
    });
    ctx.i18n.load('en', {
        contest_vp: 'Virtual Participation',
        'VP Standings': 'VP Standings',
        'VP Ranking': 'VP Ranking',
    });

    global.Hydro ||= {};
    global.Hydro.model ||= {};
    global.Hydro.model.contestVpMode = {
        isVpOngoing,
        isVpEnded,
        vpEndAt,
        contestLengthMs,
    };
}

module.exports = { apply };
