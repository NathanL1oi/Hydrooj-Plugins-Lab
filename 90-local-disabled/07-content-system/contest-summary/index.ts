import {
    ContestModel,
    Context,
    db,
    ForbiddenError,
    Handler,
    NotFoundError,
    ObjectId,
    param,
    PERM,
    PRIV,
    SettingModel,
    Types,
    UserModel,
    ValidationError,
} from 'hydrooj';
import { ContestDetailBaseHandler } from 'hydrooj/src/handler/contest';

declare const process: any;

interface ContestSummaryConfig {
    _id?: ObjectId;
    domainId: string;
    tid: ObjectId;
    enabled: boolean;
    title: string;
    prompt: string;
    deadline: Date | null;
    allowEdit: boolean;
    minWords: number;
    evaluationProblemId?: string;
    referenceText?: string;
    referenceSummary?: string;
    createdBy?: number;
    createdAt: Date;
    updatedAt: Date;
}

interface ContestSummarySubmit {
    _id: ObjectId;
    domainId: string;
    tid: ObjectId;
    uid: number;
    title: string;
    content: string;
    wordCount: number;
    hidden: boolean;
    excellent: boolean;
    teacherComment: string;
    evaluationProblemId?: string;
    evaluationId?: string;
    evaluationStatus?: string;
    evaluationScore?: number | null;
    evaluationResult?: any;
    evaluationError?: string;
    evaluationUpdatedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
    reviewedBy?: number;
    reviewedAt?: Date;
}

const collConfig = db.collection('domain.contest.summaryConfig' as any);
const collSubmit = db.collection('domain.contest.summarySubmit' as any);
const EVALUATION_ACTIVE_STATUSES = new Set(['pending', 'running']);
const EVALUATION_RETRY_STATUSES = new Set(['failed', 'failed_to_submit']);
let pluginContext: any = null;

function idText(value: any) {
    return value?.toHexString?.() || value?.toString?.() || String(value || '');
}

function contestId(tdoc: any) {
    return tdoc?.docId || tdoc?._id;
}

function sameId(a: any, b: any) {
    return idText(a) === idText(b);
}

function compactText(value: any) {
    return String(value || '').trim();
}

function summaryDisplayName(user: any) {
    return compactText(user?.displayName) || compactText(user?.uname) || (user?._id ? `U${user._id}` : '同学');
}

function defaultSubmitTitle(tdoc: any, user: any) {
    const contestTitle = compactText(tdoc?.title) || '比赛';
    return `${contestTitle} ${summaryDisplayName(user)}总结`;
}

function countWords(content: string) {
    const visible = String(content || '')
        .replace(/```([\s\S]*?)```/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/!\[[^\]]*]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
        .replace(/<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s[^<>]*)?>/g, ' ')
        .replace(/^#{1,6}\s*/gm, '')
        .replace(/^>\s?/gm, '')
        .replace(/^\s*[-*+]\s+/gm, '')
        .replace(/^\s*\d+[.)]\s+/gm, '')
        .replace(/[*_~`#>|[\]{}()\\]/g, '');
    return Array.from(visible.replace(/\s+/g, '')).length;
}

function parseDeadline(value = '') {
    const text = String(value || '').trim();
    if (!text) return null;
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) throw new ValidationError('deadline', value, 'Invalid deadline');
    return date;
}

function toDatetimeLocal(date?: Date | null) {
    if (!date) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function escapeRegExp(value: string) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function withQuery(base: string, query: Record<string, any>) {
    const pairs = Object.entries(query)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(idText(value))}`);
    if (!pairs.length) return base;
    return `${base}${base.includes('?') ? '&' : '?'}${pairs.join('&')}`;
}

function hasViewHiddenContest(handler: any) {
    const perm = (PERM as any).PERM_VIEW_HIDDEN_CONTEST;
    return !!(
        (perm && handler.user?.hasPerm?.(perm))
        || handler.user?.hasPerm?.(PERM.PERM_EDIT_CONTEST)
        || handler.user?.hasPerm?.(PERM.PERM_EDIT_DOMAIN)
    );
}

function isContestOwnerOrMaintainer(handler: any, tdoc: any) {
    const uid = handler.user?._id;
    if (!uid || !tdoc) return false;
    if (sameId(tdoc.owner, uid)) return true;
    const maintainers = Array.isArray(tdoc.maintainer) ? tdoc.maintainer : [tdoc.maintainer];
    return maintainers.some((id) => sameId(id, uid));
}

function canManageContest(handler: any, tdoc: any) {
    return !!(
        handler.user?.own?.(tdoc)
        || isContestOwnerOrMaintainer(handler, tdoc)
        || handler.user?.hasPerm?.(PERM.PERM_EDIT_CONTEST)
        || handler.user?.hasPerm?.(PERM.PERM_EDIT_DOMAIN)
    );
}

