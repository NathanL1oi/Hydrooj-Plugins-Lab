const child = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable, Writable } = require('stream');

const {
    Handler,
    MessageModel,
    PERM,
    PRIV,
    ProblemModel,
    SolutionModel,
    StorageModel,
    ValidationError,
    Zip,
    yaml,
} = require('hydrooj');

const TRASH_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

function truthy(value) {
    return value === true || value === 'true' || value === '1' || value === 'on';
}

function splitList(value) {
    return String(value || '')
        .split(/[\s,，]+/g)
        .map((item) => item.trim())
        .filter(Boolean);
}

function safeFilename(value) {
    return String(value || 'export')
        .replace(/[\\/:*?"<>|]+/g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 80) || 'export';
}

function safeJoin(root, name) {
    const target = path.resolve(root, name);
    const base = path.resolve(root);
    if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
        throw new ValidationError('file', name, 'Invalid file path');
    }
    return target;
}

function normalizeZipName(filename) {
    let name = String(filename || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
    name = name.replace(/^\/+/, '');
    if (!name || name.endsWith('/')) return '';
    const parts = name.split('/').filter(Boolean);
    if (!parts.length || parts.includes('..') || parts.includes('__pycache__')) return '';
    if (TRASH_NAMES.has(parts[parts.length - 1])) return '';
    return parts.join('/');
}

async function ensureParent(file) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
}

async function writeText(file, content) {
    await ensureParent(file);
    await fsp.writeFile(file, content);
}

async function writeStorageFile(source, file) {
    await ensureParent(file);
    const stream = await StorageModel.get(source);
    await pipeline(stream, fs.createWriteStream(file));
}

async function addProblemToDir(root, pdoc, includeSolutions) {
    const folder = String(pdoc.docId);
    const problemRoot = safeJoin(root, folder);
    await fsp.mkdir(problemRoot, { recursive: true });
    await writeText(safeJoin(problemRoot, 'problem.yaml'), yaml.dump({
        pid: pdoc.pid || `P${pdoc.docId}`,
        owner: pdoc.owner,
        title: pdoc.title,
        tag: pdoc.tag,
        nSubmit: pdoc.nSubmit,
        nAccept: pdoc.nAccept,
        difficulty: pdoc.difficulty,
    }));
    try {
        const content = JSON.parse(pdoc.content);
        if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error('single statement');
        for (const key of Object.keys(content)) {
            await writeText(
                safeJoin(problemRoot, `problem_${key}.md`),
                typeof content[key] === 'string' ? content[key] : JSON.stringify(content[key], null, 2),
            );
        }
    } catch (e) {
        await writeText(safeJoin(problemRoot, 'problem.md'), pdoc.content || '');
    }
    for (const file of pdoc.data || []) {
        await writeStorageFile(
            `problem/${pdoc.domainId}/${pdoc.docId}/testdata/${file.name}`,
            safeJoin(problemRoot, `testdata/${file.name}`),
        );
    }
    for (const file of pdoc.additional_file || []) {
        await writeStorageFile(
            `problem/${pdoc.domainId}/${pdoc.docId}/additional_file/${file.name}`,
            safeJoin(problemRoot, `additional_file/${file.name}`),
        );
    }
    if (includeSolutions) {
        const solutions = await SolutionModel.getMulti(pdoc.domainId, pdoc.docId).toArray();
        for (let i = 0; i < solutions.length; i++) {
            await writeText(safeJoin(problemRoot, `solution/solution_${i + 1}.md`), solutions[i].content || '');
        }
    }
}

async function resolveProblems(domainId, idsText, pidFilter) {
    const ids = splitList(idsText);
    if (ids.length) {
        const result = [];
        const seen = new Set();
        for (const raw of ids) {
            const key = /^\d+$/.test(raw) ? +raw : raw;
            // eslint-disable-next-line no-await-in-loop
            const pdoc = await ProblemModel.get(domainId, key);
            if (!pdoc || seen.has(String(pdoc.docId))) continue;
            seen.add(String(pdoc.docId));
            result.push(pdoc);
        }
        return result;
    }
    const query = {};
    if (pidFilter) query.pid = { $regex: new RegExp(pidFilter, 'i') };
    return await ProblemModel.getMulti(domainId, query).toArray();
}

async function buildServerZip(domainId, pdocs, includeSolutions) {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hydro-fast-export-'));
    const out = path.join(os.tmpdir(), `hydro-fast-export-${domainId}-${Date.now()}.zip`);
    try {
        for (const pdoc of pdocs) {
            // eslint-disable-next-line no-await-in-loop
            await addProblemToDir(tmpRoot, pdoc, includeSolutions);
        }
        let res = child.spawnSync('zip', ['-0', '-q', '-r', out, '.'], { cwd: tmpRoot });
        if (res.error || res.status) {
            res = child.spawnSync('zip', ['-q', '-r', out, '.'], { cwd: tmpRoot });
        }
        if (res.error) throw res.error;
        if (res.status) throw new Error(`zip exited with code ${res.status}`);
        return { tmpRoot, out };
    } catch (e) {
        await fsp.rm(tmpRoot, { recursive: true, force: true });
        await fsp.rm(out, { force: true });
        throw e;
    }
}

async function extractCleanZip(filepath, tmpRoot) {
    const reader = new Zip.ZipReader(Readable.toWeb(fs.createReadStream(filepath)));
    try {
        const entries = await reader.getEntries();
        for (const entry of entries) {
            if (entry.directory) continue;
            const name = normalizeZipName(entry.filename);
            if (!name) continue;
            const dest = safeJoin(tmpRoot, name);
            await ensureParent(dest);
            // eslint-disable-next-line no-await-in-loop
            await entry.getData(Writable.toWeb(fs.createWriteStream(dest)));
        }
    } finally {
        await reader.close();
    }
}

class ProblemFastIoHandler extends Handler {
    async get() {
        this.checkPerm(PERM.PERM_EDIT_DOMAIN);
        const domainId = this.args.domainId;
        const query = this.request.query || {};
        if (!truthy(query.download)) {
            this.response.template = 'problem_fast_io.html';
            this.response.body = { page_name: 'problem_fast_io' };
            return;
        }
        const pdocs = await resolveProblems(domainId, query.ids, query.pidFilter || '');
        if (!pdocs.length) throw new ValidationError('pid', null, 'No problem matched');
        const { tmpRoot, out } = await buildServerZip(domainId, pdocs, truthy(query.solutions));
        const stream = fs.createReadStream(out);
        stream.on('close', () => {
            fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
            fsp.rm(out, { force: true }).catch(() => {});
        });
        this.binary(stream, `${safeFilename(domainId)}-problems-${pdocs.length}.zip`);
    }

    async post() {
        this.checkPerm(PERM.PERM_CREATE_PROBLEM);
        const domainId = this.args.domainId;
        const file = this.request.files?.file;
        if (!file) throw new ValidationError('file');
        const body = this.request.body || {};
        if (truthy(body.keepUser)) this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hydro-fast-import-'));
        const run = async () => {
            if (!String(file.originalFilename || '').toLowerCase().endsWith('.zip')) {
                await fsp.rm(tmpRoot, { recursive: true, force: true });
                throw new ValidationError('file', null, 'Only Hydro ZIP packages are supported');
            }
            try {
                await extractCleanZip(file.filepath, tmpRoot);
                await ProblemModel.import(domainId, tmpRoot, {
                    preferredPrefix: body.preferredPrefix || undefined,
                    hidden: truthy(body.hidden),
                    operator: truthy(body.keepUser) ? null : this.user._id,
                    progress: this.progress.bind(this),
                    delSource: true,
                });
            } catch (e) {
                await fsp.rm(tmpRoot, { recursive: true, force: true });
                throw e;
            }
        };
        let resolved = false;
        const promise = run()
            .then(() => {
                resolved = true;
                this.progress('Fast import completed.');
            })
            .catch((e) => MessageModel.send(1, this.user._id, `Fast import failed: ${e.message}\n${e.stack}`));
        await Promise.race([
            promise,
            new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
        this.response.redirect = this.url('problem_main', resolved ? {} : { query: { showImport: 1 } });
    }
}

function apply(ctx) {
    ctx.Route('problem_fast_io', '/manage/problem-fast-io', ProblemFastIoHandler, PERM.PERM_EDIT_DOMAIN);
    ctx.injectUI('ControlPanel', 'problem_fast_io', { icon: 'desktop-download' });
    ctx.i18n.load('zh', { problem_fast_io: '题目快速导入导出' });
    ctx.i18n.load('en', { problem_fast_io: 'Fast Problem Import/Export' });
}

module.exports = { apply };
