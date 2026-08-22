import {
    Context, ContestModel, DomainModel, PERM, ProblemConfigError, ProblemModel,
    RecordModel, ValidationError, db,
} from 'hydrooj';
import { ProblemDetailHandler } from 'hydrooj/src/handler/problem';

type IntroBlankMode = 'code';

interface IntroBlankDoc {
    _id: string;
    domainId: string;
    pid: number;
    enabled: boolean;
    mode: IntroBlankMode;
    title: string;
    description: string;
    template: string;
    lang: string;
    caseSensitive: boolean;
    trimSpaces: boolean;
    createdAt?: Date;
    updatedAt: Date;
    updatedBy: number;
}

interface BlankSpec {
    index: number;
    label: string;
    raw: string;
    answers: string[];
}

interface BlankPart {
    kind: 'text' | 'blank';
    text?: string;
    index?: number;
    label?: string;
}

interface CodeRenderPart {
    kind: 'html' | 'blank';
    html?: string;
    index?: number;
    label?: string;
}

interface StatementPart {
    kind: 'markdown' | 'code';
    info?: string;
    tokens: BlankPart[];
}

interface CodeTemplate {
    info: string;
    code: string;
}

interface EditForm extends IntroBlankDoc {
    code: string;
}

const PLUGIN_ID = 'intro-blank-kit';
const coll = db.collection('problem.introBlank' as any);
const BLANK_PATTERN = /\[\[([\s\S]*?)\]\]/g;
const FENCE_PATTERN = /(```|~~~)([^\r\n]*)\r?\n([\s\S]*?)\r?\n\1/g;
const CODE_TOKEN_PATTERN = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|^\s*#[^\n]*|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[uUlLfF]*\b|\b[_A-Za-z]\w*\b|[{}()[\];,.<>+\-*\/%=!&|^~?:]+)/gm;
const CPP_KEYWORDS = new Set([
    'alignas', 'alignof', 'and', 'and_eq', 'asm', 'auto', 'bitand', 'bitor', 'bool', 'break',
    'case', 'catch', 'char', 'char16_t', 'char32_t', 'class', 'compl', 'concept', 'const',
    'constexpr', 'const_cast', 'continue', 'decltype', 'default', 'delete', 'do', 'double',
    'dynamic_cast', 'else', 'enum', 'explicit', 'export', 'extern', 'false', 'float', 'for',
    'friend', 'goto', 'if', 'inline', 'int', 'long', 'mutable', 'namespace', 'new', 'noexcept',
    'not', 'not_eq', 'nullptr', 'operator', 'or', 'or_eq', 'private', 'protected', 'public',
    'register', 'reinterpret_cast', 'requires', 'return', 'short', 'signed', 'sizeof', 'static',
    'static_assert', 'static_cast', 'struct', 'switch', 'template', 'this', 'thread_local',
    'throw', 'true', 'try', 'typedef', 'typeid', 'typename', 'union', 'unsigned', 'using',
    'virtual', 'void', 'volatile', 'while', 'xor', 'xor_eq',
]);
const CPP_BUILTINS = new Set([
    'cin', 'cout', 'cerr', 'clog', 'endl', 'string', 'vector', 'array', 'queue', 'stack',
    'deque', 'set', 'map', 'unordered_map', 'unordered_set', 'pair', 'tuple', 'priority_queue',
    'sort', 'lower_bound', 'upper_bound', 'min', 'max', 'abs', 'swap', 'begin', 'end',
    'push_back', 'pop_back', 'size', 'length', 'main', 'std',
]);

function scopedId(domainId: string, pid: number) {
    return `${domainId}:${pid}`;
}

function runtimeEnabled() {
    const pluginSwitch = (globalThis as any).Hydro?.model?.pluginSwitch;
    return pluginSwitch?.isEnabledSync?.(PLUGIN_ID) !== false;
}

function text(value: any) {
    return typeof value === 'string' ? value : '';
}

function escapeHtml(value: string) {
    return text(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function canEditProblem(handler: any) {
    return handler.user?.own?.(handler.pdoc, PERM.PERM_EDIT_PROBLEM_SELF)
        || handler.user?.hasPerm?.(PERM.PERM_EDIT_PROBLEM);
}

function ensureCanEditProblem(handler: any) {
    if (!handler.user?.own?.(handler.pdoc, PERM.PERM_EDIT_PROBLEM_SELF)) {
        handler.checkPerm(PERM.PERM_EDIT_PROBLEM);
    }
}

function parseTemplate(template: string) {
    const parts: BlankPart[] = [];
    const blanks: BlankSpec[] = [];
    let last = 0;
    let match: RegExpExecArray | null;
    BLANK_PATTERN.lastIndex = 0;

    while ((match = BLANK_PATTERN.exec(template || ''))) {
        if (match.index > last) parts.push({ kind: 'text', text: template.slice(last, match.index) });
        const index = blanks.length;
        const raw = match[1] || '';
        const spec = { index, label: raw.trim() || `填空 ${index + 1}`, raw, answers: [] };
        blanks.push(spec);
        parts.push({ kind: 'blank', index, label: spec.label });
        last = match.index + match[0].length;
    }
    if (last < (template || '').length) parts.push({ kind: 'text', text: template.slice(last) });

    return { parts, blanks };
}

function submittedBlankValues(body: any, count: number) {
    const values: string[] = [];
    for (let i = 0; i < count; i++) values.push(text(body?.[`blank_${i}`]));
    return values;
}

function stripFenceMarkerLines(source: string) {
    return text(source)
        .replace(/\r\n/g, '\n')
        .split('\n')
        .filter((line) => !/^\s*(```|~~~)[A-Za-z0-9_+.#-]*\s*$/.test(line))
        .join('\n')
        .trim();
}