function isContestSummaryTarget(tdoc: any) {
    return !!tdoc && String(tdoc.rule || '').toLowerCase() !== 'homework';
}

function shouldShowContestSummaryEntry(handler: any) {
    return !handler.tdoc || isContestSummaryTarget(handler.tdoc);
}

function visibleContestRuleQuery() {
    const rules = (ContestModel as any).RULES || {};
    const visibleRules = Object.keys(rules).filter((rule) => !rules[rule]?.hidden && rule !== 'homework');
    return visibleRules.length ? { $in: visibleRules } : { $ne: 'homework' };
}

async function userContestGroupNames(handler: any, domainId: string) {
    if (!handler.__contestSummaryGroupNames) {
        const uid = handler.user?._id || 0;
        handler.__contestSummaryGroupNames = UserModel.listGroup(domainId, uid)
            .then((groups: any[]) => groups.map((item) => item.name).filter(Boolean));
    }
    return handler.__contestSummaryGroupNames as Promise<string[]>;
}

async function contestListMongoQuery(handler: any, domainId: string) {
    const query: any = {
        rule: visibleContestRuleQuery(),
        deleted: { $ne: true },
    };
    if (!hasViewHiddenContest(handler)) {
        const uid = handler.user?._id || 0;
        const groups = await userContestGroupNames(handler, domainId);
        query.$or = [
            { maintainer: uid },
            { owner: uid },
            { assign: { $in: groups } },
            { assign: { $size: 0 } },
        ];
    }
    await handler.ctx?.parallel?.('contest/list', query, handler);
    return query;
}

function intersects(a: any[], b: any[]) {
    const set = new Set(b);
    return a.some((item) => set.has(item));
}

async function contestVisibleToUser(handler: any, domainId: string, tdoc: any) {
    if (!tdoc) return false;
    if (!isContestSummaryTarget(tdoc)) return false;
    if (tdoc.deleted) return false;
    if (canManageContest(handler, tdoc)) return true;
    if (!handler.user?.hasPerm?.(PERM.PERM_VIEW_CONTEST)) return false;
    if (hasViewHiddenContest(handler)) return true;
    const assign = Array.isArray(tdoc.assign) ? tdoc.assign : [];
    if (!assign.length) return true;
    const groups = await userContestGroupNames(handler, domainId);
    return intersects(assign, groups);
}

async function assertContestVisible(handler: any, domainId: string, tdoc: any) {
    if (!await contestVisibleToUser(handler, domainId, tdoc)) throw new ForbiddenError('Cannot view this contest summary.');
}

async function listVisibleContests(handler: any, domainId: string, selectedTid?: ObjectId | null, limit = 500) {
    const query = await contestListMongoQuery(handler, domainId);
    const docs = await ContestModel.getMulti(domainId, query)
        .sort({ endAt: -1, beginAt: -1, _id: -1 })
        .limit(limit)
        .toArray();
    if (selectedTid && !docs.some((tdoc: any) => sameId(contestId(tdoc), selectedTid))) {
        try {
            const selected = await ContestModel.get(domainId, selectedTid);
            if (selected) docs.unshift(selected);
        } catch (e) {
            // The selected contest may have been deleted. The caller will raise the final error.
        }
    }
    const seen = new Set<string>();
    const contests: any[] = [];
    for (const tdoc of docs) {
        const id = idText(contestId(tdoc));
        if (!id || seen.has(id) || !await contestVisibleToUser(handler, domainId, tdoc)) continue;
        seen.add(id);
        contests.push(tdoc);
    }
    return contests;
}

async function loadContestDict(domainId: string, tids: any[]) {
    const ids = Array.from(new Map(tids.filter(Boolean).map((tid) => [idText(tid), tid])).values());
    const dict: Record<string, any> = {};
    if (!ids.length) return dict;
    const docs = await ContestModel.getMulti(domainId, { docId: { $in: ids } }).toArray();
    for (const tdoc of docs) dict[idText(contestId(tdoc))] = tdoc;
    for (const tid of ids) {
        const key = idText(tid);
        if (dict[key]) continue;
        try {
            const tdoc = await ContestModel.get(domainId, tid);
            if (tdoc) dict[key] = tdoc;
        } catch (e) {
            // Keep missing contest empty. The view will show a fallback title.
        }
    }
    return dict;
}

