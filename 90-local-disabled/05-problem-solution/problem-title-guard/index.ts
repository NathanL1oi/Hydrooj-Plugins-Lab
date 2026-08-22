import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import {
    Context, Handler, MessageModel, PERM, PRIV, ProblemModel,
    Types, ValidationError, Zip, extractZip, fs, nanoid, param, sleep, yaml,
} from 'hydrooj';

const STAGE_ROOT = path.join(os.tmpdir(), 'hydro', 'problem-title-guard');
const PATCHED = Symbol.for('hydrooj.problem-title-guard.patched');

interface ProblemRow {
    index: number;
    folder: string;
    yamlPath: string;
    pid: string;
    title: string;
    suggestedTitle: string;
    duplicate: boolean;
    duplicateReason: string;
    matches: { docId: number, pid: string, title: string }[];
}

type TitleIndex = Map<string, { docId: number, pid: string, title: string }[]>;

function trimTitle(value: any) {
    return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeTitle(value: any) {
    return trimTitle(value).normalize('NFKC').toLowerCase();
}

function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function viewProblem(pdoc: any) {
    return {
        docId: pdoc.docId,
        pid: pdoc.pid || `P${pdoc.docId}`,
        title: pdoc.title || '',
    };
}

async function findTitleMatches(domainId: string, title: string, ignoreDocId = 0) {
    const normalized = normalizeTitle(title);
    if (!normalized) return [];
    const regex = new RegExp(`^${escapeRegExp(trimTitle(title))}$`, 'i');
    const docs = await ProblemModel.getMulti(
        domainId,
        { title: { $regex: regex } } as any,
        ['docId', 'pid', 'title'] as any,
    ).limit(30).toArray();
    return docs
        .filter((doc: any) => doc.docId !== ignoreDocId && normalizeTitle(doc.title) === normalized)
        .map(viewProblem);
}

async function loadTitleIndex(domainId: string) {
    const docs = await ProblemModel.getMulti(
        domainId,
        {},
        ['docId', 'pid', 'title'] as any,
    ).toArray();
    const index: TitleIndex = new Map();
    for (const doc of docs as any[]) {
        const key = normalizeTitle(doc.title);
        if (!key) continue;
        if (!index.has(key)) index.set(key, []);
        index.get(key)!.push(viewProblem(doc));
    }
    return index;
}

function findTitleMatchesInIndex(index: TitleIndex, title: string) {
    return index.get(normalizeTitle(title)) || [];
}

async function isTitleTaken(domainId: string, title: string, reserved = new Set<string>()) {
    const normalized = normalizeTitle(title);
    if (!normalized) return false;
    if (reserved.has(normalized)) return true;
    return !!(await findTitleMatches(domainId, title)).length;
}

function isTitleTakenInIndex(index: TitleIndex, title: string, reserved = new Set<string>()) {
    const normalized = normalizeTitle(title);
    if (!normalized) return false;
    return reserved.has(normalized) || !!findTitleMatchesInIndex(index, title).length;
}

async function makeUniqueTitle(domainId: string, title: string, reserved = new Set<string>()) {
    const base = trimTitle(title) || '未命名题目';
    if (!await isTitleTaken(domainId, base, reserved)) return base;
    for (let i = 2; i < 1000; i++) {
        const candidate = `${base} (${i})`;
        if (!await isTitleTaken(domainId, candidate, reserved)) return candidate;
    }
    return `${base} (${Date.now()})`;
}

function makeUniqueTitleInIndex(index: TitleIndex, title: string, reserved = new Set<string>()) {
    const base = trimTitle(title) || '未命名题目';
    if (!isTitleTakenInIndex(index, base, reserved)) return base;
    for (let i = 2; i < 1000; i++) {
        const candidate = `${base} (${i})`;
        if (!isTitleTakenInIndex(index, candidate, reserved)) return candidate;
    }
    return `${base} (${Date.now()})`;
}

function safeStageDir(token: string) {
    if (!/^[A-Za-z0-9_-]{12,}$/.test(token)) throw new ValidationError('stage');
    const root = path.resolve(STAGE_ROOT);
    const target = path.resolve(root, token);
    if (!target.startsWith(`${root}${path.sep}`)) throw new ValidationError('stage');
    return target;
}

function getUploadedFile(files: any) {
    const file = files?.file;
    return Array.isArray(file) ? file[0] : file;
}

async function extractUploadZip(filePath: string, workDir: string) {
    await fs.ensureDir(workDir);
    const zip = new Zip.ZipReader(Readable.toWeb(fs.createReadStream(filePath)) as any);
    try {
        const entries = await zip.getEntries();
        await extractZip(entries, workDir);
    } finally {
        await zip.close?.();
    }
}

async function getProblemFolders(workDir: string) {
    if (await fs.pathExists(path.join(workDir, 'problem.yaml'))) return ['.'];
    const files = await fs.readdir(workDir, { withFileTypes: true });
    return files
        .filter((file: any) => file.isDirectory() && !file.name.startsWith('__MACOSX'))
        .map((file: any) => file.name);
}

async function readProblemRows(workDir: string) {
    const rows: ProblemRow[] = [];
    const folders = await getProblemFolders(workDir);
    for (const folder of folders) {
        const yamlPath = path.join(workDir, folder, 'problem.yaml');
        if (!await fs.pathExists(yamlPath)) continue;
        const raw = await fs.readFile(yamlPath, 'utf8');
        const parsed = yaml.load(raw) as any;
        if (!parsed || typeof parsed !== 'object') continue;
        const title = trimTitle(parsed.title || parsed.name || folder);
        rows.push({
            index: rows.length,
            folder,
            yamlPath,
            pid: String(parsed.pid || ''),
            title,
            suggestedTitle: title,
            duplicate: false,
            duplicateReason: '',
            matches: [],
        });
    }
    return rows;
}

async function buildPreview(domainId: string, rows: ProblemRow[]) {
    const titleIndex = await loadTitleIndex(domainId);
    const reserved = new Set<string>();
    for (const row of rows) {
        const matches = findTitleMatchesInIndex(titleIndex, row.title);
        const batchDuplicate = reserved.has(normalizeTitle(row.title));
        row.matches = matches;
        row.duplicate = !!matches.length || batchDuplicate;
        row.duplicateReason = [
            matches.length ? `题库已有 ${matches.length} 道同名题` : '',
            batchDuplicate ? '本次导入包内已有同名题' : '',
        ].filter(Boolean).join('；');
        row.suggestedTitle = row.duplicate
            ? makeUniqueTitleInIndex(titleIndex, row.title, reserved)
            : trimTitle(row.title);
        reserved.add(normalizeTitle(row.suggestedTitle));
    }
    return rows;
}

async function rewriteTitles(workDir: string, domainId: string, body: any) {
    const rows = await readProblemRows(workDir);
    const titleIndex = await loadTitleIndex(domainId);
    const reserved = new Set<string>();
    for (const row of rows) {
        const field = `title_${row.index}`;
        const incoming = trimTitle(Array.isArray(body[field]) ? body[field][0] : body[field]);
        const desired = incoming || row.title;
        const finalTitle = makeUniqueTitleInIndex(titleIndex, desired, reserved);
        reserved.add(normalizeTitle(finalTitle));
        const raw = await fs.readFile(row.yamlPath, 'utf8');
        const parsed = yaml.load(raw) as any;
        parsed.title = finalTitle;
        await fs.writeFile(row.yamlPath, yaml.dump(parsed), 'utf8');
    }
}

async function cleanupOldStages() {
    await fs.ensureDir(STAGE_ROOT);
    const now = Date.now();
    const entries = await fs.readdir(STAGE_ROOT, { withFileTypes: true }).catch(() => []);
    for (const entry of entries as any[]) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(STAGE_ROOT, entry.name);
        const stat = await fs.stat(dir).catch(() => null);
        if (stat && now - stat.mtimeMs > 24 * 60 * 60 * 1000) await fs.remove(dir).catch(() => null);
    }
}

