import {
    Context, ContestModel, DomainModel, PERM, ProblemConfigError, ProblemModel,
    RecordModel, StorageModel, ValidationError, db, streamToBuffer,
} from 'hydrooj';
import { ProblemDetailHandler } from 'hydrooj/src/handler/problem';

type RichObjectiveMode = 'schema' | 'h5';
type QuestionType = 'single' | 'multiple' | 'blank' | 'textarea' | 'select';

interface RichObjectiveDoc {
    _id: string;
    domainId: string;
    pid: number;
    enabled: boolean;
    mode: RichObjectiveMode;
    title: string;
    schemaText: string;
    customCss: string;
    h5Html: string;
    createdAt?: Date;
    updatedAt: Date;
    updatedBy: number;
}

interface QuestionOption {
    value: string;
    label: string;
}

interface QuestionBlank {
    id: string;
    label: string;
    placeholder: string;
    answerKey: string;
    answerName: string;
    inline: boolean;
}

interface QuestionInlinePart {
    type: 'text' | 'blank';
    text: string;
    blank?: QuestionBlank;
}

interface RichObjectiveQuestion {
    id: string;
    type: QuestionType;
    title: string;
    description: string;
    placeholder: string;
    required: boolean;
    answerName: string;
    options: QuestionOption[];
    blanks: QuestionBlank[];
    listBlanks: QuestionBlank[];
    titleParts: QuestionInlinePart[];
    descriptionLines: QuestionInlinePart[][];
    hasInlineBlanks: boolean;
}

interface RichObjectiveSchema {
    title: string;
    description: string;
    questions: RichObjectiveQuestion[];
}

const PLUGIN_ID = 'rich-objective-kit';
const MAX_PAYLOAD_BYTES = 256 * 1024;
const coll = db.collection('rich_objective' as any);
const legacyColl = db.collection('problem.richObjective' as any);
const QUESTION_TYPES: QuestionType[] = ['single', 'multiple', 'blank', 'textarea', 'select'];
const CHOICE_TYPES = new Set<QuestionType>(['single', 'multiple', 'select']);

const DEFAULT_MARKDOWN = `# 课堂小测

选择并填写下面的问题，点击保存后会生成一次评测提交。

[single:q1] 以下哪一个是二分查找的时间复杂度？
- A. O(n)
- B. O(log n)
- C. O(n log n)
- D. O(1)

[blank:q2] C++ 中输出换行常用的流控制符是？
提示：例如 \`endl\`

[blank:q3] 内嵌填空的例子
水的化学式是 {{a:第一空}}，氧气的化学式是 {{b:第二空}}。

[blank:q4] 列表填空的例子
- a: 第一个空
- b: 第二个空
`;

const DEFAULT_CHECKER_CC = String.raw`#include "testlib.h"
#include <bits/stdc++.h>
using namespace std;

using Answers = map<string, vector<string>>;

static string rokTrim(string s) {
    while (!s.empty() && isspace((unsigned char)s.front())) s.erase(s.begin());
    while (!s.empty() && isspace((unsigned char)s.back())) s.pop_back();
    return s;
}

static string rokCompactLower(string s) {
    string result;
    for (unsigned char ch : s) {
        if (!isspace(ch)) result.push_back((char)tolower(ch));
    }
    return result;
}

static string rokReadLine(InStream& fin) {
    string line = fin.readLine();
    if (!line.empty() && line.back() == '\r') line.pop_back();
    return line;
}

static Answers readRichObjectiveAnswers(InStream& fin) {
    string magic = rokReadLine(fin);
    if (magic != "ROK1") quitf(_wa, "invalid rich objective answer format");

    string countLine = rokReadLine(fin);
    int count = 0;
    try {
        count = stoi(rokTrim(countLine));
    } catch (...) {
        quitf(_wa, "invalid answer count");
    }
    if (count < 0 || count > 10000) quitf(_wa, "invalid answer count");

    Answers answers;
    for (int i = 0; i < count; i++) {
        string header = rokReadLine(fin);
        size_t space = header.find(' ');
        if (space == string::npos) quitf(_wa, "broken answer header");

        string key = header.substr(0, space);
        int len = 0;
        try {
            len = stoi(header.substr(space + 1));
        } catch (...) {
            quitf(_wa, "invalid answer length");
        }
        if (key.empty() || key.size() > 64 || len < 0 || len > 262144) {
            quitf(_wa, "invalid answer entry");
        }

        string value(len, '\0');
        if (len) {
            for (int j = 0; j < len; j++) value[j] = fin.readChar();
        }
        char sep = fin.readChar();
        if (sep == '\r') {
            char next = fin.readChar();
            if (next != '\n') quitf(_wa, "missing answer separator");
        } else if (sep != '\n') {
            quitf(_wa, "missing answer separator");
        }
        answers[key].push_back(value);
    }
    while (!fin.seekEof()) fin.readChar();
    return answers;
}

static string one(const Answers& answers, const string& key) {
    auto it = answers.find(key);
    if (it == answers.end() || it->second.empty()) return "";
    return it->second.front();
}

static vector<string> many(const Answers& answers, const string& key) {
    auto it = answers.find(key);
    if (it == answers.end()) return {};
    vector<string> result = it->second;
    sort(result.begin(), result.end());
    return result;
}

int main(int argc, char* argv[]) {
    registerTestlibCmd(argc, argv);

    // Hydro testlib checker arguments:
    // argv[1] = input, argv[2] = user output, argv[3] = standard output.
    Answers answers = readRichObjectiveAnswers(ouf);

    int score = 0;

    // q1: single choice, standard answer B, 50 points.
    if (rokTrim(one(answers, "q1")) == "B") score += 50;

    // q2: fill blank, accept endl or std::endl, 50 points.
    string q2 = rokCompactLower(one(answers, "q2"));
    if (q2 == "endl" || q2 == "std::endl") score += 50;

    // Multiple choice example:
    // if (many(answers, "q3") == vector<string>({"A", "D"})) score += 20;

    if (score == 100) quitf(_ok, "all answers are correct");
    if (score == 0) quitf(_wa, "no answer is correct");
    quitp(score / 100.0, "partial score: %d", score);
}
`;

const DEFAULT_META_IN = 'rich-objective\n';
const DEFAULT_META_ANS = 'answers are checked by checker.cc\n';

function cppString(value: string) {
    return JSON.stringify(text(value));
}

