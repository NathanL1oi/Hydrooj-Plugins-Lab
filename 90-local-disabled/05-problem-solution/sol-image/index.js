const { render } = require('@hydrooj/ui-default/backendlib/markdown');
const {
    Handler,
    PERM,
    DocumentModel,
    SolutionModel,
    StorageModel,
    DomainModel,
    ObjectId,
    Logger,
    db,
} = require('hydrooj');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const chromeFinderModule = require('chrome-finder');
const puppeteerModule = require('puppeteer-extra');

const logger = new Logger('sol2image');
const chromeFinder = chromeFinderModule.default || chromeFinderModule;
const puppeteer = puppeteerModule.default || puppeteerModule;

const MAX_CONTEXTS = 2;
const RENDER_TIMEOUT_MS = 15000;
const MAX_DATA_URI_BYTES = 10 * 1024 * 1024;
const MAX_SOLUTION_LENGTH = 32000;
const DEFAULT_FONT_FAMILY = 'Noto Sans SC Variable';
const DEFAULT_CODE_FONT_FAMILY = 'JetBrains Mono';
const STORAGE_PREFIX = 'problem-sol';
const AUTO_RENDER_ENABLED = process.env.SOL2IMAGE_AUTO_RENDER !== '0';
const AUTO_RENDER_INTERVAL_MS = Math.max(60 * 1000, +(process.env.SOL2IMAGE_AUTO_RENDER_INTERVAL_MS || 10 * 60 * 1000));
const AUTO_RENDER_START_DELAY_MS = Math.max(0, +(process.env.SOL2IMAGE_AUTO_RENDER_START_DELAY_MS || 60 * 1000));
const AUTO_RENDER_BATCH_LIMIT = Math.max(1, +(process.env.SOL2IMAGE_AUTO_RENDER_BATCH_LIMIT || 30));
const AUTO_RENDER_DOMAIN_LIMIT = Math.max(1, +(process.env.SOL2IMAGE_AUTO_RENDER_DOMAIN_LIMIT || 8));
const AUTO_RENDER_FAILED_COOLDOWN_MS = Math.max(60 * 1000, +(process.env.SOL2IMAGE_AUTO_RENDER_FAILED_COOLDOWN_MS || 30 * 60 * 1000));
const AUTO_RENDER_PENDING_STALE_MS = Math.max(60 * 1000, +(process.env.SOL2IMAGE_AUTO_RENDER_PENDING_STALE_MS || 20 * 60 * 1000));
const AUTO_RENDER_LOCK_TTL_MS = Math.max(AUTO_RENDER_INTERVAL_MS + 60 * 1000, +(process.env.SOL2IMAGE_AUTO_RENDER_LOCK_TTL_MS || 15 * 60 * 1000));
const AUTO_RENDER_LOCK_ID = 'auto-render';
const AUTO_RENDER_LOCK_OWNER = `${process.pid || 'pid'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let browserPromise = null;
let activeContexts = 0;
const waiters = [];
const domainJobs = new Map();
const autoRenderLockColl = db.collection('sol2image.lock');
let autoRenderRunning = false;

function getBrowser() {
    if (!browserPromise) {
        browserPromise = (async () => {
            const executablePath = chromeFinder();
            logger.info('Launching chrome: %s', executablePath);
            return await puppeteer.launch({
                executablePath,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--remote-allow-origins=*',
                    '--disable-dev-shm-usage',
                    '--allow-file-access-from-files',
                    '--enable-local-file-accesses',
                ],
                headless: true,
            });
        })();
    }
    return browserPromise;
}

async function withRenderPage(callback) {
    if (activeContexts >= MAX_CONTEXTS) await new Promise((resolve) => waiters.push(resolve));
    activeContexts += 1;
    let context;
    try {
        const browser = await getBrowser();
        context = await browser.createBrowserContext();
        const page = await context.newPage();
        page.setDefaultNavigationTimeout(RENDER_TIMEOUT_MS);
        page.setDefaultTimeout(RENDER_TIMEOUT_MS);
        return await callback(page);
    } finally {
        if (context) {
            try {
                await context.close();
            } catch (error) {
                logger.warn('Failed to close chrome context: %o', error);
            }
        }
        activeContexts -= 1;
        if (waiters.length) waiters.shift()();
    }
}

async function inlineCss(file) {
    const base = path.dirname(file);
    const css = await fs.readFile(file, 'utf8');
    const withImports = await Promise.all(css.split('\n').map(async (line) => {
        const matched = line.match(/^\s*@import\s+["']([^"']+)["'];?/);
        if (!matched) return line;
        const importPath = require.resolve(matched[1], { paths: [base] });
        return await inlineCss(importPath);
    }));
    return (await Promise.all(withImports.join('\n').split('\n').map(async (line) => {
        const matched = line.match(/url\(["']?([^"')]+)["']?\)/);
        if (!matched) return line;
        const url = matched[1];
        if (/^(?:data:|https?:)/.test(url)) return line;
        const resourcePath = path.resolve(base, url);
        const bytes = await fs.readFile(resourcePath);
        if (bytes.length > MAX_DATA_URI_BYTES) return line;
        const ext = path.extname(resourcePath).toLowerCase();
        const mime = ext === '.woff2' ? 'font/woff2'
            : ext === '.woff' ? 'font/woff'
                : ext === '.ttf' ? 'font/ttf'
                    : ext === '.otf' ? 'font/otf'
                        : 'application/octet-stream';
        return line.replace(matched[0], `url(data:${mime};base64,${bytes.toString('base64')})`);
    }))).join('\n');
}

function wrapMarkdownHtml(markdownHtml, fontFamily, codeFontFamily) {
    const bodyFont = fontFamily || DEFAULT_FONT_FAMILY;
    const codeFont = codeFontFamily || DEFAULT_CODE_FONT_FAMILY;
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
:root {
  --sol-body-font: "${bodyFont}", "Noto Sans SC Variable", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
  --sol-code-font: "${codeFont}", "JetBrains Mono", "Source Code Pro", "Consolas", monospace;
}
html, body { margin: 0; padding: 0; background: #ffffff; }
body { width: fit-content; min-width: 760px; max-width: 1100px; font-family: var(--sol-body-font); color: #1f2937; }
.markdown-body {
  box-sizing: border-box;
  width: fit-content;
  min-width: 760px;
  max-width: 1100px;
  padding: 28px 34px;
  font-size: 17px;
  line-height: 1.72;
}
.markdown-body pre, .markdown-body code, .markdown-body tt {
  font-family: var(--sol-code-font);
}
</style>
</head>
<body class="markdown-body">${markdownHtml}</body>
</html>`;
}