function extractCodeTemplate(template: string, lang: string): CodeTemplate {
    const source = text(template).replace(/\r\n/g, '\n').trim();
    const fences = extractCodeFences(source);
    const target = fences.find((fence) => fence.content.includes('[[')) || fences[0];
    const info = normalizedCodeFenceLang(target?.info, lang);
    const code = stripFenceMarkerLines(target?.content || source);
    return { info, code };
}

function buildCode(template: string, values: string[], lang: string) {
    const codeTemplate = extractCodeTemplate(template, lang);
    let index = 0;
    BLANK_PATTERN.lastIndex = 0;
    return codeTemplate.code.replace(BLANK_PATTERN, () => values[index++] ?? '');
}

function extractCodeFences(markdown: string) {
    const fences: Array<{ info: string; content: string }> = [];
    let match: RegExpExecArray | null;
    FENCE_PATTERN.lastIndex = 0;
    while ((match = FENCE_PATTERN.exec(markdown || ''))) {
        fences.push({
            info: (match[2] || '').trim(),
            content: (match[3] || '').replace(/\r\n/g, '\n'),
        });
    }
    return fences;
}

function splitTemplateForEdit(template: string) {
    return { code: extractCodeTemplate(template, 'cpp').code };
}

function stripOuterFence(code: string) {
    const source = text(code).trim();
    FENCE_PATTERN.lastIndex = 0;
    const match = FENCE_PATTERN.exec(source);
    if (match && match.index === 0 && match[0].length === source.length) {
        return (match[3] || '').replace(/\r\n/g, '\n').trim();
    }
    return text(code).replace(/\r\n/g, '\n').trim();
}

function composeTemplate(code: string, lang: string) {
    const normalizedCode = stripFenceMarkerLines(stripOuterFence(code));
    const langId = text(lang).trim();
    const fenceLang = !langId || langId.startsWith('cc') || langId.toLowerCase().startsWith('c++') ? 'cpp' : langId;
    if (!normalizedCode) return '';
    return `\`\`\`${fenceLang}\n${normalizedCode}\n\`\`\``;
}

function blankTokens(source: string, state: { index: number }) {
    const tokens: BlankPart[] = [];
    let last = 0;
    let match: RegExpExecArray | null;
    BLANK_PATTERN.lastIndex = 0;
    while ((match = BLANK_PATTERN.exec(source || ''))) {
        if (match.index > last) tokens.push({ kind: 'text', text: source.slice(last, match.index) });
        const index = state.index++;
        const label = (match[1] || '').trim() || `填空 ${index + 1}`;
        tokens.push({ kind: 'blank', index, label });
        last = match.index + match[0].length;
    }
    if (last < (source || '').length) tokens.push({ kind: 'text', text: source.slice(last) });
    return tokens;
}