function patchProblemAdd(ctx: Context) {
    const model = ProblemModel as any;
    if (model[PATCHED]) return;
    const originalAddWithId = model.addWithId.bind(model);
    model.addWithId = async (
        domainId: string, docId: number, pid = '', title: string,
        content: string, owner: number, tag: string[] = [], meta: any = {},
    ) => {
        const uniqueTitle = await makeUniqueTitle(domainId, title);
        if (uniqueTitle !== trimTitle(title)) {
            ctx.logger('problem-title-guard').info(
                'rename duplicate problem title in %s: %s -> %s',
                domainId, title, uniqueTitle,
            );
        }
        return await originalAddWithId(domainId, docId, pid, uniqueTitle, content, owner, tag, meta);
    };
    model[PATCHED] = { originalAddWithId };
}

class ProblemTitleGuardCheckHandler extends Handler {
    @param('title', Types.Content)
    async post(domainId: string, title: string) {
        this.checkPerm(PERM.PERM_CREATE_PROBLEM);
        const cleanTitle = trimTitle(title);
        const matches = await findTitleMatches(domainId, cleanTitle);
        const suggestedTitle = matches.length ? await makeUniqueTitle(domainId, cleanTitle) : cleanTitle;
        this.response.body = {
            duplicate: !!matches.length,
            matches,
            suggestedTitle,
        };
    }
}