function renderThemeCss() {
    return `
.markdown-body {
  color: #1f2937;
}
.markdown-body h1,
.markdown-body h2,
.markdown-body h3 {
  color: #24344d;
  font-weight: 750;
}
.markdown-body a {
  color: #2563eb;
}
.markdown-body blockquote {
  color: #475569;
  border-left: 4px solid #93c5fd;
  background: #f8fafc;
  padding: 0.75em 1em;
  border-radius: 0 6px 6px 0;
}
.markdown-body code,
.markdown-body tt {
  font-family: var(--sol-code-font) !important;
}
.markdown-body :not(pre) > code {
  color: #be123c;
  background: #fff1f2;
  border: 1px solid #ffe4e6;
  border-radius: 4px;
  padding: 0.08em 0.35em;
  font-size: 0.92em;
}
.markdown-body pre {
  position: relative;
  margin: 1.1em 0;
  padding: 3.25em 1.35em 1.15em;
  color: #233044;
  background: #f8fafc;
  border: 1px solid #dbe4f0;
  border-radius: 8px;
  box-shadow: 0 1px 0 rgba(15, 23, 42, 0.03);
  overflow: visible;
  white-space: pre-wrap;
  word-break: break-word;
}
.markdown-body pre::before {
  content: attr(data-language);
  position: absolute;
  inset: 0 auto auto 0;
  box-sizing: border-box;
  width: 100%;
  height: 2.15em;
  padding: 0.48em 1.1em;
  color: #334155;
  background: #eef4fb;
  border-bottom: 1px solid #dbe4f0;
  border-radius: 8px 8px 0 0;
  font-family: var(--sol-body-font);
  font-size: 0.88em;
  font-weight: 700;
  line-height: 1.2;
}
.markdown-body pre:not([data-language])::before {
  content: "代码";
}
.markdown-body pre > code {
  display: block;
  padding: 0;
  color: inherit;
  background: transparent !important;
  border: 0;
  font-family: var(--sol-code-font) !important;
  font-size: 1.02em;
  line-height: 1.72;
  tab-size: 4;
  white-space: pre-wrap;
  word-break: break-word;
  font-variant-ligatures: none;
}
.token.comment,
.token.prolog,
.token.doctype,
.token.cdata {
  color: #73829a;
  font-style: italic;
}
.token.punctuation,
.token.operator {
  color: #334155;
}
.token.namespace {
  opacity: 0.8;
}
.token.property,
.token.tag,
.token.constant,
.token.symbol,
.token.deleted,
.token.macro,
.token.directive,
.token.directive-hash {
  color: #be123c;
}
.token.boolean,
.token.number {
  color: #c55a11;
}
.token.selector,
.token.attr-name,
.token.string,
.token.char,
.token.builtin,
.token.inserted {
  color: #07845f;
}
.token.keyword {
  color: #7c3aed;
  font-weight: 750;
}
.token.function {
  color: #0b6fae;
}
.token.class-name,
.token.variable {
  color: #0f766e;
}
.token.regex,
.token.important {
  color: #db2777;
}
`;
}

