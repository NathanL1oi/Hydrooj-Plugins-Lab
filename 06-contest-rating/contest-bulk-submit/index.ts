import {
    ContestModel, ContestNotFoundError, Context, Logger, ObjectId, param, PERM,
    DocumentModel, ProblemModel, RecordModel, Types, UserModel, ValidationError, Zip, fs,
} from 'hydrooj';
import { ContestDetailBaseHandler } from 'hydrooj/src/handler/contest';
import { Readable } from 'stream';

const logger = new Logger('contest-bulk-submit');
const pathPrefixes = ['answers/', 'answers-s/', 'answers-j/', 'submissions/'];
const maxCodeSize = 10 * 1024 * 1024;
const objectiveAnswerExt = new Set(['txt', 'yaml', 'yml']);

const languageByExt: Record<string, string> = {
    c: 'c',
    cc: 'cc',
    cpp: 'cc',
    cxx: 'cc',
    'c++': 'cc',
    pas: 'pas',
    java: 'java',
    kt: 'kt.jvm',
    py: 'py.py3',
    py3: 'py.py3',
    pypy3: 'py.pypy3',
    js: 'js',
    go: 'go',
    rs: 'rs',
    rb: 'rb',
    cs: 'cs',
    hs: 'hs',
};

const quietIgnoredExt = new Set(['exe', 'in', 'out', 'ans', 'o', 'obj', 'class', 'dll', 'pdb', 'ilk']);

interface ContestProblemInfo {
    index: string;
    docId: number;
    pid: string;
    title: string;
    type: string;
    folderName: string;
    sourceBase: string;
    sourceFile: string;
    fileIo: string;
    time: string;
    memory: string;
    keys: string[];
}

interface ParsedEntry {
    username: string;
    problemKeys: string[];
    filename: string;
    sourceBase: string;
    ext: string;
    displayPath: string;
}

interface ProcessResult {
    total: number;
    imported: number;
    skipped: number;
    failed: number;
    attended: number;
    messages: string[];
}

interface ProblemMapping {
    folderName: string;
    sourceFile: string;
}

function alphabeticId(index: number) {
    let n = index + 1;
    let result = '';
    while (n > 0) {
        n -= 1;
        result = String.fromCharCode(65 + (n % 26)) + result;
        n = Math.floor(n / 26);
    }
    return result;
}

function normalizeKey(value: any) {
    return String(value || '').trim().toLowerCase();
}

function safePathSegment(value: any, fallback: string) {
    const cleaned = String(value || '')
        .trim()
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/^_+|_+$/g, '');
    return cleaned || fallback;
}

function stripFileExtension(value: string) {
    return value.replace(/\.(?:in|out|ans|txt|cpp|cc|cxx|c\+\+|c|pas|java|py|js|go|rs|rb|cs|hs|kt)$/i, '');
}

function formatLimitValue(value: any, unit: string) {
    if (typeof value === 'number') return `${value}${unit}`;
    const text = String(value).trim();
    if (!text) return '-';
    return /[a-z]+$/i.test(text) ? text : `${text}${unit}`;
}

function formatLimitRange(min: any, max: any, unit: string) {
    const left = min ?? max;
    const right = max ?? min;
    if (left === undefined || left === null || left === '') return '-';
    if (right === undefined || right === null || right === '' || String(left) === String(right)) {
        return formatLimitValue(left, unit);
    }
    return `${formatLimitValue(left, unit)}~${formatLimitValue(right, unit)}`;
}

function hasValue(value: any) {
    return value !== undefined && value !== null && value !== '';
}

function readProblemLimit(configs: any[], key: 'time' | 'memory') {
    for (const config of configs) {
        if (!config || typeof config !== 'object') continue;
        if (key === 'time') {
            const min = config.timeMin ?? config.time ?? config.limits?.time ?? config.limits?.time_limit;
            const max = config.timeMax ?? config.time ?? config.limits?.time ?? config.limits?.time_limit;
            if (hasValue(min) || hasValue(max)) return formatLimitRange(min, max, 'ms');
            continue;
        }
        const min = config.memoryMin ?? config.memory ?? config.limits?.memory ?? config.limits?.memory_limit;
        const max = config.memoryMax ?? config.memory ?? config.limits?.memory ?? config.limits?.memory_limit;
        if (hasValue(min) || hasValue(max)) return formatLimitRange(min, max, 'MiB');
    }
    return '-';
}