function cppLineComment(value: string) {
    return text(value).replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function cppIdentifier(value: string, fallback: string) {
    const result = text(value).replace(/[^A-Za-z0-9_]/g, '_').replace(/^([^A-Za-z_])/, '_$1');
    return result || fallback;
}

function scoreDistribution(count: number) {
    if (count <= 0) return [];
    const base = Math.floor(100 / count);
    let rest = 100 - base * count;
    return Array.from({ length: count }, () => {
        const score = base + (rest > 0 ? 1 : 0);
        rest -= 1;
        return score;
    });
}

function checkerHelperSource() {
    return String.raw`#include "testlib.h"
#include <bits/stdc++.h>
using namespace std;

using Answers = map<string, vector<string>>;

static string rokTrim(string s) {
    while (!s.empty() && isspace((unsigned char)s.front())) s.erase(s.begin());
    while (!s.empty() && isspace((unsigned char)s.back())) s.pop_back();
    return s;
}

static string rokCompactLower(string s) {
    string result;
    for (unsigned char ch : s) {
        if (!isspace(ch)) result.push_back((char)tolower(ch));
    }
    return result;
}

static bool sameText(string actual, string expected) {
    return rokTrim(actual) == rokTrim(expected);
}

static bool sameTextIgnoreCaseAndSpaces(string actual, string expected) {
    return rokCompactLower(actual) == rokCompactLower(expected);
}

static string rokReadLine(InStream& fin) {
    string line = fin.readLine();
    if (!line.empty() && line.back() == '\r') line.pop_back();
    return line;
}

static Answers readRichObjectiveAnswers(InStream& fin) {
    string magic = rokReadLine(fin);
    if (magic != "ROK1") quitf(_wa, "invalid rich objective answer format");

    string countLine = rokReadLine(fin);
    int count = 0;
    try {
        count = stoi(rokTrim(countLine));
    } catch (...) {
        quitf(_wa, "invalid answer count");
    }
    if (count < 0 || count > 10000) quitf(_wa, "invalid answer count");

    Answers answers;
    for (int i = 0; i < count; i++) {
        string header = rokReadLine(fin);
        size_t space = header.find(' ');
        if (space == string::npos) quitf(_wa, "broken answer header");

        string key = header.substr(0, space);
        int len = 0;
        try {
            len = stoi(header.substr(space + 1));
        } catch (...) {
            quitf(_wa, "invalid answer length");
        }
        if (key.empty() || key.size() > 64 || len < 0 || len > 262144) {
            quitf(_wa, "invalid answer entry");
        }

        string value(len, '\0');
        if (len) {
            for (int j = 0; j < len; j++) value[j] = fin.readChar();
        }
        char sep = fin.readChar();
        if (sep == '\r') {
            char next = fin.readChar();
            if (next != '\n') quitf(_wa, "missing answer separator");
        } else if (sep != '\n') {
            quitf(_wa, "missing answer separator");
        }
        answers[key].push_back(value);
    }
    while (!fin.seekEof()) fin.readChar();
    return answers;
}

static string one(const Answers& answers, const string& key) {
    auto it = answers.find(key);
    if (it == answers.end() || it->second.empty()) return "";
    return it->second.front();
}

static vector<string> many(const Answers& answers, const string& key) {
    auto it = answers.find(key);
    if (it == answers.end()) return {};
    vector<string> result = it->second;
    sort(result.begin(), result.end());
    return result;
}
`;
}

function checkerFunctionForQuestion(question: RichObjectiveQuestion, index: number, maxScore: number) {
    const functionName = `score_${index + 1}_${cppIdentifier(question.id, `q${index + 1}`)}`;
    const title = cppLineComment(question.title);
    const lines = [
        `// ${question.id}: ${question.type}${title ? ` - ${title}` : ''}`,
        `static int ${functionName}(const Answers& answers) {`,
        `    const int FULL = ${maxScore};`,
    ];
    if (question.type === 'single' || question.type === 'select') {
        const first = question.options[0]?.value || 'A';
        lines.push(
            `    string ans = rokTrim(one(answers, ${cppString(question.id)}));`,
            `    // TODO: replace ${cppString(first)} with the correct option value.`,
            `    return ans == ${cppString(first)} ? FULL : 0;`,
        );
    } else if (question.type === 'multiple') {
        const firstValues = question.options.slice(0, Math.min(2, question.options.length)).map((option) => option.value);
        const expected = firstValues.length ? firstValues : ['A', 'B'];
        lines.push(
            `    vector<string> ans = many(answers, ${cppString(question.id)});`,
            `    vector<string> expected = {${expected.map(cppString).join(', ')}};`,
            `    // TODO: replace expected with all correct option values. many() already sorts both submitted values and expected values.`,
            `    sort(expected.begin(), expected.end());`,
            `    return ans == expected ? FULL : 0;`,
        );
    } else if (question.type === 'blank' && question.blanks.length) {
        const perBlank = Math.floor(maxScore / question.blanks.length);
        let rest = maxScore - perBlank * question.blanks.length;
        lines.push(`    int score = 0;`);
        for (const blank of question.blanks) {
            const varName = `ans_${cppIdentifier(blank.id, 'blank')}`;
            const blankScore = perBlank + (rest > 0 ? 1 : 0);
            rest -= 1;
            lines.push(
                `    string ${varName} = rokTrim(one(answers, ${cppString(blank.answerKey)})); // ${cppLineComment(blank.label)}`,
                `    if (sameTextIgnoreCaseAndSpaces(${varName}, "TODO")) score += ${blankScore}; // TODO: accepted answer for ${blank.answerKey}`,
            );
        }
        lines.push(`    return score;`);
    } else if (question.type === 'blank') {
        lines.push(
            `    string ans = rokTrim(one(answers, ${cppString(question.id)}));`,
            `    // TODO: replace "TODO" with the accepted answer.`,
            `    return sameTextIgnoreCaseAndSpaces(ans, "TODO") ? FULL : 0;`,
        );
    } else {
        lines.push(
            `    string ans = rokTrim(one(answers, ${cppString(question.id)}));`,
            `    // TODO: long text usually needs manual scoring logic.`,
            `    return ans.empty() ? 0 : FULL;`,
        );
    }
    lines.push(`}`, '');
    return { functionName, source: lines.join('\n') };
}

function generateCheckerForSchema(schema: RichObjectiveSchema) {
    const scores = scoreDistribution(schema.questions.length);
    const functions = schema.questions.map((question, index) => checkerFunctionForQuestion(question, index, scores[index] || 0));
    return [
        checkerHelperSource(),
        ...functions.map((item) => item.source),
        'int main(int argc, char* argv[]) {',
        '    registerTestlibCmd(argc, argv);',
        '',
        '    // Hydro testlib checker arguments:',
        '    // argv[1] = input, argv[2] = user output, argv[3] = standard output.',
        '    Answers answers = readRichObjectiveAnswers(ouf);',
        '',
        '    int score = 0;',
        ...functions.map((item) => `    score += ${item.functionName}(answers);`),
        '',
        '    if (score >= 100) quitf(_ok, "all answers are correct");',
        '    if (score <= 0) quitf(_wa, "no answer is correct");',
        '    quitp(score / 100.0, "partial score: %d", score);',
        '}',
        '',
    ].join('\n');
}

function checkerTemplateForRequest(handler: any, config: RichObjectiveDoc | null) {
    const body = handler.request?.body || {};
    const mode = hasOwn(body, 'mode') ? normalizeMode(body.mode) : config?.mode || 'schema';
    if (mode !== 'schema') return DEFAULT_CHECKER_CC;
    const schemaText = hasOwn(body, 'schemaText')
        ? lastText(body.schemaText).trim()
        : config?.schemaText || initialSchemaText(handler);
    try {
        return generateCheckerForSchema(parseSchema(schemaText));
    } catch {
        return DEFAULT_CHECKER_CC;
    }
}

function hasRichQuestionHeader(source: string) {
    return /(^|\n)\s*\[(single|multiple|blank|textarea|select)(\?)?:[A-Za-z0-9_.-]+\]/i.test(source);
}

function preferredStatementLanguages(handler: any) {
    return [
        text(handler.request?.query?.lang),
        text(handler.user?.viewLang),
        text(handler.session?.viewLang),
        'zh_CN',
        'zh',
        'en',
    ].filter(Boolean);
}

function pickLocalizedProblemContent(rawContent: any, handler: any) {
    const raw = text(rawContent).trim();
    if (!raw) return '';
    let parsed: any;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return raw;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return raw;
    const keys = Object.keys(parsed).filter((key) => typeof parsed[key] === 'string');
    if (!keys.length) return raw;
    for (const lang of preferredStatementLanguages(handler)) {
        if (typeof parsed[lang] === 'string') return parsed[lang].trim();
        const matched = keys.find((key) => key.startsWith(lang) || lang.startsWith(key));
        if (matched) return parsed[matched].trim();
    }
    return text(parsed[keys[0]]).trim();
}

function initialSchemaText(handler: any) {
    const content = pickLocalizedProblemContent(handler.pdoc?.content, handler);
    if (!content) return DEFAULT_MARKDOWN;
    if (hasRichQuestionHeader(content)) return content;
    return content;
}

function isGeneratedDefaultSchemaText(value: any) {
    const source = text(value).trim();
    if (!source || source === DEFAULT_MARKDOWN.trim()) return true;
    if (source.includes('# 课堂小测')
        && source.includes('[single:q1] 以下哪一个是二分查找的时间复杂度？')
        && source.includes('[blank:q2] C++ 中输出换行常用的流控制符是？')) return true;
    if (!source.startsWith('{')) return false;
    try {
        const raw = JSON.parse(source);
        return Array.isArray(raw?.questions)
            && raw.questions[0]?.id === 'q1'
            && raw.questions[0]?.type === 'single'
            && raw.questions[1]?.id === 'q2'
            && raw.questions[1]?.type === 'blank';
    } catch {
        return false;
    }
}

function schemaTextForEdit(handler: any, config: RichObjectiveDoc | null) {
    if (config && !isGeneratedDefaultSchemaText(config.schemaText)) return config.schemaText;
    return initialSchemaText(handler);
}

function scopedId(domainId: string, pid: number) {
    return `${domainId}:${pid}`;
}

function runtimeEnabled() {
    const pluginSwitch = (globalThis as any).Hydro?.model?.pluginSwitch;
    return pluginSwitch?.isEnabledSync?.(PLUGIN_ID) !== false;
}

function text(value: any, fallback = '') {
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return fallback;
    return String(value);
}

function lastText(value: any, fallback = '') {
    if (Array.isArray(value)) return text(value[value.length - 1], fallback);
    return text(value, fallback);
}

function hasOwn(value: any, key: string) {
    return !!value && Object.prototype.hasOwnProperty.call(value, key);
}

function asArray(value: any) {
    if (value === undefined || value === null || value === '') return [];
    return Array.isArray(value) ? value : [value];
}

function formBoolean(value: any, fallback = true) {
    const values = asArray(value).map((item) => text(item).trim().toLowerCase()).filter(Boolean);
    if (!values.length) return fallback;
    if (values.some((item) => ['on', 'true', '1', 'yes'].includes(item))) return true;
    if (values.some((item) => ['off', 'false', '0', 'no'].includes(item))) return false;
    return fallback;
}

function normalizeMode(value: any): RichObjectiveMode {
    return text(value).trim() === 'h5' ? 'h5' : 'schema';
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

function answerField(id: string) {
    return `answer_${Buffer.from(id, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

function normalizeQuestionId(raw: any, index: number, seen: Set<string>) {
    const id = text(raw).trim() || `q${index + 1}`;
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id)) {
        throw new ValidationError('schema', id, '题目 id 只能包含字母、数字、下划线、点和短横线，长度不超过 64。');
    }
    if (seen.has(id)) throw new ValidationError('schema', id, `题目 id 重复：${id}`);
    seen.add(id);
    return id;
}

function normalizeQuestionType(raw: any) {
    const type = text(raw, 'blank').trim() as QuestionType;
    if (!QUESTION_TYPES.includes(type)) {
        throw new ValidationError('schema', type, `不支持的题目类型：${type}`);
    }
    return type;
}

function normalizeOptions(value: any) {
    return asArray(value).map((item, index) => {
        if (typeof item === 'string') {
            const label = item.trim();
            return { value: String.fromCharCode(65 + index), label: label || `选项 ${index + 1}` };
        }
        const optionValue = text(item?.value, String.fromCharCode(65 + index)).trim();
        const optionLabel = text(item?.label, optionValue).trim();
        if (!optionValue) throw new ValidationError('schema', null, '选项 value 不能为空。');
        return { value: optionValue, label: optionLabel || optionValue };
    });
}

function normalizeBlanks(value: any, parentId: string) {
    const seen = new Set<string>();
    return asArray(value).map((item, index) => {
        let rawId: any = typeof item === 'string' ? '' : item?.id;
        let label = typeof item === 'string' ? item.trim() : text(item?.label).trim();
        const parsed = label.match(/^([A-Za-z0-9_.-]{1,64})\s*[:：]\s*(.*)$/);
        if (!rawId && parsed) {
            rawId = parsed[1];
            label = parsed[2].trim();
        }
        const id = normalizeQuestionId(rawId, index, seen);
        const answerKey = `${parentId}.${id}`;
        return {
            id,
            label: label || `第 ${index + 1} 空`,
            placeholder: typeof item === 'string' ? '请输入答案' : text(item?.placeholder, '请输入答案').trim(),
            answerKey,
            answerName: answerField(answerKey),
            inline: false,
        };
    });
}

function textParts(source: string): QuestionInlinePart[] {
    return [{ type: 'text', text: source }];
}

function parseInlineBlankParts(
    source: string, parentId: string, seen: Set<string>, blanks: QuestionBlank[],
) {
    const parts: QuestionInlinePart[] = [];
    const pattern = /\{\{\s*([A-Za-z0-9_.-]{1,64})(?:\s*[:：]\s*([^}]+?))?\s*\}\}/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
        if (match.index > lastIndex) parts.push({ type: 'text', text: source.slice(lastIndex, match.index) });
        const id = normalizeQuestionId(match[1], blanks.length, seen);
        const label = text(match[2]).trim() || `第 ${blanks.length + 1} 空`;
        const answerKey = `${parentId}.${id}`;
        const blank = {
            id,
            label,
            placeholder: label,
            answerKey,
            answerName: answerField(answerKey),
            inline: true,
        };
        blanks.push(blank);
        parts.push({ type: 'blank', text: '', blank });
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < source.length) parts.push({ type: 'text', text: source.slice(lastIndex) });
    return parts.length ? parts : textParts(source);
}

function enrichQuestion(question: Omit<RichObjectiveQuestion, 'listBlanks' | 'titleParts' | 'descriptionLines' | 'hasInlineBlanks'>) {
    if (question.type !== 'blank') {
        return {
            ...question,
            listBlanks: question.blanks,
            titleParts: textParts(question.title),
            descriptionLines: question.description ? question.description.split('\n').map(textParts) : [],
            hasInlineBlanks: false,
        };
    }
    const blanks = [...question.blanks];
    const seen = new Set(blanks.map((blank) => blank.id));
    const titleParts = parseInlineBlankParts(question.title, question.id, seen, blanks);
    const descriptionLines = question.description
        ? question.description.split('\n').map((line) => parseInlineBlankParts(line, question.id, seen, blanks))
        : [];
    const hasInlineBlanks = blanks.some((blank) => blank.inline);
    return {
        ...question,
        blanks,
        listBlanks: blanks.filter((blank) => !blank.inline),
        titleParts,
        descriptionLines,
        hasInlineBlanks,
    };
}

function parseSchema(schemaText: string): RichObjectiveSchema {
    const source = text(schemaText).trim();
    if (!source || source.startsWith('{')) return parseJsonSchema(source || '{}');
    return parseMarkdownSchema(schemaText);
}

function parseJsonSchema(schemaText: string): RichObjectiveSchema {
    let raw: any;
    try {
        raw = JSON.parse(schemaText || '{}');
    } catch (e: any) {
        throw new ValidationError('schema', null, `题目 Schema 不是合法 JSON：${e?.message || e}`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ValidationError('schema', null, '题目 Schema 必须是 JSON 对象。');
    }
    const seen = new Set<string>();
    const questions = asArray(raw.questions).map((question, index) => {
        const type = normalizeQuestionType(question?.type);
        const id = normalizeQuestionId(question?.id, index, seen);
        const title = text(question?.title, `题目 ${index + 1}`).trim();
        const options = normalizeOptions(question?.options);
        if (CHOICE_TYPES.has(type) && !options.length) {
            throw new ValidationError('schema', id, `${id} 是选择题，但没有配置 options。`);
        }
        return enrichQuestion({
            id,
            type,
            title: title || `题目 ${index + 1}`,
            description: text(question?.description).trim(),
            placeholder: text(question?.placeholder).trim(),
            required: question?.required !== false,
            answerName: answerField(id),
            options,
            blanks: type === 'blank' ? normalizeBlanks(question?.blanks, id) : [],
        });
    });
    if (!questions.length) throw new ValidationError('schema', null, '至少需要配置一道题。');
    return {
        title: text(raw.title).trim(),
        description: text(raw.description).trim(),
        questions,
    };
}

interface MarkdownQuestionDraft {
    id: string;
    type: QuestionType;
    title: string;
    required: boolean;
    lines: string[];
}

interface MarkdownBlankDraft {
    id: string;
    label: string;
}

function trimBlankLines(lines: string[]) {
    const result = [...lines];
    while (result.length && !result[0].trim()) result.shift();
    while (result.length && !result[result.length - 1].trim()) result.pop();
    return result;
}

function parseMarkdownOption(line: string, index: number): QuestionOption | null {
    const bullet = line.trim().match(/^[-*+]\s+(.+)$/);
    if (!bullet) return null;
    const content = bullet[1].trim();
    if (!content) return null;
    const keyed = content.match(/^\[([A-Za-z0-9_.-]{1,64})\]\s*(.+)$/)
        || content.match(/^([A-Za-z0-9_.-]{1,64})[.)、:：]\s*(.+)$/);
    if (keyed) {
        const value = (keyed[1] || String.fromCharCode(65 + index)).trim();
        const label = text(keyed[2], value).trim();
        if (!value) throw new ValidationError('schema', null, '选项 value 不能为空。');
        return { value, label: label || value };
    }
    return { value: String.fromCharCode(65 + index), label: content };
}

function parseMarkdownBlank(line: string, index: number): MarkdownBlankDraft | null {
    const bullet = line.trim().match(/^[-*+]\s+(.+)$/);
    if (!bullet) return null;
    const content = bullet[1].trim();
    if (!content) return null;
    const bracket = content.match(/^\[([A-Za-z0-9_.-]{1,64})\]\s*(.+)$/);
    if (bracket) return { id: bracket[1], label: bracket[2].trim() };
    const colon = content.match(/^([A-Za-z0-9_.-]{1,64})\s*[:：]\s*(.+)$/);
    if (colon) return { id: colon[1], label: colon[2].trim() };
    return { id: String.fromCharCode(97 + index), label: content };
}

function parseMarkdownSchema(source: string): RichObjectiveSchema {
    const lines = text(source).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const headerPattern = /^\s*\[(single|multiple|blank|textarea|select)(\?)?:([A-Za-z0-9_.-]+)\]\s*(.*)$/i;
    const intro: string[] = [];
    const drafts: MarkdownQuestionDraft[] = [];
    let active: MarkdownQuestionDraft | null = null;

    for (const line of lines) {
        const header = line.match(headerPattern);
        if (header) {
            if (active) drafts.push(active);
            active = {
                type: normalizeQuestionType(header[1].toLowerCase()),
                required: !header[2],
                id: header[3],
                title: header[4].trim(),
                lines: [],
            };
        } else if (active) {
            active.lines.push(line);
        } else {
            intro.push(line);
        }
    }
    if (active) drafts.push(active);

    const introLines = trimBlankLines(intro);
    let title = '';
    if (introLines[0]?.startsWith('# ')) {
        title = introLines[0].replace(/^#\s+/, '').trim();
        introLines.shift();
    }
    const description = trimBlankLines(introLines).join('\n').trim();
    const seen = new Set<string>();
    const questions = drafts.map((draft, index) => {
        const id = normalizeQuestionId(draft.id, index, seen);
        const bodyLines = trimBlankLines(draft.lines);
        const options: QuestionOption[] = [];
        const blankDrafts: MarkdownBlankDraft[] = [];
        const descriptionLines: string[] = [];
        for (const line of bodyLines) {
            const option = CHOICE_TYPES.has(draft.type) ? parseMarkdownOption(line, options.length) : null;
            const blank = draft.type === 'blank' ? parseMarkdownBlank(line, blankDrafts.length) : null;
            if (option) options.push(option);
            else if (blank) blankDrafts.push(blank);
            else descriptionLines.push(line);
        }
        let questionTitle = draft.title.trim();
        if (!questionTitle) {
            const firstText = descriptionLines.findIndex((line) => !!line.trim());
            if (firstText >= 0) {
                questionTitle = descriptionLines[firstText].trim();
                descriptionLines.splice(firstText, 1);
            }
        }
        if (CHOICE_TYPES.has(draft.type) && !options.length) {
            throw new ValidationError('schema', id, `${id} 是选择题，但没有配置选项。`);
        }
        return enrichQuestion({
            id,
            type: draft.type,
            title: questionTitle || `题目 ${index + 1}`,
            description: trimBlankLines(descriptionLines).join('\n').trim(),
            placeholder: ['blank', 'textarea'].includes(draft.type) ? '请输入答案' : '',
            required: draft.required,
            answerName: answerField(id),
            options,
            blanks: blankDrafts.map((blank, blankIndex) => {
                const answerKey = `${id}.${blank.id}`;
                return {
                    id: normalizeQuestionId(blank.id, blankIndex, new Set(blankDrafts.slice(0, blankIndex).map((item) => item.id))),
                    label: blank.label || `第 ${blankIndex + 1} 空`,
                    placeholder: '请输入答案',
                    answerKey,
                    answerName: answerField(answerKey),
                    inline: false,
                };
            }),
        });
    });
    if (!questions.length) throw new ValidationError('schema', null, '至少需要配置一道题。');
    return { title, description, questions };
}

function parseH5Payload(raw: string) {
    if (!raw.trim()) throw new ValidationError('answers_payload', null, 'H5 页面没有导出答案。');
    let parsed: any;
    try {
        parsed = JSON.parse(raw);
    } catch (e: any) {
        throw new ValidationError('answers_payload', null, `答案不是合法 JSON：${e?.message || e}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ValidationError('answers_payload', null, 'H5 答案必须是 JSON 对象。');
    }
    const answers = parsed.answers && typeof parsed.answers === 'object' && !Array.isArray(parsed.answers)
        ? parsed.answers
        : parsed;
    return JSON.parse(JSON.stringify(answers));
}

function normalizeSchemaAnswers(schema: RichObjectiveSchema, body: any) {
    const answers: Record<string, string | string[]> = {};
    for (const question of schema.questions) {
        if (question.type === 'blank' && question.blanks.length) {
            for (const blank of question.blanks) {
                const value = lastText(body?.[blank.answerName]).trim();
                answers[blank.answerKey] = value;
                if (question.required && !value) {
                    throw new ValidationError(blank.answerName, null, `请填写：${question.title} / ${blank.label}`);
                }
            }
            continue;
        }
        const raw = body?.[answerField(question.id)];
        if (question.type === 'multiple') {
            answers[question.id] = asArray(raw).map((item) => text(item).trim()).filter(Boolean);
        } else {
            answers[question.id] = lastText(raw).trim();
        }
        if (question.required) {
            const value = answers[question.id];
            if (Array.isArray(value) ? !value.length : !value) {
                throw new ValidationError(answerField(question.id), null, `请填写：${question.title}`);
            }
        }
    }
    return answers;
}

function buildSubmissionPayload(config: RichObjectiveDoc, schema: RichObjectiveSchema | null, body: any) {
    const answers = config.mode === 'schema'
        ? normalizeSchemaAnswers(schema!, body)
        : parseH5Payload(lastText(body?.answers_payload).trim());
    const serialized = serializeAnswers(answers);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
        throw new ValidationError('answers_payload', null, '答案内容过大。');
    }
    return serialized;
}

