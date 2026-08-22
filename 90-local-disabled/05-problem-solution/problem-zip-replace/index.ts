import {
    Context,
    DocumentModel,
    FileUploadError,
    Handler,
    ObjectId,
    OplogModel,
    PERM,
    PermissionError,
    ProblemModel,
    SolutionModel,
    StorageModel,
    ValidationError,
    Zip,
    db,
    yaml,
} from 'hydrooj';
import { createReadStream } from 'fs';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';

const JOB_TTL_SECONDS = 24 * 3600;
const STORAGE_PREFIX = 'problem-zip-replace';
const jobs = db.collection('problem.zipReplaceJob');

const DIFFICULTY_TEXT = new Map<string, number>([
    ['暂无评定', 0],
    ['入门', 1],
    ['普及-', 2],
    ['普及', 3],
    ['普及+/提高-', 4],
    ['提高', 5],
    ['提高+/省选-', 6],
    ['省选/NOI-', 7],
    ['NOI/NOI+/CTS', 8],
    ['普及/提高-', 3],
    ['普及+/提高', 4],
    ['NOI/NOI+', 8],
    ['NOI/NOI+/CTSC', 8],
]);

const DIFFICULTY_LABELS = new Map<number, string>([
    [0, '暂无评定'],
    [1, '入门'],
    [2, '普及-'],
    [3, '普及'],
    [4, '普及+/提高-'],
    [5, '提高'],
    [6, '提高+/省选-'],
    [7, '省选/NOI-'],
    [8, 'NOI/NOI+/CTS'],
]);

interface ZipFileEntry {
    name: string;
    entry: any;
}

interface ZipProblem {
    index: number;
    folder: string;
    key: string;
    meta: any;
    content: string;
    testdata: ZipFileEntry[];
    additional: ZipFileEntry[];
    solutions: ZipFileEntry[];
}

interface ReplaceResult {
    title: string;
    testdataCount: number;
    additionalCount: number;
    addedSolutions: number;
    deletedSolutions: number;
}

interface BatchOptions {
    replaceSolutions: boolean;
}

interface BatchPreviewRow {
    index: number;
    sourceIndex: number;
    sourceFolder: string;
    sourcePid: string;
    sourceTitle: string;
    targetDocId?: number;
    targetPid?: string;
    targetTitle?: string;
    testdataCount: number;
    additionalCount: number;
    solutionCount: number;
    status: 'ok' | 'error' | 'done';
    message: string;
}

function asText(value: any, fallback = '') {
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return fallback;
    return String(value);
}

function asArray(value: any) {
    if (value === undefined || value === null || value === '') return [];
    return Array.isArray(value) ? value : [value];
}

function normalizeTags(value: any) {
    if (typeof value === 'string') {
        value = value.split(/[,，\n\r]+/).map((item) => item.trim()).filter(Boolean);
    }
    return Array.from(new Set(asArray(value).map((item) => {
        const text = asText(item).replace(/\s+/g, ' ').replace(/^难度\s*[:：]\s*/, '').trim();
        const difficulty = DIFFICULTY_TEXT.get(text);
        return difficulty !== undefined ? DIFFICULTY_LABELS.get(difficulty) : text;
    }).filter(Boolean)));
}

function normalizeDifficulty(value: any) {
    const direct = Number(value);
    if (Number.isFinite(direct) && direct >= 0 && direct <= 8) return direct;
    const textValue = DIFFICULTY_TEXT.get(asText(value).trim());
    if (textValue !== undefined) return textValue;
    return 0;
}

function boolOption(value: any, fallback = true) {
    if (Array.isArray(value)) value = value[value.length - 1];
    if (value === undefined || value === null || value === '') return fallback;
    return ['1', 'true', 'on', 'yes'].includes(String(value).toLowerCase());
}

function normalizeZipPath(filename: string) {
    return filename.replace(/\\/g, '/').replace(/^\/+/, '');
}

function isUnsafeZipName(filename: string) {
    const normalized = normalizeZipPath(filename);
    return !normalized || normalized.includes('\0') || normalized.split('/').some((part) => part === '..');
}