async function renderMarkdownToPng(content, fontFamily, codeFontFamily) {
    const markdownHtml = await render(content);
    const bodyHtml = wrapMarkdownHtml(markdownHtml, fontFamily, codeFontFamily);
    const bodyFontCss = await inlineCss(require.resolve('@fontsource-variable/noto-sans-sc/index.css'));
    const jetbrainsCss = await inlineCss(require.resolve('@fontsource/jetbrains-mono/index.css'));
    const sourceCodeCss = await inlineCss(require.resolve('@fontsource/source-code-pro/index.css'));
    const githubCss = await inlineCss(require.resolve('github-markdown-css/github-markdown.css'));
    const katexCss = await inlineCss(require.resolve('katex/dist/katex.min.css'));
    const prismCss = await fs.readFile(require.resolve('prismjs/themes/prism.css'), 'utf8');
    const katexJs = await fs.readFile(require.resolve('katex/dist/katex.min.js'), 'utf8');
    const katexAutoRenderJs = await fs.readFile(require.resolve('katex/dist/contrib/auto-render.min.js'), 'utf8');
    const prismCoreJs = await fs.readFile(require.resolve('prismjs/components/prism-core.min.js'), 'utf8');
    const prismClikeJs = await fs.readFile(require.resolve('prismjs/components/prism-clike.min.js'), 'utf8');
    const prismCJs = await fs.readFile(require.resolve('prismjs/components/prism-c.min.js'), 'utf8');
    const prismCppJs = await fs.readFile(require.resolve('prismjs/components/prism-cpp.min.js'), 'utf8');
    const katexMhchemJs = await fs.readFile(require.resolve('katex/dist/contrib/mhchem.min.js'), 'utf8');
    return await withRenderPage(async (page) => {
        await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 2 });
        await page.setContent(bodyHtml, { waitUntil: 'domcontentloaded' });
        await page.addStyleTag({ content: `${bodyFontCss}\n${jetbrainsCss}\n${sourceCodeCss}\n${githubCss}\n${katexCss}\n${prismCss}\n${renderThemeCss()}` });
        await page.addScriptTag({ content: katexJs });
        await page.addScriptTag({ content: katexAutoRenderJs });
        await page.addScriptTag({ content: prismCoreJs });
        await page.addScriptTag({ content: prismClikeJs });
        await page.addScriptTag({ content: prismCJs });
        await page.addScriptTag({ content: prismCppJs });
        await page.addScriptTag({ content: katexMhchemJs });
        await page.evaluate(() => {
            document.querySelectorAll('pre > code').forEach((code) => {
                const pre = code.parentElement;
                const languageClass = Array.from(code.classList).find((name) => name.startsWith('language-'));
                if (!languageClass) {
                    code.classList.add('language-cpp');
                    pre?.classList.add('language-cpp');
                    pre?.setAttribute('data-language', 'C++');
                    return;
                }
                pre?.classList.add(languageClass);
                const label = languageClass.replace(/^language-/, '').toUpperCase().replace('CPP', 'C++');
                pre?.setAttribute('data-language', label || '代码');
            });
            renderMathInElement(document.body, {
                delimiters: [
                    { left: '$$', right: '$$', display: true },
                    { left: '$', right: '$', display: false },
                    { left: '\\(', right: '\\)', display: false },
                    { left: '\\[', right: '\\]', display: true },
                ],
                throwOnError: false,
                trust: true,
            });
            Prism.highlightAll();
        });
        await page.emulateMediaType('screen');
        await page.evaluate(() => document.fonts?.ready || Promise.resolve());
        return await page.screenshot({ type: 'png', fullPage: true });
    });
}

