import { Context, Handler, PERM, ProblemModel, Types, param } from 'hydrooj';

const PID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
type SequenceType = 'number' | 'letter';

interface ResolvedProblem {
    docId: number;
    pid?: string;
    title?: string;
}

interface BatchRow {
    lineNo: number;
    source: string;
    lookupBy: 'pid' | 'title' | 'auto' | 'empty';
    docId?: number;
    oldPid?: string;
    newPid?: string;
    oldTitle?: string;
    status: 'ok' | 'noop' | 'reserved' | 'error' | 'done';
    message: string;
}

interface SourceLine {
    lineNo: number;
    source: string;
    lookupBy: 'pid' | 'title' | 'auto' | 'empty';
    title?: string;
}

function looksLikePidToken(value: string) {
    return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value) && /\d/.test(value);
}

function splitTableColumns(line: string) {
    if (line.includes('\t')) return line.split('\t');
    const separator = line.match(/[，,；;]/);
    if (!separator || separator.index === undefined) return null;
    return [
        line.slice(0, separator.index),
        line.slice(separator.index + separator[0].length),
    ];
}

function parseSourceLines(raw: string) {
    const rows: SourceLine[] = [];
    const lines = (raw || '').split(/\r?\n/);
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    for (const line of lines) {
        const source = line.trim();
        if (!source) {
            rows.push({ lineNo: rows.length + 1, source: '', lookupBy: 'empty' });
            continue;
        }
        if (source.startsWith('#')) continue;

        const columns = splitTableColumns(line);
        if (columns) {
            const first = (columns[0] || '').trim();
            const second = columns.slice(1).join('\t').trim();
            if (/^(比赛域)?题号$|^pid$|^docid$/i.test(first) && /^题目名$|^title$/i.test(second)) continue;
            rows.push({
                lineNo: rows.length + 1,
                source: first || second,
                lookupBy: first ? 'pid' : 'title',
                title: second || undefined,
            });
            continue;
        }

        const words = splitWords(source);
        if (words.length > 1 && words.every(looksLikePidToken)) {
            for (const token of words) rows.push({ lineNo: rows.length + 1, source: token, lookupBy: 'pid' });
        } else {
            rows.push({ lineNo: rows.length + 1, source, lookupBy: 'auto' });
        }
    }
    return rows;
}

