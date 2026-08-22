import {
    BadRequestError,
    ContestModel,
    Context,
    db,
    DomainModel,
    ForbiddenError,
    Handler,
    MessageModel,
    NotFoundError,
    ObjectId,
    param,
    PERM,
    PRIV,
    RecordModel,
    SettingModel,
    STATUS,
    Time,
    Types,
    UserModel,
    ValidationError,
} from 'hydrooj';

declare const process: any;

type TargetType = 'section' | 'subsec';
type SubmitStatus = 'submitted' | 'late';
type PointSourceType = 'summary' | 'manual' | 'contest' | 'recent_status' | 'adjustment';

interface SummaryTask {
    _id: ObjectId;
    domainId: string;
    courseId: ObjectId;
    sectionId: ObjectId;
    subsecId: ObjectId | null;
    targetType: TargetType;
    title: string;
    content: string;
    deadline: Date | null;
    allowLate: boolean;
    dailyReminder: boolean;
    reminderTime: string;
    minWords: number;
    defaultPoints: number;
    evaluationProblemId?: string;
    evaluationSourceText?: string;
    evaluationReferenceSummary?: string;
    evaluationRubricText?: string;
    createdBy: number;
    createdAt: Date;
    updatedAt: Date;
}

interface SummarySubmit {
    _id: ObjectId;
    domainId: string;
    taskId: ObjectId;
    uid: number;
    content: string;
    wordCount: number;
    status: SubmitStatus;
    excellent: boolean;
    comment: string;
    score: number | null;
    awardedPoints: number;
    createdAt: Date;
    updatedAt: Date;
    reviewedBy?: number;
    reviewedAt?: Date;
    evaluationProblemId?: string;
    evaluationId?: string;
    evaluationStatus?: string;
    evaluationScore?: number | null;
    evaluationResult?: any;
    evaluationError?: string;
    evaluationUpdatedAt?: Date;
}

const collTask = db.collection('domain.learning.summaryTask' as any);
const collSubmit = db.collection('domain.learning.summarySubmit' as any);
const collLedger = db.collection('domain.learning.pointLedger' as any);
const collPointSummary = db.collection('domain.learning.pointSummary' as any);
const collReminder = db.collection('domain.learning.reminderLog' as any);
const collGroup = db.collection('user.group' as any);
const DEFAULT_SUMMARY_TASK_TITLE = '##';
const DEFAULT_SUMMARY_TASK_CONTENT = '##';
const DEFAULT_SUMMARY_TASK_CREATED_BY = 1;
let pluginContext: Context | null = null;

function idText(value: any) {
    return value?.toHexString?.() || value?.toString?.() || String(value);
}

function getCourseModel() {
    const course = (globalThis as any).Hydro?.model?.course;
    if (!course) throw new NotFoundError('course model not found');
    return course;
}

function parseDeadline(value = '') {
    const text = value.trim();
    if (!text) return null;
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) throw new ValidationError('deadlineText', value, 'Invalid deadline');
    return date;
}