function defaultConfig(domainId: string, tid: ObjectId, tdoc: any, uid?: number): ContestSummaryConfig {
    const now = new Date();
    const title = tdoc?.title ? `${tdoc.title} 赛后总结` : '比赛赛后总结';
    return {
        domainId,
        tid,
        enabled: true,
        title,
        prompt: [
            '请围绕本场比赛写一份赛后总结，可以包含：',
            '',
            '- 本场比赛的整体策略与时间分配',
            '- 关键题目的思路、卡点与修正过程',
            '- 赛后补题计划和下一步训练重点',
        ].join('\n'),
        deadline: null,
        allowEdit: true,
        minWords: 100,
        evaluationProblemId: '',
        referenceText: '',
        referenceSummary: '',
        createdBy: uid,
        createdAt: now,
        updatedAt: now,
    };
}

async function getConfig(domainId: string, tid: ObjectId, tdoc?: any) {
    const config = await collConfig.findOne({ domainId, tid }) as ContestSummaryConfig | null;
    return config || defaultConfig(domainId, tid, tdoc, undefined);
}

async function ensureConfig(domainId: string, tid: ObjectId, tdoc: any, uid: number) {
    const config = await getConfig(domainId, tid, tdoc);
    if (config._id) return config;
    await collConfig.updateOne(
        { domainId, tid },
        { $setOnInsert: defaultConfig(domainId, tid, tdoc, uid) },
        { upsert: true },
    );
    return await collConfig.findOne({ domainId, tid }) as ContestSummaryConfig;
}

function canWriteSummary(config: ContestSummaryConfig, submit?: ContestSummarySubmit | null) {
    if (!config.enabled) return false;
    if (config.deadline && config.deadline.getTime() < Date.now()) return false;
    if (submit && !config.allowEdit) return false;
    return true;
}

function evaluationProblemId(config: ContestSummaryConfig) {
    const custom = String(config.evaluationProblemId || '').trim();
    return custom || `contest-summary:${config.domainId}:${idText(config.tid)}`;
}

function getEvaluationConfig() {
    const env = typeof process !== 'undefined' ? process.env || {} : {};
    const setting = pluginContext?.setting;
    const baseUrl = String(
        setting?.get('SummaryEvaluation.serverUrl')
        || env.SUMMARY_EVALUATION_SERVER_URL
        || env.EVALUATION_SERVER_URL
        || '',
    ).replace(/\/+$/, '');
    const apiKey = String(
        setting?.get('SummaryEvaluation.apiKey')
        || env.SUMMARY_EVALUATION_API_KEY
        || env.EVALUATION_SERVER_API_KEY
        || '',
    );
    const timeoutMs = Math.max(1000, Number(
        setting?.get('SummaryEvaluation.timeoutMs')
        || env.SUMMARY_EVALUATION_TIMEOUT_MS
        || env.EVALUATION_SERVER_TIMEOUT_MS
        || 8000,
    ) || 8000);
    return { enabled: !!(baseUrl && apiKey), baseUrl, apiKey, timeoutMs };
}

function defaultReferenceText(tdoc: any, config: ContestSummaryConfig) {
    const parts = [
        tdoc?.title ? `比赛：${tdoc.title}` : '',
        tdoc?.rule ? `规则：${tdoc.rule}` : '',
        tdoc?.beginAt ? `开始时间：${tdoc.beginAt}` : '',
        tdoc?.endAt ? `结束时间：${tdoc.endAt}` : '',
        tdoc?.content ? `比赛说明：\n${tdoc.content}` : '',
        config.prompt ? `总结要求：\n${config.prompt}` : '',
    ].map(compactText).filter(Boolean);
    return parts.join('\n\n');
}

function compatEvaluationRubric() {
    return [
        {
            name: '比赛复盘质量',
            weight: 100,
            criteria: 'evaluation-server 会根据 evaluation_type=1 使用服务端内置的比赛总结维度评分。',
        },
    ];
}

function evaluationTaskPayload(config: ContestSummaryConfig, tdoc: any) {
    const sourceText = compactText(config.referenceText) || defaultReferenceText(tdoc, config);
    return {
        title: config.title || tdoc?.title || idText(config.tid),
        evaluation_type: 1,
        assignment_prompt: config.prompt || '请写一份比赛赛后总结。',
        source_text: sourceText,
        reference_materials: [
            {
                title: tdoc?.title || config.title || '比赛资料',
                content: sourceText,
            },
        ],
        reference_summary: compactText(config.referenceSummary) || config.prompt || sourceText,
        rubric: compatEvaluationRubric(),
        model_config: null,
    };
}