function readYamlScalar(raw: string, keys: string[]) {
    for (const key of keys) {
        const pattern = new RegExp(`(?:^|\\n)\\s*${key}\\s*:\\s*["']?([^"'\\r\\n#]+)`, 'i');
        const match = raw.match(pattern);
        if (match?.[1]?.trim()) return match[1].trim();
    }
    return '';
}

function parseConfigText(raw: string) {
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
    } catch { }
    const filename = readYamlScalar(raw, ['subType', 'subtype', 'filename', 'fileName', 'file', 'inputFile', 'input_file']);
    const time = readYamlScalar(raw, ['time', 'time_limit', 'timeLimit']);
    const memory = readYamlScalar(raw, ['memory', 'memory_limit', 'memoryLimit']);
    const type = readYamlScalar(raw, ['type']);
    const result: any = {};
    if (filename) {
        result.subType = filename;
        result.filename = filename;
    }
    if (time) result.time = time;
    if (memory) result.memory = memory;
    if (type) result.type = type;
    return result;
}

function normalizeConfig(config: any) {
    if (!config) return {};
    if (typeof config === 'string') return parseConfigText(config);
    if (typeof config === 'object') return config;
    return {};
}

function readConfiguredFileBase(configs: any[]) {
    for (const config of configs) {
        if (!config || typeof config !== 'object') continue;
        const value = [
            config.subType,
            config.subtype,
            config.filename,
            config.fileName,
            config.file,
            config.inputFile,
            config.input_file,
            config.io?.filename,
        ].find((i) => typeof i === 'string' && i.trim());
        if (!value) continue;
        const name = String(value).replace(/\\/g, '/').split('/').pop() || '';
        const safe = safePathSegment(stripFileExtension(name), '');
        if (safe) return safe;
    }
    return '';
}

function safeDecodeUriComponent(value: string) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function readFileBasesFromContent(content: any) {
    const text = typeof content === 'string'
        ? content
        : typeof content?.content === 'string'
            ? content.content
            : '';
    if (!text) return [];

    const result: string[] = [];
    const re = /file:\/\/\/?([^)\]\s"']+)/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
        const target = safeDecodeUriComponent(match[1] || '').replace(/\\/g, '/');
        const filename = target.split('/').pop() || '';
        const base = safePathSegment(stripFileExtension(filename), '');
        if (base && !result.includes(base)) result.push(base);
    }
    return result;
}

async function getProblemConfigSources(domainId: string, pid: any, parsedPdoc: any) {
    const sources = [normalizeConfig(parsedPdoc?.config)];
    try {
        const rawDocId = parsedPdoc?.docId || (Number.isSafeInteger(+pid) ? +pid : null);
        const rawPdoc: any = rawDocId
            ? await DocumentModel.get(domainId, DocumentModel.TYPE_PROBLEM, rawDocId, ['config', 'docId', 'pid', 'title'] as any)
            : await ProblemModel.get(domainId, pid, ProblemModel.PROJECTION_PUBLIC as any, true);
        const rawConfig = normalizeConfig(rawPdoc?.config);
        if (Object.keys(rawConfig).length) sources.unshift(rawConfig);
    } catch (e) {
        logger.warn('Cannot read raw problem config: %s', (e as any)?.message || e);
    }
    return sources;
}

function uniqueKeys(values: any[]) {
    const result: string[] = [];
    for (const value of values) {
        const key = String(value || '').trim();
        if (key && !result.includes(key)) result.push(key);
    }
    return result;
}

async function getContestProblems(domainId: string, tdoc: any) {
    const problems: ContestProblemInfo[] = [];
    const problemMap = new Map<string, ContestProblemInfo>();

    for (const [i, pid] of (tdoc.pids || []).entries()) {
        const pdoc: any = await ProblemModel.get(domainId, pid);
        if (!pdoc) continue;
        const index = alphabeticId(i);
        const configs = await getProblemConfigSources(domainId, pid, pdoc);
        const configuredBase = readConfiguredFileBase(configs);
        const fallbackBase = safePathSegment(pdoc.pid || pdoc.docId || index, index);
        const sourceBase = configuredBase || fallbackBase;
        const contentFileBases = readFileBasesFromContent(pdoc.content);
        const folderName = sourceBase;
        const title = pdoc.title || '';
        const type = String(configs.find((config) => config?.type)?.type || '');
        const info: ContestProblemInfo = {
            index,
            docId: pdoc.docId,
            pid: String(pdoc.pid || pdoc.docId),
            title,
            type,
            folderName,
            sourceBase,
            sourceFile: `${sourceBase}.cpp`,
            fileIo: configuredBase ? `${sourceBase}.in / ${sourceBase}.out` : '标准输入输出',
            time: readProblemLimit(configs, 'time'),
            memory: readProblemLimit(configs, 'memory'),
            keys: [],
        };
        const keys = uniqueKeys([
            index,
            pdoc.pid,
            pdoc.docId,
            title,
            folderName,
            sourceBase,
            info.sourceFile,
            ...contentFileBases,
            ...contentFileBases.map((base) => `${base}.cpp`),
        ]);
        for (const key of keys) {
            const normalized = normalizeKey(key);
            if (!normalized) continue;
            if (!problemMap.has(normalized)) problemMap.set(normalized, info);
            info.keys.push(key);
        }
        problems.push(info);
    }

    return { problems, problemMap };
}