function solutionId(psdoc) {
    return psdoc?.docId || psdoc?._id;
}

function storagePath(domainId, psid, filename) {
    return `${STORAGE_PREFIX}/${domainId}/${psid}/${filename}`;
}

async function applySolutionImageContent(domainId, psdoc, viewer, options = {}) {
    const canEdit = options.canEdit ?? viewer?.hasPerm?.(PERM.PERM_EDIT_PROBLEM_SOLUTION);
    if (String(psdoc.owner) === String(viewer?._id) || canEdit) return false;
    const psid = solutionId(psdoc);
    if (psdoc.filename && psdoc.status === 'completed') {
        const target = storagePath(domainId, psid, psdoc.filename);
        const exists = await StorageModel.exists(target).catch(() => false);
        if (exists) {
            const url = await StorageModel.signDownloadLink(target, psdoc.filename, false, 'user');
            psdoc.content = `![solution](${url})`;
        } else {
            const now = new Date();
            await DocumentModel.set(domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, psid, {
                status: 'failed',
                sol2imageStatusAt: now,
                sol2imageFailedAt: now,
                sol2imageError: 'image file missing',
            }).catch(() => null);
            psdoc.content = '系统提示：题解图片文件缺失，请联系管理员在题库页批量渲染题解。';
        }
    } else if (psdoc.status === 'failed') {
        psdoc.content = '系统提示：题解图片渲染失败，请联系管理员处理。';
    } else if (psdoc.filename) {
        psdoc.content = '系统提示：题解图片正在渲染中，请稍后刷新页面查看。';
    } else {
        psdoc.content = '系统提示：该题解还没有渲染成图片，请联系管理员批量渲染或请作者重新提交题解。';
    }
    return true;
}

function normalizedContent(content) {
    const text = String(content || '');
    if (text.length <= MAX_SOLUTION_LENGTH) return text;
    return `${text.substring(0, MAX_SOLUTION_LENGTH)}\n\n......`;
}

function imageFilename(psid, content) {
    return `${crypto.createHash('md5').update(`${psid}-${content}`).digest('hex')}.png`;
}

async function renderSolutionImage(domainId, psid, content, filename, fontFamily, codeFontFamily) {
    try {
        const image = await renderMarkdownToPng(content, fontFamily, codeFontFamily);
        await StorageModel.put(storagePath(domainId, psid, filename), image);
        const now = new Date();
        await DocumentModel.set(domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, psid, {
            status: 'completed',
            sol2imageStatusAt: now,
            sol2imageRenderedAt: now,
        }, {
            sol2imageError: '',
            sol2imageFailedAt: '',
        });
        return true;
    } catch (error) {
        logger.error('Failed to render solution image for %s/%s: %o', domainId, psid, error);
        const now = new Date();
        await DocumentModel.set(domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, psid, {
            status: 'failed',
            sol2imageStatusAt: now,
            sol2imageFailedAt: now,
            sol2imageError: error?.message || String(error),
        });
        return false;
    }
}