async function evaluationRequest(path: string, init: any = {}) {
    const config = getEvaluationConfig();
    if (!config.enabled) return null;
    const fetchImpl = (globalThis as any).fetch;
    if (typeof fetchImpl !== 'function') throw new Error('global fetch is not available');
    const headers = {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
    };
    const AbortControllerImpl = (globalThis as any).AbortController;
    const controller = typeof AbortControllerImpl === 'function' ? new AbortControllerImpl() : null;
    const timer = controller ? setTimeout(() => controller.abort(), config.timeoutMs) : null;
    let res: any;
    let text = '';
    try {
        res = await fetchImpl(`${config.baseUrl}${path}`, { ...init, headers, signal: controller?.signal || init.signal });
        text = await res.text();
    } finally {
        if (timer) clearTimeout(timer);
    }
    let data: any = null;
    if (text) {
        try {
            data = JSON.parse(text);
        } catch (e) {
            data = { raw: text };
        }
    }
    if (!res.ok) {
        const detail = data?.detail || data?.error || text || `${res.status} ${res.statusText}`;
        throw new Error(`evaluation server ${res.status}: ${detail}`);
    }
    return data;
}

async function createSummaryEvaluation(config: ContestSummaryConfig, submit: ContestSummarySubmit, tdoc: any) {
    const evaluationConfig = getEvaluationConfig();
    if (!evaluationConfig.enabled) return false;
    const problemId = evaluationProblemId(config);
    try {
        await evaluationRequest(`/api/tasks/${encodeURIComponent(problemId)}`, {
            method: 'PUT',
            body: JSON.stringify(evaluationTaskPayload(config, tdoc)),
        });
        const data = await evaluationRequest('/api/evaluations', {
            method: 'POST',
            body: JSON.stringify({
                problem_id: problemId,
                submission_id: idText(submit._id),
                student_id: String(submit.uid),
                student_answer: `${submit.title}\n\n${submit.content}`,
            }),
        });
        await collSubmit.updateOne(
            { domainId: submit.domainId, _id: submit._id },
            {
                $set: {
                    evaluationProblemId: problemId,
                    evaluationId: data?.evaluation_id || '',
                    evaluationStatus: data?.status || 'pending',
                    evaluationScore: null,
                    evaluationResult: null,
                    evaluationError: '',
                    evaluationUpdatedAt: new Date(),
                },
            },
        );
        return true;
    } catch (e) {
        await collSubmit.updateOne(
            { domainId: submit.domainId, _id: submit._id },
            {
                $set: {
                    evaluationProblemId: problemId,
                    evaluationStatus: 'failed_to_submit',
                    evaluationError: e?.message || String(e),
                    evaluationUpdatedAt: new Date(),
                },
            },
        );
        return false;
    }
}

async function refreshSummaryEvaluation(submit: ContestSummarySubmit) {
    if (!submit.evaluationId) throw new ValidationError('evaluationId', null, 'No evaluation has been created for this summary.');
    const data = await evaluationRequest(`/api/evaluations/${encodeURIComponent(submit.evaluationId)}`, { method: 'GET' });
    if (!data) throw new ValidationError('evaluation', null, 'AI evaluation is disabled.');
    await collSubmit.updateOne(
        { domainId: submit.domainId, _id: submit._id },
        {
            $set: {
                evaluationProblemId: data.problem_id || submit.evaluationProblemId || '',
                evaluationStatus: data.status || '',
                evaluationScore: data.score ?? data.result?.summary?.score ?? null,
                evaluationResult: data.result || null,
                evaluationError: data.error_message || '',
                evaluationUpdatedAt: new Date(),
            },
        },
    );
}

function shouldRefreshEvaluation(submit?: ContestSummarySubmit | null) {
    if (!submit?.evaluationId) return false;
    return EVALUATION_ACTIVE_STATUSES.has(String(submit.evaluationStatus || '').toLowerCase());
}

async function refreshEvaluationQuietly(submit?: ContestSummarySubmit | null) {
    if (!submit || !shouldRefreshEvaluation(submit)) return;
    try {
        await refreshSummaryEvaluation(submit);
    } catch (e) {
        // Keep page rendering even if the external evaluator is temporarily unavailable.
    }
}

function evaluationStatusText(status = '') {
    return ({
        pending: '等待评测',
        running: '正在评测',
        succeeded: '评测完成',
        failed: '评测失败',
        failed_to_submit: '提交评测失败',
    } as Record<string, string>)[String(status || '').toLowerCase()] || status || '未创建';
}

function submitSummaryText(content = '') {
    return compactText(content).replace(/\s+/g, ' ').slice(0, 220);
}