function readBodyString(body: any, key: string) {
    const value = body?.[key];
    const raw = Array.isArray(value) ? value[value.length - 1] : value;
    return String(raw || '').trim();
}

function splitMappingValues(value: any) {
    return uniqueKeys(String(value || '')
        .split(/[\n,;，；]+/)
        .map((item) => item.trim())
        .filter(Boolean));
}

function mappingKeyVariants(value: any) {
    const result: string[] = [];
    for (const item of splitMappingValues(value)) {
        const normalized = item.replace(/\\/g, '/');
        const filename = normalized.split('/').pop() || normalized;
        const base = safePathSegment(stripFileExtension(filename), '');
        result.push(item);
        if (filename && filename !== item) result.push(filename);
        if (base) result.push(base);
    }
    return uniqueKeys(result);
}

function readSubmittedMappings(body: any, problems: ContestProblemInfo[]) {
    const mappings = new Map<number, ProblemMapping>();
    for (const problem of problems) {
        const folderName = readBodyString(body, `folderName_${problem.docId}`) || problem.folderName;
        const sourceFile = readBodyString(body, `sourceFile_${problem.docId}`) || problem.sourceFile;
        mappings.set(problem.docId, { folderName, sourceFile });
    }
    return mappings;
}

function applyProblemMappings(
    problems: ContestProblemInfo[],
    problemMap: Map<string, ContestProblemInfo>,
    mappings?: Map<number, ProblemMapping>,
) {
    if (!mappings) return;
    for (const problem of problems) {
        const mapping = mappings.get(problem.docId);
        if (!mapping) continue;
        problem.folderName = mapping.folderName || problem.folderName;
        problem.sourceFile = mapping.sourceFile || problem.sourceFile;

        const keys = uniqueKeys([
            ...mappingKeyVariants(mapping.folderName),
            ...mappingKeyVariants(mapping.sourceFile),
        ]);
        for (const key of keys) {
            const normalized = normalizeKey(key);
            if (!normalized) continue;
            problemMap.set(normalized, problem);
            if (!problem.keys.includes(key)) problem.keys.push(key);
        }
    }
}

function parseEntryPath(rawPath: string): ParsedEntry | null {
    let clean = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!clean || clean.startsWith('__MACOSX/')) return null;
    for (const prefix of pathPrefixes) {
        if (clean.startsWith(prefix)) clean = clean.slice(prefix.length);
    }
    const parts = clean.split('/').filter(Boolean);
    if (parts.length < 2) return null;

    const filename = parts[parts.length - 1];
    if (!filename || filename.startsWith('.') || filename.toLowerCase() === 'thumbs.db') return null;
    const match = filename.match(/\.([a-z0-9+]+)$/i);
    if (!match) return null;

    const sourceBase = filename.slice(0, -match[0].length);
    const parentFolder = parts.length >= 3 ? parts[1] : '';
    const lastFolder = parts.length >= 3 ? parts[parts.length - 2] : '';
    return {
        username: parts[0],
        problemKeys: uniqueKeys([parentFolder, lastFolder, sourceBase, filename]),
        filename,
        sourceBase,
        ext: match[1].toLowerCase(),
        displayPath: clean,
    };
}

function readPathExt(rawPath: string) {
    const filename = rawPath.replace(/\\/g, '/').split('/').pop() || '';
    const match = filename.match(/\.([a-z0-9+]+)$/i);
    return match ? match[1].toLowerCase() : '';
}

function findProblem(problemMap: Map<string, ContestProblemInfo>, keys: string[]) {
    for (const key of keys) {
        const problem = problemMap.get(normalizeKey(key));
        if (problem) return problem;
    }
    return null;
}