function safeStoredName(filename: string) {
    const normalized = normalizeZipPath(filename).replace(/^\/+/, '');
    if (isUnsafeZipName(normalized) || normalized.endsWith('/')) return '';
    return normalized;
}

function relPath(filename: string, prefix: string) {
    const normalized = normalizeZipPath(filename);
    return prefix ? normalized.slice(prefix.length) : normalized;
}

function problemYamlPrefix(filename: string) {
    const normalized = normalizeZipPath(filename);
    if (normalized === 'problem.yaml' || normalized === 'problem.yml') return '';
    if (normalized.endsWith('/problem.yaml')) return normalized.slice(0, -'problem.yaml'.length);
    if (normalized.endsWith('/problem.yml')) return normalized.slice(0, -'problem.yml'.length);
    return null;
}

async function readTextEntry(entry: any) {
    return entry.getData(new Zip.TextWriter());
}

function uniqueEntries(entries: ZipFileEntry[]) {
    const seen = new Set<string>();
    return entries.filter((entry) => {
        if (!entry.name || seen.has(entry.name)) return false;
        seen.add(entry.name);
        return true;
    });
}

async function readZipProblemsFromReader(reader: any) {
    const entries = await reader.getEntries();
    const files = entries.filter((entry) => !entry.directory && !isUnsafeZipName(entry.filename));
    const problemEntries = files
        .map((entry) => ({ entry, prefix: problemYamlPrefix(entry.filename) }))
        .filter((item) => item.prefix !== null) as { entry: any; prefix: string }[];
    if (!problemEntries.length) throw new ValidationError('file', null, 'ZIP 中没有找到 problem.yaml。');

    const problems: ZipProblem[] = [];
    for (const [index, item] of problemEntries.entries()) {
        const prefix = item.prefix;
        const meta = yaml.load(await readTextEntry(item.entry)) || {};
        const groupEntries = files.filter((entry) => normalizeZipPath(entry.filename).startsWith(prefix));
        const contentEntries = groupEntries
            .map((entry) => ({ entry, name: relPath(entry.filename, prefix) }))
            .filter((entry) => /^problem(?:_.+)?\.md$/i.test(entry.name));
        if (!contentEntries.length) {
            throw new ValidationError('file', null, `${prefix || '/'} 缺少 problem.md 或 problem_*.md。`);
        }

        let content = '';
        if (contentEntries.length === 1 && contentEntries[0].name.toLowerCase() === 'problem.md') {
            content = await readTextEntry(contentEntries[0].entry);
        } else {
            const payload: Record<string, string> = {};
            for (const contentEntry of contentEntries) {
                const match = contentEntry.name.match(/^problem_(.+)\.md$/i);
                const key = match?.[1] || 'zh';
                payload[key] = await readTextEntry(contentEntry.entry);
            }
            content = JSON.stringify(payload, null, 2);
        }

        const collect = (folder: string) => groupEntries
            .map((entry) => ({ entry, name: relPath(entry.filename, prefix) }))
            .filter((entry) => entry.name.startsWith(`${folder}/`))
            .map((entry) => ({
                entry: entry.entry,
                name: safeStoredName(entry.name.slice(folder.length + 1)),
            }))
            .filter((entry) => entry.name && !entry.name.endsWith('/'));

        const folderName = prefix.replace(/\/$/, '');
        problems.push({
            index: index + 1,
            folder: folderName,
            key: folderName || `problem-${index + 1}`,
            meta,
            content,
            testdata: uniqueEntries(collect('testdata')),
            additional: uniqueEntries([...collect('additional_file'), ...collect('additional')]),
            solutions: uniqueEntries([...collect('solution'), ...collect('solutions'), ...collect('sol')]),
        });
    }
    return problems;
}

async function readZipProblemsFromPath(filepath: string) {
    const reader = new Zip.ZipReader(Readable.toWeb(createReadStream(filepath)) as any);
    try {
        return await readZipProblemsFromReader(reader);
    } finally {
        await reader.close();
    }
}

async function readZipProblemsFromStorage(storagePath: string) {
    const stream = await StorageModel.get(storagePath);
    const reader = new Zip.ZipReader(Readable.toWeb(stream) as any);
    try {
        return await readZipProblemsFromReader(reader);
    } finally {
        await reader.close();
    }
}