function buildStatementParts(markdown: string) {
    const blocks: StatementPart[] = [];
    const state = { index: 0 };
    let last = 0;
    let match: RegExpExecArray | null;
    FENCE_PATTERN.lastIndex = 0;
    while ((match = FENCE_PATTERN.exec(markdown || ''))) {
        if (match.index > last) {
            blocks.push({ kind: 'markdown', tokens: blankTokens(markdown.slice(last, match.index), state) });
        }
        blocks.push({
            kind: 'code',
            info: (match[2] || '').trim(),
            tokens: blankTokens((match[3] || '').replace(/\r\n/g, '\n'), state),
        });
        last = match.index + match[0].length;
    }
    if (last < (markdown || '').length) {
        blocks.push({ kind: 'markdown', tokens: blankTokens(markdown.slice(last), state) });
    }
    return blocks;
}

function buildCodeBlock(markdown: string, lang: string) {
    const codeTemplate = extractCodeTemplate(markdown, lang);
    return {
        kind: 'code' as const,
        info: codeTemplate.info,
        tokens: blankTokens(codeTemplate.code, { index: 0 }),
    };
}

function codeBlankTokens(tokens: BlankPart[]) {
    return tokens.filter((token) => token.kind === 'blank');
}

function normalizedCodeFenceLang(info: string | undefined, lang: string) {
    const first = text(info).trim().split(/\s+/)[0] || fenceLangFrom(lang);
    return first.replace(/[^A-Za-z0-9_+.#-]/g, '') || 'cpp';
}

function classifyCodeToken(token: string) {
    if (token.startsWith('//') || token.startsWith('/*')) return 'comment';
    if (token.startsWith('"') || token.startsWith("'")) return 'string';
    if (/^\s*#/.test(token)) return 'meta';
    if (/^\d/.test(token)) return 'number';
    if (CPP_KEYWORDS.has(token)) return 'keyword';
    if (CPP_BUILTINS.has(token)) return 'builtin';
    if (/^[{}()[\];,.<>+\-*\/%=!&|^~?:]+$/.test(token)) return 'operator';
    return '';
}

function highlightCodeText(source: string) {
    let html = '';
    let last = 0;
    let match: RegExpExecArray | null;
    CODE_TOKEN_PATTERN.lastIndex = 0;
    while ((match = CODE_TOKEN_PATTERN.exec(source || ''))) {
        if (match.index > last) html += escapeHtml(source.slice(last, match.index));
        const token = match[0];
        const kind = classifyCodeToken(token);
        html += kind
            ? `<span class="ibk-hl-${kind}">${escapeHtml(token)}</span>`
            : escapeHtml(token);
        last = match.index + token.length;
    }
    if (last < (source || '').length) html += escapeHtml(source.slice(last));
    return html;
}

function renderCodeTokens(tokens: BlankPart[]) {
    const rendered: CodeRenderPart[] = [];
    for (const token of tokens) {
        if (token.kind === 'blank') {
            rendered.push({
                kind: 'blank',
                index: token.index || 0,
                label: token.label || `填空 ${(token.index || 0) + 1}`,
            });
        } else {
            const html = highlightCodeText(token.text || '');
            if (html) rendered.push({ kind: 'html', html });
        }
    }
    return rendered;
}

function fenceLangFrom(lang: string) {
    const langId = text(lang).trim();
    return !langId || langId.startsWith('cc') || langId.toLowerCase().startsWith('c++') ? 'cpp' : langId;
}

async function getConfig(domainId: string, pid: number) {
    return await coll.findOne({ _id: scopedId(domainId, pid) }) as IntroBlankDoc | null;
}

function baseBody(handler: any, config: IntroBlankDoc | null) {
    const pid = handler.pdoc.docId;
    const tid = handler.args?.tid;
    const suffix = tid ? `?tid=${tid}` : '';
    return {
        pdoc: handler.pdoc,
        tdoc: handler.tdoc,
        psdoc: handler.psdoc,
        title: config?.title || handler.pdoc.title,
        config,
        canEdit: canEditProblem(handler),
        originalUrl: handler.url('problem_detail', { pid }) + suffix,
        editUrl: handler.url('intro_blank_edit', { pid }) + suffix,
        submitUrl: handler.url('intro_blank_problem', { pid }) + suffix,
    };
}

function validateConfig(config: IntroBlankDoc) {
    const codeBlock = buildCodeBlock(config.template, config.lang);
    const blanks = codeBlankTokens(codeBlock.tokens).map((token, index) => ({
        index,
        label: token.label || `填空 ${index + 1}`,
        raw: token.label || '',
        answers: [],
    }));
    if (!blanks.length) {
        throw new ValidationError('template', null, '代码模板里请至少写一个 [[填空]]。');
    }
    if (!config.lang.trim()) throw new ValidationError('lang');
    return { parts: codeBlock.tokens, blanks };
}

async function bumpSubmit(domainId: string, pid: number, uid: number) {
    await Promise.all([
        ProblemModel.inc(domainId, pid, 'nSubmit', 1),
        DomainModel.incUserInDomain(domainId, uid, 'nSubmit'),
    ]);
}

class IntroBlankProblemHandler extends ProblemDetailHandler {
    async get() {
        if (!runtimeEnabled()) throw new ValidationError('introBlank', null, '程序填空插件已停用。');
        const config = await getConfig(this.args.domainId, this.pdoc.docId);
        if (!config?.enabled) {
            if (canEditProblem(this)) {
                this.response.redirect = this.url('intro_blank_edit', { pid: this.pdoc.docId });
                return;
            }
            throw new ValidationError('introBlank', null, '这道题还没有启用程序填空。');
        }

        this.response.template = 'intro_blank_detail.html';
        const codeBlock = buildCodeBlock(config.template, config.lang);
        const blanks = codeBlankTokens(codeBlock.tokens).map((token, index) => ({
            index: token.index ?? index,
            label: token.label || `填空 ${index + 1}`,
        }));
        this.response.body = {
            ...baseBody(this, config),
            page_name: 'intro_blank_problem',
            blanks,
            totalBlankCount: blanks.length,
            codeBlock,
            renderedCode: renderCodeTokens(codeBlock.tokens),
            codeFenceLang: normalizedCodeFenceLang(codeBlock.info, config.lang),
        };
    }

    async post() {
        const domainId = this.args.domainId;
        if (!runtimeEnabled()) throw new ValidationError('introBlank', null, '程序填空插件已停用。');
        if (this.tdoc && !(ContestModel as any).isOngoing?.(this.tdoc, this.tsdoc)) {
            throw new ValidationError('contest', null, '比赛或作业当前不能提交。');
        }
        const config = await getConfig(domainId, this.pdoc.docId);
        if (!config?.enabled) throw new ValidationError('introBlank', null, '这道题还没有启用程序填空。');

        const parsed = validateConfig(config);
        const values = submittedBlankValues(this.request.body || {}, parsed.blanks.length);

        if (typeof this.pdoc.config === 'string' || this.pdoc.config === null) throw new ProblemConfigError();
        const lang = config.lang.trim();
        if ((this.pdoc.config as any).langs?.length && !(this.pdoc.config as any).langs.includes(lang)) {
            throw new ValidationError('lang', lang, '当前题目配置不允许这个语言。');
        }
        const code = buildCode(config.template, values, lang);
        const rid = await RecordModel.add(
            domainId, this.pdoc.docId, this.user._id, lang, code, true,
            this.args.tid ? { contest: this.args.tid, type: 'judge' } : { type: 'judge' },
        );
        await bumpSubmit(domainId, this.pdoc.docId, this.user._id);
        if (this.args.tid) {
            await (ContestModel as any).updateStatus(domainId, this.args.tid, this.user._id, rid, this.pdoc.docId);
        }
        this.response.redirect = this.url('record_detail', { rid });
    }
}

class IntroBlankEditHandler extends ProblemDetailHandler {
    async get() {
        ensureCanEditProblem(this);
        const config = await getConfig(this.args.domainId, this.pdoc.docId);
        const defaultTemplate = '```cpp\n[[填空]]\n```\n';
        const base = config ? { ...config, mode: 'code' } : {
            enabled: true,
            mode: 'code',
            title: this.pdoc.title,
            description: '',
            template: defaultTemplate,
            lang: 'cc',
            caseSensitive: true,
            trimSpaces: true,
        };
        const { code } = splitTemplateForEdit(base.template);
        const form: EditForm = { ...base, code } as EditForm;
        this.response.template = 'intro_blank_edit.html';
        this.response.body = {
            ...baseBody(this, config),
            page_name: 'intro_blank_edit',
            form,
            messages: [],
        };
    }

    async post() {
        await this.saveConfig();
    }

    async postSave() {
        await this.saveConfig();
    }

    async postDelete() {
        ensureCanEditProblem(this);
        await coll.deleteOne({ _id: scopedId(this.args.domainId, this.pdoc.docId) });
        this.response.redirect = this.url('problem_detail', { pid: this.pdoc.docId });
    }

    private async saveConfig() {
        ensureCanEditProblem(this);
        const body = this.request.body || {};
        const now = new Date();
        const domainId = this.args.domainId;
        const previous = await getConfig(domainId, this.pdoc.docId);
        const lang = text(body.lang).trim() || 'cc';
        const template = Object.prototype.hasOwnProperty.call(body, 'code')
            ? composeTemplate(body.code, lang)
            : text(body.template);
        const doc: IntroBlankDoc = {
            _id: scopedId(domainId, this.pdoc.docId),
            domainId,
            pid: this.pdoc.docId,
            enabled: true,
            mode: 'code',
            title: text(body.title).trim() || this.pdoc.title,
            description: '',
            template,
            lang,
            caseSensitive: true,
            trimSpaces: true,
            createdAt: previous?.createdAt || now,
            updatedAt: now,
            updatedBy: this.user._id,
        };
        validateConfig(doc);
        await coll.updateOne({ _id: doc._id }, { $set: doc }, { upsert: true });

        this.response.redirect = this.url('intro_blank_edit', { pid: this.pdoc.docId });
    }
}

function setProblemUi(handler: any, config: IntroBlankDoc | null) {
    const pdoc = handler.response?.body?.pdoc || handler.pdoc;
    if (!pdoc?.docId) return;
    const tid = handler.args?.tid;
    const suffix = tid ? `?tid=${tid}` : '';
    handler.UiContext ||= {};
    handler.UiContext.introBlankKit = {
        enabled: !!config?.enabled,
        mode: config?.mode || '',
        canEdit: canEditProblem(handler),
        title: config?.title || '程序填空',
        url: handler.url('intro_blank_problem', { pid: pdoc.docId }) + suffix,
        editUrl: handler.url('intro_blank_edit', { pid: pdoc.docId }) + suffix,
    };
}

export async function apply(ctx: Context) {
    ctx.Route('intro_blank_problem', '/p/:pid/intro-blank', IntroBlankProblemHandler, PERM.PERM_SUBMIT_PROBLEM);
    ctx.Route('intro_blank_edit', '/p/:pid/intro-blank/edit', IntroBlankEditHandler, PERM.PERM_VIEW_PROBLEM);

    ctx.on('handler/after/ProblemDetail#get', async (handler: any) => {
        if (!runtimeEnabled()) return;
        const pdoc = handler.response?.body?.pdoc || handler.pdoc;
        if (!pdoc?.docId) return;
        const config = await getConfig(handler.args.domainId, pdoc.docId);
        setProblemUi(handler, config);
    });

    await db.ensureIndexes(
        coll,
        { key: { domainId: 1, pid: 1 }, name: 'intro_blank_problem', unique: true },
        { key: { domainId: 1, enabled: 1 }, name: 'intro_blank_enabled' },
    );

    ctx.i18n.load('zh', {
        intro_blank_problem: '程序填空',
        intro_blank_edit: '配置程序填空',
    });
    ctx.i18n.load('en', {
        intro_blank_problem: 'Code Blanks',
        intro_blank_edit: 'Edit Code Blanks',
    });
}