async function resolveUser(domainId: string, username: string) {
    const uidMatch = username.match(/^u?(\d+)$/i);
    if (uidMatch) {
        const udoc = await UserModel.getById(domainId, Number(uidMatch[1]));
        if (udoc) return udoc;
    }
    return await UserModel.getByUname(domainId, username)
        || await UserModel.getByUname('system', username);
}

function getUploadedFile(files: any) {
    const file = files?.file;
    return Array.isArray(file) ? file[0] : file;
}

function pushMessage(result: ProcessResult, message: string) {
    if (result.messages.length < 500) {
        result.messages.push(message);
    } else if (result.messages.length === 500) {
        result.messages.push('日志过长，后续条目已省略。');
    }
}

async function processSubmissions(
    domainId: string,
    tid: ObjectId,
    problemMap: Map<string, ContestProblemInfo>,
    zipReader: any,
    defaultProblem: ContestProblemInfo | null = null,
): Promise<ProcessResult> {
    const allEntries = (await zipReader.getEntries()).filter((entry: any) => !entry.directory);
    const entries = allEntries.filter((entry: any) => !quietIgnoredExt.has(readPathExt(entry.filename)));
    const ignoredArtifacts = allEntries.length - entries.length;
    const result: ProcessResult = {
        total: entries.length,
        imported: 0,
        skipped: 0,
        failed: 0,
        attended: 0,
        messages: [`发现 ${entries.length} 个源码候选文件${ignoredArtifacts ? `，已忽略 ${ignoredArtifacts} 个运行产物` : ''}，开始解析。`],
    };
    const attended = new Set<number>();
    const userCache = new Map<string, number>();

    for (const [i, entry] of entries.entries()) {
        if (i % 100 === 0) logger.info('Processing %d/%d', i, entries.length);
        try {
            const parsed = parseEntryPath(entry.filename);
            if (!parsed) {
                result.skipped++;
                pushMessage(result, `跳过：${entry.filename} 不是可识别的提交文件。`);
                continue;
            }

            let problem = findProblem(problemMap, parsed.problemKeys);
            const usedDefaultProblem = !problem && !!defaultProblem;
            if (!problem && defaultProblem) problem = defaultProblem;
            if (!problem) {
                result.skipped++;
                pushMessage(result, `跳过：${parsed.displayPath} 的题目标识 "${parsed.problemKeys.join(' / ')}" 不在本场比赛中。`);
                continue;
            }

            const lang = problem.type === 'objective' && objectiveAnswerExt.has(parsed.ext)
                ? '_'
                : languageByExt[parsed.ext];
            if (!lang) {
                result.skipped++;
                if (!quietIgnoredExt.has(parsed.ext)) {
                    pushMessage(result, `跳过：${parsed.displayPath} 的扩展名 ".${parsed.ext}" 暂未配置语言映射。`);
                }
                continue;
            }

            const code = await entry.getData(new Zip.TextWriter());
            if (!code || !String(code).trim()) {
                result.skipped++;
                pushMessage(result, `跳过：${parsed.displayPath} 是空文件。`);
                continue;
            }
            if (String(code).length > maxCodeSize) {
                result.skipped++;
                pushMessage(result, `跳过：${parsed.displayPath} 超过 10MB。`);
                continue;
            }

            let userId = userCache.get(parsed.username);
            if (!userId) {
                const user = await resolveUser(domainId, parsed.username);
                userId = user?._id || await UserModel.ensureVuser(parsed.username);
                userCache.set(parsed.username, userId);
            }

            if (!attended.has(userId)) {
                const status = await ContestModel.getStatus(domainId, tid, userId);
                if (!status?.attend) {
                    await ContestModel.attend(domainId, tid, userId);
                    result.attended++;
                }
                attended.add(userId);
            }

            const record = await RecordModel.add(domainId, problem.docId, userId, lang, String(code), false, {
                contest: tid,
                type: 'judge',
            });
            await Promise.all([
                RecordModel.judge(domainId, record, -10000000, {}),
                ProblemModel.inc(domainId, problem.docId, 'nSubmit', 1),
                ContestModel.updateStatus(domainId, tid, userId, record, problem.docId),
            ]);
            result.imported++;
            const defaultNote = usedDefaultProblem
                ? `（未识别题目标识 "${parsed.problemKeys.join(' / ')}"，已使用默认题目）`
                : '';
            pushMessage(result, `导入：${parsed.username} / ${problem.index} ${problem.title || problem.pid} / ${parsed.filename} -> ${lang}${defaultNote}`);
        } catch (e: any) {
            result.failed++;
            pushMessage(result, `失败：${entry.filename}：${e?.message || e}`);
        }
    }

    pushMessage(result, `完成：导入 ${result.imported}，自动参赛 ${result.attended}，跳过 ${result.skipped}，失败 ${result.failed}。`);
    return result;
}