async function queueSolutionRender(domainId, psid, rawContent, user, oldFilename) {
    const content = normalizedContent(rawContent);
    const filename = imageFilename(psid, content);
    await DocumentModel.set(domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, psid, {
        filename,
        status: 'pending',
        sol2imageStatusAt: new Date(),
    });
    renderSolutionImage(
        domainId,
        psid,
        content,
        filename,
        user?.fontFamily || DEFAULT_FONT_FAMILY,
        user?.codeFontFamily || DEFAULT_CODE_FONT_FAMILY,
    ).then(async (success) => {
        if (success && oldFilename && oldFilename !== filename) {
            await StorageModel.del([storagePath(domainId, psid, oldFilename)]).catch((error) => {
                logger.warn('Failed to delete old solution image: %o', error);
            });
        }
    });
}

async function renderExistingSolution(domainId, psdoc, options = {}) {
    const psid = solutionId(psdoc);
    if (!psid || !psdoc?.content) return { ok: false, skipped: true, reason: 'empty' };
    if (!options.force && psdoc.filename && psdoc.status === 'completed') {
        return { ok: true, skipped: true, reason: 'completed' };
    }
    const content = normalizedContent(psdoc.content);
    const filename = imageFilename(psid, content);
    await DocumentModel.set(domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, psid, {
        filename,
        status: 'pending',
        sol2imageStatusAt: new Date(),
    });
    const ok = await renderSolutionImage(
        domainId,
        psid,
        content,
        filename,
        DEFAULT_FONT_FAMILY,
        DEFAULT_CODE_FONT_FAMILY,
    );
    if (ok && psdoc.filename && psdoc.filename !== filename) {
        await StorageModel.del([storagePath(domainId, psid, psdoc.filename)]).catch((error) => {
            logger.warn('Failed to delete stale solution image: %o', error);
        });
    }
    return { ok, skipped: false };
}

function missingQuery() {
    return {
        parentType: DocumentModel.TYPE_PROBLEM,
        $or: [
            { filename: { $exists: false } },
            { filename: '' },
            { status: { $exists: false } },
            { status: { $ne: 'completed' } },
        ],
    };
}

function autoRenderQuery(date = new Date()) {
    const failedBefore = new Date(date.getTime() - AUTO_RENDER_FAILED_COOLDOWN_MS);
    const pendingBefore = new Date(date.getTime() - AUTO_RENDER_PENDING_STALE_MS);
    return {
        parentType: DocumentModel.TYPE_PROBLEM,
        content: { $exists: true, $nin: ['', null] },
        $or: [
            { status: { $exists: false } },
            { status: { $nin: ['completed', 'pending', 'failed'] } },
            {
                status: { $nin: ['pending', 'failed'] },
                $or: [
                    { filename: { $exists: false } },
                    { filename: '' },
                ],
            },
            { status: 'pending', sol2imageStatusAt: { $exists: false } },
            { status: 'pending', sol2imageStatusAt: { $lte: pendingBefore } },
            { status: 'failed', sol2imageFailedAt: { $exists: false } },
            { status: 'failed', sol2imageFailedAt: { $lte: failedBefore } },
        ],
    };
}

async function acquireAutoRenderLock(trigger) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + AUTO_RENDER_LOCK_TTL_MS);
    try {
        const doc = await autoRenderLockColl.findOneAndUpdate(
            {
                _id: AUTO_RENDER_LOCK_ID,
                $or: [
                    { expiresAt: { $exists: false } },
                    { expiresAt: { $lte: now } },
                    { owner: AUTO_RENDER_LOCK_OWNER },
                ],
            },
            { $set: { owner: AUTO_RENDER_LOCK_OWNER, trigger, expiresAt, updatedAt: now } },
            { upsert: true, returnDocument: 'after' },
        );
        return doc?.owner === AUTO_RENDER_LOCK_OWNER;
    } catch (error) {
        if (error?.code !== 11000) logger.warn('Failed to acquire auto render lock: %o', error);
        return false;
    }
}

async function refreshAutoRenderLock() {
    const now = new Date();
    await autoRenderLockColl.updateOne(
        { _id: AUTO_RENDER_LOCK_ID, owner: AUTO_RENDER_LOCK_OWNER },
        { $set: { expiresAt: new Date(now.getTime() + AUTO_RENDER_LOCK_TTL_MS), updatedAt: now } },
    ).catch((error) => logger.warn('Failed to refresh auto render lock: %o', error));
}