function answerValueList(value: any) {
    const values = Array.isArray(value) ? value : [value];
    return values.map((item) => {
        if (item === undefined || item === null) return '';
        if (typeof item === 'object') return JSON.stringify(item);
        return text(item).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    });
}

function serializeAnswers(answers: Record<string, any>) {
    const entries: Array<{ key: string, value: string }> = [];
    for (const key of Object.keys(answers || {}).sort()) {
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) {
            throw new ValidationError('answers_payload', key, '答案 key 只能包含字母、数字、下划线、点和短横线，长度不超过 64。');
        }
        for (const value of answerValueList(answers[key])) entries.push({ key, value });
    }
    const chunks = ['ROK1', String(entries.length)];
    for (const entry of entries) {
        chunks.push(`${entry.key} ${Buffer.byteLength(entry.value, 'utf8')}`);
        chunks.push(entry.value);
    }
    return `${chunks.join('\n')}\n`;
}

function domainIdOf(handler: any) {
    return handler.args?.domainId || handler.domain?._id || handler.pdoc?.domainId || 'system';
}

function normalizeConfigDoc(raw: any, domainId: string, pid: number): RichObjectiveDoc | null {
    if (!raw) return null;
    const now = new Date();
    return {
        _id: scopedId(domainId, pid),
        domainId,
        pid,
        enabled: raw.enabled !== false,
        mode: normalizeMode(raw.mode),
        title: text(raw.title).trim(),
        schemaText: text(raw.schemaText),
        customCss: text(raw.customCss),
        h5Html: text(raw.h5Html),
        createdAt: raw.createdAt || now,
        updatedAt: raw.updatedAt || now,
        updatedBy: +raw.updatedBy || 0,
    };
}