class ProblemTitleGuardImportHandler extends Handler {
    async get() {
        await cleanupOldStages();
        this.response.template = 'problem_title_guard_import.html';
        this.response.body = {
            rows: [],
            stage: '',
            preferredPrefix: '',
            hidden: false,
            keepUser: false,
            uploadedName: '',
        };
    }

    @param('keepUser', Types.Boolean)
    @param('preferredPrefix', Types.String, true)
    @param('hidden', Types.Boolean)
    async postPreview(domainId: string, keepUser = false, preferredPrefix = '', hidden = false) {
        if (keepUser) this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        if (preferredPrefix && !/^[a-zA-Z]+$/.test(preferredPrefix)) throw new ValidationError('preferredPrefix');
        const file = getUploadedFile(this.request.files);
        if (!file?.filepath) throw new ValidationError('file');
        if (!String(file.originalFilename || '').toLowerCase().endsWith('.zip')) {
            throw new ValidationError('file', null, '只支持 Hydro ZIP 导入包。');
        }
        await cleanupOldStages();
        const stage = nanoid();
        const stageDir = safeStageDir(stage);
        const workDir = path.join(stageDir, 'work');
        await fs.ensureDir(stageDir);
        await extractUploadZip(file.filepath, workDir);
        const rows = await buildPreview(domainId, await readProblemRows(workDir));
        if (!rows.length) throw new ValidationError('file', null, '导入包中没有找到 problem.yaml。');
        this.response.template = 'problem_title_guard_import.html';
        this.response.body = {
            rows,
            conflictCount: rows.filter((row) => row.duplicate).length,
            stage,
            preferredPrefix,
            hidden,
            keepUser,
            uploadedName: file.originalFilename || 'problems.zip',
        };
    }

    @param('stage', Types.String)
    @param('preferredPrefix', Types.String, true)
    @param('hidden', Types.Boolean)
    @param('keepUser', Types.Boolean)
    async postConfirm(domainId: string, stage: string, preferredPrefix = '', hidden = false, keepUser = false) {
        if (keepUser) this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        if (preferredPrefix && !/^[a-zA-Z]+$/.test(preferredPrefix)) throw new ValidationError('preferredPrefix');
        const stageDir = safeStageDir(stage);
        const workDir = path.join(stageDir, 'work');
        if (!await fs.pathExists(workDir)) throw new ValidationError('stage');
        await rewriteTitles(workDir, domainId, this.request.body || {});
        const promise = ProblemModel.import(domainId, workDir, {
            preferredPrefix,
            progress: this.progress.bind(this),
            operator: keepUser ? null : this.user._id,
            delSource: true,
            hidden,
        }).catch((e: any) => MessageModel.send(1, this.user._id, `Import failed: ${e.message}\n${e.stack}`));
        let resolved = false;
        await Promise.race([
            promise.then(() => { resolved = true; }),
            sleep(5000),
        ]);
        this.response.redirect = this.url('problem_main', resolved ? {} : { query: { showImport: 1 } });
    }
}

export async function apply(ctx: Context) {
    patchProblemAdd(ctx);
    ctx.Route('problem_title_guard_check', '/problem-title-guard/check', ProblemTitleGuardCheckHandler, PERM.PERM_CREATE_PROBLEM);
    ctx.Route('problem_title_guard_import', '/problem/import/title-guard', ProblemTitleGuardImportHandler, PERM.PERM_CREATE_PROBLEM);
    ctx.injectUI('ProblemAdd', 'problem_title_guard_import', { icon: 'copy', text: '防重名导入' });
    ctx.i18n.load('zh', {
        problem_title_guard_import: '防重名导入',
        'Import With Title Guard': '防重名导入',
        'Duplicate title preview': '重名题目预览',
        'Problem title guard': '题目重名保护',
        'Title updated.': '题名已更新。',
    });
    ctx.i18n.load('en', {
        problem_title_guard_import: 'Import With Title Guard',
        'Import With Title Guard': 'Import With Title Guard',
        'Duplicate title preview': 'Duplicate title preview',
        'Problem title guard': 'Problem title guard',
        'Title updated.': 'Title updated.',
    });
}