async function releaseAutoRenderLock() {
    await autoRenderLockColl.deleteOne({
        _id: AUTO_RENDER_LOCK_ID,
        owner: AUTO_RENDER_LOCK_OWNER,
    }).catch((error) => logger.warn('Failed to release auto render lock: %o', error));
}

async function collectAutoRenderCandidates(domainId, limit) {
    if (limit <= 0) return [];
    return await DocumentModel.getMulti(domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, autoRenderQuery())
        .project({
            docId: 1,
            _id: 1,
            parentId: 1,
            owner: 1,
            content: 1,
            filename: 1,
            status: 1,
            sol2imageStatusAt: 1,
            sol2imageFailedAt: 1,
        })
        .sort({ _id: 1 })
        .limit(limit)
        .toArray();
}

async function runAutoRenderOnce(trigger = 'timer') {
    if (!AUTO_RENDER_ENABLED) return { skipped: true, reason: 'disabled' };
    if (autoRenderRunning) return { skipped: true, reason: 'running' };
    autoRenderRunning = true;
    const locked = await acquireAutoRenderLock(trigger);
    if (!locked) {
        autoRenderRunning = false;
        return { skipped: true, reason: 'locked' };
    }
    const stats = {
        domains: 0,
        scanned: 0,
        rendered: 0,
        failed: 0,
        skipped: 0,
    };
    try {
        const domains = await DomainModel.getMulti({})
            .project({ _id: 1 })
            .sort({ _id: 1 })
            .toArray();
        for (const ddoc of domains) {
            if (stats.scanned >= AUTO_RENDER_BATCH_LIMIT) break;
            const domainId = String(ddoc._id);
            const job = getJob(domainId);
            if (job && !job.finishedAt && !job.cancelled) continue;
            const limit = Math.min(AUTO_RENDER_DOMAIN_LIMIT, AUTO_RENDER_BATCH_LIMIT - stats.scanned);
            const psdocs = await collectAutoRenderCandidates(domainId, limit);
            if (!psdocs.length) continue;
            stats.domains += 1;
            for (const psdoc of psdocs) {
                await refreshAutoRenderLock();
                stats.scanned += 1;
                const result = await renderExistingSolution(domainId, psdoc, { force: false });
                if (result.skipped) stats.skipped += 1;
                else if (result.ok) stats.rendered += 1;
                else stats.failed += 1;
                if (stats.scanned >= AUTO_RENDER_BATCH_LIMIT) break;
            }
        }
        if (stats.scanned) {
            logger.info(
                'Auto render scan done: trigger=%s domains=%d scanned=%d rendered=%d failed=%d skipped=%d',
                trigger, stats.domains, stats.scanned, stats.rendered, stats.failed, stats.skipped,
            );
        }
        return stats;
    } catch (error) {
        logger.error('Auto render scan failed: %o', error);
        return { ...stats, error };
    } finally {
        await releaseAutoRenderLock();
        autoRenderRunning = false;
    }
}

function startAutoRenderScheduler(ctx) {
    if (!AUTO_RENDER_ENABLED) {
        logger.info('Auto render scheduler is disabled by SOL2IMAGE_AUTO_RENDER=0.');
        return;
    }
    ctx.effect(() => {
        const run = (trigger) => {
            runAutoRenderOnce(trigger).catch((error) => {
                logger.error('Auto render scheduler failed: %o', error);
            });
        };
        const startupTimer = setTimeout(() => run('startup'), AUTO_RENDER_START_DELAY_MS);
        const intervalTimer = setInterval(() => run('timer'), AUTO_RENDER_INTERVAL_MS);
        logger.info(
            'Auto render scheduler enabled: interval=%dms batch=%d perDomain=%d',
            AUTO_RENDER_INTERVAL_MS, AUTO_RENDER_BATCH_LIMIT, AUTO_RENDER_DOMAIN_LIMIT,
        );
        return () => {
            clearTimeout(startupTimer);
            clearInterval(intervalTimer);
        };
    });
}

async function countSolutions(domainId, query) {
    try {
        return await DocumentModel.count(domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, query);
    } catch (error) {
        logger.warn('Failed to count solutions in %s: %o', domainId, error);
        return 0;
    }
}