async function findConfigInCollection(collection: any, domainId: string, pid: number) {
    return await collection.findOne({ _id: scopedId(domainId, pid) })
        || await collection.findOne({ domainId, pid })
        || await collection.find({ pid }).sort({ updatedAt: -1 }).limit(1).next();
}

async function getConfig(domainId: string, pid: number) {
    const raw = await findConfigInCollection(coll, domainId, pid)
        || await findConfigInCollection(legacyColl, domainId, pid);
    const doc = normalizeConfigDoc(raw, domainId, pid);
    if (doc && raw?._id !== doc._id) await upsertConfig(doc);
    return doc;
}

async function upsertConfig(doc: RichObjectiveDoc) {
    const { _id, ...fields } = doc;
    const update = { $set: fields, $setOnInsert: { _id } };
    await Promise.all([
        coll.updateOne({ _id }, update, { upsert: true }),
        legacyColl.updateOne({ _id }, update, { upsert: true }),
    ]);
}

function defaultConfig(handler: any): RichObjectiveDoc {
    const now = new Date();
    return {
        _id: scopedId(domainIdOf(handler), handler.pdoc.docId),
        domainId: domainIdOf(handler),
        pid: handler.pdoc.docId,
        enabled: true,
        mode: 'schema',
        title: handler.pdoc.title || '富交互客观题',
        schemaText: initialSchemaText(handler),
        customCss: '',
        h5Html: '',
        createdAt: now,
        updatedAt: now,
        updatedBy: handler.user._id,
    };
}

