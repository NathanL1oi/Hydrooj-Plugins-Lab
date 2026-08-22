'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
    ForbiddenError,
    Handler,
    Logger,
    NotFoundError,
    ObjectId,
    PERM,
    PRIV,
    ProblemModel,
    StorageModel,
    ValidationError,
} = require('hydrooj');

let renderMarkdown = null;
try {
    const markdownModule = require('@hydrooj/ui-default/backendlib/markdown');
    renderMarkdown = markdownModule.render || markdownModule.default || markdownModule;
} catch {
    renderMarkdown = null;
}

const MARKER_RE = /<!--\s*hydro-course-lecture-problem\s+({[\s\S]*?})\s*-->\s*/g;
const STORAGE_PREFIX = 'course-lecture-problem';
const DEFAULT_FONT_FAMILY = 'Noto Sans SC Variable';
const DEFAULT_CODE_FONT_FAMILY = 'JetBrains Mono';
const RENDER_TIMEOUT_MS = 15000;
const STATEMENT_RENDER_VERSION = '8';
const MAX_DATA_URI_BYTES = 10 * 1024 * 1024;
const MAX_STATEMENT_LENGTH = 60000;
const SVG_WIDTH = 1100;
const SVG_MAX_HEIGHT = 14000;
const logger = new Logger('course-lecture-problem');
const DEPENDENCY_ROOTS = [
    __dirname,
    path.resolve(__dirname, '..', 'sol-image'),
    path.resolve(__dirname, '..', '..', '01 已装', 'sol-image'),
    '/root/.hydro/add/sol-image',
    '/root/.hydro/addons/sol-image',
    '/home/hydro-plugins/sol-image',
    '/home/hydro-plu/sol-image',
].filter(Boolean);
let courseModelPatched = false;
let browserPromise = null;
let activeContexts = 0;
const waiters = [];

function resolveDependency(name, extraPaths = []) {
    return require.resolve(name, {
        paths: [...extraPaths.filter(Boolean), ...DEPENDENCY_ROOTS],
    });
}

function requireDependency(name) {
    return require(resolveDependency(name));
}

if (!renderMarkdown) {
    try {
        const markdownModule = requireDependency('@hydrooj/ui-default/backendlib/markdown');
        renderMarkdown = markdownModule.render || markdownModule.default || markdownModule;
    } catch {
        renderMarkdown = null;
    }
}

function domainIdOf(handler) {
    return String(handler.args?.domainId || handler.domain?._id || 'system');
}

function textId(value) {
    return value?.toHexString?.() || value?.toString?.() || String(value || '');
}

function objectId(value, field) {
    try {
        if (value?.toHexString) return value;
        return new ObjectId(String(value));
    } catch {
        throw new ValidationError(field || 'id');
    }
}

function routeValue(handler, name) {
    return handler.args?.[name]
        ?? handler.request?.params?.[name]
        ?? handler.request?.query?.[name];
}