async function collectStats(domainId) {
    const allQuery = { parentType: DocumentModel.TYPE_PROBLEM };
    return {
        total: await countSolutions(domainId, allQuery),
        missing: await countSolutions(domainId, missingQuery()),
        completed: await countSolutions(domainId, { ...allQuery, filename: { $exists: true }, status: 'completed' }),
        pending: await countSolutions(domainId, { ...allQuery, status: 'pending' }),
        failed: await countSolutions(domainId, { ...allQuery, status: 'failed' }),
    };
}

function nowText(date = new Date()) {
    return date.toLocaleString('zh-CN', { hour12: false });
}

function addJobMessage(job, message) {
    job.messages.unshift(`${nowText()} ${message}`);
    if (job.messages.length > 20) job.messages.length = 20;
}

function getJob(domainId) {
    return domainJobs.get(String(domainId));
}

function startDomainJob(domainId, force, uid) {
    const key = String(domainId);
    const current = domainJobs.get(key);
    if (current && !current.finishedAt && !current.cancelled) return { job: current, started: false };
    const job = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        domainId: key,
        force,
        uid,
        total: 0,
        scanned: 0,
        rendered: 0,
        failed: 0,
        skipped: 0,
        cancelled: false,
        startedAt: Date.now(),
        startedAtText: nowText(),
        finishedAt: 0,
        finishedAtText: '',
        current: '',
        messages: [],
    };
    domainJobs.set(key, job);
    addJobMessage(job, force ? '已开始强制重新渲染当前子域全部题解。' : '已开始渲染当前子域缺失或未完成的题解。');
    runDomainJob(job).catch((error) => {
        logger.error('Batch render job failed in %s: %o', key, error);
        job.failed += 1;
        job.finishedAt = Date.now();
        job.finishedAtText = nowText();
        addJobMessage(job, '批量任务异常结束，请查看 Hydro 日志。');
    });
    return { job, started: true };
}

async function runDomainJob(job) {
    const domainId = job.domainId;
    const query = job.force ? { parentType: DocumentModel.TYPE_PROBLEM } : missingQuery();
    const psdocs = await DocumentModel.getMulti(domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, query)
        .project({ docId: 1, _id: 1, parentId: 1, owner: 1, content: 1, filename: 1, status: 1 })
        .toArray();
    job.total = psdocs.length;
    addJobMessage(job, `本次任务发现 ${job.total} 篇待处理题解。`);
    for (const psdoc of psdocs) {
        if (job.cancelled) break;
        const psid = solutionId(psdoc);
        job.current = String(psid || '');
        job.scanned += 1;
        const result = await renderExistingSolution(domainId, psdoc, { force: job.force });
        if (result.skipped) job.skipped += 1;
        else if (result.ok) job.rendered += 1;
        else job.failed += 1;
        if (job.scanned % 10 === 0 || job.scanned === job.total) {
            addJobMessage(job, `进度 ${job.scanned}/${job.total}，成功 ${job.rendered}，失败 ${job.failed}，跳过 ${job.skipped}。`);
        }
    }
    job.current = '';
    job.finishedAt = Date.now();
    job.finishedAtText = nowText();
    addJobMessage(job, job.cancelled ? '批量任务已停止。' : '批量任务已完成。');
}

async function renderBatchPage(handler, messages = []) {
    const domainId = String(handler.domain?._id || handler.args?.domainId || 'system');
    handler.response.template = 'sol2image_batch_render.html';
    handler.response.body = {
        page_name: 'sol2image_batch_render',
        domainId,
        stats: await collectStats(domainId),
        job: getJob(domainId),
        messages,
    };
}

class Sol2ImageBatchRenderHandler extends Handler {
    async prepare() {
        this.checkPerm(PERM.PERM_EDIT_DOMAIN);
    }

    async get() {
        await renderBatchPage(this);
    }

    async start(force) {
        const domainId = String(this.domain?._id || this.args?.domainId || 'system');
        const messages = [];
        const { started } = startDomainJob(domainId, force, this.user?._id);
        messages.push(started ? '批量任务已启动，页面会自动刷新进度。' : '当前子域已经有批量任务在运行。');
        await renderBatchPage(this, messages);
    }