function testdataNames(pdoc: any) {
    return new Set(asArray(pdoc?.data).map((file) => text(file?.name)).filter(Boolean));
}

function configFilenameFrom(names: Set<string>) {
    return [...names].find((name) => /^config\.ya?ml$/i.test(name)) || 'config.yaml';
}

function yamlTopLevelValue(source: string, key: string) {
    for (const line of text(source).split(/\r?\n/)) {
        const match = line.match(new RegExp(`^${key}\\s*:\\s*(.*)$`));
        if (!match) continue;
        return match[1].trim().replace(/^['"]|['"]$/g, '');
    }
    return '';
}

function yamlHasTopLevelKey(source: string, key: string) {
    return text(source).split(/\r?\n/).some((line) => new RegExp(`^${key}\\s*:`).test(line));
}

function setYamlTopLevelScalar(source: string, key: string, value: string, overwrite = false) {
    const lines = text(source).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    let found = false;
    const next = lines.map((line) => {
        if (!new RegExp(`^${key}\\s*:`).test(line)) return line;
        found = true;
        return overwrite ? `${key}: ${value}` : line;
    });
    if (!found) next.push(`${key}: ${value}`);
    return next.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function hasCaseLikeConfig(source: string) {
    return ['cases', 'subtasks', 'answers'].some((key) => yamlHasTopLevelKey(source, key));
}

function richObjectiveStarterConfig(checkerName = 'checker.cc') {
    return [
        'type: submit_answer',
        'checker_type: testlib',
        `checker: ${checkerName}`,
        'subtasks:',
        '  - type: sum',
        '    cases:',
        '      - input: meta.in',
        '        output: meta.ans',
        '        score: 100',
        '',
    ].join('\n');
}

function mergeRichObjectiveConfig(source: string, checkerName = 'checker.cc', forceSubmitAnswer = true) {
    let next = text(source).trim();
    if (!next) return richObjectiveStarterConfig(checkerName);
    next = setYamlTopLevelScalar(next, 'type', 'submit_answer', forceSubmitAnswer || !yamlTopLevelValue(next, 'type'));
    if (!yamlTopLevelValue(next, 'checker_type')) next = setYamlTopLevelScalar(next, 'checker_type', 'testlib');
    if (!yamlTopLevelValue(next, 'checker')) next = setYamlTopLevelScalar(next, 'checker', checkerName);
    if (!hasCaseLikeConfig(next)) {
        next = `${next.trimEnd()}\n` + [
            'subtasks:',
            '  - type: sum',
            '    cases:',
            '      - input: meta.in',
            '        output: meta.ans',
            '        score: 100',
        ].join('\n');
    }
    return `${next.trimEnd()}\n`;
}

function uniqueCheckerExampleName(names: Set<string>) {
    if (!names.has('checker.rich-objective.example.cc')) return 'checker.rich-objective.example.cc';
    for (let i = 2; i < 1000; i++) {
        const name = `checker.rich-objective.example.${i}.cc`;
        if (!names.has(name)) return name;
    }
    return `checker.rich-objective.example.${Date.now()}.cc`;
}

async function getRawProblem(handler: any) {
    return await (ProblemModel as any).get(
        domainIdOf(handler), handler.pdoc.docId,
        (ProblemModel as any).PROJECTION_PUBLIC, true,
    ) || handler.pdoc;
}

async function readProblemConfigText(domainId: string, pdoc: any) {
    const names = testdataNames(pdoc);
    const configName = configFilenameFrom(names);
    if (names.has(configName)) {
        try {
            const stream = await StorageModel.get(`problem/${domainId}/${pdoc.docId}/testdata/${configName}`);
            return (await streamToBuffer(stream)).toString();
        } catch { /* fall back to pdoc.config */ }
    }
    return typeof pdoc?.config === 'string' ? pdoc.config : '';
}

async function checkerSetupState(handler: any) {
    const rawPdoc = await getRawProblem(handler);
    const domainId = domainIdOf(handler);
    const names = testdataNames(rawPdoc);
    const configName = configFilenameFrom(names);
    const configText = await readProblemConfigText(domainId, rawPdoc);
    const checker = yamlTopLevelValue(configText, 'checker');
    const checkerType = yamlTopLevelValue(configText, 'checker_type');
    const type = yamlTopLevelValue(configText, 'type') || (typeof handler.pdoc?.config === 'object' ? handler.pdoc.config?.type : '');
    const hasCheckerFile = checker ? names.has(checker) : names.has('checker.cc');
    const hasConfigFile = [...names].some((name) => /^config\.ya?ml$/i.test(name));
    const ready = type === 'submit_answer' && !!checker && !!checkerType && hasCheckerFile && hasCaseLikeConfig(configText);
    return {
        ready,
        type,
        checker,
        checkerType,
        configName,
        hasConfigFile,
        hasCheckerCc: names.has('checker.cc'),
        hasCheckerFile,
        hasMetaIn: names.has('meta.in'),
        hasMetaAns: names.has('meta.ans'),
        message: text(handler.request?.query?.checker_setup),
    };
}

async function initCheckerExample(handler: any, requireEdit = true) {
    if (requireEdit) ensureCanEditProblem(handler);
    const domainId = domainIdOf(handler);
    const config = await getConfig(domainId, handler.pdoc.docId);
    const rawPdoc = await getRawProblem(handler);
    const names = testdataNames(rawPdoc);
    const configName = configFilenameFrom(names);
    const configText = await readProblemConfigText(domainId, rawPdoc);
    const existingChecker = yamlTopLevelValue(configText, 'checker');
    const checkerForConfig = existingChecker || 'checker.cc';
    const checkerExists = names.has('checker.cc');
    const checkerExampleName = checkerExists ? uniqueCheckerExampleName(names) : 'checker.cc';
    const checkerSource = checkerTemplateForRequest(handler, config);

    await ProblemModel.addTestdata(
        domainId, rawPdoc.docId, checkerExampleName,
        Buffer.from(checkerSource, 'utf8'), handler.user._id,
    );
    if (!names.has('meta.in')) {
        await ProblemModel.addTestdata(domainId, rawPdoc.docId, 'meta.in', Buffer.from(DEFAULT_META_IN, 'utf8'), handler.user._id);
    }
    if (!names.has('meta.ans')) {
        await ProblemModel.addTestdata(domainId, rawPdoc.docId, 'meta.ans', Buffer.from(DEFAULT_META_ANS, 'utf8'), handler.user._id);
    }
    const nextConfig = mergeRichObjectiveConfig(configText, checkerForConfig, true);
    await ProblemModel.addTestdata(
        domainId, rawPdoc.docId, configName,
        Buffer.from(nextConfig, 'utf8'), handler.user._id,
    );

    return {
        checkerExampleName,
        wroteReference: checkerExists,
        configName,
    };
}

async function ensureCheckerExample(handler: any, requireEdit = true) {
    const state = await checkerSetupState(handler);
    if (state.ready) return null;
    return await initCheckerExample(handler, requireEdit);
}

function routeWithTid(handler: any, name: string, pid: number, query: Record<string, any> = {}) {
    const nextQuery = { ...query };
    if (handler.args?.tid) nextQuery.tid = handler.args.tid;
    return Object.keys(nextQuery).length
        ? handler.url(name, { pid, query: nextQuery })
        : handler.url(name, { pid });
}

function validateHydroSubmitAnswerConfig(pdoc: any) {
    if (typeof pdoc.config === 'string' || pdoc.config === null) throw new ProblemConfigError();
    if (pdoc.config.type !== 'submit_answer') {
        throw new ValidationError('config.type', pdoc.config.type, '富交互客观题需要把 Hydro 题型设置为 submit_answer。');
    }
}

function baseBody(handler: any, config: RichObjectiveDoc | null) {
    const pid = handler.pdoc.docId;
    return {
        pdoc: handler.pdoc,
        tdoc: handler.tdoc,
        psdoc: handler.psdoc,
        config,
        canEdit: canEditProblem(handler),
        originalUrl: routeWithTid(handler, 'problem_detail', pid, { rich_objective: 'off' }),
        editUrl: routeWithTid(handler, 'rich_objective_edit', pid),
        submitUrl: routeWithTid(handler, 'rich_objective_problem', pid),
        toggleUrl: routeWithTid(handler, 'rich_objective_toggle', pid),
        draftKey: `rich-objective:${handler.user?._id || 0}:${domainIdOf(handler)}:${pid}${handler.args?.tid ? `:${handler.args.tid}` : ''}`,
    };
}

class RichObjectiveProblemHandler extends ProblemDetailHandler {
    async get() {
        if (!runtimeEnabled()) throw new ValidationError('richObjective', null, '富交互客观题插件已停用。');
        const config = await getConfig(domainIdOf(this), this.pdoc.docId);
        if (!config?.enabled) {
            if (canEditProblem(this)) {
                this.response.redirect = routeWithTid(this, 'rich_objective_edit', this.pdoc.docId);
                return;
            }
            throw new ValidationError('richObjective', null, '这道题还没有启用富交互客观题。');
        }
        validateHydroSubmitAnswerConfig(this.pdoc);
        const schema = config.mode === 'schema' ? parseSchema(config.schemaText) : null;
        if (config.mode === 'h5' && !config.h5Html.trim()) {
            throw new ValidationError('h5Html', null, 'H5 模式还没有配置页面内容。');
        }
        this.response.template = 'rich_objective_detail.html';
        this.response.body = {
            ...baseBody(this, config),
            page_name: 'rich_objective_problem',
            title: config.title || schema?.title || this.pdoc.title,
            schema,
            mode: config.mode,
            h5Srcdoc: config.h5Html,
        };
    }

    async post() {
        const domainId = domainIdOf(this);
        if (!runtimeEnabled()) throw new ValidationError('richObjective', null, '富交互客观题插件已停用。');
        if (this.tdoc && !(ContestModel as any).isOngoing?.(this.tdoc, this.tsdoc)) {
            throw new ValidationError('contest', null, '比赛或作业当前不能提交。');
        }
        const config = await getConfig(domainId, this.pdoc.docId);
        if (!config?.enabled) throw new ValidationError('richObjective', null, '这道题还没有启用富交互客观题。');
        await ensureCheckerExample(this, false);
        const latestPdoc = await (ProblemModel as any).get(domainId, this.pdoc.docId);
        if (latestPdoc) this.pdoc = latestPdoc;
        validateHydroSubmitAnswerConfig(this.pdoc);
        const schema = config.mode === 'schema' ? parseSchema(config.schemaText) : null;
        const code = buildSubmissionPayload(config, schema, this.request.body || {});
        const rid = await RecordModel.add(
            domainId, this.pdoc.docId, this.user._id, '_', code, true,
            this.args.tid ? { contest: this.args.tid, type: 'judge' } : { type: 'judge' },
        );
        await Promise.all([
            ProblemModel.inc(domainId, this.pdoc.docId, 'nSubmit', 1),
            DomainModel.incUserInDomain(domainId, this.user._id, 'nSubmit'),
            this.args.tid && (ContestModel as any).updateStatus(domainId, this.args.tid, this.user._id, rid, this.pdoc.docId),
        ].filter(Boolean));
        this.response.body = { rid };
        this.response.redirect = this.url('record_detail', { rid });
    }
}

class RichObjectiveEditHandler extends ProblemDetailHandler {
    async get() {
        ensureCanEditProblem(this);
        const config = await getConfig(domainIdOf(this), this.pdoc.docId);
        const form = {
            ...(config || defaultConfig(this)),
            schemaText: schemaTextForEdit(this, config),
        };
        const formTitle = text(form.title).trim() || this.pdoc.title || '富交互客观题';
        const formEnabled = form.enabled !== false;
        const formMode = normalizeMode(form.mode);
        const schemaTextValue = text(form.schemaText);
        let schema: RichObjectiveSchema | null = null;
        let schemaError = '';
        if (formMode === 'schema') {
            try {
                schema = parseSchema(schemaTextValue);
            } catch (e: any) {
                schemaError = !hasRichQuestionHeader(schemaTextValue)
                    ? '已载入原题面 Markdown。请在编辑框中加入 [single:q1]、[multiple:q1]、[blank:q1] 等题型标记后保存。'
                    : e?.message || String(e);
            }
        }
        this.response.template = 'rich_objective_edit.html';
        this.response.body = {
            ...baseBody(this, config),
            page_name: 'rich_objective_edit',
            form,
            formTitle,
            formEnabled,
            formMode,
            schemaTextValue,
            schema,
            schemaError,
            hydroReady: typeof this.pdoc.config === 'object' && this.pdoc.config?.type === 'submit_answer',
            checkerSetup: await checkerSetupState(this),
            defaultSchemaText: DEFAULT_MARKDOWN,
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
        const domainId = domainIdOf(this);
        const pid = this.pdoc.docId;
        const query = { $or: [{ _id: scopedId(domainId, pid) }, { domainId, pid }] };
        await Promise.all([
            coll.deleteMany(query),
            legacyColl.deleteMany(query),
        ]);
        this.response.redirect = this.url('problem_detail', { pid: this.pdoc.docId });
    }

    async postInitChecker() {
        const result = await initCheckerExample(this);
        const message = result.wroteReference
            ? `checker.cc 已存在，已生成参考文件 ${result.checkerExampleName}，并补齐 ${result.configName}。`
            : `已生成 ${result.checkerExampleName}、meta.in、meta.ans，并补齐 ${result.configName}。`;
        this.response.redirect = routeWithTid(this, 'rich_objective_edit', this.pdoc.docId, { checker_setup: message });
    }

    private async saveConfig() {
        ensureCanEditProblem(this);
        const body = this.request.body || {};
        const now = new Date();
        const domainId = domainIdOf(this);
        const previous = await getConfig(domainId, this.pdoc.docId);
        const mode = hasOwn(body, 'mode') ? normalizeMode(body.mode) : previous?.mode || 'schema';
        const schemaText = hasOwn(body, 'schemaText')
            ? lastText(body.schemaText).trim() || previous?.schemaText || DEFAULT_MARKDOWN
            : previous?.schemaText || DEFAULT_MARKDOWN;
        const h5Html = hasOwn(body, 'h5Html') ? lastText(body.h5Html) : previous?.h5Html || '';
        const customCss = hasOwn(body, 'customCss') ? lastText(body.customCss) : previous?.customCss || '';
        const title = hasOwn(body, 'title')
            ? lastText(body.title).trim() || previous?.title || this.pdoc.title || '富交互客观题'
            : previous?.title || this.pdoc.title || '富交互客观题';
        const enabled = hasOwn(body, 'enabled') ? formBoolean(body.enabled, previous?.enabled ?? true) : previous?.enabled ?? true;
        const doc: RichObjectiveDoc = {
            _id: scopedId(domainId, this.pdoc.docId),
            domainId,
            pid: this.pdoc.docId,
            enabled,
            mode,
            title,
            schemaText,
            customCss,
            h5Html,
            createdAt: previous?.createdAt || now,
            updatedAt: now,
            updatedBy: this.user._id,
        };
        await upsertConfig(doc);
        const setup = doc.enabled ? await ensureCheckerExample(this) : null;
        const query = setup
            ? {
                checker_setup: setup.wroteReference
                    ? `checker.cc 已存在，已生成参考文件 ${setup.checkerExampleName}，并补齐 ${setup.configName}。`
                    : `已生成 ${setup.checkerExampleName}、meta.in、meta.ans，并补齐 ${setup.configName}。`,
            }
            : {};
        this.response.redirect = routeWithTid(this, 'rich_objective_edit', this.pdoc.docId, query);
    }
}

class RichObjectiveToggleHandler extends ProblemDetailHandler {
    async post() {
        ensureCanEditProblem(this);
        const hydroType = typeof this.pdoc.config === 'object' ? (this.pdoc.config as any)?.type : '';
        if (hydroType !== 'submit_answer') {
            throw new ValidationError('config.type', hydroType, '只有 submit_answer 题可以启用富交互客观题。');
        }
        const enabled = formBoolean(this.request.body?.enabled);
        const previous = await getConfig(domainIdOf(this), this.pdoc.docId);
        const next = previous || defaultConfig(this);
        next.enabled = enabled;
        next.updatedAt = new Date();
        next.updatedBy = this.user._id;
        await upsertConfig(next);
        this.response.redirect = enabled
            ? routeWithTid(this, 'rich_objective_problem', this.pdoc.docId)
            : routeWithTid(this, 'problem_detail', this.pdoc.docId, { rich_objective: 'off' });
    }
}

function setProblemUi(handler: any, config: RichObjectiveDoc | null) {
    const pdoc = handler.response?.body?.pdoc || handler.pdoc;
    if (!pdoc?.docId) return;
    const hydroType = typeof pdoc.config === 'object' ? pdoc.config?.type || '' : '';
    handler.UiContext ||= {};
    handler.UiContext.richObjectiveKit = {
        configured: !!config,
        enabled: !!config?.enabled,
        hydroType,
        mode: config?.mode || '',
        canEdit: canEditProblem(handler),
        title: config?.title || '富交互客观题',
        url: routeWithTid(handler, 'rich_objective_problem', pdoc.docId),
        editUrl: routeWithTid(handler, 'rich_objective_edit', pdoc.docId),
        toggleUrl: routeWithTid(handler, 'rich_objective_toggle', pdoc.docId),
    };
}

function shouldBypassRichRedirect(handler: any) {
    const query = handler.request?.query || {};
    return query.rich_objective === 'off' || query.richObjective === 'off'
        || query.plain === '1' || query.pjax || handler.request?.json;
}

function redirectToRichObjective(handler: any, pdoc: any, config: RichObjectiveDoc | null) {
    if (!config?.enabled || shouldBypassRichRedirect(handler)) return false;
    const hydroType = typeof pdoc.config === 'object' ? pdoc.config?.type || '' : '';
    if (hydroType !== 'submit_answer') return false;
    handler.response.redirect = routeWithTid(handler, 'rich_objective_problem', pdoc.docId);
    return true;
}

export async function apply(ctx: Context) {
    ctx.Route('rich_objective_problem', '/p/:pid/rich-objective', RichObjectiveProblemHandler, PERM.PERM_SUBMIT_PROBLEM);
    ctx.Route('rich_objective_edit', '/p/:pid/rich-objective/edit', RichObjectiveEditHandler, PERM.PERM_VIEW_PROBLEM);
    ctx.Route('rich_objective_toggle', '/p/:pid/rich-objective/toggle', RichObjectiveToggleHandler, PERM.PERM_VIEW_PROBLEM);

    ctx.on('handler/after/ProblemDetail#get', async (handler: any) => {
        if (!runtimeEnabled()) return;
        const pdoc = handler.response?.body?.pdoc || handler.pdoc;
        if (!pdoc?.docId) return;
        const config = await getConfig(domainIdOf(handler), pdoc.docId);
        if (redirectToRichObjective(handler, pdoc, config)) return;
        setProblemUi(handler, config);
    });

    await db.ensureIndexes(
        coll,
        { key: { domainId: 1, pid: 1 }, name: 'rich_objective_problem', unique: true },
        { key: { domainId: 1, enabled: 1 }, name: 'rich_objective_enabled' },
    );

    ctx.i18n.load('zh', {
        rich_objective_problem: '富交互客观题',
        rich_objective_edit: '配置富交互客观题',
    });
    ctx.i18n.load('en', {
        rich_objective_problem: 'Rich Objective',
        rich_objective_edit: 'Edit Rich Objective',
    });
}