function toDatetimeLocal(date?: Date | null) {
    if (!date) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function defaultSummaryDeadline() {
    return new Date(2099, 11, 31, 23, 59, 0, 0);
}

function normalizeReminderTime(value = '') {
    const text = value.trim();
    if (/^\d{2}:\d{2}$/.test(text)) return text;
    return '20:00';
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

function csvCell(value: any) {
    if (value === undefined || value === null) return '';
    const text = value instanceof Date ? value.toISOString() : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows: any[][]) {
    return `\ufeff${rows.map((row) => row.map(csvCell).join(',')).join('\n')}`;
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

function compatEvaluationRubric() {
    return [
        {
            name: '服务端默认评分维度',
            weight: 100,
            criteria: 'evaluation-server 会使用服务端内置的算法总结评分维度；该字段仅用于兼容接口。',
        },
    ];
}

function defaultEvaluationProblemIdForTarget(domainId: string, courseId: ObjectId, sectionId: ObjectId, subsecId: ObjectId | null) {
    return `course-summary:${domainId}:${idText(courseId)}:${idText(sectionId)}${subsecId ? `:${idText(subsecId)}` : ''}`;
}

function compactText(value: any) {
    return String(value || '').trim();
}

function defaultEvaluationSourceText(cdoc: any, csdoc: any, ssdoc: any, task?: SummaryTask | null) {
    const parts = [
        cdoc?.title ? `课程：${cdoc.title}` : '',
        cdoc?.content ? `课程内容：\n${cdoc.content}` : '',
        csdoc?.title ? `章节：${csdoc.title}` : '',
        csdoc?.content ? `章节内容：\n${csdoc.content}` : '',
        ssdoc?.title ? `小节：${ssdoc.title}` : '',
        ssdoc?.content ? `小节内容：\n${ssdoc.content}` : '',
        task?.content ? `小结写作要求：\n${task.content}` : '',
    ].map(compactText).filter(Boolean);
    return parts.join('\n\n');
}

function defaultEvaluationReferenceSummary(task?: SummaryTask | null) {
    return compactText(task?.evaluationReferenceSummary) || compactText(task?.content);
}

function evaluationProblemId(task: SummaryTask) {
    const custom = String(task.evaluationProblemId || '').trim();
    return custom || defaultEvaluationProblemIdForTarget(task.domainId, task.courseId, task.sectionId, task.subsecId || null);
}

function evaluationTaskPayload(task: SummaryTask, targetTitle = '') {
    const prompt = task.content || task.title || '请评价学生课程小结。';
    const sourceText = String(task.evaluationSourceText || '').trim() || prompt;
    const referenceSummary = String(task.evaluationReferenceSummary || '').trim() || prompt;
    return {
        title: task.title || targetTitle || idText(task._id),
        assignment_prompt: prompt,
        source_text: sourceText,
        reference_materials: [
            {
                title: targetTitle || task.title || '课程小结任务',
                content: sourceText,
            },
        ],
        reference_summary: referenceSummary,
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

async function createSummaryEvaluation(task: SummaryTask, submit: SummarySubmit, targetTitle = '') {
    const config = getEvaluationConfig();
    if (!config.enabled) return false;
    const problemId = evaluationProblemId(task);
    try {
        await evaluationRequest(`/api/tasks/${encodeURIComponent(problemId)}`, {
            method: 'PUT',
            body: JSON.stringify(evaluationTaskPayload(task, targetTitle)),
        });
        const data = await evaluationRequest('/api/evaluations', {
            method: 'POST',
            body: JSON.stringify({
                problem_id: problemId,
                submission_id: idText(submit._id),
                student_id: String(submit.uid),
                student_answer: submit.content,
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

async function refreshSummaryEvaluation(submit: SummarySubmit) {
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

const EVALUATION_ACTIVE_STATUSES = new Set(['pending', 'running']);

function shouldRefreshEvaluation(submit?: SummarySubmit | null) {
    if (!submit?.evaluationId) return false;
    return EVALUATION_ACTIVE_STATUSES.has(String(submit.evaluationStatus || '').toLowerCase());
}

function evaluationStatusText(status = '') {
    return ({
        pending: '等待评测',
        running: '正在评测',
        succeeded: '评测完成',
        failed: '评测失败',
        failed_to_submit: '提交评测失败',
    } as Record<string, string>)[String(status || '').toLowerCase()] || status || '未知';
}

function evaluationSuggestionTypeText(type = '') {
    return ({
        replace: '替换',
        insert: '补充',
        delete: '删除',
    } as Record<string, string>)[String(type || '').toLowerCase()] || '修改';
}

function evaluationPriorityText(priority = '') {
    return ({
        high: '重点',
        medium: '建议',
        low: '可选',
    } as Record<string, string>)[String(priority || '').toLowerCase()] || '';
}

function evaluationResultForView(result: any) {
    if (!result) return null;
    return {
        ...result,
        suggestions: Array.isArray(result.suggestions)
            ? result.suggestions.map((item: any, index: number) => ({
                ...item,
                displayIndex: index + 1,
                typeText: evaluationSuggestionTypeText(item?.type),
                priorityText: evaluationPriorityText(item?.priority),
            }))
            : [],
    };
}

function escapeHtmlText(text = '') {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function htmlLineBreaks(text = '') {
    return escapeHtmlText(text).replace(/\n/g, '<br>');
}

function findNthIndex(text: string, needle: string, occurrence = 1) {
    const target = String(needle || '');
    if (!target) return -1;
    let from = 0;
    let found = -1;
    const count = Math.max(1, Number(occurrence) || 1);
    for (let i = 0; i < count; i++) {
        found = text.indexOf(target, from);
        if (found < 0) return -1;
        from = found + target.length;
    }
    return found;
}

function normalizeForMatch(text: string) {
    let normalized = '';
    const map: number[] = [];
    let pendingSpace = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (/\s/.test(ch)) {
            pendingSpace = true;
            continue;
        }
        if (pendingSpace && normalized) {
            normalized += ' ';
            map.push(i);
        }
        pendingSpace = false;
        normalized += ch;
        map.push(i);
    }
    return { normalized, map };
}

function findNormalizedRange(text: string, needle: string, occurrence = 1) {
    const target = String(needle || '').trim();
    if (!target) return null;
    const haystack = normalizeForMatch(text);
    const normalizedNeedle = normalizeForMatch(target).normalized;
    const at = findNthIndex(haystack.normalized, normalizedNeedle, occurrence);
    if (at < 0) return null;
    const endIndex = at + normalizedNeedle.length - 1;
    const start = haystack.map[at] ?? 0;
    const end = (haystack.map[endIndex] ?? start) + 1;
    return { start, end };
}

function suggestionRange(content: string, item: any) {
    const location = item?.location || {};
    const type = String(item?.type || '').toLowerCase();
    if (type === 'insert' && Number.isInteger(location.char_start) && Number.isInteger(location.char_end)) {
        const start = Math.max(0, Math.min(content.length, Number(location.char_start)));
        const end = Math.max(start, Math.min(content.length, Number(location.char_end)));
        const after = String(item?.insert_position || '').toLowerCase() !== 'before';
        const pos = after ? end : start;
        return { start: pos, end: pos };
    }
    if (Number.isInteger(location.char_start) && Number.isInteger(location.char_end)) {
        const start = Math.max(0, Math.min(content.length, Number(location.char_start)));
        const end = Math.max(start, Math.min(content.length, Number(location.char_end)));
        return { start, end };
    }
    if (type === 'insert') {
        const anchor = item?.anchor_text || location.quote || '';
        const occurrence = item?.occurrence || location.occurrence || 1;
        const at = findNthIndex(content, anchor, occurrence);
        const normalizedRange = at < 0 ? findNormalizedRange(content, anchor, occurrence) : null;
        if (at >= 0 || normalizedRange) {
            const after = String(item?.insert_position || '').toLowerCase() !== 'before';
            const pos = normalizedRange
                ? (after ? normalizedRange.end : normalizedRange.start)
                : (after ? at + String(anchor).length : at);
            return { start: pos, end: pos };
        }
        return null;
    }
    const original = item?.original || location.quote || '';
    const occurrence = item?.occurrence || location.occurrence || 1;
    const at = findNthIndex(content, original, occurrence);
    if (at < 0) return findNormalizedRange(content, original, occurrence);
    return { start: at, end: at + String(original).length };
}

function insertionWithSpacing(content: string, start: number, suggestion: string, insertPosition = 'after') {
    const before = content.slice(0, start);
    const after = content.slice(start);
    const needsBeforeBreak = before && !/\s$/.test(before);
    const needsAfterBreak = after && !/^\s/.test(after);
    return `${needsBeforeBreak ? '\n' : ''}${suggestion}${needsAfterBreak ? '\n' : ''}`;
}

function toBlockquote(markdown = '') {
    return String(markdown || '')
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
}

function suggestionInlineMarkdown(type: string, original: string, suggestion: string) {
    if (type === 'insert') {
        return `\n\n> **补充建议**\n>\n${toBlockquote(suggestion)}\n\n`;
    }
    if (type === 'delete') {
        return `\n\n> **建议删除原文**\n>\n${toBlockquote(original)}\n\n`;
    }
    return `\n\n> **建议替换原文**\n>\n${toBlockquote(original)}\n>\n> **建议改为**\n>\n${toBlockquote(suggestion)}\n\n`;
}

function summaryRevisionView(content = '', result: any) {
    const suggestions = Array.isArray(result?.suggestions) ? result.suggestions : [];
    const unresolvedInserts: any[] = [];
    const edits = suggestions
        .map((item: any, index: number) => {
            const range = suggestionRange(content, item);
            const type = String(item?.type || '').toLowerCase();
            if (!range) {
                if (type === 'insert' && String(item?.suggestion || '').trim()) {
                    unresolvedInserts.push({ index, suggestion: String(item.suggestion || '') });
                }
                return null;
            }
            const original = range.end > range.start ? content.slice(range.start, range.end) : String(item?.original || '');
            return {
                index,
                start: range.start,
                end: range.end,
                type: ['replace', 'insert', 'delete'].includes(type) ? type : 'replace',
                original,
                suggestion: String(item?.suggestion || ''),
                insertPosition: String(item?.insert_position || '').toLowerCase() === 'before' ? 'before' : 'after',
            };
        })
        .filter(Boolean)
        .sort((a: any, b: any) => b.start - a.start || b.end - a.end || b.index - a.index) as any[];
    let annotated = content;
    let revised = content;
    for (const edit of edits) {
        if (edit.type === 'insert' && !edit.suggestion) continue;
        if (edit.type === 'replace' && !edit.suggestion) continue;
        const replacement = edit.type === 'delete'
            ? ''
            : edit.type === 'insert'
                ? insertionWithSpacing(revised, edit.start, edit.suggestion, edit.insertPosition)
                : edit.suggestion;
        const annotation = suggestionInlineMarkdown(edit.type, edit.original, edit.type === 'insert' ? replacement : edit.suggestion);
        annotated = `${annotated.slice(0, edit.start)}${annotation}${annotated.slice(edit.end)}`;
        revised = `${revised.slice(0, edit.start)}${replacement}${revised.slice(edit.end)}`;
    }
    for (const item of unresolvedInserts.sort((a, b) => a.index - b.index)) {
        const suggestion = String(item.suggestion || '').trim();
        if (!suggestion) continue;
        const annotation = suggestionInlineMarkdown('insert', '', `未定位到精确位置，建议补充：\n\n${suggestion}`);
        annotated = `${annotated}${annotation}`;
        revised = `${revised}${insertionWithSpacing(revised, revised.length, suggestion, 'after')}`;
    }
    return {
        annotatedContent: annotated,
        revisedContent: revised,
        hasInlineSuggestions: edits.length > 0 || unresolvedInserts.length > 0,
    };
}

function submitForView(submit: SummarySubmit) {
    const evaluationResult = evaluationResultForView(submit.evaluationResult);
    const revision = summaryRevisionView(submit.content || '', evaluationResult);
    const suggestionCount = Array.isArray(evaluationResult?.suggestions) ? evaluationResult.suggestions.length : 0;
    const summaryText = compactText(
        evaluationResult?.summary?.overall
        || (submit.content || '').replace(/[#>*_`~\-[\]()]/g, ' '),
    );
    return {
        ...submit,
        evaluationStatusText: evaluationStatusText(submit.evaluationStatus || ''),
        evaluationResult,
        suggestionCount,
        summaryText,
        ...revision,
    };
}

async function refreshEvaluationQuietly(submit?: SummarySubmit | null) {
    if (!shouldRefreshEvaluation(submit)) return submit || null;
    try {
        await refreshSummaryEvaluation(submit);
        return await collSubmit.findOne({ domainId: submit.domainId, _id: submit._id }) as SummarySubmit | null;
    } catch (e) {
        console.warn('[course-summary-points] evaluation refresh failed', submit._id, e);
        return submit || null;
    }
}

async function refreshPendingEvaluations(submits: SummarySubmit[], limit = 8) {
    const active = submits.filter(shouldRefreshEvaluation).slice(0, limit);
    if (!active.length) return submits;
    await Promise.all(active.map((submit) => refreshEvaluationQuietly(submit)));
    const refreshed = await collSubmit.find({
        domainId: active[0].domainId,
        _id: { $in: active.map((submit) => submit._id) },
    }).toArray() as SummarySubmit[];
    const refreshedMap = new Map(refreshed.map((submit) => [idText(submit._id), submit]));
    return submits.map((submit) => refreshedMap.get(idText(submit._id)) || submit);
}

function sourceLabel(type: PointSourceType) {
    return ({
        summary: '课程小结',
        manual: '教师手动',
        contest: '比赛成绩',
        recent_status: '近期状态',
        adjustment: '修正调整',
    } as Record<PointSourceType, string>)[type] || type;
}

async function getGroupUids(domainId: string, groupName = '') {
    if (!groupName || groupName === 'all') return null;
    const gdoc = await collGroup.findOne({ domainId, name: groupName }) as any;
    if (!gdoc) throw new ValidationError('groupName', groupName, 'Group not found');
    return new Set<number>((gdoc.uids || []).map((uid: any) => Number(uid)).filter(Boolean));
}

function filterUidsByGroup(uids: number[], groupUids: Set<number> | null) {
    if (!groupUids) return uids;
    return uids.filter((uid) => groupUids.has(uid));
}

function withQuery(url: string, query: Record<string, any>) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '' && value !== 'all') params.set(key, String(value));
    }
    const qs = params.toString();
    return qs ? `${url}?${qs}` : url;
}

async function userGroupText(domainId: string, uids: number[]) {
    const groups = await UserModel.listGroup(domainId);
    const map: Record<number, string[]> = {};
    for (const group of groups as any[]) {
        for (const uid of group.uids || []) {
            if (!uids.includes(Number(uid))) continue;
            map[Number(uid)] ||= [];
            map[Number(uid)].push(group.name);
        }
    }
    return { groups, groupMap: map };
}

function targetFilter(domainId: string, courseId: ObjectId, sectionId: ObjectId, subsecId: ObjectId | null, targetType: TargetType) {
    return {
        domainId,
        courseId,
        sectionId,
        subsecId: targetType === 'subsec' ? subsecId : null,
        targetType,
    };
}

function targetName(targetType: TargetType, csdoc: any, ssdoc?: any) {
    if (targetType === 'subsec') return `小节：${ssdoc?.title || idText(ssdoc?._id)}`;
    return `章：${csdoc?.title || idText(csdoc?.docId || csdoc?._id)}`;
}

function courseTargetUrl(handler: Handler, targetType: TargetType, courseId: ObjectId, sectionId: ObjectId, subsecId?: ObjectId | null) {
    if (targetType === 'subsec' && subsecId) {
        return handler.url('course_subsec_detail', { cid: courseId, csid: sectionId, ssid: subsecId });
    }
    return handler.url('course_section_detail', { cid: courseId, csid: sectionId });
}

function taskEditUrl(handler: Handler, targetType: TargetType, courseId: ObjectId, sectionId: ObjectId, subsecId?: ObjectId | null) {
    const base = handler.url('course_summary_task_edit', { targetType, cid: courseId, csid: sectionId });
    if (targetType === 'subsec' && subsecId) return `${base}?ssid=${encodeURIComponent(idText(subsecId))}`;
    return base;
}

function taskEditUrlForTask(handler: Handler, task: SummaryTask) {
    return handler.url('course_summary_task_edit_existing', { taskId: task._id });
}

async function resolveTarget(domainId: string, courseId: ObjectId, sectionId: ObjectId, subsecId: ObjectId | null, targetType: TargetType) {
    const course = getCourseModel();
    const [cdoc, csdoc] = await Promise.all([
        course.get(domainId, courseId),
        course.getSection(domainId, sectionId),
    ]);
    if (!cdoc) throw new NotFoundError('course not found');
    if (!csdoc) throw new NotFoundError('course section not found');
    if (idText(csdoc.parentId) !== idText(courseId)) {
        throw new BadRequestError('section does not belong to this course');
    }
    if (targetType === 'section') return { course, cdoc, csdoc, ssdoc: null };
    if (!subsecId) throw new ValidationError('ssid', null, 'Subsection is required');
    const [realSection, ssdoc] = await course.getSubSection(domainId, sectionId, subsecId);
    if (!ssdoc) throw new NotFoundError('course subsection not found');
    if (idText(realSection.parentId) !== idText(courseId)) {
        throw new BadRequestError('subsection does not belong to this course');
    }
    return { course, cdoc, csdoc: realSection, ssdoc };
}

async function getTaskForTarget(domainId: string, courseId: ObjectId, sectionId: ObjectId, subsecId: ObjectId | null, targetType: TargetType) {
    return await collTask.findOne(targetFilter(domainId, courseId, sectionId, subsecId, targetType)) as SummaryTask | null;
}

async function ensureTaskForTarget(domainId: string, courseId: ObjectId, sectionId: ObjectId, subsecId: ObjectId | null, targetType: TargetType) {
    const filter = targetFilter(domainId, courseId, sectionId, subsecId, targetType);
    const existing = await collTask.findOne(filter) as SummaryTask | null;
    if (existing) return existing;

    const now = new Date();
    await collTask.updateOne(
        filter,
        {
            $setOnInsert: {
                ...filter,
                title: DEFAULT_SUMMARY_TASK_TITLE,
                content: DEFAULT_SUMMARY_TASK_CONTENT,
                deadline: defaultSummaryDeadline(),
                allowLate: true,
                dailyReminder: false,
                reminderTime: '20:00',
                minWords: 100,
                defaultPoints: 0,
                createdBy: DEFAULT_SUMMARY_TASK_CREATED_BY,
                createdAt: now,
                updatedAt: now,
            },
        },
        { upsert: true },
    );
    return await collTask.findOne(filter) as SummaryTask | null;
}

async function addPoints(
    domainId: string,
    uid: number,
    amount: number,
    reason: string,
    sourceType: PointSourceType,
    sourceId: any,
    operator: number,
) {
    amount = Number(amount) || 0;
    if (!amount) return;
    const now = new Date();
    await collLedger.insertOne({
        domainId,
        uid,
        amount,
        reason: reason || '学习积分调整',
        sourceType,
        sourceId: sourceId || null,
        operator,
        createdAt: now,
    });
    await collPointSummary.updateOne(
        { domainId, uid },
        {
            $inc: { total: amount },
            $set: { updatedAt: now },
            $setOnInsert: { createdAt: now },
        },
        { upsert: true },
    );
}

async function addPointsUnique(
    domainId: string,
    uid: number,
    amount: number,
    reason: string,
    sourceType: PointSourceType,
    sourceId: any,
    operator: number,
) {
    if (!amount) return false;
    if (sourceId && await collLedger.findOne({ domainId, uid, sourceType, sourceId })) return false;
    await addPoints(domainId, uid, amount, reason, sourceType, sourceId, operator);
    return true;
}

async function deletePointLedger(domainId: string, ledgerId: ObjectId) {
    const bill = await collLedger.findOne({ domainId, _id: ledgerId }) as any;
    if (!bill) throw new NotFoundError('point ledger not found');
    if (bill.sourceType === 'summary') {
        throw new ValidationError('ledgerId', idText(ledgerId), '课程小结奖励请在批改页修改');
    }
    const amount = Number(bill.amount) || 0;
    await collLedger.deleteOne({ domainId, _id: ledgerId });
    if (amount) {
        await collPointSummary.updateOne(
            { domainId, uid: Number(bill.uid) },
            { $inc: { total: -amount }, $set: { updatedAt: new Date() } },
        );
    }
    return bill;
}

async function deleteSummaryTask(domainId: string, taskId: ObjectId) {
    const submits = await collSubmit.find({ domainId, taskId }).project({ _id: 1 }).toArray() as any[];
    const submitIds = submits.map((submit) => submit._id).filter(Boolean);
    if (submitIds.length) {
        const pointSums = await collLedger.aggregate([
            { $match: { domainId, sourceType: 'summary', sourceId: { $in: submitIds } } },
            { $group: { _id: '$uid', amount: { $sum: '$amount' } } },
        ]).toArray() as any[];
        await Promise.all(pointSums.map((item) => collPointSummary.updateOne(
            { domainId, uid: Number(item._id) },
            { $inc: { total: -(Number(item.amount) || 0) }, $set: { updatedAt: new Date() } },
        )));
        await collLedger.deleteMany({ domainId, sourceType: 'summary', sourceId: { $in: submitIds } });
    }
    await Promise.all([
        collTask.deleteOne({ domainId, _id: taskId }),
        collSubmit.deleteMany({ domainId, taskId }),
        collReminder.deleteMany({ domainId, taskId }),
    ]);
    return { submitCount: submits.length, ledgerCleared: submitIds.length };
}

async function getEnrolledUids(domainId: string, courseId: ObjectId) {
    const course = getCourseModel();
    const rows = await course.getMultiStatus(domainId, { docId: courseId, uid: { $gt: 1 }, enroll: 1 })
        .project({ uid: 1 })
        .toArray();
    return rows.map((row: any) => Number(row.uid)).filter(Boolean);
}

async function getPendingUids(task: SummaryTask) {
    const enrolled = await getEnrolledUids(task.domainId, task.courseId);
    if (!enrolled.length) return [];
    const submits = await collSubmit.find({ domainId: task.domainId, taskId: task._id, uid: { $in: enrolled } })
        .project({ uid: 1 })
        .toArray() as any[];
    const submitted = new Set(submits.map((item) => Number(item.uid)));
    return enrolled.filter((uid) => !submitted.has(uid));
}

function dayKey(date: Date) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function recordDayKey(record: any) {
    const date = record?._id?.getTimestamp?.() || record?.createdAt || new Date();
    return dayKey(date);
}

function parseContestRankPoints(value = '') {
    const raw = String(value || '').trim() || '5,4,3,2,1';
    return raw
        .replace(/\uFF0C|\u3001/g, ',')
        .split(/[,\s]+/)
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item) && item > 0);
}

async function sendReminder(task: SummaryTask, uid: number, respectDailyLog: boolean) {
    const today = dayKey(new Date());
    if (respectDailyLog) {
        const result = await collReminder.updateOne(
            { domainId: task.domainId, taskId: task._id, uid, date: today },
            { $setOnInsert: { domainId: task.domainId, taskId: task._id, uid, date: today, createdAt: new Date() } },
            { upsert: true },
        );
        if (!result.upsertedCount) return false;
    }
    const link = `/d/${task.domainId}/course-summary/task/${idText(task._id)}/submit`;
    const msg = JSON.stringify({
        message: '课程小结提醒：{0}。请及时完成：{1:link}',
        params: [task.title, link],
    });
    await MessageModel.send(1, uid, msg, MessageModel.FLAG_RICHTEXT | MessageModel.FLAG_UNREAD);
    return true;
}

async function sendTaskReminders(task: SummaryTask, respectDailyLog: boolean, allowedUids?: Set<number> | null) {
    let pending = await getPendingUids(task);
    if (allowedUids) pending = pending.filter((uid) => allowedUids.has(uid));
    let sent = 0;
    for (const uid of pending) {
        try {
            if (await sendReminder(task, uid, respectDailyLog)) sent++;
        } catch (e) {
            console.warn('[course-summary-points] reminder failed', task._id, uid, e);
        }
    }
    return sent;
}

async function buildPointRows(domainId: string, groupName = '') {
    const groupUids = await getGroupUids(domainId, groupName);
    const userQuery: any = { uid: { $gt: 1 } };
    if (groupUids) userQuery.uid = { $in: Array.from(groupUids) };
    const [domainDoc, rawDudocs] = await Promise.all([
        DomainModel.get(domainId) as Promise<any>,
        DomainModel.getMultiUserInDomain(domainId, userQuery)
            .project({ uid: 1, role: 1 })
            .toArray() as Promise<any[]>,
    ]);
    const roleHasEditDomain = (role = 'default') => {
        if (role === 'root') return true;
        const raw = domainDoc?.roles?.[role];
        if (raw === undefined || raw === null) return false;
        try {
            return (BigInt(raw) & PERM.PERM_EDIT_DOMAIN) === PERM.PERM_EDIT_DOMAIN;
        } catch {
            return false;
        }
    };
    const dudocs = rawDudocs
        .filter((doc) => Number(doc.uid) !== Number(domainDoc?.owner))
        .filter((doc) => !roleHasEditDomain(doc.role || 'default'));
    const uids = dudocs.map((doc) => Number(doc.uid)).filter(Boolean);
    const [udict, pointDocs, ledgerSums, groupInfo] = await Promise.all([
        UserModel.getList(domainId, uids),
        collPointSummary.find({ domainId, uid: { $in: uids } }).toArray() as Promise<any[]>,
        collLedger.aggregate([
            { $match: { domainId, uid: { $in: uids } } },
            { $group: { _id: { uid: '$uid', sourceType: '$sourceType' }, amount: { $sum: '$amount' } } },
        ]).toArray() as Promise<any[]>,
        userGroupText(domainId, uids),
    ]);
    const points = new Map(pointDocs.map((doc) => [Number(doc.uid), doc]));
    const sourceMap: Record<number, Record<string, number>> = {};
    for (const item of ledgerSums) {
        const uid = Number(item._id.uid);
        sourceMap[uid] ||= {};
        sourceMap[uid][item._id.sourceType] = Number(item.amount) || 0;
    }
    const visibleDudocs = dudocs.filter((doc) => !udict[Number(doc.uid)]?.hasPerm?.(PERM.PERM_EDIT_DOMAIN));
    const rows = visibleDudocs.map((doc) => {
        const uid = Number(doc.uid);
        const pdoc = points.get(uid);
        const sources = sourceMap[uid] || {};
        return {
            uid,
            uname: udict[uid]?.uname || '',
            displayName: doc.displayName || udict[uid]?.displayName || '',
            studentId: doc.studentId || udict[uid]?.studentId || '',
            groups: groupInfo.groupMap[uid] || [],
            total: Number(pdoc?.total) || 0,
            summary: sources.summary || 0,
            contest: sources.contest || 0,
            recentStatus: sources.recent_status || 0,
            manual: sources.manual || 0,
            adjustment: sources.adjustment || 0,
            updatedAt: pdoc?.updatedAt || null,
        };
    });
    rows.sort((a, b) => b.total - a.total || a.uid - b.uid);
    let lastTotal: number | null = null;
    let rank = 0;
    rows.forEach((row, index) => {
        if (row.total !== lastTotal) {
            rank = index + 1;
            lastTotal = row.total;
        }
        (row as any).rank = rank;
    });
    return { rows, udict, groups: groupInfo.groups };
}

async function awardContestScore(
    domainId: string,
    contestId: ObjectId,
    rankPointText: string,
    rate: number,
    base: number,
    groupName: string,
    batchKey: string,
    operator: number,
) {
    const tdoc = await ContestModel.get(domainId, contestId);
    if (!tdoc) throw new NotFoundError('contest not found');
    const groupUids = await getGroupUids(domainId, groupName);
    const statuses = await ContestModel.getMultiStatus(domainId, {
        docId: contestId,
        uid: { $gt: 1 },
        attend: { $exists: true },
    }).project({ uid: 1, score: 1 }).toArray() as any[];
    const rankPoints = parseContestRankPoints(rankPointText);
    const sourceId = `contest:${idText(contestId)}:${batchKey || 'top5'}`;
    const ranked = statuses
        .map((status) => ({ uid: Number(status.uid), score: Number(status.score) || 0 }))
        .filter((status) => status.uid && (!groupUids || groupUids.has(status.uid)))
        .sort((a, b) => b.score - a.score || a.uid - b.uid);
    let scanned = ranked.length;
    let awarded = 0;
    let skipped = 0;
    let rank = 0;
    let lastScore: number | null = null;
    for (let index = 0; index < ranked.length; index++) {
        const status = ranked[index];
        if (status.score !== lastScore) {
            rank = index + 1;
            lastScore = status.score;
        }
        if (rank > rankPoints.length) continue;
        const amount = (Number(rankPoints[rank - 1]) || 0)
            + Math.floor(status.score * (Number(rate) || 0) / 100)
            + (Number(base) || 0);
        if (!amount) continue;
        const ok = await addPointsUnique(
            domainId,
            status.uid,
            amount,
            `比赛排名加分：${tdoc.title || idText(contestId)}，第 ${rank} 名，成绩 ${status.score}`,
            'contest',
            sourceId,
            operator,
        );
        if (ok) awarded++;
        else skipped++;
    }
    return { scanned, awarded, skipped };
}

async function awardRecentStatus(
    domainId: string,
    days: number,
    dailyPoint: number,
    submitPoint: number,
    acceptPoint: number,
    groupName: string,
    batchKey: string,
    reason: string,
    operator: number,
) {
    const groupUids = await getGroupUids(domainId, groupName);
    let uids: number[] | undefined;
    if (groupUids) uids = Array.from(groupUids);
    const dayCount = Math.max(1, Number(days) || 1);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - dayCount + 1);
    const match: any = {
        _id: { $gte: Time.getObjectID(start) },
        domainId,
        contest: { $nin: [RecordModel.RECORD_PRETEST, RecordModel.RECORD_GENERATE] },
        uid: uids ? { $in: uids } : { $gt: 1 },
    };
    const records = await RecordModel.coll.find(match)
        .project({ _id: 1, uid: 1, status: 1 })
        .toArray() as any[];
    const dayRows = new Map<string, { uid: number, date: string, nSubmit: number, nAccept: number }>();
    for (const record of records) {
        const uid = Number(record.uid);
        if (!uid) continue;
        const date = recordDayKey(record);
        const key = `${uid}:${date}`;
        const row = dayRows.get(key) || { uid, date, nSubmit: 0, nAccept: 0 };
        row.nSubmit++;
        if (record.status === STATUS.STATUS_ACCEPTED) row.nAccept++;
        dayRows.set(key, row);
    }
    let awarded = 0;
    let skipped = 0;
    for (const row of dayRows.values()) {
        const amount = (Number(dailyPoint) || 0)
            + (Number(row.nSubmit) || 0) * (Number(submitPoint) || 0)
            + (Number(row.nAccept) || 0) * (Number(acceptPoint) || 0);
        if (!row.uid || !amount) continue;
        const ok = await addPointsUnique(
            domainId,
            row.uid,
            amount,
            reason || `近期状态加分：${row.date} 提交 ${row.nSubmit}，通过 ${row.nAccept}`,
            'recent_status',
            `recent:${row.date}:${batchKey || 'daily'}`,
            operator,
        );
        if (ok) awarded++;
        else skipped++;
    }
    return { scanned: dayRows.size, awarded, skipped };
}

function shouldRunReminder(task: SummaryTask, now: Date) {
    if (!task.dailyReminder) return false;
    if (task.deadline && task.deadline.getTime() < now.getTime()) return false;
    const pad = (n: number) => String(n).padStart(2, '0');
    const current = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    return current >= normalizeReminderTime(task.reminderTime);
}

async function runReminderPass() {
    const now = new Date();
    const tasks = await collTask.find({
        dailyReminder: true,
        $or: [{ deadline: null }, { deadline: { $gte: now } }],
    }).limit(100).toArray() as SummaryTask[];
    for (const task of tasks) {
        if (shouldRunReminder(task, now)) await sendTaskReminders(task, true);
    }
}

function startReminderLoop(ctx: Context) {
    const run = () => runReminderPass().catch((e) => console.warn('[course-summary-points] reminder pass failed', e));
    const timer = setInterval(run, 10 * 60 * 1000);
    (timer as any).unref?.();
    setTimeout(run, 30 * 1000);
    (ctx as any).on?.('dispose', () => clearInterval(timer));
}

class CourseSummaryWidgetHandler extends Handler {
    @param('cid', Types.ObjectId)
    @param('csid', Types.ObjectId)
    @param('ssid', Types.ObjectId, true)
    @param('targetType', Types.Range(['section', 'subsec']))
    async get({ domainId }, courseId: ObjectId, sectionId: ObjectId, subsecId: ObjectId | null, targetType: TargetType) {
        const target = await resolveTarget(this.domain._id, courseId, sectionId, subsecId || null, targetType);
        const task = await ensureTaskForTarget(this.domain._id, courseId, sectionId, subsecId || null, targetType);
        const canEdit = this.user.hasPerm(PERM.PERM_EDIT_TRAINING);
        const canSubmit = this.user.hasPriv(PRIV.PRIV_USER_PROFILE);
        const submit = task && canSubmit
            ? await collSubmit.findOne({ domainId: this.domain._id, taskId: task._id, uid: this.user._id }) as SummarySubmit | null
            : null;
        const point = canSubmit
            ? await collPointSummary.findOne({ domainId: this.domain._id, uid: this.user._id }) as any
            : null;
        const pendingCount = task && canEdit ? await getPendingUids(task).then((uids) => uids.length) : 0;
        this.response.body = {
            ok: true,
            hasTask: !!task,
            canEdit,
            canSubmit,
            targetTitle: targetName(targetType, target.csdoc, target.ssdoc),
            task: task ? {
                _id: idText(task._id),
                title: task.title,
                content: task.content,
                deadline: task.deadline ? task.deadline.toISOString() : '',
                deadlineText: task.deadline ? toDatetimeLocal(task.deadline).replace('T', ' ') : '不限',
                minWords: task.minWords,
                defaultPoints: task.defaultPoints,
                dailyReminder: task.dailyReminder,
                allowLate: task.allowLate,
            } : null,
            submit: submit ? {
                _id: idText(submit._id),
                status: submit.status,
                wordCount: submit.wordCount,
                awardedPoints: submit.awardedPoints || 0,
                excellent: !!submit.excellent,
                updatedAt: submit.updatedAt ? submit.updatedAt.toISOString() : '',
            } : null,
            pointTotal: point?.total || 0,
            pendingCount,
            editUrl: task ? taskEditUrlForTask(this, task) : taskEditUrl(this, targetType, courseId, sectionId, subsecId || null),
            submitUrl: task ? this.url('course_summary_submit', { taskId: task._id }) : '',
            viewUrl: task && submit ? this.url('course_summary_manage_submit', { taskId: task._id, submitId: submit._id }) : '',
            manageUrl: task ? this.url('course_summary_manage', { taskId: task._id }) : '',
        };
    }
}

class CourseSummaryTaskEditHandler extends Handler {
    cdoc: any;
    csdoc: any;
    ssdoc: any;
    task: SummaryTask | null = null;

    @param('targetType', Types.Range(['section', 'subsec']))
    @param('cid', Types.ObjectId)
    @param('csid', Types.ObjectId)
    @param('ssid', Types.ObjectId, true)
    async prepare({ domainId }, targetType: TargetType, courseId: ObjectId, sectionId: ObjectId, subsecId?: ObjectId) {
        this.checkPerm(PERM.PERM_EDIT_TRAINING);
        const target = await resolveTarget(this.domain._id, courseId, sectionId, subsecId || null, targetType);
        this.cdoc = target.cdoc;
        this.csdoc = target.csdoc;
        this.ssdoc = target.ssdoc;
        this.task = await ensureTaskForTarget(this.domain._id, courseId, sectionId, subsecId || null, targetType);
    }

    @param('targetType', Types.Range(['section', 'subsec']))
    @param('cid', Types.ObjectId)
    @param('csid', Types.ObjectId)
    @param('ssid', Types.ObjectId, true)
    async get({ domainId }, targetType: TargetType, courseId: ObjectId, sectionId: ObjectId, subsecId?: ObjectId) {
        if (this.task?._id) {
            this.response.redirect = taskEditUrlForTask(this, this.task);
            return;
        }
        this.response.template = 'course_summary_task_edit.html';
        this.response.body = {
            page_name: 'course_summary_task_edit',
            cdoc: this.cdoc,
            csdoc: this.csdoc,
            ssdoc: this.ssdoc,
            task: this.task,
            targetType,
            targetTitle: targetName(targetType, this.csdoc, this.ssdoc),
            backUrl: courseTargetUrl(this, targetType, courseId, sectionId, subsecId || null),
            formAction: this.task ? taskEditUrlForTask(this, this.task) : taskEditUrl(this, targetType, courseId, sectionId, subsecId || null),
            taskForm: {
                title: this.task?.title || `${targetName(targetType, this.csdoc, this.ssdoc)}学习小结`,
                content: this.task?.content || '',
                deadlineText: toDatetimeLocal(this.task?.deadline),
                allowLate: this.task?.allowLate ?? true,
                dailyReminder: this.task?.dailyReminder ?? false,
                reminderTime: this.task?.reminderTime || '20:00',
                minWords: this.task?.minWords || 100,
                defaultPoints: this.task?.defaultPoints || 0,
                evaluationProblemId: this.task?.evaluationProblemId || defaultEvaluationProblemIdForTarget(this.domain._id, courseId, sectionId, subsecId || null),
                evaluationSourceText: compactText(this.task?.evaluationSourceText) || defaultEvaluationSourceText(this.cdoc, this.csdoc, this.ssdoc, this.task),
                evaluationReferenceSummary: defaultEvaluationReferenceSummary(this.task),
            },
        };
    }

    @param('targetType', Types.Range(['section', 'subsec']))
    @param('cid', Types.ObjectId)
    @param('csid', Types.ObjectId)
    @param('ssid', Types.ObjectId, true)
    @param('title', Types.Title)
    @param('content', Types.Content, true)
    @param('deadlineText', Types.String, true)
    @param('allowLate', Types.Boolean, true)
    @param('dailyReminder', Types.Boolean, true)
    @param('reminderTime', Types.String, true)
    @param('minWords', Types.Int, true)
    @param('defaultPoints', Types.Int, true)
    @param('evaluationProblemId', Types.String, true)
    @param('evaluationSourceText', Types.Content, true)
    @param('evaluationReferenceSummary', Types.Content, true)
    async post(
        { domainId },
        targetType: TargetType,
        courseId: ObjectId,
        sectionId: ObjectId,
        subsecId: ObjectId | undefined,
        title: string,
        content = '',
        deadlineText = '',
        allowLate = false,
        dailyReminder = false,
        reminderTime = '20:00',
        minWords = 0,
        defaultPoints = 0,
        evaluationProblemId = '',
        evaluationSourceText = '',
        evaluationReferenceSummary = '',
    ) {
        const target = await resolveTarget(this.domain._id, courseId, sectionId, subsecId || null, targetType);
        const sourceText = compactText(evaluationSourceText) || defaultEvaluationSourceText(target.cdoc, target.csdoc, target.ssdoc, this.task);
        const referenceSummary = compactText(evaluationReferenceSummary) || compactText(content);
        const now = new Date();
        const filter = targetFilter(this.domain._id, courseId, sectionId, subsecId || null, targetType);
        await collTask.updateOne(
            filter,
            {
                $set: {
                    ...filter,
                    title,
                    content,
                    deadline: parseDeadline(deadlineText),
                    allowLate: !!allowLate,
                    dailyReminder: !!dailyReminder,
                    reminderTime: normalizeReminderTime(reminderTime),
                    minWords: Math.max(0, Number(minWords) || 0),
                    defaultPoints: Number(defaultPoints) || 0,
                    evaluationProblemId: String(evaluationProblemId || '').trim(),
                    evaluationSourceText: sourceText,
                    evaluationReferenceSummary: referenceSummary,
                    updatedAt: now,
                },
                $setOnInsert: {
                    createdBy: this.user._id,
                    createdAt: now,
                },
            },
            { upsert: true },
        );
        this.response.redirect = courseTargetUrl(this, targetType, courseId, sectionId, subsecId || null);
    }

    @param('targetType', Types.Range(['section', 'subsec']))
    @param('cid', Types.ObjectId)
    @param('csid', Types.ObjectId)
    @param('ssid', Types.ObjectId, true)
    async postDelete({ domainId }, targetType: TargetType, courseId: ObjectId, sectionId: ObjectId, subsecId?: ObjectId) {
        const task = await getTaskForTarget(this.domain._id, courseId, sectionId, subsecId || null, targetType);
        if (task) await deleteSummaryTask(this.domain._id, task._id);
        this.response.redirect = courseTargetUrl(this, targetType, courseId, sectionId, subsecId || null);
    }
}

class CourseSummaryTaskEditExistingHandler extends Handler {
    task: SummaryTask;
    cdoc: any;
    csdoc: any;
    ssdoc: any;

    @param('taskId', Types.ObjectId)
    async prepare({ domainId }, taskId: ObjectId) {
        this.checkPerm(PERM.PERM_EDIT_TRAINING);
        const task = await collTask.findOne({ domainId: this.domain._id, _id: taskId }) as SummaryTask | null;
        if (!task) throw new NotFoundError('summary task not found');
        const target = await resolveTarget(this.domain._id, task.courseId, task.sectionId, task.subsecId, task.targetType);
        this.task = task;
        this.cdoc = target.cdoc;
        this.csdoc = target.csdoc;
        this.ssdoc = target.ssdoc;
    }

    async get() {
        this.response.template = 'course_summary_task_edit.html';
        this.response.body = {
            page_name: 'course_summary_task_edit',
            cdoc: this.cdoc,
            csdoc: this.csdoc,
            ssdoc: this.ssdoc,
            task: this.task,
            targetType: this.task.targetType,
            targetTitle: targetName(this.task.targetType, this.csdoc, this.ssdoc),
            backUrl: courseTargetUrl(this, this.task.targetType, this.task.courseId, this.task.sectionId, this.task.subsecId),
            formAction: taskEditUrlForTask(this, this.task),
            taskForm: {
                title: this.task.title || `${targetName(this.task.targetType, this.csdoc, this.ssdoc)}学习小结`,
                content: this.task.content || '',
                deadlineText: toDatetimeLocal(this.task.deadline),
                allowLate: this.task.allowLate ?? true,
                dailyReminder: this.task.dailyReminder ?? false,
                reminderTime: this.task.reminderTime || '20:00',
                minWords: this.task.minWords || 100,
                defaultPoints: this.task.defaultPoints || 0,
                evaluationProblemId: this.task.evaluationProblemId || defaultEvaluationProblemIdForTarget(this.domain._id, this.task.courseId, this.task.sectionId, this.task.subsecId || null),
                evaluationSourceText: compactText(this.task.evaluationSourceText) || defaultEvaluationSourceText(this.cdoc, this.csdoc, this.ssdoc, this.task),
                evaluationReferenceSummary: defaultEvaluationReferenceSummary(this.task),
            },
        };
    }

    @param('title', Types.Title)
    @param('content', Types.Content, true)
    @param('deadlineText', Types.String, true)
    @param('allowLate', Types.Boolean, true)
    @param('dailyReminder', Types.Boolean, true)
    @param('reminderTime', Types.String, true)
    @param('minWords', Types.Int, true)
    @param('defaultPoints', Types.Int, true)
    @param('evaluationProblemId', Types.String, true)
    @param('evaluationSourceText', Types.Content, true)
    @param('evaluationReferenceSummary', Types.Content, true)
    async post(
        { domainId },
        title: string,
        content = '',
        deadlineText = '',
        allowLate = false,
        dailyReminder = false,
        reminderTime = '20:00',
        minWords = 0,
        defaultPoints = 0,
        evaluationProblemId = '',
        evaluationSourceText = '',
        evaluationReferenceSummary = '',
    ) {
        const sourceText = compactText(evaluationSourceText) || defaultEvaluationSourceText(this.cdoc, this.csdoc, this.ssdoc, this.task);
        const referenceSummary = compactText(evaluationReferenceSummary) || compactText(content);
        await collTask.updateOne(
            { domainId: this.domain._id, _id: this.task._id },
            {
                $set: {
                    title,
                    content,
                    deadline: parseDeadline(deadlineText),
                    allowLate: !!allowLate,
                    dailyReminder: !!dailyReminder,
                    reminderTime: normalizeReminderTime(reminderTime),
                    minWords: Math.max(0, Number(minWords) || 0),
                    defaultPoints: Number(defaultPoints) || 0,
                    evaluationProblemId: String(evaluationProblemId || '').trim(),
                    evaluationSourceText: sourceText,
                    evaluationReferenceSummary: referenceSummary,
                    updatedAt: new Date(),
                },
            },
        );
        this.response.redirect = taskEditUrlForTask(this, this.task);
    }
}

class CourseSummarySubmitHandler extends Handler {
    task: SummaryTask;
    cdoc: any;
    csdoc: any;
    ssdoc: any;
    submit: SummarySubmit | null = null;

    @param('taskId', Types.ObjectId)
    async prepare({ domainId }, taskId: ObjectId) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const task = await collTask.findOne({ domainId: this.domain._id, _id: taskId }) as SummaryTask | null;
        if (!task) throw new NotFoundError('summary task not found');
        const target = await resolveTarget(this.domain._id, task.courseId, task.sectionId, task.subsecId, task.targetType);
        const status = await target.course.getStatus(this.domain._id, task.courseId, this.user._id);
        if (!status?.enroll && !this.user.hasPerm(PERM.PERM_EDIT_TRAINING)) {
            throw new ForbiddenError('请先加入课程后再提交小结。');
        }
        this.task = task;
        this.cdoc = target.cdoc;
        this.csdoc = target.csdoc;
        this.ssdoc = target.ssdoc;
        this.submit = await collSubmit.findOne({ domainId: this.domain._id, taskId, uid: this.user._id }) as SummarySubmit | null;
    }

    async get() {
        this.submit = await refreshEvaluationQuietly(this.submit);
        this.response.template = 'course_summary_submit.html';
        this.response.body = {
            page_name: 'course_summary_submit',
            task: this.task,
            referenceText: compactText(this.task.evaluationSourceText) || defaultEvaluationSourceText(this.cdoc, this.csdoc, this.ssdoc, this.task),
            cdoc: this.cdoc,
            csdoc: this.csdoc,
            ssdoc: this.ssdoc,
            submit: this.submit ? {
                ...submitForView(this.submit),
                displayWordCount: countWords(this.submit.content || ''),
                storedWordCount: Number(this.submit.wordCount) || 0,
            } : null,
            targetTitle: targetName(this.task.targetType, this.csdoc, this.ssdoc),
            backUrl: courseTargetUrl(this, this.task.targetType, this.task.courseId, this.task.sectionId, this.task.subsecId),
            manageUrl: this.user.hasPerm(PERM.PERM_EDIT_TRAINING) ? this.url('course_summary_manage', { taskId: this.task._id }) : '',
            refreshUrl: this.url('course_summary_submit_refresh', { taskId: this.task._id }),
        };
    }

    @param('content', Types.Content)
    async post({ domainId }, content: string) {
        const now = new Date();
        if (this.task.deadline && now.getTime() > this.task.deadline.getTime() && !this.task.allowLate) {
            throw new ForbiddenError('小结已过截止时间，当前任务不允许补交。');
        }
        const wordCount = countWords(content);
        if (this.task.minWords && wordCount < this.task.minWords) {
            throw new ValidationError('content', null, `小结至少需要 ${this.task.minWords} 字/词。`);
        }
        const status: SubmitStatus = this.task.deadline && now.getTime() > this.task.deadline.getTime() ? 'late' : 'submitted';
        await collSubmit.updateOne(
            { domainId: this.domain._id, taskId: this.task._id, uid: this.user._id },
            {
                $set: {
                    domainId: this.domain._id,
                    taskId: this.task._id,
                    uid: this.user._id,
                    content,
                    wordCount,
                    status,
                    updatedAt: now,
                },
                $setOnInsert: {
                    excellent: false,
                    comment: '',
                    score: null,
                    awardedPoints: 0,
                    createdAt: now,
                },
            },
            { upsert: true },
        );
        const submit = await collSubmit.findOne({ domainId: this.domain._id, taskId: this.task._id, uid: this.user._id }) as SummarySubmit | null;
        if (submit) await createSummaryEvaluation(this.task, submit, targetName(this.task.targetType, this.csdoc, this.ssdoc));
        this.response.redirect = submit
            ? this.url('course_summary_manage_submit', { taskId: this.task._id, submitId: submit._id })
            : this.url('course_summary_submit', { taskId: this.task._id });
    }

    async postRefreshEvaluation() {
        if (!this.submit) throw new NotFoundError('summary submit not found');
        await refreshSummaryEvaluation(this.submit);
        this.response.redirect = this.url('course_summary_submit', { taskId: this.task._id });
    }
}

class CourseSummarySubmitRefreshHandler extends Handler {
    task: SummaryTask;
    submit: SummarySubmit | null = null;

    @param('taskId', Types.ObjectId)
    async prepare({ domainId }, taskId: ObjectId) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const task = await collTask.findOne({ domainId: this.domain._id, _id: taskId }) as SummaryTask | null;
        if (!task) throw new NotFoundError('summary task not found');
        const target = await resolveTarget(this.domain._id, task.courseId, task.sectionId, task.subsecId, task.targetType);
        const status = await target.course.getStatus(this.domain._id, task.courseId, this.user._id);
        if (!status?.enroll && !this.user.hasPerm(PERM.PERM_EDIT_TRAINING)) {
            throw new ForbiddenError('Please enroll in the course before refreshing the summary evaluation.');
        }
        this.task = task;
        this.submit = await collSubmit.findOne({ domainId: this.domain._id, taskId, uid: this.user._id }) as SummarySubmit | null;
    }

    async post() {
        if (!this.submit) throw new NotFoundError('summary submit not found');
        await refreshSummaryEvaluation(this.submit);
        this.response.redirect = this.url('course_summary_submit', { taskId: this.task._id });
    }
}

class CourseSummaryManageHandler extends Handler {
    task: SummaryTask;
    cdoc: any;
    csdoc: any;
    ssdoc: any;

    @param('taskId', Types.ObjectId)
    async prepare({ domainId }, taskId: ObjectId) {
        this.checkPerm(PERM.PERM_EDIT_TRAINING);
        const task = await collTask.findOne({ domainId: this.domain._id, _id: taskId }) as SummaryTask | null;
        if (!task) throw new NotFoundError('summary task not found');
        const target = await resolveTarget(this.domain._id, task.courseId, task.sectionId, task.subsecId, task.targetType);
        this.task = task;
        this.cdoc = target.cdoc;
        this.csdoc = target.csdoc;
        this.ssdoc = target.ssdoc;
    }

    @param('groupName', Types.String, true)
    @param('message', Types.String, true)
    @param('page', Types.PositiveInt, true)
    async get({ domainId }, groupName = '', message = '', page = 1) {
        const groupUids = await getGroupUids(this.domain._id, groupName);
        const [submits, pendingUids] = await Promise.all([
            collSubmit.find({ domainId: this.domain._id, taskId: this.task._id }).sort({ updatedAt: -1 }).toArray() as Promise<SummarySubmit[]>,
            getPendingUids(this.task),
        ]);
        const filteredSubmits = await refreshPendingEvaluations(groupUids ? submits.filter((item) => groupUids.has(item.uid)) : submits);
        const filteredPendingUids = filterUidsByGroup(pendingUids, groupUids);
        const unevaluatedCount = filteredSubmits.filter((item) => !compactText(item.evaluationId) && compactText(item.content)).length;
        const pageSize = Math.max(1, Number((this.ctx as any).setting.get('pagination.course_summary_manage')) || 20);
        const pcount = Math.max(1, Math.ceil(filteredSubmits.length / pageSize));
        const currentPage = Math.min(Math.max(1, page), pcount);
        const pageSubmits = filteredSubmits.slice((currentPage - 1) * pageSize, currentPage * pageSize);
        const uids = Array.from(new Set([...pageSubmits.map((item) => item.uid), ...filteredPendingUids]));
        const groups = await UserModel.listGroup(this.domain._id);
        const udict = await UserModel.getList(this.domain._id, uids);
        const reviewSubmits = pageSubmits.map((item) => ({
            ...submitForView(item),
            displayWordCount: countWords(item.content || ''),
            storedWordCount: Number(item.wordCount) || 0,
            detailUrl: withQuery(this.url('course_summary_manage_submit', { taskId: this.task._id, submitId: item._id }), {
                groupName: groupName || '',
                page: currentPage > 1 ? currentPage : '',
            }),
        }));
        this.response.template = 'course_summary_manage.html';
        this.response.body = {
            page_name: 'course_summary_manage',
            task: this.task,
            cdoc: this.cdoc,
            csdoc: this.csdoc,
            ssdoc: this.ssdoc,
            submits: reviewSubmits,
            pendingUids: filteredPendingUids,
            udict,
            groups,
            filterGroupName: groupName || 'all',
            targetTitle: targetName(this.task.targetType, this.csdoc, this.ssdoc),
            editUrl: taskEditUrl(this, this.task.targetType, this.task.courseId, this.task.sectionId, this.task.subsecId),
            backUrl: courseTargetUrl(this, this.task.targetType, this.task.courseId, this.task.sectionId, this.task.subsecId),
            submitCount: filteredSubmits.length,
            pendingCount: filteredPendingUids.length,
            allSubmitCount: submits.length,
            allPendingCount: pendingUids.length,
            unevaluatedCount,
            evaluationEnabled: getEvaluationConfig().enabled,
            messages: message ? [message] : [],
            page: currentPage,
            pcount,
            listUrl: this.url('course_summary_manage', { taskId: this.task._id }),
            queryBase: groupName && groupName !== 'all' ? `groupName=${encodeURIComponent(groupName)}` : '',
        };
    }

    @param('submitId', Types.ObjectId)
    @param('excellent', Types.Boolean, true)
    @param('groupName', Types.String, true)
    async postReview({ domainId }, submitId: ObjectId, excellent = false, groupName = '') {
        const submit = await collSubmit.findOne({ domainId: this.domain._id, taskId: this.task._id, _id: submitId }) as SummarySubmit | null;
        if (!submit) throw new NotFoundError('summary submit not found');
        await collSubmit.updateOne(
            { domainId: this.domain._id, taskId: this.task._id, _id: submitId },
            {
                $set: {
                    wordCount: countWords(submit.content || ''),
                    excellent: !!excellent,
                    reviewedBy: this.user._id,
                    reviewedAt: new Date(),
                },
            },
        );
        this.response.redirect = withQuery(this.url('course_summary_manage_submit', { taskId: this.task._id, submitId }), { groupName });
    }

    @param('submitId', Types.ObjectId)
    @param('groupName', Types.String, true)
    async postRefreshEvaluation({ domainId }, submitId: ObjectId, groupName = '') {
        const submit = await collSubmit.findOne({ domainId: this.domain._id, taskId: this.task._id, _id: submitId }) as SummarySubmit | null;
        if (!submit) throw new NotFoundError('summary submit not found');
        await refreshSummaryEvaluation(submit);
        this.response.redirect = withQuery(this.url('course_summary_manage', { taskId: this.task._id }), { groupName });
    }

    @param('groupName', Types.String, true)
    @param('page', Types.PositiveInt, true)
    async postBackfillEvaluation({ domainId }, groupName = '', page = 1) {
        if (!getEvaluationConfig().enabled) {
            this.response.redirect = withQuery(this.url('course_summary_manage', { taskId: this.task._id }), {
                groupName,
                message: 'AI 评测服务未配置，无法补评历史小结。',
                page: page > 1 ? page : '',
            });
            return;
        }
        const groupUids = await getGroupUids(this.domain._id, groupName);
        const query: any = { domainId: this.domain._id, taskId: this.task._id };
        if (groupUids) query.uid = { $in: Array.from(groupUids) };
        const submits = await collSubmit.find(query).sort({ updatedAt: -1 }).toArray() as SummarySubmit[];
        const targets = submits.filter((item) => !compactText(item.evaluationId) && compactText(item.content));
        let created = 0;
        let failed = 0;
        const targetTitle = targetName(this.task.targetType, this.csdoc, this.ssdoc);
        for (const submit of targets) {
            if (await createSummaryEvaluation(this.task, submit, targetTitle)) created++;
            else failed++;
        }
        const message = targets.length
            ? `已向 AI 评测服务提交 ${created} 篇历史小结${failed ? `，${failed} 篇提交失败` : ''}。`
            : '当前筛选下没有需要补评的历史小结。';
        this.response.redirect = withQuery(this.url('course_summary_manage', { taskId: this.task._id }), {
            groupName,
            message,
            page: page > 1 ? page : '',
        });
    }

    @param('groupName', Types.String, true)
    @param('page', Types.PositiveInt, true)
    async postRemind({ domainId }, groupName = '', page = 1) {
        const groupUids = await getGroupUids(this.domain._id, groupName);
        const sent = await sendTaskReminders(this.task, false, groupUids);
        this.response.body = { sent };
        this.response.redirect = withQuery(this.url('course_summary_manage', { taskId: this.task._id }), {
            groupName,
            page: page > 1 ? page : '',
        });
    }
}

class CourseSummaryManageSubmitHandler extends Handler {
    task: SummaryTask;
    submit: SummarySubmit;
    cdoc: any;
    csdoc: any;
    ssdoc: any;
    canReview = false;
    isOwner = false;

    @param('taskId', Types.ObjectId)
    @param('submitId', Types.ObjectId)
    async prepare({ domainId }, taskId: ObjectId, submitId: ObjectId) {
        const [task, submit] = await Promise.all([
            collTask.findOne({ domainId: this.domain._id, _id: taskId }) as Promise<SummaryTask | null>,
            collSubmit.findOne({ domainId: this.domain._id, taskId, _id: submitId }) as Promise<SummarySubmit | null>,
        ]);
        if (!task) throw new NotFoundError('summary task not found');
        if (!submit) throw new NotFoundError('summary submit not found');
        const target = await resolveTarget(this.domain._id, task.courseId, task.sectionId, task.subsecId, task.targetType);
        this.canReview = this.user.hasPerm(PERM.PERM_EDIT_TRAINING);
        this.isOwner = Number(submit.uid) === Number(this.user._id);
        if (!this.canReview && !this.isOwner) throw new ForbiddenError('只能查看自己的课程小结。');
        this.task = task;
        this.submit = submit;
        this.cdoc = target.cdoc;
        this.csdoc = target.csdoc;
        this.ssdoc = target.ssdoc;
    }

    @param('groupName', Types.String, true)
    @param('page', Types.PositiveInt, true)
    async get({ domainId }, groupName = '', page = 1) {
        this.submit = await refreshEvaluationQuietly(this.submit) as SummarySubmit;
        const udict = await UserModel.getList(this.domain._id, [this.submit.uid]);
        this.response.template = 'course_summary_manage_submit.html';
        this.response.body = {
            page_name: 'course_summary_manage',
            task: this.task,
            submit: {
                ...submitForView(this.submit),
                displayWordCount: countWords(this.submit.content || ''),
                storedWordCount: Number(this.submit.wordCount) || 0,
            },
            udict,
            groupName,
            page,
            canReview: this.canReview,
            isOwner: this.isOwner,
            targetTitle: targetName(this.task.targetType, this.csdoc, this.ssdoc),
            listUrl: this.canReview
                ? withQuery(this.url('course_summary_manage', { taskId: this.task._id }), {
                    groupName,
                    page: page > 1 ? page : '',
                })
                : courseTargetUrl(this, this.task.targetType, this.task.courseId, this.task.sectionId, this.task.subsecId),
            editUrl: this.isOwner ? this.url('course_summary_submit', { taskId: this.task._id }) : '',
        };
    }

    @param('excellent', Types.Boolean, true)
    @param('groupName', Types.String, true)
    @param('page', Types.PositiveInt, true)
    async postReview({ domainId }, excellent = false, groupName = '', page = 1) {
        if (!this.canReview) throw new ForbiddenError('没有批改课程小结的权限。');
        await collSubmit.updateOne(
            { domainId: this.domain._id, taskId: this.task._id, _id: this.submit._id },
            {
                $set: {
                    wordCount: countWords(this.submit.content || ''),
                    excellent: !!excellent,
                    reviewedBy: this.user._id,
                    reviewedAt: new Date(),
                },
            },
        );
        this.response.redirect = withQuery(this.url('course_summary_manage_submit', { taskId: this.task._id, submitId: this.submit._id }), {
            groupName,
            page: page > 1 ? page : '',
        });
    }

    @param('groupName', Types.String, true)
    @param('page', Types.PositiveInt, true)
    async postRefreshEvaluation({ domainId }, groupName = '', page = 1) {
        await refreshSummaryEvaluation(this.submit);
        this.response.redirect = withQuery(this.url('course_summary_manage_submit', { taskId: this.task._id, submitId: this.submit._id }), {
            groupName,
            page: page > 1 ? page : '',
        });
    }
}

class DomainLearningCenterHandler extends Handler {
    async prepare() {
        this.checkPerm(PERM.PERM_EDIT_DOMAIN);
    }

    @param('message', Types.String, true)
    async get({ domainId }, message = '') {
        const [pointTable, ledgers, excellent, taskCount, submitCount, groups] = await Promise.all([
            buildPointRows(this.domain._id),
            collLedger.find({ domainId: this.domain._id }).sort({ createdAt: -1 }).limit(100).toArray() as Promise<any[]>,
            collSubmit.find({ domainId: this.domain._id, excellent: true }).sort({ reviewedAt: -1 }).limit(8).toArray() as Promise<SummarySubmit[]>,
            collTask.countDocuments({ domainId: this.domain._id }),
            collSubmit.countDocuments({ domainId: this.domain._id }),
            UserModel.listGroup(this.domain._id),
        ]);
        const uids = Array.from(new Set([
            ...pointTable.rows.slice(0, 100).map((item) => item.uid),
            ...ledgers.map((item) => item.uid),
            ...ledgers.map((item) => item.operator),
            ...excellent.map((item) => item.uid),
        ].filter(Boolean)));
        const udict = await UserModel.getList(this.domain._id, uids);
        const taskIds = Array.from(new Set(excellent.map((item) => idText(item.taskId))));
        const tasks = taskIds.length ? await collTask.find({ domainId: this.domain._id, _id: { $in: excellent.map((item) => item.taskId) } }).toArray() as SummaryTask[] : [];
        const taskDict = Object.fromEntries(tasks.map((task) => [idText(task._id), task]));
        const totalPoints = pointTable.rows.reduce((sum, item) => sum + (Number(item.total) || 0), 0);
        this.response.template = 'domain_learning_center.html';
        this.response.body = {
            page_name: 'domain_learning_center',
            domainId: this.domain._id,
            domainName: this.domain.name || this.domain._id,
            ranking: pointTable.rows.slice(0, 20),
            ledgers,
            excellent,
            taskDict,
            udict,
            groups,
            taskCount,
            submitCount,
            totalPoints,
            pointTableUrl: this.url('domain_learning_point_table'),
            excellentUrl: this.url('course_summary_excellent'),
            messages: message ? [message] : [],
        };
    }

    @param('uidOrName', Types.String)
    @param('amount', Types.Int)
    @param('sourceType', Types.Range(['manual', 'contest', 'recent_status', 'adjustment']))
    @param('reason', Types.Content, true)
    async postAward({ domainId }, uidOrName: string, amount: number, sourceType: PointSourceType, reason = '') {
        if (!amount) throw new ValidationError('amount', amount, '积分变动不能为 0');
        const key = uidOrName.trim();
        const udoc = await UserModel.getById(this.domain._id, Number(key))
            || await UserModel.getByUname(this.domain._id, key)
            || await UserModel.getByEmail(this.domain._id, key);
        if (!udoc) throw new ValidationError('uidOrName', uidOrName, '找不到这个用户');
        await addPoints(
            this.domain._id,
            udoc._id,
            Number(amount),
            reason || '教师手动调整学习积分',
            sourceType,
            null,
            this.user._id,
        );
        this.response.redirect = withQuery(this.url('domain_learning_center'), { message: '单人积分已发放' });
    }

    @param('contestId', Types.ObjectId)
    @param('contestRankPoints', Types.String, true)
    @param('contestRate', Types.Int, true)
    @param('contestBase', Types.Int, true)
    @param('contestGroupName', Types.String, true)
    @param('contestBatchKey', Types.String, true)
    async postContestAward(
        { domainId },
        contestId: ObjectId,
        contestRankPoints = '5,4,3,2,1',
        contestRate = 0,
        contestBase = 0,
        contestGroupName = '',
        contestBatchKey = '',
    ) {
        const result = await awardContestScore(
            this.domain._id,
            contestId,
            contestRankPoints,
            contestRate,
            contestBase,
            contestGroupName,
            contestBatchKey,
            this.user._id,
        );
        this.response.redirect = withQuery(this.url('domain_learning_center'), {
            message: `比赛加分完成：扫描 ${result.scanned} 人，发放 ${result.awarded} 人，跳过重复 ${result.skipped} 人`,
        });
    }

    @param('recentDays', Types.PositiveInt, true)
    @param('recentDailyPoint', Types.Int, true)
    @param('recentSubmitPoint', Types.Int, true)
    @param('recentAcceptPoint', Types.Int, true)
    @param('recentGroupName', Types.String, true)
    @param('recentBatchKey', Types.String, true)
    @param('recentReason', Types.Content, true)
    async postRecentAward(
        { domainId },
        recentDays = 1,
        recentDailyPoint = 1,
        recentSubmitPoint = 0,
        recentAcceptPoint = 0,
        recentGroupName = '',
        recentBatchKey = '',
        recentReason = '',
    ) {
        const result = await awardRecentStatus(
            this.domain._id,
            recentDays,
            recentDailyPoint,
            recentSubmitPoint,
            recentAcceptPoint,
            recentGroupName,
            recentBatchKey,
            recentReason,
            this.user._id,
        );
        this.response.redirect = withQuery(this.url('domain_learning_center'), {
            message: `近期状态加分完成：扫描 ${result.scanned} 条每日记录，发放 ${result.awarded} 条，跳过重复 ${result.skipped} 条`,
        });
    }

    @param('ledgerId', Types.ObjectId)
    async postDeleteLedger({ domainId }, ledgerId: ObjectId) {
        const bill = await deletePointLedger(this.domain._id, ledgerId);
        this.response.redirect = withQuery(this.url('domain_learning_center'), {
            message: `已删除积分记录：UID ${bill.uid}，变动 ${bill.amount}`,
        });
    }
}

class DomainLearningPointTableHandler extends Handler {
    async prepare() {
        this.checkPerm(PERM.PERM_VIEW_RANKING);
    }

    @param('groupName', Types.String, true)
    @param('csv', Types.Boolean, true)
    async get({ domainId }, groupName = '', csv = false) {
        const canManagePoints = this.user.hasPerm(PERM.PERM_EDIT_DOMAIN);
        const { rows, udict, groups } = await buildPointRows(this.domain._id, groupName);
        if (csv) {
            if (!canManagePoints) throw new ForbiddenError('Only domain managers can export learning points.');
            const data = [
                ['排名', 'UID', '用户名', '小组', '总积分', '小结', '比赛成绩', '近期状态', '更新时间'],
                ...rows.map((row: any) => [
                    row.rank,
                    row.uid,
                    row.uname,
                    row.groups.join('|'),
                    row.total,
                    row.summary,
                    row.contest,
                    row.recentStatus,
                    row.updatedAt || '',
                ]),
            ];
            this.binary(toCsv(data), `learning_points_${this.domain._id}_${groupName || 'all'}.csv`);
            return;
        }
        this.response.template = 'domain_learning_point_table.html';
        this.response.body = {
            page_name: 'domain_learning_point_table',
            rows,
            udict,
            groups,
            filterGroupName: groupName || 'all',
            qs: groupName && groupName !== 'all' ? `groupName=${encodeURIComponent(groupName)}` : '',
            canManagePoints,
            exportUrl: canManagePoints ? withQuery(this.url('domain_learning_point_table'), { groupName, csv: true }) : '',
            centerUrl: canManagePoints ? this.url('domain_learning_center') : '',
        };
    }
}

class CourseSummaryExcellentHandler extends Handler {
    @param('groupName', Types.String, true)
    @param('csv', Types.Boolean, true)
    async get({ domainId }, groupName = '', csv = false) {
        const canFilter = this.user.hasPerm(PERM.PERM_EDIT_TRAINING) || this.user.hasPerm(PERM.PERM_EDIT_DOMAIN);
        const groupUids = canFilter ? await getGroupUids(this.domain._id, groupName) : null;
        const query: any = { domainId: this.domain._id, excellent: true };
        if (groupUids) query.uid = { $in: Array.from(groupUids) };
        const submits = await collSubmit.find(query).sort({ reviewedAt: -1, updatedAt: -1 }).limit(csv ? 2000 : 100).toArray() as SummarySubmit[];
        const taskIds = Array.from(new Set(submits.map((item) => idText(item.taskId))));
        const [tasks, udict, groups] = await Promise.all([
            taskIds.length ? collTask.find({ domainId: this.domain._id, _id: { $in: submits.map((item) => item.taskId) } }).toArray() as Promise<SummaryTask[]> : Promise.resolve([]),
            UserModel.getList(this.domain._id, submits.map((item) => item.uid)),
            UserModel.listGroup(this.domain._id),
        ]);
        const taskDict = Object.fromEntries(tasks.map((task) => [idText(task._id), task]));
        if (csv) {
            const data = [
                ['UID', '用户名', '任务', '字数', '分数', '积分', '评语', '提交时间', '批改时间', '内容'],
                ...submits.map((submit) => {
                    const task = taskDict[idText(submit.taskId)] as SummaryTask | undefined;
                    return [
                        submit.uid,
                        udict[submit.uid]?.uname || '',
                        task?.title || idText(submit.taskId),
                        submit.wordCount,
                        submit.score ?? '',
                        submit.awardedPoints || 0,
                        submit.comment || '',
                        submit.updatedAt || '',
                        submit.reviewedAt || '',
                        submit.content || '',
                    ];
                }),
            ];
            this.binary(toCsv(data), `excellent_summaries_${this.domain._id}_${groupName || 'all'}.csv`);
            return;
        }
        this.response.template = 'course_summary_excellent.html';
        this.response.body = {
            page_name: 'course_summary_excellent',
            submits,
            taskDict,
            udict,
            groups,
            canFilter,
            filterGroupName: groupName || 'all',
            exportUrl: withQuery(this.url('course_summary_excellent'), { groupName: canFilter ? groupName : '', csv: true }),
            centerUrl: this.user.hasPerm(PERM.PERM_EDIT_DOMAIN) ? this.url('domain_learning_center') : '',
        };
    }
}

export async function apply(ctx: Context) {
    pluginContext = ctx;
    await db.ensureIndexes(
        collTask,
        { key: { domainId: 1, courseId: 1, sectionId: 1, subsecId: 1, targetType: 1 }, name: 'course_summary_target', unique: true },
        { key: { domainId: 1, dailyReminder: 1, deadline: 1 }, name: 'course_summary_reminder' },
    );
    await db.ensureIndexes(
        collSubmit,
        { key: { domainId: 1, taskId: 1, uid: 1 }, name: 'course_summary_submit_user', unique: true },
        { key: { domainId: 1, uid: 1, updatedAt: -1 }, name: 'course_summary_submit_uid' },
    );
    await db.ensureIndexes(
        collLedger,
        { key: { domainId: 1, uid: 1, createdAt: -1 }, name: 'course_points_uid_time' },
        { key: { domainId: 1, sourceType: 1, sourceId: 1 }, name: 'course_points_source' },
    );
    await db.ensureIndexes(
        collPointSummary,
        { key: { domainId: 1, uid: 1 }, name: 'course_points_uid', unique: true },
        { key: { domainId: 1, total: -1 }, name: 'course_points_rank' },
    );
    await db.ensureIndexes(
        collReminder,
        { key: { domainId: 1, taskId: 1, uid: 1, date: 1 }, name: 'course_summary_daily_reminder', unique: true },
    );

    (globalThis as any).Hydro = (globalThis as any).Hydro || {};
    (globalThis as any).Hydro.model = (globalThis as any).Hydro.model || {};
    (globalThis as any).Hydro.model.courseSummaryPoints = {
        addPoints,
        sendTaskReminders,
    };

    ctx.inject(['setting'], (c) => {
        c.setting.SystemSetting(
            SettingModel.Setting('SummaryEvaluation', 'SummaryEvaluation.serverUrl', '', 'text', 'Summary evaluation server URL', 'For example: http://127.0.0.1:8000'),
            SettingModel.Setting('SummaryEvaluation', 'SummaryEvaluation.apiKey', '', 'text', 'Summary evaluation API key', 'Bearer token used by evaluation-server'),
            SettingModel.Setting('SummaryEvaluation', 'SummaryEvaluation.timeoutMs', 8000, 'number', 'Summary evaluation timeout', 'Request timeout in milliseconds'),
        );
    });

    ctx.Route('course_summary_widget', '/course-summary/widget', CourseSummaryWidgetHandler, PERM.PERM_VIEW_TRAINING);
    ctx.Route('course_summary_task_edit', '/course-summary/task/:targetType/:cid/:csid/edit', CourseSummaryTaskEditHandler, PERM.PERM_EDIT_TRAINING);
    ctx.Route('course_summary_task_edit_existing', '/course-summary/task/:taskId/edit', CourseSummaryTaskEditExistingHandler, PERM.PERM_EDIT_TRAINING);
    ctx.Route('course_summary_submit', '/course-summary/task/:taskId/submit', CourseSummarySubmitHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('course_summary_submit_refresh', '/course-summary/task/:taskId/submit/refresh-ai', CourseSummarySubmitRefreshHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('course_summary_manage', '/course-summary/task/:taskId/manage', CourseSummaryManageHandler, PERM.PERM_EDIT_TRAINING);
    ctx.Route('course_summary_manage_submit', '/course-summary/task/:taskId/submit/:submitId', CourseSummaryManageSubmitHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('course_summary_excellent', '/course-summary/excellent', CourseSummaryExcellentHandler, PERM.PERM_VIEW_TRAINING);
    ctx.Route('domain_learning_center', '/domain/learning-center', DomainLearningCenterHandler, PERM.PERM_EDIT_DOMAIN);
    ctx.Route('domain_learning_point_table', '/ranking/learning-points', DomainLearningPointTableHandler, PERM.PERM_VIEW_RANKING);
    ctx.Route('domain_learning_point_table_legacy', '/domain/learning-points', DomainLearningPointTableHandler, PERM.PERM_VIEW_RANKING);
    ctx.injectUI('Nav', 'domain_learning_point_table', { prefix: 'domain_learning_point_table', before: 'domain_dashboard' }, PERM.PERM_VIEW_RANKING);
    ctx.injectUI('DomainManage', 'domain_learning_center', { family: 'Training', icon: 'award' }, PERM.PERM_EDIT_DOMAIN);
    ctx.injectUI('DomainManage', 'domain_learning_point_table', { family: 'Training', icon: 'statistics' }, PERM.PERM_EDIT_DOMAIN);
    ctx.i18n.load('zh', {
        course_summary_task_edit: '课程小结设置',
        course_summary_submit: '课程小结',
        course_summary_manage: '小结批改',
        domain_learning_center: '学习积分',
    });
    ctx.i18n.load('en', {
        course_summary_task_edit: 'Course Summary Task',
        course_summary_submit: 'Course Summary',
        course_summary_manage: 'Summary Review',
        domain_learning_center: 'Learning Points',
    });
    ctx.i18n.load('zh', {
        course_summary_excellent: '优秀小结',
        domain_learning_point_table: '积分榜',
    });
    ctx.i18n.load('en', {
        course_summary_excellent: 'Excellent Summaries',
        domain_learning_point_table: 'Point Table',
    });
    startReminderLoop(ctx);
}