function canManageContest(handler: any) {
    return handler.user?.own?.(handler.tdoc) || handler.user?.hasPerm?.(PERM.PERM_EDIT_CONTEST);
}

class ContestBulkSubmitHandler extends ContestDetailBaseHandler {
    async prepare(domainId: string, tid: ObjectId) {
        if (!this.tdoc) throw new ContestNotFoundError(domainId, tid);
        if (!canManageContest(this)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
    }

    async render(
        domainId: string,
        tid: ObjectId,
        result: ProcessResult | null = null,
        uploadName = '',
        selectedDefaultProblemDocId = 0,
        mappings?: Map<number, ProblemMapping>,
    ) {
        const { problems, problemMap } = await getContestProblems(domainId, this.tdoc);
        applyProblemMappings(problems, problemMap, mappings);
        const owner = await UserModel.getById(domainId, this.tdoc.owner);
        this.response.template = 'contest_bulk_submit.html';
        this.response.body = {
            page_name: 'contest_bulk_submit',
            tdoc: this.tdoc,
            tsdoc: this.tsdoc,
            owner_udoc: owner,
            tid,
            problems,
            result,
            uploadName,
            selectedDefaultProblemDocId,
            maxCodeSizeMB: Math.floor(maxCodeSize / 1024 / 1024),
            extensions: Object.keys(languageByExt).map((i) => `.${i}`).join(', '),
        };
    }

    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: ObjectId) {
        await this.render(domainId, tid);
    }

    @param('tid', Types.ObjectId)
    @param('defaultProblem', Types.Int, true)
    async post(domainId: string, tid: ObjectId, defaultProblemDocId = 0) {
        const file = getUploadedFile(this.request.files);
        if (!file?.filepath) throw new ValidationError('file', null, '请上传 ZIP 压缩包。');
        if (!String(file.originalFilename || '').toLowerCase().endsWith('.zip')) {
            throw new ValidationError('file', null, '只支持 ZIP 压缩包。');
        }

        this.holdFile('file');
        const { problems, problemMap } = await getContestProblems(domainId, this.tdoc);
        const mappings = readSubmittedMappings(this.request.body, problems);
        applyProblemMappings(problems, problemMap, mappings);
        const defaultProblem = defaultProblemDocId
            ? problems.find((problem) => problem.docId === defaultProblemDocId)
            : null;
        if (defaultProblemDocId && !defaultProblem) {
            throw new ValidationError('defaultProblem', null, '默认题目不在本场比赛中。');
        }
        const fileStream = fs.createReadStream(file.filepath);
        const zipReader = new Zip.ZipReader(Readable.toWeb(fileStream) as any, { filenameEncoding: 'gbk' });
        let result: ProcessResult;
        try {
            result = await processSubmissions(domainId, tid, problemMap, zipReader, defaultProblem);
        } finally {
            if (zipReader.close) await zipReader.close();
        }
        await this.render(domainId, tid, result, file.originalFilename || 'submissions.zip', defaultProblem?.docId || 0, mappings);
    }
}

export async function apply(ctx: Context) {
    ctx.Route('contest_bulk_submit', '/contest/:tid/bulk_submit', ContestBulkSubmitHandler, PERM.PERM_VIEW_CONTEST);

    ctx.injectUI('ContestDetail' as any, 'contest_bulk_submit', (handler) => ({
        icon: 'upload',
        displayName: 'Bulk Submit Upload',
        args: { tid: handler.args?.tid || handler.tdoc?.docId || handler.tdoc?._id },
    }), canManageContest);

    ctx.on('handler/after/ContestDetail#get', async (handler: any) => {
        if (!canManageContest(handler)) return;
        handler.UiContext.contestBulkSubmit = {
            url: handler.url('contest_bulk_submit', { tid: handler.args.tid }),
            title: '批量上传提交',
        };
    });

    ctx.i18n.load('zh', {
        contest_bulk_submit: '批量上传提交',
        'Bulk Submit Upload': '批量上传提交',
        'Upload Contest Submissions': '上传比赛提交',
    });
    ctx.i18n.load('en', {
        contest_bulk_submit: 'Bulk Submit Upload',
        'Bulk Submit Upload': 'Bulk Submit Upload',
        'Upload Contest Submissions': 'Upload Contest Submissions',
    });
}