function submitForView(handler: any, submit: ContestSummarySubmit, tdoc: any, config?: ContestSummaryConfig | null) {
    const tid = idText(submit.tid);
    const canManage = canManageContest(handler, tdoc);
    const owned = handler.user?._id === submit.uid;
    return {
        ...submit,
        tidText: tid,
        contestTitle: tdoc?.title || `比赛 ${tid}`,
        contestUrl: handler.url('contest_detail', { tid: submit.tid }),
        detailUrl: handler.url('contest_summary_detail', { sid: submit._id }),
        editUrl: withQuery(handler.url('contest_summary_write'), { tid }),
        listUrl: withQuery(handler.url('contest_summary'), { tid }),
        evaluationStatusText: evaluationStatusText(submit.evaluationStatus),
        summaryText: submitSummaryText(submit.content),
        canManage,
        canEdit: owned && (!config || canWriteSummary(config, submit)),
        canRetryEvaluation: canManage && EVALUATION_RETRY_STATUSES.has(String(submit.evaluationStatus || '').toLowerCase()),
        isOwner: owned,
    };
}

async function retrySummaryEvaluation(handler: any, domainId: string, sid: ObjectId) {
    const submit = await collSubmit.findOne({ domainId, _id: sid }) as ContestSummarySubmit | null;
    if (!submit) throw new NotFoundError('contest summary not found');
    const tdoc = await ContestModel.get(domainId, submit.tid);
    await assertContestVisible(handler, domainId, tdoc);
    if (!canManageContest(handler, tdoc)) throw new ForbiddenError('Cannot retry this summary evaluation.');
    if (!EVALUATION_RETRY_STATUSES.has(String(submit.evaluationStatus || '').toLowerCase())) {
        throw new ValidationError('evaluationStatus', submit.evaluationStatus, 'Only failed evaluations can be retried.');
    }
    if (!getEvaluationConfig().enabled) {
        throw new ValidationError('evaluation', null, 'AI evaluation is disabled.');
    }
    const config = await getConfig(domainId, submit.tid, tdoc);
    await createSummaryEvaluation(config, submit, tdoc);
}

async function buildSubmitRows(handler: any, domainId: string, submits: ContestSummarySubmit[], configMap?: Record<string, ContestSummaryConfig>) {
    const tdict = await loadContestDict(domainId, submits.map((item) => item.tid));
    const rows = [];
    for (const submit of submits) {
        const tdoc = tdict[idText(submit.tid)];
        if (!await contestVisibleToUser(handler, domainId, tdoc)) continue;
        if (submit.hidden && !canManageContest(handler, tdoc) && handler.user?._id !== submit.uid) continue;
        rows.push(submitForView(handler, submit, tdoc, configMap?.[idText(submit.tid)]));
    }
    const udict = await UserModel.getList(domainId, Array.from(new Set(rows.map((item) => item.uid))));
    return { rows, tdict, udict };
}

class ContestSummaryEntryHandler extends ContestDetailBaseHandler {
    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: ObjectId) {
        this.response.redirect = withQuery(this.url('contest_summary'), { tid });
    }
}

class ContestSummaryMainHandler extends Handler {
    @param('page', Types.PositiveInt, true)
    @param('tid', Types.ObjectId, true)
    @param('q', Types.String, true)
    @param('excellent', Types.Boolean, true)
    @param('sort', Types.String, true)
    async get({ domainId }: any, page = 1, tid?: ObjectId, q = '', excellent = false, sort = 'updated') {
        let selectedContest: any = null;
        if (tid) {
            selectedContest = await ContestModel.get(domainId, tid);
            await assertContestVisible(this, domainId, selectedContest);
        }
        const contests = await listVisibleContests(this, domainId, tid);
        const visibleTids = contests.map((tdoc: any) => contestId(tdoc)).filter(Boolean);
        const query: any = { domainId };
        if (tid) query.tid = tid;
        else query.tid = { $in: visibleTids };
        const canManageSelected = selectedContest ? canManageContest(this, selectedContest) : this.user?.hasPerm?.(PERM.PERM_EDIT_CONTEST);
        if (!canManageSelected) query.hidden = { $ne: true };
        if (excellent) query.excellent = true;
        const keyword = compactText(q);
        if (keyword) {
            const regex = new RegExp(escapeRegExp(keyword), 'i');
            query.$or = [{ title: regex }, { content: regex }, { teacherComment: regex }];
        }
        const sorter: any = sort === 'score'
            ? { evaluationScore: -1, updatedAt: -1 }
            : sort === 'created'
                ? { createdAt: -1 }
                : { updatedAt: -1 };
        const [submits, pcount] = await this.paginate(
            collSubmit.find(query).sort(sorter),
            page,
            (this.ctx as any).setting.get('pagination.contest_summary') || 20,
        ) as any as [ContestSummarySubmit[], number];
        const selectedConfig = selectedContest ? await getConfig(domainId, tid, selectedContest) : null;
        const configMap: Record<string, ContestSummaryConfig> = {};
        if (selectedConfig) configMap[idText(tid)] = selectedConfig;
        const { rows, udict } = await buildSubmitRows(this, domainId, submits, configMap);
        const selectedTid = tid ? idText(tid) : '';
        this.response.template = 'contest_summary.html';
        this.response.body = {
            page_name: 'contest_summary',
            contests: contests.map((tdoc: any) => ({ id: idText(contestId(tdoc)), title: tdoc.title || idText(contestId(tdoc)) })),
            selectedTid,
            selectedContest,
            selectedConfig,
            canManageSelected: !!canManageSelected,
            rows,
            udict,
            page,
            pcount,
            q,
            excellent: !!excellent,
            sort,
            listUrl: this.url('contest_summary'),
            writeUrl: withQuery(this.url('contest_summary_write'), { tid: selectedTid }),
            settingsUrl: selectedTid ? withQuery(this.url('contest_summary_settings'), { tid: selectedTid }) : '',
            queryBase: [
                selectedTid ? `tid=${encodeURIComponent(selectedTid)}` : '',
                q ? `q=${encodeURIComponent(q)}` : '',
                excellent ? 'excellent=true' : '',
                sort ? `sort=${encodeURIComponent(sort)}` : '',
            ].filter(Boolean).join('&'),
        };
    }
}

class ContestSummaryWriteHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }

    @param('tid', Types.ObjectId, true)
    async get({ domainId }: any, tid?: ObjectId) {
        let selectedContest: any = null;
        let config: ContestSummaryConfig | null = null;
        let submit: ContestSummarySubmit | null = null;
        if (tid) {
            selectedContest = await ContestModel.get(domainId, tid);
            await assertContestVisible(this, domainId, selectedContest);
            config = await getConfig(domainId, tid, selectedContest);
            submit = await collSubmit.findOne({ domainId, tid, uid: this.user._id }) as ContestSummarySubmit | null;
        }
        const contests = await listVisibleContests(this, domainId, tid);
        const contestOptions = contests.map((tdoc: any) => ({
            id: idText(contestId(tdoc)),
            title: tdoc.title || idText(contestId(tdoc)),
            defaultTitle: defaultSubmitTitle(tdoc, this.user),
        }));
        const defaultTitle = selectedContest ? defaultSubmitTitle(selectedContest, this.user) : '';
        this.response.template = 'contest_summary_edit.html';
        this.response.body = {
            page_name: 'contest_summary_write',
            contests: contestOptions,
            selectedTid: tid ? idText(tid) : '',
            selectedContest,
            config,
            submit,
            defaultTitle,
            canSubmit: config ? canWriteSummary(config, submit) : true,
            deadlineText: config?.deadline ? toDatetimeLocal(config.deadline) : '',
            listUrl: withQuery(this.url('contest_summary'), { tid }),
        };
    }

    @param('tid', Types.ObjectId)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async post({ domainId }: any, tid: ObjectId, title: string, content: string) {
        const tdoc = await ContestModel.get(domainId, tid);
        await assertContestVisible(this, domainId, tdoc);
        const config = await ensureConfig(domainId, tid, tdoc, this.user._id);
        const existing = await collSubmit.findOne({ domainId, tid, uid: this.user._id }) as ContestSummarySubmit | null;
        if (!config.enabled) throw new ForbiddenError('This contest summary is not open.');
        if (config.deadline && config.deadline.getTime() < Date.now() && !canManageContest(this, tdoc)) {
            throw new ValidationError('deadline', config.deadline, 'Contest summary deadline has passed.');
        }
        if (existing && !config.allowEdit && !canManageContest(this, tdoc)) {
            throw new ForbiddenError('This contest summary cannot be edited after submission.');
        }
        const wordCount = countWords(content);
        if (wordCount < Math.max(0, Number(config.minWords) || 0)) {
            throw new ValidationError('content', wordCount, `总结字数不足，至少需要 ${config.minWords} 字。`);
        }
        const now = new Date();
        await collSubmit.updateOne(
            { domainId, tid, uid: this.user._id },
            {
                $setOnInsert: {
                    domainId,
                    tid,
                    uid: this.user._id,
                    hidden: false,
                    excellent: false,
                    teacherComment: '',
                    createdAt: now,
                },
                $set: {
                    title: compactText(title) || defaultSubmitTitle(tdoc, this.user),
                    content,
                    wordCount,
                    updatedAt: now,
                },
            },
            { upsert: true },
        );
        const submit = await collSubmit.findOne({ domainId, tid, uid: this.user._id }) as ContestSummarySubmit;
        await createSummaryEvaluation(config, submit, tdoc);
        this.response.redirect = this.url('contest_summary_detail', { sid: submit._id });
    }
}