    async postStartMissing() {
        await this.start(false);
    }

    async postStartAll() {
        await this.start(true);
    }

    async postStop() {
        const domainId = String(this.domain?._id || this.args?.domainId || 'system');
        const messages = [];
        const job = getJob(domainId);
        if (job && !job.finishedAt) {
            job.cancelled = true;
            addJobMessage(job, '已收到停止请求，当前正在渲染的题解完成后会停下。');
            messages.push('已请求停止当前批量任务。');
        } else {
            messages.push('当前没有正在运行的批量任务。');
        }
        await renderBatchPage(this, messages);
    }

    async post() {
        await renderBatchPage(this);
    }
}

function installHooks(ctx) {
    ctx.on('handler/before/ProblemSolution#post', async (handler) => {
        const args = handler.args || {};
        if (args.operation !== 'delete_solution') return;
        const psdoc = await DocumentModel.get(handler.args.domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, new ObjectId(String(args.psid))).catch(() => null);
        if (!psdoc) return;
        if (String(psdoc.owner) !== String(handler.user?._id) && !handler.user?.hasPerm(PERM.PERM_EDIT_PROBLEM_SOLUTION)) return;
        if (psdoc?.filename) await StorageModel.del([storagePath(handler.args.domainId, args.psid, psdoc.filename)]).catch(() => null);
    });

    ctx.on('handler/after/ProblemSolution#get', async (handler) => {
        const psdocs = handler.response.body?.psdocs || [];
        const fallbackDomainId = String(handler.pdoc?.reference?.domainId || handler.args?.domainId || handler.domain?._id || 'system');
        for (const psdoc of psdocs) {
            const domainId = String(psdoc.domainId || fallbackDomainId);
            await applySolutionImageContent(domainId, psdoc, handler.user);
        }
    });

    ctx.on('handler/after/ProblemSolution#post', async (handler) => {
        const args = handler.args || {};
        const domainId = String(args.domainId || handler.domain?._id || 'system');
        if (args.operation === 'submit') {
            const psid = handler.response.body?.psid;
            if (!psid) return;
            const psdoc = await SolutionModel.get(domainId, psid);
            await queueSolutionRender(domainId, psid, psdoc?.content || '', handler.user);
        } else if (args.operation === 'edit_solution') {
            const psid = new ObjectId(String(args.psid));
            const psdoc = await SolutionModel.get(domainId, psid);
            await queueSolutionRender(domainId, psid, psdoc?.content || '', handler.user, psdoc?.filename);
        }
    });

    ctx.on('handler/before/ProblemMain#get', async (handler) => {
        if (!handler.UiContext) handler.UiContext = {};
        handler.UiContext.sol2imageBatch = {
            canUse: handler.user?.hasPerm(PERM.PERM_EDIT_DOMAIN),
            url: handler.url('sol2image_batch_render'),
        };
    });
    ctx.on('handler/after/ProblemMain#get', async (handler) => {
        if (!handler.UiContext) handler.UiContext = {};
        handler.UiContext.sol2imageBatch = {
            canUse: handler.user?.hasPerm(PERM.PERM_EDIT_DOMAIN),
            url: handler.url('sol2image_batch_render'),
        };
    });
}

exports.apply = (ctx) => {
    global.Hydro ||= {};
    global.Hydro.model ||= {};
    global.Hydro.model.solImage = {
        solutionId,
        storagePath,
        applySolutionImageContent,
        renderExistingSolution,
        startDomainJob,
        runAutoRenderOnce,
    };
    global.Hydro.model.sol2image = global.Hydro.model.solImage;
    ctx.Route('sol2image_batch_render', '/domain/sol2image/render', Sol2ImageBatchRenderHandler, PERM.PERM_EDIT_DOMAIN);
    ctx.injectUI('DomainManage', 'sol2image_batch_render', {
        family: 'Problem',
        icon: 'image',
    }, PERM.PERM_EDIT_DOMAIN);
    ctx.i18n.load('zh', {
        sol2image_batch_render: '批量渲染题解',
    });
    installHooks(ctx);
    startAutoRenderScheduler(ctx);
};