function splitWords(raw: string) {
    return raw
        .split(/[,\t;，；\s]+/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function safeDecodeURIComponent(value: string) {
    try {
        return decodeURIComponent(value);
    } catch (e) {
        return value;
    }
}

function sourceCandidates(source: string) {
    const words = splitWords(source);
    const result: string[] = [];
    const push = (value?: string) => {
        const item = (value || '').trim();
        if (item && !result.includes(item)) result.push(item);
    };

    for (const word of words) {
        const explicit = word.match(/^(doc|docId|pid):(.+)$/i);
        if (explicit) push(explicit[2]);
    }
    for (const word of words) {
        const url = word.match(/\/p\/([^/?#\s]+)/);
        if (url) push(safeDecodeURIComponent(url[1]));
    }
    for (const word of words) push(word);
    push(source);
    return result;
}

function normalizeSequenceType(value: string): SequenceType {
    return value === 'letter' ? 'letter' : 'number';
}

function normalizeAlphaStart(value: string) {
    const clean = (value || 'A').trim().replace(/[^A-Za-z]/g, '').toUpperCase();
    return clean || 'A';
}

function alphaLabelToNumber(label: string) {
    let value = 0;
    const normalized = normalizeAlphaStart(label);
    for (const ch of normalized) value = value * 26 + (ch.charCodeAt(0) - 64);
    return Math.max(0, value - 1);
}

function numberToAlphaLabel(value: number) {
    let n = Math.max(0, Math.floor(value));
    let label = '';
    do {
        label = String.fromCharCode(65 + (n % 26)) + label;
        n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return label;
}

function generateTargetPids(count: number, prefix: string, start: number, width: number, sequenceType: SequenceType, alphaStart: string) {
    if (sequenceType === 'letter') {
        const base = alphaLabelToNumber(alphaStart);
        const list: string[] = [];
        for (let i = 0; i < count; i++) list.push(`${prefix || ''}${numberToAlphaLabel(base + i)}`);
        return list;
    }

    const safeStart = Number.isFinite(start) ? start : 1;
    const safeWidth = Number.isFinite(width) ? width : 2;
    const list: string[] = [];
    for (let i = 0; i < count; i++) {
        list.push(`${prefix || ''}${String(safeStart + i).padStart(Math.max(0, safeWidth), '0')}`);
    }
    return list;
}

function validatePid(pid: string) {
    if (!PID_PATTERN.test(pid)) return 'PID 只能包含字母、数字、下划线和连字符，且长度不超过 64。';
    if (/^\d+$/.test(pid)) return 'PID 不能是纯数字，否则会和 Hydro 的 docId 查询混淆。';
    return '';
}

function queryText(value: any) {
    if (Array.isArray(value)) return value.join('\n');
    return typeof value === 'string' ? value : '';
}

async function tryGetProblem(domainId: string, token: string): Promise<ResolvedProblem | null> {
    const value = token.trim();
    if (!value) return null;

    const attempts: Array<string | number> = [value];
    if (/^\d+$/.test(value)) attempts.push(Number(value));

    for (const attempt of attempts) {
        try {
            const pdoc = await ProblemModel.get(domainId, attempt as any, ProblemModel.PROJECTION_PUBLIC, true);
            if (pdoc) return pdoc as any;
        } catch (e) {
            // Try the next interpretation.
        }
    }
    return null;
}

async function tryGetProblemByTitle(domainId: string, title: string) {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) return { pdoc: null, message: '' };
    const matches = await ProblemModel.getMulti(
        domainId,
        { title: normalizedTitle } as any,
        ProblemModel.PROJECTION_PUBLIC,
    ).limit(2).toArray();
    if (matches.length === 1) return { pdoc: matches[0] as any, message: '' };
    if (matches.length > 1) return { pdoc: null, message: `题目名 "${normalizedTitle}" 匹配到多道题，请在第一列补充 PID 或 docId。` };
    return { pdoc: null, message: '' };
}

async function resolveProblemByPid(domainId: string, source: string) {
    for (const candidate of sourceCandidates(source)) {
        const pdoc = await tryGetProblem(domainId, candidate);
        if (pdoc) return pdoc;
    }
    return null;
}

async function resolveSourceProblem(domainId: string, item: SourceLine) {
    if (item.lookupBy === 'empty') return { pdoc: null, message: '空行。' };
    if (item.lookupBy === 'title') return tryGetProblemByTitle(domainId, item.title || item.source);

    const pdoc = await resolveProblemByPid(domainId, item.source);
    if (pdoc) return { pdoc, message: '' };

    if (item.lookupBy === 'pid') return { pdoc: null, message: `未按 PID/docId 找到 "${item.source}"。` };
    const title = item.title || item.source;
    return tryGetProblemByTitle(domainId, title);
}

async function buildRows(domainId: string, problemIds: string, prefix: string, start: number, width: number, sequenceType: SequenceType, alphaStart: string) {
    const messages: string[] = [];
    const sourceLines = parseSourceLines(problemIds);
    const rows: BatchRow[] = [];

    if (!sourceLines.length) {
        messages.push('请至少按顺序输入一个当前 PID、docId 或题目名。');
        return { rows, messages };
    }

    const generatedTargets = generateTargetPids(sourceLines.length, prefix, start, width, sequenceType, alphaStart);

    for (const [index, item] of sourceLines.entries()) {
        const { pdoc, message } = await resolveSourceProblem(domainId, item);
        if (!pdoc) {
            rows.push({
                lineNo: item.lineNo,
                source: item.source,
                lookupBy: item.lookupBy,
                newPid: generatedTargets[index],
                status: 'reserved',
                message: `${message || '未找到题目。'} 已保留该编号，执行时跳过。`,
            });
            continue;
        }
        rows.push({
            lineNo: item.lineNo,
            source: item.source,
            lookupBy: item.lookupBy,
            docId: pdoc.docId,
            oldPid: pdoc.pid || '',
            newPid: generatedTargets[index],
            oldTitle: pdoc.title || '',
            status: 'ok',
            message: '待检查。',
        });
    }

    const selectedDocIds = new Set<number>();
    const targetSeen = new Map<string, BatchRow>();
    for (const row of rows) {
        if (row.docId && selectedDocIds.has(row.docId)) {
            row.status = 'error';
            row.message = '同一题目被重复选择。';
            continue;
        }
        if (row.docId) selectedDocIds.add(row.docId);

        const pidError = validatePid(row.newPid || '');
        if (pidError) {
            row.status = 'error';
            row.message = pidError;
            continue;
        }

        if (targetSeen.has(row.newPid!)) {
            row.status = 'error';
            row.message = `新 PID "${row.newPid}" 在本批次中重复。`;
            continue;
        }
        targetSeen.set(row.newPid!, row);

        if (!row.docId) continue;

        const pidChanged = row.oldPid !== row.newPid;
        if (!pidChanged) {
            row.status = 'noop';
            row.message = '新旧 PID 相同，执行时会跳过。';
            continue;
        }

        row.status = 'ok';
        row.message = '可以修改 PID。';
    }

    const selectedRowsByDocId = new Map<number, BatchRow>();
    for (const row of rows) {
        if (row.docId && !selectedRowsByDocId.has(row.docId)) selectedRowsByDocId.set(row.docId, row);
    }

    for (const row of rows) {
        if (!['ok', 'reserved'].includes(row.status) || !row.newPid) continue;
        const exists = await tryGetProblem(domainId, row.newPid);
        if (!exists || exists.docId === row.docId) continue;

        const ownerRow = selectedRowsByDocId.get(exists.docId);
        if (!ownerRow) {
            row.status = 'error';
            row.message = `新 PID "${row.newPid}" 已被 docId=${exists.docId} 使用。`;
        } else if (ownerRow.status === 'noop') {
            row.status = 'error';
            row.message = `新 PID "${row.newPid}" 被本批次 docId=${exists.docId} 保留，不能占用。`;
        } else if (ownerRow.status === 'error') {
            row.status = 'error';
            row.message = `新 PID "${row.newPid}" 属于本批次中校验失败的题目，不能占用。`;
        } else if (!row.docId) {
            row.message = `未找到题目，编号 "${row.newPid}" 会在 docId=${exists.docId} 移走后空出，请后续单独补题。`;
        }
    }

    if (messages.length) {
        for (const row of rows) {
            if (row.status === 'ok') {
                row.status = 'error';
                row.message = '全局校验未通过，暂不允许执行。';
            }
        }
    }

    const errorCount = rows.filter((row) => row.status === 'error').length;
    const changeCount = rows.filter((row) => row.status === 'ok').length;
    const noopCount = rows.filter((row) => row.status === 'noop').length;
    const reservedCount = rows.filter((row) => row.status === 'reserved').length;
    messages.push(`预览完成：可修改 ${changeCount}，保留 ${reservedCount}，跳过 ${noopCount}，错误 ${errorCount}。`);

    return { rows, messages };
}

async function uniqueTempPid(domainId: string, index: number) {
    for (let attempt = 0; attempt < 20; attempt++) {
        const token = `${Date.now().toString(36)}_${index}_${attempt}`.toUpperCase();
        const pid = `TMP_${token}`;
        const exists = await tryGetProblem(domainId, pid);
        if (!exists) return pid;
    }
    throw new Error('无法生成未占用的临时 PID。');
}

async function executeRows(domainId: string, rows: BatchRow[]) {
    const messages: string[] = [];
    const changeRows = rows.filter((row) => row.status === 'ok' && row.docId && row.newPid && row.oldPid !== row.newPid);

    if (rows.some((row) => row.status === 'error')) {
        messages.push('存在错误行，已取消执行。请修正后重新预览。');
        return messages;
    }
    if (!changeRows.length) {
        messages.push('没有需要修改的题目。');
        return messages;
    }

    const temps: Array<{ row: BatchRow; tempPid: string }> = [];
    try {
        for (const [index, row] of changeRows.entries()) {
            const tempPid = await uniqueTempPid(domainId, index + 1);
            await ProblemModel.edit(domainId, row.docId!, { pid: tempPid } as any);
            temps.push({ row, tempPid });
        }
        for (const item of temps) {
            await ProblemModel.edit(domainId, item.row.docId!, { pid: item.row.newPid } as any);
            item.row.status = 'done';
            item.row.message = `已修改为 ${item.row.newPid}。`;
        }
        messages.push(`执行完成：成功修改 ${temps.length} 题。`);
    } catch (e: any) {
        messages.push(`执行失败：${e?.message || e}`);
        messages.push('正在尝试回滚已经进入临时 PID 的题目。');
        for (const item of temps) {
            item.row.status = 'error';
            try {
                await ProblemModel.edit(domainId, item.row.docId!, { pid: item.row.oldPid } as any);
                item.row.message = `已回滚为 ${item.row.oldPid}。`;
            } catch (rollbackError: any) {
                item.row.status = 'error';
                item.row.message = `回滚失败，请手动检查。${rollbackError?.message || rollbackError}`;
            }
        }
    }
    return messages;
}

class ProblemBatchPidHandler extends Handler {
    async prepare() {
        this.checkPerm(PERM.PERM_EDIT_DOMAIN);
    }

    async get() {
        const query = this.request.query || {};
        const problemIds = queryText(query.problemIds || query.pids);
        const prefix = typeof query.prefix === 'string' ? query.prefix : 'D';
        const start = Number.isSafeInteger(+query.start) ? +query.start : 1;
        const width = Number.isSafeInteger(+query.width) ? +query.width : 2;
        const sequenceType = normalizeSequenceType(typeof query.sequenceType === 'string' ? query.sequenceType : 'number');
        const alphaStart = normalizeAlphaStart(typeof query.alphaStart === 'string' ? query.alphaStart : 'A');

        this.response.template = 'problem_batch_pid.html';
        this.response.body = {
            page_name: 'problem_batch_pid',
            problemIds,
            prefix,
            start,
            width,
            sequenceType,
            alphaStart,
            rows: [],
            messages: [],
            executed: false,
        };
    }

    @param('problemIds', Types.Content)
    @param('prefix', Types.String, true)
    @param('start', Types.Int, true)
    @param('width', Types.Int, true)
    @param('sequenceType', Types.String, true)
    @param('alphaStart', Types.String, true)
    @param('action', Types.String)
    async post(domainId: string, problemIds: string, prefix = 'D', start = 1, width = 2, sequenceType = 'number', alphaStart = 'A', action = 'preview') {
        const realDomainId = this.domain._id;
        const normalizedPrefix = typeof prefix === 'string' ? prefix.trim() : 'D';
        const normalizedStart = Number.isFinite(start) ? start : 1;
        const normalizedWidth = Number.isFinite(width) ? width : 2;
        const normalizedSequenceType = normalizeSequenceType(sequenceType);
        const normalizedAlphaStart = normalizeAlphaStart(alphaStart);
        const state = await buildRows(realDomainId, problemIds, normalizedPrefix, normalizedStart, normalizedWidth, normalizedSequenceType, normalizedAlphaStart);
        let executed = false;

        if (action === 'execute') {
            const executeMessages = await executeRows(realDomainId, state.rows);
            state.messages.push(...executeMessages);
            executed = !state.rows.some((row) => row.status === 'error') && state.rows.some((row) => row.status === 'done');
        }

        this.response.template = 'problem_batch_pid.html';
        this.response.body = {
            page_name: 'problem_batch_pid',
            problemIds,
            prefix: normalizedPrefix,
            start: normalizedStart,
            width: normalizedWidth,
            sequenceType: normalizedSequenceType,
            alphaStart: normalizedAlphaStart,
            rows: state.rows,
            messages: state.messages,
            executed,
        };
    }
}

export async function apply(ctx: Context) {
    ctx.Route('problem_batch_pid', '/domain/problem-batch-pid', ProblemBatchPidHandler, PERM.PERM_EDIT_DOMAIN);
    ctx.injectUI('ProblemAdd', 'problem_batch_pid', { icon: 'edit', text: 'problem_batch_pid_order' }, PERM.PERM_EDIT_DOMAIN);

    ctx.i18n.load('zh', {
        problem_batch_pid: '批量修改题号',
        problem_batch_pid_order: '按顺序改题号',
    });
    ctx.i18n.load('en', {
        problem_batch_pid: 'Batch Rename Problem PID',
        problem_batch_pid_order: 'Rename by PID Order',
    });
}