class ContestSummaryDetailHandler extends Handler {
    @param('sid', Types.ObjectId)
    async get({ domainId }: any, sid: ObjectId) {
        let submit = await collSubmit.findOne({ domainId, _id: sid }) as ContestSummarySubmit | null;
        if (!submit) throw new NotFoundError('contest summary not found');
        const tdoc = await ContestModel.get(domainId, submit.tid);
        await assertContestVisible(this, domainId, tdoc);
        const canManage = canManageContest(this, tdoc);
        if (submit.hidden && !canManage && this.user?._id !== submit.uid) throw new ForbiddenError('This summary is hidden.');
        await refreshEvaluationQuietly(submit);
        submit = await collSubmit.findOne({ domainId, _id: sid }) as ContestSummarySubmit;
        const config = await getConfig(domainId, submit.tid, tdoc);
        const udict = await UserModel.getList(domainId, [submit.uid]);
        this.response.template = 'contest_summary_detail.html';
        this.response.body = {
            page_name: 'contest_summary_detail',
            submit: submitForView(this, submit, tdoc, config),
            tdoc,
            config,
            udoc: udict[submit.uid],
            canManage,
            listUrl: withQuery(this.url('contest_summary'), { tid: submit.tid }),
            writeUrl: withQuery(this.url('contest_summary_write'), { tid: submit.tid }),
            settingsUrl: withQuery(this.url('contest_summary_settings'), { tid: submit.tid }),
            retryEvaluationUrl: this.url('contest_summary_retry_evaluation', { sid }),
        };
    }

    @param('sid', Types.ObjectId)
    @param('operation', Types.String)
    @param('hidden', Types.Boolean, true)
    @param('excellent', Types.Boolean, true)
    @param('teacherComment', Types.Content, true)
    async post({ domainId }: any, sid: ObjectId, operation: string, hidden = false, excellent = false, teacherComment = '') {
        const submit = await collSubmit.findOne({ domainId, _id: sid }) as ContestSummarySubmit | null;
        if (!submit) throw new NotFoundError('contest summary not found');
        const tdoc = await ContestModel.get(domainId, submit.tid);
        await assertContestVisible(this, domainId, tdoc);
        const canManage = canManageContest(this, tdoc);
        const owned = this.user?._id === submit.uid;
        if (operation === 'review') {
            if (!canManage) throw new ForbiddenError('Cannot review this summary.');
            await collSubmit.updateOne(
                { domainId, _id: sid },
                {
                    $set: {
                        hidden: !!hidden,
                        excellent: !!excellent,
                        teacherComment: teacherComment || '',
                        reviewedBy: this.user._id,
                        reviewedAt: new Date(),
                    },
                },
            );
        } else if (operation === 'delete') {
            if (!owned && !canManage) throw new ForbiddenError('Cannot delete this summary.');
            await collSubmit.deleteOne({ domainId, _id: sid });
            this.response.redirect = withQuery(this.url('contest_summary'), { tid: submit.tid });
            return;
        }
        this.response.redirect = this.url('contest_summary_detail', { sid });
    }
}

class ContestSummaryEvaluationRetryHandler extends Handler {
    @param('sid', Types.ObjectId)
    async post({ domainId }: any, sid: ObjectId) {
        await retrySummaryEvaluation(this, domainId, sid);
        this.response.redirect = this.url('contest_summary_detail', { sid });
    }
}

class ContestSummarySettingsHandler extends Handler {
    @param('tid', Types.ObjectId)
    async get({ domainId }: any, tid: ObjectId) {
        const tdoc = await ContestModel.get(domainId, tid);
        if (!isContestSummaryTarget(tdoc)) throw new ForbiddenError('Cannot manage this contest summary.');
        if (!canManageContest(this, tdoc)) throw new ForbiddenError('Cannot manage this contest summary.');
        const config = await getConfig(domainId, tid, tdoc);
        this.response.template = 'contest_summary_settings.html';
        this.response.body = {
            page_name: 'contest_summary_settings',
            tdoc,
            config,
            tidText: idText(tid),
            deadlineText: toDatetimeLocal(config.deadline),
            listUrl: withQuery(this.url('contest_summary'), { tid }),
            writeUrl: withQuery(this.url('contest_summary_write'), { tid }),
        };
    }