function appendQuery(url, query) {
    const pairs = [];
    for (const [key, value] of Object.entries(query || {})) {
        if (value === undefined || value === null || value === '') continue;
        pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
    if (!pairs.length) return url;
    return `${url}${url.includes('?') ? '&' : '?'}${pairs.join('&')}`;
}

function lectureContextToken(cid, csid, ssid) {
    return [cid, csid, ssid].map(textId).join(',');
}

function parseLectureContextToken(value) {
    const parts = String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
    if (parts.length !== 3) return null;
    return { cid: parts[0], csid: parts[1], ssid: parts[2] };
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function safeDecodeURIComponent(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function requestOrigin(handler) {
    const request = handler?.request || {};
    const headers = request.headers || {};
    const host = headers.host || request.host || handler?.domain?.host;
    if (!host || Array.isArray(host)) return '';
    const forwardedProto = String(headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const protocol = forwardedProto || request.protocol || (request.secure ? 'https' : 'http');
    return `${protocol}://${host}`;
}

function extractProblemFileName(src) {
    const raw = String(src || '').trim();
    if (!raw || /^(?:data:|blob:|https?:)/i.test(raw)) return '';
    let value = raw.replace(/&amp;/g, '&');
    if (/^file:\/\//i.test(value)) value = value.replace(/^file:\/\//i, '');
    else {
        const match = value.match(/(?:^|\/|\.\/)(?:p\/[^/]+\/)?file\/([^?#]+)/i);
        if (!match) return '';
        value = match[1];
    }
    value = value.split(/[?#]/)[0].replace(/^\/+/, '');
    return safeDecodeURIComponent(value);
}

function signedProblemFileUrl(src, fileUrls) {
    const filename = extractProblemFileName(src);
    if (!filename) return '';
    return fileUrls[filename] || fileUrls[path.basename(filename)] || '';
}

function rewriteProblemFileReferences(content, fileUrls) {
    const rewrite = (src) => signedProblemFileUrl(src, fileUrls) || src;
    return String(content || '')
        .replace(/file:\/\/([^ \n)\]\\'"]+)/g, (src) => rewrite(src))
        .replace(/(\]\()((?:\.\/|\/)?(?:p\/[^/\s)]+\/)?file\/[^)\s]+)(\))/gi, (all, left, src, right) => `${left}${rewrite(src)}${right}`)
        .replace(/((?:src|href|poster)=["'])((?:\.\/|\/)?(?:p\/[^"']+\/)?file\/[^"']+)(["'])/gi, (all, left, src, right) => `${left}${rewrite(src)}${right}`);
}

function rewriteProblemFileRoutes(content, pdoc) {
    const names = new Set((Array.isArray(pdoc?.additional_file) ? pdoc.additional_file : [])
        .flatMap((file) => {
            const name = file?.name || file?._id;
            if (!name) return [];
            const normalized = safeDecodeURIComponent(String(name));
            return [String(name), normalized, path.basename(normalized)];
        }));
    if (!names.size) return content;
    const domainId = encodeURIComponent(String(pdoc.domainId || ''));
    const docId = encodeURIComponent(String(pdoc.docId || ''));
    const rewriteText = (value) => String(value || '').replace(/file:\/\/([^ \n)\]\\'"]+)/g, (all, fileinfo) => {
        const filename = safeDecodeURIComponent(String(fileinfo || '').split(/[?#]/)[0].replace(/^\/+/, ''));
        if (!names.has(filename) && !names.has(path.basename(filename))) return all;
        return `/d/${domainId}/p/${docId}/file/${fileinfo}`;
    });
    if (typeof content === 'string') return rewriteText(content);
    if (!content || typeof content !== 'object' || Array.isArray(content)) return content;
    return Object.fromEntries(Object.entries(content).map(([key, value]) => [
        key,
        typeof value === 'string' ? rewriteText(value) : value,
    ]));
}

async function signedProblemFileUrls(pdoc) {
    const urls = {};
    const files = Array.isArray(pdoc?.additional_file) ? pdoc.additional_file : [];
    for (const file of files) {
        const name = file?.name || file?._id;
        if (!name) continue;
        const target = `problem/${pdoc.domainId}/${pdoc.docId}/additional_file/${name}`;
        try {
            const url = await StorageModel.signDownloadLink(target, undefined, false, 'user');
            const normalized = safeDecodeURIComponent(String(name));
            urls[normalized] = url;
            urls[String(name)] = url;
            urls[path.basename(normalized)] ||= url;
        } catch (error) {
            logger.warn('Failed to sign lecture problem file %s: %o', name, error);
        }
    }
    return urls;
}

function normalizePid(value) {
    const match = String(value || '').trim().match(/P?\s*(\d+)/i);
    const pid = match ? Number(match[1]) : 0;
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

function parsePids(value) {
    const raw = Array.isArray(value) ? value : String(value || '').split(/[,\uFF0C\s]+/);
    const seen = new Set();
    const pids = [];
    for (const item of raw) {
        const pid = normalizePid(item);
        if (!pid || seen.has(pid)) continue;
        seen.add(pid);
        pids.push(pid);
    }
    return pids;
}

function stripMarker(content) {
    MARKER_RE.lastIndex = 0;
    const clean = String(content || '').replace(MARKER_RE, '');
    MARKER_RE.lastIndex = 0;
    return clean.trimStart();
}

function readMarker(content) {
    let result = null;
    MARKER_RE.lastIndex = 0;
    let match;
    while ((match = MARKER_RE.exec(String(content || '')))) {
        try {
            result = JSON.parse(match[1]);
        } catch {
            result = null;
        }
    }
    MARKER_RE.lastIndex = 0;
    return result || {};
}

function withMarker(content, lecturePids) {
    const clean = stripMarker(content);
    const pids = parsePids(lecturePids);
    if (!pids.length) return clean;
    const meta = { pids };
    if (pids.length === 1) meta.pid = pids[0];
    return `<!-- hydro-course-lecture-problem ${JSON.stringify(meta)} -->\n${clean}`;
}

function markerLecturePids(meta, pids) {
    const directPids = parsePids(meta?.pids);
    const singlePid = normalizePid(meta?.pid);
    if (singlePid && !directPids.includes(singlePid)) directPids.push(singlePid);
    return directPids;
}

function lecturePidsFromDoc(doc) {
    const meta = readMarker(doc?.content);
    return markerLecturePids(meta, doc?.pids);
}

function lecturePidFromDoc(doc) {
    return lecturePidsFromDoc(doc)[0] || 0;
}

function pidsWithoutLectures(value, lecturePids) {
    const lectureSet = new Set(parsePids(lecturePids));
    return parsePids(value).filter((pid) => !lectureSet.has(pid));
}

function pidsWithoutLecture(value, lecturePid) {
    return pidsWithoutLectures(value, [lecturePid]);
}

function getCourseModel() {
    return global.Hydro?.model?.course || null;
}

function canManageCourse(user) {
    return !!(user?.hasPerm?.(PERM.PERM_EDIT_TRAINING) || user?.hasPerm?.(PERM.PERM_EDIT_DOMAIN));
}

function canEditProblem(user, pdoc) {
    return !!(
        user?.hasPerm?.(PERM.PERM_EDIT_DOMAIN)
        || user?.hasPerm?.(PERM.PERM_EDIT_PROBLEM)
        || user?.own?.(pdoc, PERM.PERM_EDIT_PROBLEM_SELF)
    );
}

async function ensureProblemReadable(domainId, pid, handler) {
    if (!pid) return null;
    const scope = handler.user?.hasPerm?.(PERM.PERM_VIEW_PROBLEM_HIDDEN) ? true : handler.user?._id;
    return await ProblemModel.get(domainId, pid, ProblemModel.PROJECTION_PUBLIC, scope);
}

async function resolveStatementProblem(pdoc, fallbackDomainId = '') {
    let current = pdoc ? { ...pdoc, domainId: pdoc.domainId || fallbackDomainId } : pdoc;
    const seen = new Set();
    while (current?.reference?.domainId && current.reference.pid !== undefined) {
        const key = `${current.reference.domainId}:${current.reference.pid}`;
        if (seen.has(key)) break;
        seen.add(key);
        const refDomainId = current.reference.domainId;
        const refProblem = await ProblemModel.get(
            current.reference.domainId,
            current.reference.pid,
            ProblemModel.PROJECTION_PUBLIC,
            true,
        );
        if (!refProblem) break;
        refProblem.domainId ||= refDomainId;
        current = refProblem;
    }
    if (!current) return pdoc;
    return {
        ...current,
        content: rewriteProblemFileRoutes(current.content, current),
    };
}

function lectureProblemPid(pdoc, lecturePid) {
    return pdoc?.pid || `P${lecturePid || pdoc?.docId || ''}`;
}

function lectureProblemDifficulty(pdoc) {
    if (pdoc?.difficulty) return pdoc.difficulty;
    return '';
}

function selectLocalizedValue(value, handler) {
    if (typeof value === 'string') {
        const text = value.trim();
        if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
            try {
                return selectLocalizedValue(JSON.parse(text), handler);
            } catch {
                return value;
            }
        }
        return value;
    }
    if (!value || typeof value !== 'object') return '';
    const lang = handler.request?.query?.lang || handler.user?.viewLang || handler.session?.viewLang;
    return value[lang] || value.zh || value['zh-cn'] || value.en || Object.values(value).find((item) => typeof item === 'string') || '';
}

function statementMarkdown(pdoc, handler) {
    const content = selectLocalizedValue(pdoc?.content, handler);
    const text = String(content || '');
    if (text.length <= MAX_STATEMENT_LENGTH) return text;
    return `${text.slice(0, MAX_STATEMENT_LENGTH)}\n\n......`;
}

function statementHash(pdoc, content) {
    const files = (Array.isArray(pdoc?.additional_file) ? pdoc.additional_file : [])
        .map((file) => `${file?.name || file?._id || ''}:${file?.size || ''}:${file?.lastModified || file?.mtime || ''}`)
        .join('|');
    return crypto.createHash('md5')
        .update(`${STATEMENT_RENDER_VERSION}/${pdoc?.domainId || ''}/${pdoc?.docId || ''}/${files}/${content}`)
        .digest('hex');
}

function statementImagePath(domainId, pdoc, content, ext = 'png') {
    const hash = statementHash(pdoc, content);
    const format = ext === 'svg' ? 'svg' : 'png';
    return {
        filename: `lecture-p${pdoc.docId}-${hash}.${format}`,
        target: `${STORAGE_PREFIX}/${domainId}/${pdoc.docId}/${hash}.${format}`,
        type: format === 'svg' ? 'image/svg+xml' : 'image/png',
    };
}

function loadRendererDeps() {
    const chromeFinderModule = requireDependency('chrome-finder');
    const puppeteerModule = requireDependency('puppeteer-extra');
    return {
        chromeFinder: chromeFinderModule.default || chromeFinderModule,
        puppeteer: puppeteerModule.default || puppeteerModule,
    };
}

async function getBrowser() {
    if (!browserPromise) {
        browserPromise = (async () => {
            const { chromeFinder, puppeteer } = loadRendererDeps();
            const executablePath = chromeFinder();
            logger.info('Launching chrome for lecture render: %s', executablePath);
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
    if (activeContexts >= 2) await new Promise((resolve) => waiters.push(resolve));
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
                logger.warn('Failed to close render context: %o', error);
            }
        }
        activeContexts -= 1;
        if (waiters.length) waiters.shift()();
    }
}

async function inlineCss(file) {
    const base = path.dirname(file);
    const css = await fs.readFile(file, 'utf8');
    const imported = await Promise.all(css.split('\n').map(async (line) => {
        const matched = line.match(/^\s*@import\s+["']([^"']+)["'];?/);
        if (!matched) return line;
        const importPath = resolveDependency(matched[1], [base]);
        return await inlineCss(importPath);
    }));
    const inlined = await Promise.all(imported.join('\n').split('\n').map(async (line) => {
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
    }));
    return inlined.join('\n');
}

function wrapStatementHtml(markdownHtml, pdoc, baseUrl = '') {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
${baseUrl ? `<base href="${escapeHtml(baseUrl.replace(/\/?$/, '/'))}">` : ''}
<style>
:root {
  --sol-body-font: "${DEFAULT_FONT_FAMILY}", "Noto Sans SC Variable", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
  --sol-code-font: "${DEFAULT_CODE_FONT_FAMILY}", "JetBrains Mono", "Source Code Pro", "Consolas", monospace;
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

function renderStatementThemeCss() {
    return `
.markdown-body { color: #1f2937; }
.markdown-body h1, .markdown-body h2, .markdown-body h3 {
  color: #24344d;
  font-weight: 750;
}
.markdown-body a { color: #2563eb; }
.markdown-body blockquote {
  color: #475569;
  border-left: 4px solid #93c5fd;
  background: #f8fafc;
  padding: 0.75em 1em;
  border-radius: 0 6px 6px 0;
}
.markdown-body code, .markdown-body tt {
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
.markdown-body pre:not([data-language])::before { content: "\\4ee3\\7801"; }
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
.token.comment, .token.prolog, .token.doctype, .token.cdata { color: #73829a; font-style: italic; }
.token.punctuation, .token.operator { color: #334155; }
.token.namespace { opacity: 0.8; }
.token.property, .token.tag, .token.constant, .token.symbol, .token.deleted, .token.macro, .token.directive, .token.directive-hash { color: #be123c; }
.token.boolean, .token.number { color: #c55a11; }
.token.selector, .token.attr-name, .token.string, .token.char, .token.builtin, .token.inserted { color: #07845f; }
.token.keyword { color: #7c3aed; font-weight: 750; }
.token.function { color: #0b6fae; }
.token.class-name, .token.variable { color: #0f766e; }
.token.regex, .token.important { color: #db2777; }
`;
}

async function renderStatementToPng(pdoc, content, handler) {
    const baseUrl = requestOrigin(handler);
    const fileUrls = await signedProblemFileUrls(pdoc);
    const renderContent = rewriteProblemFileReferences(content, fileUrls);
    const markdownHtml = pdoc?.html
        ? String(renderContent || '')
        : (
            typeof renderMarkdown === 'function'
                ? await renderMarkdown(renderContent)
                : `<pre>${escapeHtml(renderContent)}</pre>`
        );
    const bodyHtml = wrapStatementHtml(markdownHtml, pdoc, baseUrl);
    const bodyFontCss = await inlineCss(resolveDependency('@fontsource-variable/noto-sans-sc/index.css'));
    const jetbrainsCss = await inlineCss(resolveDependency('@fontsource/jetbrains-mono/index.css'));
    const sourceCodeCss = await inlineCss(resolveDependency('@fontsource/source-code-pro/index.css'));
    const githubCss = await inlineCss(resolveDependency('github-markdown-css/github-markdown.css'));
    const katexCss = await inlineCss(resolveDependency('katex/dist/katex.min.css'));
    const prismCss = await fs.readFile(resolveDependency('prismjs/themes/prism.css'), 'utf8');
    const katexJs = await fs.readFile(resolveDependency('katex/dist/katex.min.js'), 'utf8');
    const katexAutoRenderJs = await fs.readFile(resolveDependency('katex/dist/contrib/auto-render.min.js'), 'utf8');
    const prismCoreJs = await fs.readFile(resolveDependency('prismjs/components/prism-core.min.js'), 'utf8');
    const prismClikeJs = await fs.readFile(resolveDependency('prismjs/components/prism-clike.min.js'), 'utf8');
    const prismCJs = await fs.readFile(resolveDependency('prismjs/components/prism-c.min.js'), 'utf8');
    const prismCppJs = await fs.readFile(resolveDependency('prismjs/components/prism-cpp.min.js'), 'utf8');
    const katexMhchemJs = await fs.readFile(resolveDependency('katex/dist/contrib/mhchem.min.js'), 'utf8');
    return await withRenderPage(async (page) => {
        await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 2 });
        await page.setContent(bodyHtml, { waitUntil: 'domcontentloaded' });
        await page.addStyleTag({ content: `${bodyFontCss}\n${jetbrainsCss}\n${sourceCodeCss}\n${githubCss}\n${katexCss}\n${prismCss}\n${renderStatementThemeCss()}` });
        await page.evaluate(({ fileUrls: signedFiles, origin }) => {
            const decode = (value) => {
                try {
                    return decodeURIComponent(value);
                } catch {
                    return value;
                }
            };
            const filenameOf = (value) => {
                let raw = String(value || '').trim().replace(/&amp;/g, '&');
                if (!raw || /^(?:data:|blob:)/i.test(raw)) return '';
                if (/^file:\/\//i.test(raw)) {
                    raw = raw.replace(/^file:\/\//i, '');
                    return decode(raw.split(/[?#]/)[0].replace(/^\/+/, ''));
                }
                const matched = raw.match(/(?:^|\/|\.\/)(?:p\/[^/]+\/)?file\/([^?#]+)/i);
                if (!matched) return '';
                return decode(matched[1].split(/[?#]/)[0].replace(/^\/+/, ''));
            };
            const absolutize = (value) => {
                if (!origin || !value || /^(?:data:|blob:|https?:|file:)/i.test(value)) return value;
                try {
                    return new URL(value, `${origin}/`).toString();
                } catch {
                    return value;
                }
            };
            document.querySelectorAll('img[src], source[src], video[src], audio[src]').forEach((node) => {
                const raw = node.getAttribute('src') || '';
                const filename = filenameOf(raw);
                const signed = signedFiles[filename] || signedFiles[filename.split('/').pop()];
                node.setAttribute('src', signed || absolutize(raw));
            });
            document.querySelectorAll('img[srcset], source[srcset]').forEach((node) => {
                const entries = String(node.getAttribute('srcset') || '').split(',').map((entry) => {
                    const [raw, ...rest] = entry.trim().split(/\s+/);
                    const filename = filenameOf(raw);
                    const signed = signedFiles[filename] || signedFiles[filename.split('/').pop()];
                    return [signed || absolutize(raw), ...rest].filter(Boolean).join(' ');
                });
                node.setAttribute('srcset', entries.join(', '));
            });
        }, { fileUrls, origin: baseUrl });
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
                pre?.setAttribute('data-language', label || '\u4ee3\u7801');
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
        await page.evaluate(async () => {
            const images = Array.from(document.images || []);
            await Promise.all(images.map((img) => {
                if (img.complete && img.naturalWidth > 0) return Promise.resolve();
                return new Promise((resolve) => {
                    const done = () => resolve();
                    img.addEventListener('load', done, { once: true });
                    img.addEventListener('error', done, { once: true });
                    setTimeout(done, 8000);
                });
            }));
        });
        return await page.screenshot({ type: 'png', fullPage: true });
    });
}

function stripMarkdownInline(value) {
    return String(value || '')
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/[*_~]/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function visualWidth(text) {
    let width = 0;
    for (const ch of String(text || '')) width += ch.charCodeAt(0) > 255 ? 1 : 0.56;
    return width;
}

function wrapText(text, maxWidth) {
    const source = String(text || '');
    const lines = [];
    let current = '';
    let width = 0;
    for (const ch of source) {
        const weight = ch.charCodeAt(0) > 255 ? 1 : 0.56;
        if (width + weight > maxWidth && current) {
            lines.push(current);
            current = ch;
            width = weight;
        } else {
            current += ch;
            width += weight;
        }
    }
    if (current) lines.push(current);
    return lines.length ? lines : [''];
}

function svgLine(text, x, y, options = {}) {
    const size = options.size || 20;
    const weight = options.weight || 400;
    const fill = options.fill || '#1f2937';
    const family = options.mono
        ? '"Consolas", "Source Code Pro", monospace'
        : '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", Arial, sans-serif';
    return `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="${weight}" font-family="${escapeHtml(family)}">${escapeHtml(text)}</text>`;
}

function parseStatementBlocks(content) {
    const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
    const blocks = [];
    let paragraph = [];
    let code = null;
    const flushParagraph = () => {
        if (!paragraph.length) return;
        blocks.push({ type: 'p', text: stripMarkdownInline(paragraph.join(' ')) });
        paragraph = [];
    };
    const flushCode = () => {
        if (!code) return;
        blocks.push({ type: 'code', lang: code.lang || 'C++', lines: code.lines });
        code = null;
    };
    for (const rawLine of lines) {
        const line = rawLine.replace(/\t/g, '    ');
        const fence = line.match(/^\s*```(\S*)\s*$/);
        if (fence) {
            if (code) flushCode();
            else {
                flushParagraph();
                code = { lang: fence[1] || 'C++', lines: [] };
            }
            continue;
        }
        if (code) {
            code.lines.push(line);
            continue;
        }
        if (!line.trim()) {
            flushParagraph();
            continue;
        }
        const heading = line.match(/^(#{1,6})\s+(.+)$/);
        if (heading) {
            flushParagraph();
            blocks.push({ type: 'h', level: heading[1].length, text: stripMarkdownInline(heading[2]) });
            continue;
        }
        const quote = line.match(/^\s*>\s*(.+)$/);
        if (quote) {
            flushParagraph();
            blocks.push({ type: 'quote', text: stripMarkdownInline(quote[1]) });
            continue;
        }
        const list = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/);
        if (list) {
            flushParagraph();
            blocks.push({ type: 'li', text: stripMarkdownInline(list[1]) });
            continue;
        }
        paragraph.push(line.trim());
    }
    flushParagraph();
    flushCode();
    return blocks;
}

function renderStatementToSvg(pdoc, content) {
    const blocks = parseStatementBlocks(content);
    const elements = [];
    let y = 58;
    const pageX = 42;
    const bodyX = 54;
    const title = pdoc.title || '';
    elements.push(svgLine(title, pageX, y, { size: 34, weight: 700, fill: '#10233f' }));
    y += 28;
    elements.push(`<line x1="${pageX}" y1="${y}" x2="${SVG_WIDTH - pageX}" y2="${y}" stroke="#e5edf6" stroke-width="1"/>`);
    y += 42;

    for (const block of blocks) {
        if (y > SVG_MAX_HEIGHT - 160) {
            elements.push(svgLine('内容较长，后续部分已省略。', bodyX, y + 24, { size: 19, fill: '#64748b' }));
            y += 60;
            break;
        }
        if (block.type === 'h') {
            const size = block.level <= 2 ? 27 : 23;
            y += 14;
            for (const line of wrapText(block.text, 52)) {
                elements.push(svgLine(line, pageX, y, { size, weight: 700, fill: '#24344d' }));
                y += size + 13;
            }
            elements.push(`<line x1="${pageX}" y1="${y - 6}" x2="${SVG_WIDTH - pageX}" y2="${y - 6}" stroke="#edf2f7" stroke-width="1"/>`);
            y += 10;
        } else if (block.type === 'code') {
            const codeLines = block.lines.length ? block.lines : [''];
            const wrapped = [];
            for (const line of codeLines) wrapped.push(...wrapText(line, 86));
            const boxHeight = Math.max(72, 46 + wrapped.length * 24);
            elements.push(`<rect x="${pageX}" y="${y - 20}" width="${SVG_WIDTH - pageX * 2}" height="${boxHeight}" rx="8" fill="#f8fafc" stroke="#dbe4f0"/>`);
            elements.push(`<rect x="${pageX}" y="${y - 20}" width="${SVG_WIDTH - pageX * 2}" height="32" rx="8" fill="#eef4fb"/>`);
            elements.push(svgLine(block.lang || 'Code', pageX + 16, y + 3, { size: 15, weight: 700, fill: '#334155' }));
            let codeY = y + 42;
            for (const line of wrapped) {
                elements.push(svgLine(line, pageX + 18, codeY, { size: 17, fill: '#1f3b57', mono: true }));
                codeY += 24;
            }
            y += boxHeight + 24;
        } else if (block.type === 'quote') {
            const lines = wrapText(block.text, 56);
            const boxHeight = 20 + lines.length * 29;
            elements.push(`<rect x="${pageX}" y="${y - 22}" width="${SVG_WIDTH - pageX * 2}" height="${boxHeight}" rx="6" fill="#f8fafc"/>`);
            elements.push(`<rect x="${pageX}" y="${y - 22}" width="4" height="${boxHeight}" fill="#93c5fd"/>`);
            for (const line of lines) {
                elements.push(svgLine(line, bodyX, y, { size: 19, fill: '#475569' }));
                y += 29;
            }
            y += 18;
        } else if (block.type === 'li') {
            const lines = wrapText(block.text, 54);
            elements.push(svgLine('•', bodyX, y, { size: 20, weight: 700, fill: '#2563eb' }));
            let first = true;
            for (const line of lines) {
                elements.push(svgLine(line, bodyX + 24, y, { size: 20 }));
                y += first ? 31 : 28;
                first = false;
            }
            y += 4;
        } else {
            if (!block.text) continue;
            for (const line of wrapText(block.text, 56)) {
                elements.push(svgLine(line, bodyX, y, { size: 20 }));
                y += 32;
            }
            y += 12;
        }
    }

    const height = Math.max(360, Math.min(SVG_MAX_HEIGHT, y + 42));
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${height}" viewBox="0 0 ${SVG_WIDTH} ${height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  ${elements.join('\n  ')}
</svg>`;
}

function renderStatementToSvgSafe(pdoc, content) {
    const blocks = parseStatementBlocks(content);
    const elements = [];
    let y = 58;
    const pageX = 42;
    const bodyX = 54;
    const title = pdoc.title || '';
    elements.push(svgLine(title, pageX, y, { size: 34, weight: 700, fill: '#10233f' }));
    y += 28;
    elements.push(`<line x1="${pageX}" y1="${y}" x2="${SVG_WIDTH - pageX}" y2="${y}" stroke="#e5edf6" stroke-width="1"/>`);
    y += 42;

    for (const block of blocks) {
        if (y > SVG_MAX_HEIGHT - 160) {
            elements.push(svgLine('\u5185\u5bb9\u8f83\u957f\uff0c\u540e\u7eed\u90e8\u5206\u5df2\u7701\u7565\u3002', bodyX, y + 24, { size: 19, fill: '#64748b' }));
            y += 60;
            break;
        }
        if (block.type === 'h') {
            const size = block.level <= 2 ? 27 : 23;
            y += 14;
            for (const line of wrapText(block.text, 52)) {
                elements.push(svgLine(line, pageX, y, { size, weight: 700, fill: '#24344d' }));
                y += size + 13;
            }
            elements.push(`<line x1="${pageX}" y1="${y - 6}" x2="${SVG_WIDTH - pageX}" y2="${y - 6}" stroke="#edf2f7" stroke-width="1"/>`);
            y += 10;
        } else if (block.type === 'code') {
            const codeLines = block.lines.length ? block.lines : [''];
            const wrapped = [];
            for (const line of codeLines) wrapped.push(...wrapText(line, 86));
            const boxHeight = Math.max(72, 46 + wrapped.length * 24);
            elements.push(`<rect x="${pageX}" y="${y - 20}" width="${SVG_WIDTH - pageX * 2}" height="${boxHeight}" rx="8" fill="#f8fafc" stroke="#dbe4f0"/>`);
            elements.push(`<rect x="${pageX}" y="${y - 20}" width="${SVG_WIDTH - pageX * 2}" height="32" rx="8" fill="#eef4fb"/>`);
            elements.push(svgLine(block.lang || 'Code', pageX + 16, y + 3, { size: 15, weight: 700, fill: '#334155' }));
            let codeY = y + 42;
            for (const line of wrapped) {
                elements.push(svgLine(line, pageX + 18, codeY, { size: 17, fill: '#1f3b57', mono: true }));
                codeY += 24;
            }
            y += boxHeight + 24;
        } else if (block.type === 'quote') {
            const lines = wrapText(block.text, 56);
            const boxHeight = 20 + lines.length * 29;
            elements.push(`<rect x="${pageX}" y="${y - 22}" width="${SVG_WIDTH - pageX * 2}" height="${boxHeight}" rx="6" fill="#f8fafc"/>`);
            elements.push(`<rect x="${pageX}" y="${y - 22}" width="4" height="${boxHeight}" fill="#93c5fd"/>`);
            for (const line of lines) {
                elements.push(svgLine(line, bodyX, y, { size: 19, fill: '#475569' }));
                y += 29;
            }
            y += 18;
        } else if (block.type === 'li') {
            const lines = wrapText(block.text, 54);
            elements.push(svgLine('\u2022', bodyX, y, { size: 20, weight: 700, fill: '#2563eb' }));
            let first = true;
            for (const line of lines) {
                elements.push(svgLine(line, bodyX + 24, y, { size: 20 }));
                y += first ? 31 : 28;
                first = false;
            }
            y += 4;
        } else {
            if (!block.text) continue;
            for (const line of wrapText(block.text, 56)) {
                elements.push(svgLine(line, bodyX, y, { size: 20 }));
                y += 32;
            }
            y += 12;
        }
    }

    const height = Math.max(360, Math.min(SVG_MAX_HEIGHT, y + 42));
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${height}" viewBox="0 0 ${SVG_WIDTH} ${height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  ${elements.join('\n  ')}
</svg>`;
}

function decodeHtmlEntitiesForMath(value) {
    return String(value || '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (all, code) => String.fromCharCode(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (all, code) => String.fromCharCode(parseInt(code, 16)));
}

function previousBackslashCount(text, index) {
    let count = 0;
    for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) count += 1;
    return count;
}

function isEscapedDelimiter(text, index) {
    return previousBackslashCount(text, index) % 2 === 1;
}

function findUnescaped(text, needle, from) {
    let index = text.indexOf(needle, from);
    while (index >= 0) {
        if (!isEscapedDelimiter(text, index)) return index;
        index = text.indexOf(needle, index + 1);
    }
    return -1;
}

function findInlineDollar(text, from) {
    let index = text.indexOf('$', from);
    while (index >= 0) {
        const prev = text[index - 1] || '';
        const next = text[index + 1] || '';
        if (
            text[index + 1] !== '$'
            && !isEscapedDelimiter(text, index)
            && !/\s/.test(next)
        ) return index;
        index = text.indexOf('$', index + 1);
    }
    return -1;
}

function renderKatexFormula(raw, displayMode) {
    let katex;
    try {
        katex = requireDependency('katex');
    } catch (error) {
        logger.warn('Failed to load katex for lecture fallback render: %o', error);
        return null;
    }
    try {
        return katex.renderToString(decodeHtmlEntitiesForMath(raw), {
            displayMode,
            throwOnError: false,
            trust: true,
            strict: 'ignore',
            output: 'html',
        });
    } catch (error) {
        logger.warn('Failed to render lecture formula: %o', error);
        return null;
    }
}

function renderMathInTextNode(text) {
    const source = String(text || '');
    let output = '';
    let index = 0;
    while (index < source.length) {
        const candidates = [
            { start: findUnescaped(source, '$$', index), open: '$$', close: '$$', display: true },
            { start: findUnescaped(source, '\\[', index), open: '\\[', close: '\\]', display: true },
            { start: findUnescaped(source, '\\(', index), open: '\\(', close: '\\)', display: false },
            { start: findInlineDollar(source, index), open: '$', close: '$', display: false },
        ].filter((item) => item.start >= 0).sort((a, b) => a.start - b.start);
        if (!candidates.length) {
            output += source.slice(index);
            break;
        }
        const current = candidates[0];
        const contentStart = current.start + current.open.length;
        const end = findUnescaped(source, current.close, contentStart);
        if (end < 0) {
            output += source.slice(index, contentStart);
            index = contentStart;
            continue;
        }
        const raw = source.slice(contentStart, end);
        const rendered = raw.trim() ? renderKatexFormula(raw, current.display) : null;
        output += source.slice(index, current.start);
        output += rendered || source.slice(current.start, end + current.close.length);
        index = end + current.close.length;
    }
    return output;
}

function renderMathInHtml(html) {
    const skipTags = new Set(['code', 'pre', 'script', 'style', 'textarea']);
    let skipDepth = 0;
    return String(html || '').split(/(<[^>]+>)/g).map((part) => {
        if (!part) return '';
        if (part.startsWith('<')) {
            const tag = part.match(/^<\s*\/?\s*([a-z0-9-]+)/i)?.[1]?.toLowerCase();
            if (tag && skipTags.has(tag)) {
                const closing = /^<\s*\//.test(part);
                const selfClosing = /\/\s*>$/.test(part);
                if (closing) skipDepth = Math.max(0, skipDepth - 1);
                else if (!selfClosing) skipDepth += 1;
            }
            return part;
        }
        return skipDepth ? part : renderMathInTextNode(part);
    }).join('');
}

function normalizeHtmlForSvgForeignObject(html) {
    const voidTags = 'area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr';
    return String(html || '')
        .replace(new RegExp(`<(${voidTags})(\\s[^<>]*?)?>`, 'gi'), (all, tag, attrs = '') => (
            /\/\s*>$/.test(all) ? all : `<${tag}${attrs} />`
        ))
        .replace(/&nbsp;/g, '&#160;')
        .replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/gi, '&amp;');
}

function estimateFallbackSvgHeight(content, html) {
    const blocks = parseStatementBlocks(content);
    let height = 150;
    for (const block of blocks) {
        if (block.type === 'h') height += 64;
        else if (block.type === 'code') height += 74 + Math.max(1, block.lines.length) * 27;
        else if (block.type === 'quote') height += 50 + wrapText(block.text, 56).length * 30;
        else height += Math.max(1, wrapText(block.text || '', 56).length) * 35 + 12;
    }
    const rendered = String(html || '');
    height += (rendered.match(/katex-display/g) || []).length * 80;
    height += (rendered.match(/<table\b/gi) || []).length * 180;
    height += (rendered.match(/<img\b/gi) || []).length * 260;
    return Math.max(480, Math.min(SVG_MAX_HEIGHT, height + 80));
}

function svgStyleCdata(css) {
    return `<![CDATA[${String(css || '').replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
}

async function renderStatementToHtmlSvg(pdoc, content, handler) {
    const fileUrls = await signedProblemFileUrls(pdoc);
    const renderContent = rewriteProblemFileReferences(content, fileUrls);
    const rawMarkdownHtml = pdoc?.html
        ? String(renderContent || '')
        : (
            typeof renderMarkdown === 'function'
                ? await renderMarkdown(renderContent)
                : `<pre>${escapeHtml(renderContent)}</pre>`
        );
    const markdownHtml = normalizeHtmlForSvgForeignObject(renderMathInHtml(rawMarkdownHtml));
    const katexCss = await inlineCss(resolveDependency('katex/dist/katex.min.css')).catch(() => '');
    const height = estimateFallbackSvgHeight(content, markdownHtml);
    const css = `
html, body { margin: 0; padding: 0; }
.lecture-statement {
  box-sizing: border-box;
  width: ${SVG_WIDTH}px;
  min-height: ${height}px;
  padding: 28px 34px;
  background: #ffffff;
  color: #1f2937;
  font-family: "Noto Sans SC Variable", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
  font-size: 17px;
  line-height: 1.72;
}
.lecture-statement h1, .lecture-statement h2, .lecture-statement h3 {
  color: #24344d;
  font-weight: 750;
}
.lecture-statement a { color: #2563eb; }
.lecture-statement blockquote {
  margin: 1em 0;
  color: #475569;
  border-left: 4px solid #93c5fd;
  background: #f8fafc;
  padding: 0.75em 1em;
  border-radius: 0 6px 6px 0;
}
.lecture-statement code, .lecture-statement tt {
  color: #be123c;
  background: #fff1f2;
  border: 1px solid #ffe4e6;
  border-radius: 4px;
  padding: 0.08em 0.35em;
  font-family: "JetBrains Mono", "Source Code Pro", Consolas, monospace;
  font-size: 0.92em;
}
.lecture-statement pre {
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
.lecture-statement pre::before {
  content: "\\4ee3\\7801";
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
  font-family: "Noto Sans SC Variable", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
  font-size: 0.88em;
  font-weight: 700;
  line-height: 1.2;
}
.lecture-statement pre > code {
  display: block;
  color: inherit;
  background: transparent !important;
  border: 0;
  padding: 0;
  font-family: "JetBrains Mono", "Source Code Pro", Consolas, monospace;
  font-size: 1.02em;
  line-height: 1.72;
  tab-size: 4;
  white-space: pre-wrap;
  word-break: break-word;
  font-variant-ligatures: none;
}
.lecture-statement table {
  border-collapse: collapse;
  width: 100%;
  margin: 1em 0;
}
.lecture-statement th, .lecture-statement td {
  border: 1px solid #dbe4f0;
  padding: 0.45em 0.6em;
}
.lecture-statement th { background: #f1f5f9; }
.lecture-statement .katex-display {
  margin: 1em 0;
  overflow: visible;
}
${katexCss}
`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${height}" viewBox="0 0 ${SVG_WIDTH} ${height}">
  <foreignObject x="0" y="0" width="${SVG_WIDTH}" height="${height}">
    <div xmlns="http://www.w3.org/1999/xhtml">
      <style>${svgStyleCdata(css)}</style>
      <article class="lecture-statement">
        ${markdownHtml}
      </article>
    </div>
  </foreignObject>
</svg>`;
}

async function ensureStatementImage(domainId, pdoc, handler) {
    const content = statementMarkdown(pdoc, handler);
    if (!content) return null;
    const png = statementImagePath(domainId, pdoc, content, 'png');
    const svg = statementImagePath(domainId, pdoc, content, 'svg');
    const exists = async (target) => (typeof StorageModel.exists === 'function'
        ? await StorageModel.exists(target).catch(async () => !!(await StorageModel.getMeta(target).catch(() => null)))
        : !!(await StorageModel.getMeta(target).catch(() => null)));
    if (await exists(png.target)) return png;
    if (await exists(svg.target)) return svg;

    try {
        const image = await renderStatementToPng(pdoc, content, handler);
        await StorageModel.put(png.target, image);
        return png;
    } catch (error) {
        logger.warn('Failed to render lecture problem %s with chrome, using SVG fallback: %o', pdoc.docId, error);
        await StorageModel.put(svg.target, Buffer.from(await renderStatementToHtmlSvg(pdoc, content, handler), 'utf8'));
        return svg;
    }
}

async function getStatementImageUrl(domainId, pdoc, handler) {
    const image = await ensureStatementImage(domainId, pdoc, handler);
    if (!image) return '';
    const { target, filename } = image;
    return await StorageModel.signDownloadLink(target, filename, false, 'user');
}

function cleanSubsectionDoc(doc) {
    if (!doc) return [];
    const lecturePids = lecturePidsFromDoc(doc);
    doc.content = stripMarker(doc.content);
    if (lecturePids.length) doc.pids = pidsWithoutLectures(doc.pids, lecturePids);
    return lecturePids;
}

function cleanCoursePackageLesson(lesson) {
    if (!lesson) return [];
    const lecturePids = lecturePidsFromDoc(lesson);
    lesson.lecturePids = lecturePids;
    lesson.lecturePid = lecturePids[0] || null;
    lesson.content = stripMarker(lesson.content);
    if (lecturePids.length) lesson.pids = pidsWithoutLectures(lesson.pids, lecturePids);
    return lecturePids;
}

async function findMappedLecturePid(domainId, sourcePid, pids) {
    if (!sourcePid || !pids?.length) return 0;
    for (const pid of pids) {
        const pdoc = await ProblemModel.get(domainId, pid, ProblemModel.PROJECTION_PUBLIC, true).catch(() => null);
        const refPid = normalizePid(pdoc?.reference?.pid);
        if (refPid === sourcePid) return pid;
    }
    return 0;
}

async function storageLecturePids(domainId, meta, pids) {
    const allPids = parsePids(pids);
    const markerPids = markerLecturePids(meta, allPids);
    const resolved = [];
    for (const sourcePid of markerPids) {
        let pid = sourcePid;
        if (sourcePid && !allPids.includes(sourcePid)) {
            pid = await findMappedLecturePid(domainId, sourcePid, allPids) || sourcePid;
        }
        if (pid && !resolved.includes(pid)) resolved.push(pid);
    }
    return resolved;
}

function cleanCoursePackageChapters(chapters) {
    for (const chapter of chapters || []) {
        for (const lesson of chapter.lessons || []) cleanCoursePackageLesson(lesson);
    }
}

function summarizeChapters(chapters) {
    const pids = new Set();
    let lessonCount = 0;
    for (const chapter of chapters || []) {
        lessonCount += (chapter.lessons || []).length;
        for (const lesson of chapter.lessons || []) {
            for (const pid of parsePids(lesson.pids)) pids.add(pid);
        }
    }
    return {
        chapterCount: (chapters || []).length,
        lessonCount,
        problemCount: pids.size,
    };
}

function patchCourseModelForPackageCopy() {
    if (courseModelPatched) return;
    const course = getCourseModel();
    if (!course?.addSubSection) return;
    courseModelPatched = true;

    const originalAddSubSection = course.addSubSection;
    course.addSubSection = async function patchedAddSubSection(domainId, sectionId, owner, title, content, pids, pin, ...rest) {
        const meta = readMarker(content);
        const allPids = parsePids(pids);
        const lecturePids = await storageLecturePids(domainId, meta, allPids);
        if (!lecturePids.length) {
            return await originalAddSubSection.call(this, domainId, sectionId, owner, title, stripMarker(content), allPids, pin, ...rest);
        }
        const lectureSet = new Set(lecturePids);
        const scoredPids = allPids.filter((pid) => !lectureSet.has(pid));
        const storedContent = withMarker(content, lecturePids);
        return await originalAddSubSection.call(this, domainId, sectionId, owner, title, storedContent, scoredPids, pin, ...rest);
    };

    if (course.editSubSection) {
        const originalEditSubSection = course.editSubSection;
        course.editSubSection = async function patchedEditSubSection(domainId, sectionId, subSectionId, payload, ...rest) {
            if (!payload || typeof payload !== 'object' || typeof payload.content !== 'string') {
                return await originalEditSubSection.call(this, domainId, sectionId, subSectionId, payload, ...rest);
            }
            const meta = readMarker(payload.content);
            const allPids = Object.prototype.hasOwnProperty.call(payload, 'pids') ? parsePids(payload.pids) : [];
            const lecturePids = await storageLecturePids(domainId, meta, allPids);
            if (!lecturePids.length) {
                return await originalEditSubSection.call(this, domainId, sectionId, subSectionId, {
                    ...payload,
                    content: stripMarker(payload.content),
                    ...(Object.prototype.hasOwnProperty.call(payload, 'pids') ? { pids: allPids } : {}),
                }, ...rest);
            }
            const lectureSet = new Set(lecturePids);
            return await originalEditSubSection.call(this, domainId, sectionId, subSectionId, {
                ...payload,
                content: withMarker(payload.content, lecturePids),
                ...(Object.prototype.hasOwnProperty.call(payload, 'pids') ? { pids: allPids.filter((pid) => !lectureSet.has(pid)) } : {}),
            }, ...rest);
        };
    }
}

async function exposeUi(handler) {
    patchCourseModelForPackageCopy();
    const body = handler.response?.body;
    if (!body) return;

    if (body.page_name === 'course_subsec_edit' || body.page_name === 'course_subsec_create') {
        const lecturePids = cleanSubsectionDoc(body.ssdoc);
        handler.UiContext ||= {};
        handler.UiContext.courseLectureProblem = {
            page: body.page_name,
            lecturePids,
            lecturePid: lecturePids[0] || 0,
            markerName: 'hydro-course-lecture-problem',
            keepLectureInPids: true,
        };
        return;
    }

    if (body.page_name === 'course_package_lesson_edit' || body.page_name === 'course_package_lesson_create') {
        const lecturePids = cleanCoursePackageLesson(body.lesson);
        handler.UiContext ||= {};
        handler.UiContext.courseLectureProblem = {
            page: body.page_name,
            lecturePids,
            lecturePid: lecturePids[0] || 0,
            markerName: 'hydro-course-lecture-problem',
            keepLectureInPids: true,
        };
        return;
    }

    if (body.page_name === 'course_package_version_detail') {
        if (body.vpdoc?.chapters) cleanCoursePackageChapters(body.vpdoc.chapters);
        if (body.chapters) cleanCoursePackageChapters(body.chapters);
        if (body.chapters) body.summary = summarizeChapters(body.chapters);
        else if (body.vpdoc?.chapters) body.summary = summarizeChapters(body.vpdoc.chapters);
        return;
    }

    const isProblemDetail = body.page_name === 'problem_detail' || handler.response?.template === 'problem_detail.html';
    if (isProblemDetail && body.pdoc) {
        const lectureContext = parseLectureContextToken(routeValue(handler, 'courseLecture'));
        if (!lectureContext) return;
        let context;
        try {
            context = await loadLectureContextByIds(handler, lectureContext.cid, lectureContext.csid, lectureContext.ssid);
        } catch (error) {
            logger.warn('Failed to load lecture context for problem page: %o', error);
            return;
        }
        const requestedPid = normalizePid(body.pdoc.docId || body.pdoc.pid);
        if (!context.lecturePids.includes(requestedPid)) return;
        const cid = textId(context.cdoc.docId || context.cdoc._id);
        const csid = textId(context.csdoc.docId || context.csdoc._id);
        const ssid = textId(context.ssdoc._id || context.ssdoc.docId);
        handler.response.redirect = handler.url('course_lecture_problem_view', { cid, csid, ssid, pid: requestedPid });
        return;
    }

    if (body.cdoc && body.csdoc && body.ssdoc) {
        const lecturePids = cleanSubsectionDoc(body.ssdoc);
        if (!lecturePids.length) return;
        body.pids = pidsWithoutLectures(body.pids || body.ssdoc.pids, lecturePids);

        const domainId = domainIdOf(handler);
        const cid = textId(body.cdoc.docId || body.cdoc._id);
        const csid = textId(body.csdoc.docId || body.csdoc._id);
        const ssid = textId(body.ssdoc._id || body.ssdoc.docId);
        const context = {
            domainId,
            cdoc: body.cdoc,
            csdoc: body.csdoc,
            ssdoc: body.ssdoc,
            lecturePids,
        };
        const lectureItems = await buildLectureItems(handler, context);
        if (!lectureItems.length) return;
        handler.UiContext ||= {};
        handler.UiContext.courseLectureProblem = {
            page: 'course_subsec_detail',
            lecturePids,
            lecturePid: lecturePids[0] || 0,
            lectureItems,
            courseLectureToken: lectureContextToken(cid, csid, ssid),
        };
    }
}

async function loadLectureContextByIds(handler, cidValue, csidValue, ssidValue) {
    const domainId = domainIdOf(handler);
    const cid = objectId(cidValue, 'cid');
    const csid = objectId(csidValue, 'csid');
    const ssid = objectId(ssidValue, 'ssid');
    const course = getCourseModel();
    if (!course?.get || !course?.getSubSection || !course?.getStatus) throw new NotFoundError('course model');

    const [cdoc, sectionAndSubsection, cstdoc] = await Promise.all([
        course.get(domainId, cid),
        course.getSubSection(domainId, csid, ssid),
        handler.user?.hasPriv?.(PRIV.PRIV_USER_PROFILE)
            ? course.getStatus(domainId, cid, handler.user._id).catch(() => null)
            : Promise.resolve(null),
    ]);
    const [csdoc, ssdoc] = sectionAndSubsection || [];
    if (!cdoc || !csdoc || !ssdoc || textId(csdoc.parentId) !== textId(cid)) throw new NotFoundError('lecture');
    if (!cstdoc?.enroll && !canManageCourse(handler.user)) throw new ForbiddenError('You have not yet joined this course.');

    const lecturePids = lecturePidsFromDoc(ssdoc);
    if (!lecturePids.length) throw new NotFoundError('lecture');
    return {
        domainId,
        cid,
        csid,
        ssid,
        cdoc,
        csdoc,
        ssdoc,
        lecturePids,
    };
}

async function loadLectureContext(handler) {
    return await loadLectureContextByIds(
        handler,
        routeValue(handler, 'cid'),
        routeValue(handler, 'csid'),
        routeValue(handler, 'ssid'),
    );
}

async function loadLectureProblemContext(handler, pidValue = null) {
    const context = await loadLectureContext(handler);
    const requestedPid = normalizePid(pidValue ?? routeValue(handler, 'pid')) || context.lecturePids[0];
    if (!context.lecturePids.includes(requestedPid)) throw new NotFoundError('lecture');
    const pdoc = await ensureProblemReadable(context.domainId, requestedPid, handler);
    return {
        ...context,
        lecturePid: requestedPid,
        lectureIndex: context.lecturePids.indexOf(requestedPid),
        pdoc,
    };
}

async function buildLectureItems(handler, context) {
    const cid = textId(context.cdoc.docId || context.cdoc._id);
    const csid = textId(context.csdoc.docId || context.csdoc._id);
    const ssid = textId(context.ssdoc._id || context.ssdoc.docId);
    const items = [];
    for (const pid of context.lecturePids) {
        const pdoc = await ensureProblemReadable(context.domainId, pid, handler).catch(() => null);
        if (!pdoc) continue;
        items.push({
            lecturePid: pid,
            problemPid: lectureProblemPid(pdoc, pid),
            problemTitle: pdoc.title || '',
            nSubmit: pdoc.nSubmit || 0,
            nAccept: pdoc.nAccept || 0,
            difficulty: lectureProblemDifficulty(pdoc),
            lectureUrl: handler.url('course_lecture_problem_view', { cid, csid, ssid, pid }),
            imageUrl: handler.url('course_lecture_problem_image', { cid, csid, ssid, pid }),
        });
    }
    return items;
}

class CourseLectureProblemImageHandler extends Handler {
    async get() {
        const { domainId, pdoc } = await loadLectureProblemContext(this);
        const statementPdoc = await resolveStatementProblem(pdoc, domainId);
        const image = await ensureStatementImage(domainId, statementPdoc, this);
        if (!image) throw new NotFoundError('lecture image');
        const meta = await StorageModel.getMeta(image.target).catch(() => null);
        this.response.type = image.type || meta?.['Content-Type'] || 'application/octet-stream';
        this.response.addHeader('Cache-Control', 'private, no-store');
        this.response.addHeader('X-Content-Type-Options', 'nosniff');
        if (meta?.size) this.response.addHeader('Content-Length', String(meta.size));
        this.response.body = await StorageModel.get(image.target);
    }
}

class CourseLectureProblemViewHandler extends Handler {
    async get() {
        const context = await loadLectureProblemContext(this);
        const lectureItems = await buildLectureItems(this, context);
        const activeItem = lectureItems.find((item) => item.lecturePid === context.lecturePid);
        if (!activeItem) throw new NotFoundError('lecture');
        const statementPdoc = await resolveStatementProblem(context.pdoc, context.domainId);
        this.response.template = 'course_lecture_problem_view.html';
        this.response.body = {
            page_name: 'course_lecture_problem_view',
            cdoc: context.cdoc,
            csdoc: context.csdoc,
            ssdoc: context.ssdoc,
            pdoc: context.pdoc,
            statementPdoc,
            lecturePid: context.lecturePid,
            lectureItems: lectureItems.map((item) => ({
                ...item,
                active: item.lecturePid === context.lecturePid,
            })),
            activeItem,
            imageUrl: activeItem.imageUrl,
            canManageCourse: canManageCourse(this.user),
        };
    }
}

async function apply(ctx) {
    patchCourseModelForPackageCopy();
    setImmediate(patchCourseModelForPackageCopy);

    ctx.Route('course_lecture_problem_view', '/course/:cid/s/:csid/:ssid/lecture/:pid', CourseLectureProblemViewHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('course_lecture_problem_image', '/course/:cid/s/:csid/:ssid/lecture/:pid/image', CourseLectureProblemImageHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('course_lecture_problem_first', '/course/:cid/s/:csid/:ssid/lecture', CourseLectureProblemViewHandler, PRIV.PRIV_USER_PROFILE);

    ctx.on('handler/after', async (handler) => {
        await exposeUi(handler);
    });
}

module.exports = { apply };