async function tryGetProblem(domainId: string, token: string) {
    const value = token.trim();
    if (!value) return null;
    const attempts: any[] = [value];
    if (/^\d+$/.test(value)) attempts.unshift(Number(value));
    if (/^P\d+$/i.test(value)) attempts.push(Number(value.slice(1)));
    for (const attempt of attempts) {
        try {
            const pdoc = await ProblemModel.get(domainId, attempt, ProblemModel.PROJECTION_PUBLIC, true);
            if (pdoc) return pdoc as any;
        } catch (error) {
            // Try the next lookup form.
        }
    }
    return null;
}

function fileMeta(name: string, meta: any) {
    return {
        _id: name,
        name,
        size: meta?.size || 0,
        lastModified: meta?.lastModified,
        etag: meta?.etag,
    };
}

async function writeEntryToStorage(entry: any, storagePath: string, uid: number) {
    const Writer = (Zip as any).Uint8ArrayWriter;
    if (!Writer) throw new ValidationError('file', null, '当前 Hydro Zip 组件不支持读取二进制文件。');
    const bytes = await entry.getData(new Writer());
    const tmp = join(tmpdir(), `problem-zip-replace-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.writeFile(tmp, Buffer.from(bytes));
    try {
        await StorageModel.put(storagePath, tmp, uid);
        const meta = await StorageModel.getMeta(storagePath);
        if (!meta) throw new FileUploadError();
        return meta;
    } finally {
        await fs.unlink(tmp).catch(() => {});
    }
}

async function replaceProblemFiles(
    domainId: string,
    docId: number,
    area: 'testdata' | 'additional_file',
    oldFiles: any[],
    entries: ZipFileEntry[],
    uid: number,
) {
    const nextFiles: any[] = [];
    for (const item of entries) {
        const target = `problem/${domainId}/${docId}/${area}/${item.name}`;
        const meta = await writeEntryToStorage(item.entry, target, uid);
        nextFiles.push(fileMeta(item.name, meta));
    }
    const keep = new Set(nextFiles.map((item) => item.name));
    const stale = (oldFiles || [])
        .filter((item) => item?.name && !keep.has(item.name))
        .map((item) => `problem/${domainId}/${docId}/${area}/${item.name}`);
    if (stale.length) await StorageModel.del(stale, uid);
    return nextFiles;
}

function copyExtraProblemFields(meta: any, update: any) {
    const extraFields = [
        'config', 'type', 'subType', 'judge', 'checker', 'validator', 'spj',
        'interactive', 'hackable', 'lang', 'langs', 'source', 'display',
        'disable_sol',
    ];
    for (const field of extraFields) {
        if (meta?.[field] !== undefined) update[field] = meta[field];
    }
    const skipFields = new Set([
        '_id', 'docId', 'domainId', 'pid', 'owner',
        'title', 'content', 'tag', 'difficulty', 'hidden',
        'data', 'testdata', 'additional', 'additional_file',
        'solution', 'solutions', 'sol',
        'nSubmit', 'nAccept',
    ]);
    for (const [field, value] of Object.entries(meta || {})) {
        if (skipFields.has(field) || update[field] !== undefined) continue;
        update[field] = value;
    }
}

async function replaceProblemSolutions(domainId: string, docId: number, entries: ZipFileEntry[], uid: number) {
    const nextContents: string[] = [];
    for (const item of entries) {
        const content = await readTextEntry(item.entry);
        if (content.trim()) nextContents.push(content);
    }

    const oldSolutions = await SolutionModel.getMulti(domainId, docId).toArray();
    for (const psdoc of oldSolutions) {
        const psid = psdoc.docId || psdoc._id;
        if (!psid) continue;
        await (DocumentModel as any).deleteOne(domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, psid);
        await (DocumentModel as any).deleteMultiStatus(domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, { docId: psid }).catch(() => {});
        if (psdoc.filename) {
            await StorageModel.del([`problem-sol/${domainId}/${psid}/${psdoc.filename}`], uid).catch(() => {});
        }
    }

    let addedSolutions = 0;
    for (const content of nextContents) {
        await SolutionModel.add(domainId, docId, uid, content);
        addedSolutions += 1;
    }
    return { deletedSolutions: oldSolutions.length, addedSolutions };
}

async function replaceCurrentProblem(domainId: string, pdoc: any, source: ZipProblem, uid: number, replaceSolutions: boolean): Promise<ReplaceResult> {
    const update: any = {
        title: asText(source.meta?.title, pdoc.title || ''),
        content: source.content,
        tag: normalizeTags(source.meta?.tag),
        difficulty: normalizeDifficulty(source.meta?.difficulty),
        data: await replaceProblemFiles(domainId, pdoc.docId, 'testdata', pdoc.data || [], source.testdata, uid),
        additional_file: await replaceProblemFiles(domainId, pdoc.docId, 'additional_file', pdoc.additional_file || [], source.additional, uid),
    };
    if (source.meta?.hidden !== undefined) update.hidden = !!source.meta.hidden;
    copyExtraProblemFields(source.meta, update);

    // Deliberately keep docId and pid unchanged so existing course/course-package references remain valid.
    delete update.docId;
    delete update.pid;
    delete update._id;

    await ProblemModel.edit(domainId, pdoc.docId, update);
    const solutionResult = replaceSolutions
        ? await replaceProblemSolutions(domainId, pdoc.docId, source.solutions, uid)
        : { deletedSolutions: 0, addedSolutions: 0 };

    return {
        title: update.title,
        testdataCount: source.testdata.length,
        additionalCount: source.additional.length,
        ...solutionResult,
    };
}

function sourcePid(problem: ZipProblem) {
    return asText(problem.meta?.pid).trim();
}

async function buildBatchPreviewRows(domainId: string, problems: ZipProblem[]) {
    const rows: BatchPreviewRow[] = [];
    const messages: string[] = [];
    const seenSourcePids = new Set<string>();
    const seenTargets = new Set<number>();

    for (const problem of problems) {
        const pid = sourcePid(problem);
        const row: BatchPreviewRow = {
            index: rows.length + 1,
            sourceIndex: problem.index,
            sourceFolder: problem.folder || '/',
            sourcePid: pid,
            sourceTitle: asText(problem.meta?.title),
            testdataCount: problem.testdata.length,
            additionalCount: problem.additional.length,
            solutionCount: problem.solutions.length,
            status: 'ok',
            message: '可替换',
        };

        if (!pid) {
            row.status = 'error';
            row.message = 'ZIP 内该题缺少 pid，无法按同 PID 匹配。';
            rows.push(row);
            continue;
        }

        const pidKey = pid.toLowerCase();
        if (seenSourcePids.has(pidKey)) {
            row.status = 'error';
            row.message = `ZIP 内 pid=${pid} 重复，无法判断应使用哪一份。`;
            rows.push(row);
            continue;
        }
        seenSourcePids.add(pidKey);

        const target = await tryGetProblem(domainId, pid);
        if (!target) {
            row.status = 'error';
            row.message = `当前题库未找到 pid=${pid} 的题目。`;
        } else {
            row.targetDocId = target.docId;
            row.targetPid = target.pid || `P${target.docId}`;
            row.targetTitle = target.title || '';
            if (seenTargets.has(target.docId)) {
                row.status = 'error';
                row.message = `docId=${target.docId} 被重复匹配。`;
            } else {
                seenTargets.add(target.docId);
            }
        }

        if (!problem.content) {
            row.status = 'error';
            row.message = 'ZIP 内该题缺少题面内容。';
        }
        rows.push(row);
    }

    const errorCount = rows.filter((row) => row.status === 'error').length;
    messages.push(`预览完成：可替换 ${rows.length - errorCount} 题，错误 ${errorCount} 题。`);
    messages.push('匹配规则：只读取 ZIP 中 problem.yaml 的 pid，并替换当前域题库内同 pid 的已有题目；已有 docId/pid 保持不变。');
    return { rows, messages };
}

function storagePathForJob(domainId: string, uid: number, jobId: ObjectId) {
    return `${STORAGE_PREFIX}/${domainId}/${uid}/${jobId.toString()}.zip`;
}

function renderBatchBody(extra: any = {}) {
    return {
        page_name: 'problem_zip_replace_batch',
        options: { replaceSolutions: true },
        rows: [],
        messages: [],
        jobId: '',
        canExecute: false,
        executed: false,
        ...extra,
    };
}

function canReplaceProblem(user: any, pdoc: any) {
    return !!pdoc && user?.hasPerm?.(PERM.PERM_EDIT_DOMAIN);
}

function problemDisplayId(pdoc: any) {
    return pdoc?.pid || pdoc?.docId || '';
}

class ProblemZipReplaceCurrentHandler extends Handler {
    async post() {
        const domainId = this.domain._id;
        const body = this.request.body || {};
        const target = asText(body.pid).trim();
        if (!target) throw new ValidationError('pid', null, '缺少当前题目 ID。');

        const pdoc = await tryGetProblem(domainId, target);
        if (!pdoc) throw new ValidationError('pid', null, `题目 ${target} 不存在。`);
        if (!canReplaceProblem(this.user, pdoc)) throw new PermissionError(PERM.PERM_EDIT_DOMAIN);

        const file = this.request.files?.file;
        if (!file) throw new ValidationError('file', null, '请上传 Hydro ZIP。');

        const problems = await readZipProblemsFromPath(file.filepath);
        if (problems.length !== 1) {
            throw new ValidationError('file', null, `请上传单题 Hydro ZIP；当前 ZIP 内包含 ${problems.length} 个 problem.yaml。`);
        }
        const source = problems[0];
        const result = await replaceCurrentProblem(domainId, pdoc, source, this.user._id, boolOption(body.replaceSolutions, true));

        await OplogModel.log(this, 'problem.zip.replace', {
            pid: pdoc.docId,
            displayId: problemDisplayId(pdoc),
            source: source.key,
            title: result.title,
        });
        this.back({
            zipReplace: 'success',
            zipReplaceTitle: result.title,
            zipReplaceData: String(result.testdataCount),
            zipReplaceSol: String(result.addedSolutions),
            zipReplaceOldSol: String(result.deletedSolutions),
        });
    }
}

class ProblemZipReplaceBatchHandler extends Handler {
    async prepare() {
        this.checkPerm(PERM.PERM_EDIT_DOMAIN);
    }

    async get() {
        this.response.template = 'problem_zip_replace_batch.html';
        this.response.body = renderBatchBody();
    }

    async post() {
        const domainId = this.domain._id;
        const body = this.request.body || {};
        const action = asText(body.action, 'preview');
        const options: BatchOptions = {
            replaceSolutions: boolOption(body.replaceSolutions, true),
        };

        if (action === 'execute') {
            const jobIdText = asText(body.jobId).trim();
            if (!/^[a-f0-9]{24}$/i.test(jobIdText)) throw new ValidationError('jobId', null, '预览任务已失效，请重新上传 ZIP。');
            const jobId = new ObjectId(jobIdText);
            const job = await jobs.findOne({ _id: jobId, domainId, owner: this.user._id });
            if (!job) throw new ValidationError('jobId', null, '预览任务不存在或已过期。');

            const problems = await readZipProblemsFromStorage(job.storagePath);
            const state = await buildBatchPreviewRows(domainId, problems);
            if (state.rows.some((row) => row.status === 'error')) {
                state.messages.push('存在错误映射，已取消执行。');
                this.response.template = 'problem_zip_replace_batch.html';
                this.response.body = renderBatchBody({
                    options: job.options || options,
                    rows: state.rows,
                    messages: state.messages,
                    jobId: jobIdText,
                    canExecute: false,
                });
                return;
            }

            const byIndex = new Map(problems.map((problem) => [problem.index, problem]));
            let done = 0;
            let addedSolutions = 0;
            let deletedSolutions = 0;
            const executeOptions = job.options || options;
            for (const row of state.rows) {
                const source = byIndex.get(row.sourceIndex);
                if (!source || !row.targetDocId) throw new ValidationError('jobId', null, '预览任务数据不完整，请重新上传 ZIP。');
                const target = await ProblemModel.get(domainId, row.targetDocId, ProblemModel.PROJECTION_PUBLIC, true) as any;
                if (!target) throw new ValidationError('pid', null, `目标题目 docId=${row.targetDocId} 不存在。`);
                const result = await replaceCurrentProblem(domainId, target, source, this.user._id, executeOptions.replaceSolutions);
                row.status = 'done';
                row.message = `已替换，docId=${row.targetDocId} / pid=${row.targetPid} 保持不变。`;
                done += 1;
                addedSolutions += result.addedSolutions;
                deletedSolutions += result.deletedSolutions;
            }

            state.messages.push(`执行完成：已替换 ${done} 题。`);
            state.messages.push(`题解：导入 ${addedSolutions} 条，清理旧题解 ${deletedSolutions} 条。`);
            await jobs.updateOne({ _id: jobId }, { $set: { executedAt: new Date(), rows: state.rows } });
            await OplogModel.log(this, 'problem.zip.replace.batch', { count: done, jobId: jobIdText });

            this.response.template = 'problem_zip_replace_batch.html';
            this.response.body = renderBatchBody({
                options: executeOptions,
                rows: state.rows,
                messages: state.messages,
                jobId: jobIdText,
                canExecute: false,
                executed: true,
            });
            return;
        }

        const file = this.request.files?.file;
        if (!file) throw new ValidationError('file', null, '请上传 Hydro ZIP。');
        const problems = await readZipProblemsFromPath(file.filepath);
        const state = await buildBatchPreviewRows(domainId, problems);
        const jobId = new ObjectId();
        const storagePath = storagePathForJob(domainId, this.user._id, jobId);
        await StorageModel.put(storagePath, file.filepath, this.user._id);
        await jobs.insertOne({
            _id: jobId,
            domainId,
            owner: this.user._id,
            createdAt: new Date(),
            storagePath,
            options,
            rows: state.rows,
        });

        this.response.template = 'problem_zip_replace_batch.html';
        this.response.body = renderBatchBody({
            options,
            rows: state.rows,
            messages: state.messages,
            jobId: jobId.toString(),
            canExecute: state.rows.length > 0 && !state.rows.some((row) => row.status === 'error'),
        });
    }
}

function exposeProblemZipReplace(handler: any) {
    const pdoc = handler.response?.body?.pdoc || handler.pdoc;
    if (!pdoc?.docId || handler.response?.body?.tdoc) return;
    if (!canReplaceProblem(handler.user, pdoc)) return;
    handler.UiContext ||= {};
    handler.UiContext.problemZipReplace = {
        action: handler.url('problem_zip_replace_current'),
        csrfToken: handler.csrfToken || '',
        pid: String(problemDisplayId(pdoc)),
        docId: pdoc.docId,
        title: pdoc.title || '',
    };
}

export async function apply(ctx: Context) {
    await jobs.createIndex({ createdAt: 1 }, { expireAfterSeconds: JOB_TTL_SECONDS });
    await jobs.createIndex({ domainId: 1, owner: 1, createdAt: -1 });
    ctx.Route('problem_zip_replace_current', '/domain/problem-zip-replace/current', ProblemZipReplaceCurrentHandler, PERM.PERM_EDIT_DOMAIN);
    ctx.Route('problem_zip_replace_batch', '/domain/problem-zip-replace/batch', ProblemZipReplaceBatchHandler, PERM.PERM_EDIT_DOMAIN);
    ctx.on('handler/after/ProblemDetail#get', async (handler: any) => {
        exposeProblemZipReplace(handler);
    });
    ctx.injectUI('ProblemAdd', 'problem_zip_replace_batch', { icon: 'upload', text: 'problem_zip_replace_batch' }, PERM.PERM_EDIT_DOMAIN);
    ctx.i18n.load('zh', {
        problem_zip_replace: 'ZIP 替换题目',
        problem_zip_replace_current: 'ZIP 替换本题',
        problem_zip_replace_batch: '批量 ZIP 替换',
    });
    ctx.i18n.load('en', {
        problem_zip_replace: 'Replace Problem by ZIP',
        problem_zip_replace_current: 'Replace This Problem by ZIP',
        problem_zip_replace_batch: 'Batch ZIP Replace',
    });
}