    @param('tid', Types.ObjectId)
    @param('enabled', Types.Boolean, true)
    @param('title', Types.Title)
    @param('prompt', Types.Content, true)
    @param('deadline', Types.String, true)
    @param('allowEdit', Types.Boolean, true)
    @param('minWords', Types.Int, true)
    @param('evaluationProblemId', Types.String, true)
    @param('referenceText', Types.Content, true)
    @param('referenceSummary', Types.Content, true)
    async post(
        { domainId }: any,
        tid: ObjectId,
        enabled = false,
        title: string,
        prompt = '',
        deadline = '',
        allowEdit = false,
        minWords = 0,
        evaluationProblemId = '',
        referenceText = '',
        referenceSummary = '',
    ) {
        const tdoc = await ContestModel.get(domainId, tid);
        if (!isContestSummaryTarget(tdoc)) throw new ForbiddenError('Cannot manage this contest summary.');
        if (!canManageContest(this, tdoc)) throw new ForbiddenError('Cannot manage this contest summary.');
        const now = new Date();
        await collConfig.updateOne(
            { domainId, tid },
            {
                $setOnInsert: {
                    domainId,
                    tid,
                    createdBy: this.user._id,
                    createdAt: now,
                },
                $set: {
                    enabled: !!enabled,
                    title: title || `${tdoc.title || '比赛'} 赛后总结`,
                    prompt: prompt || defaultConfig(domainId, tid, tdoc, this.user._id).prompt,
                    deadline: parseDeadline(deadline),
                    allowEdit: !!allowEdit,
                    minWords: Math.max(0, Number(minWords) || 0),
                    evaluationProblemId: compactText(evaluationProblemId),
                    referenceText: compactText(referenceText),
                    referenceSummary: compactText(referenceSummary),
                    updatedAt: now,
                },
            },
            { upsert: true },
        );
        this.response.redirect = withQuery(this.url('contest_summary_settings'), { tid });
    }
}

export const description = '比赛赛后总结';

export async function apply(ctx: Context) {
    const app = ctx as any;
    pluginContext = app;
    await db.ensureIndexes(
        collConfig,
        { key: { domainId: 1, tid: 1 }, name: 'contest_summary_config_tid', unique: true },
    );
    await db.ensureIndexes(
        collSubmit,
        { key: { domainId: 1, tid: 1, uid: 1 }, name: 'contest_summary_submit_user', unique: true },
        { key: { domainId: 1, tid: 1, updatedAt: -1 }, name: 'contest_summary_submit_tid_time' },
        { key: { domainId: 1, uid: 1, updatedAt: -1 }, name: 'contest_summary_submit_uid_time' },
        { key: { domainId: 1, excellent: 1, updatedAt: -1 }, name: 'contest_summary_submit_excellent' },
    );

    app.Route('contest_summary', '/contest-summary', ContestSummaryMainHandler, PERM.PERM_VIEW_CONTEST);
    app.Route('contest_summary_entry', '/contest/:tid/summary', ContestSummaryEntryHandler, PERM.PERM_VIEW_CONTEST);
    app.Route('contest_summary_write', '/contest-summary/write', ContestSummaryWriteHandler, PRIV.PRIV_USER_PROFILE);
    app.Route('contest_summary_detail', '/contest-summary/detail/:sid', ContestSummaryDetailHandler, PERM.PERM_VIEW_CONTEST);
    app.Route('contest_summary_retry_evaluation', '/contest-summary/detail/:sid/retry-evaluation', ContestSummaryEvaluationRetryHandler, PERM.PERM_VIEW_CONTEST);
    app.Route('contest_summary_settings', '/contest-summary/settings', ContestSummarySettingsHandler, PERM.PERM_VIEW_CONTEST);

    app.inject(['setting'], (c) => {
        c.setting.SystemSetting(SettingModel.Setting('setting_limit', 'pagination.contest_summary', 20, 'number', '每页比赛总结数量'));
    });

    app.injectUI('ContestDetail', 'contest_summary_entry', (handler: any) => ({
        icon: 'edit',
        displayName: '赛后总结',
        args: { tid: handler.args?.tid || handler.tdoc?.docId || handler.tdoc?._id || '' },
    }), shouldShowContestSummaryEntry);

    app.on('handler/after/ContestDetail#get', async (handler: any) => {
        if (!shouldShowContestSummaryEntry(handler)) return;
        const tid = handler.args?.tid || handler.tdoc?.docId || handler.tdoc?._id;
        if (!tid) return;
        handler.UiContext ||= {};
        handler.UiContext.contestSummaryEntry = {
            url: handler.url('contest_summary_entry', { tid }),
            title: '赛后总结',
        };
    });

    app.on('contest/del', async (domainId: string, tid: ObjectId) => {
        await Promise.all([
            collConfig.deleteMany({ domainId, tid }),
            collSubmit.deleteMany({ domainId, tid }),
        ]);
    });

    app.i18n.load('zh', {
        contest_summary: '比赛总结',
        contest_summary_entry: '赛后总结',
        contest_summary_write: '写比赛总结',
        contest_summary_detail: '比赛总结详情',
        contest_summary_settings: '比赛总结设置',
    });
    app.i18n.load('en', {
        contest_summary: 'Contest Summary',
        contest_summary_entry: 'Contest Summary',
        contest_summary_write: 'Write Contest Summary',
        contest_summary_detail: 'Contest Summary Detail',
        contest_summary_settings: 'Contest Summary Settings',
    });
}
