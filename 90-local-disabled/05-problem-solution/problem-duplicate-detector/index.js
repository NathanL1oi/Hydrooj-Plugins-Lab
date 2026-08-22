const {
    db, DocumentModel, Handler, PERM, ValidationError,
} = require('hydrooj');

const collIgnore = db.collection('problem.duplicateDetector.ignore');
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1500;
const DEFAULT_THRESHOLD = 82;

function asText(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
}

function collectStrings(value, depth = 0, out = []) {
    if (depth > 6 || out.join('\n').length > 120000) return out;
    if (typeof value === 'string') {
        if (value.trim()) out.push(value);
    } else if (Array.isArray(value)) {
        for (const item of value) collectStrings(item, depth + 1, out);
    } else if (value && typeof value === 'object') {
        for (const item of Object.values(value)) collectStrings(item, depth + 1, out);
    }
    return out;
}

function normalizeText(value) {
    return asText(value)
        .normalize('NFKC')
        .toLowerCase()
        .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
        .replace(/<[^>]+>/g, ' ')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`]*`/g, ' ')
        .replace(/https?:\/\/[^\s)\]'"<>]+/g, ' ')
        .replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^_`{|}~，。！？；：、“”‘’（）【】《》￥·…—-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function compactText(value) {
    return normalizeText(value).replace(/\s+/g, '');
}

function shingles(value, size = 3) {
    const text = compactText(value);
    const result = new Set();
    if (!text) return result;
    if (text.length <= size) {
        result.add(text);
        return result;
    }
    for (let i = 0; i <= text.length - size; i++) result.add(text.slice(i, i + size));
    return result;
}

function jaccard(a, b) {
    if (!a.size && !b.size) return 0;
    let same = 0;
    const small = a.size < b.size ? a : b;
    const large = a.size < b.size ? b : a;
    for (const item of small) {
        if (large.has(item)) same++;
    }
    return same / (a.size + b.size - same);
}

function hashText(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function extractUrls(value) {
    const set = new Set();
    const text = collectStrings(value).join('\n');
    for (const match of text.matchAll(/https?:\/\/[^\s)\]'"<>]+/g)) {
        set.add(match[0].replace(/[.,;，。；]+$/g, ''));
    }
    return set;
}

function extractCodeBlocks(value) {
    const blocks = [];
    const text = collectStrings(value).join('\n');
    for (const match of text.matchAll(/```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/g)) {
        const body = match[1].trim();
        if (body) blocks.push(body);
    }
    return blocks;
}

function tagsOf(pdoc) {
    const tags = [];
    const push = (value) => {
        const item = asText(value).trim();
        if (item && !tags.includes(item)) tags.push(item);
    };
    for (const field of [pdoc.tag, pdoc.tags, pdoc.config?.tag, pdoc.config?.tags]) {
        if (Array.isArray(field)) field.forEach(push);
        else if (field && typeof field === 'object') Object.values(field).forEach(push);
        else push(field);
    }
    return tags;
}

function referenceKeys(pdoc) {
    const keys = new Set();
    if (pdoc.reference?.domainId && pdoc.reference?.pid !== undefined) {
        keys.add(`${pdoc.reference.domainId}:${pdoc.reference.pid}`);
    }
    for (const url of extractUrls([pdoc.content, pdoc.config, pdoc.source, pdoc.reference])) keys.add(url);
    return keys;
}

function sampleTextOf(pdoc) {
    const blocks = [
        ...extractCodeBlocks(pdoc.content),
        ...collectStrings(pdoc.config?.samples),
        ...collectStrings(pdoc.config?.sample),
        ...collectStrings(pdoc.config?.examples),
    ];
    return blocks.join('\n---\n');
}

function problemTextOf(pdoc) {
    return collectStrings([
        pdoc.content,
        pdoc.description,
        pdoc.input,
        pdoc.output,
        pdoc.hint,
    ]).join('\n');
}

function prepareProblem(pdoc) {
    const title = asText(pdoc.title).trim();
    const body = problemTextOf(pdoc);
    const sample = sampleTextOf(pdoc);
    const tags = tagsOf(pdoc);
    const refs = referenceKeys(pdoc);
    const urlPid = pdoc.pid || pdoc.docId;
    return {
        docId: pdoc.docId,
        pid: pdoc.pid || `P${pdoc.docId}`,
        urlPid,
        title,
        titleNorm: normalizeText(title),
        titleSet: shingles(title, 2),
        bodyNorm: normalizeText(body),
        bodySet: shingles(body, 4),
        sampleNorm: normalizeText(sample),
        sampleSet: shingles(sample, 3),
        sampleHash: compactText(sample) ? hashText(compactText(sample)) : '',
        tagSet: new Set(tags.map((tag) => normalizeText(tag)).filter(Boolean)),
        refs,
    };
}

function pairKey(a, b) {
    const x = Math.min(Number(a), Number(b));
    const y = Math.max(Number(a), Number(b));
    return `${x}:${y}`;
}

function viewProblem(problem) {
    return {
        docId: problem.docId,
        pid: problem.pid,
        urlPid: problem.urlPid,
        title: problem.title,
    };
}

function sharedCount(a, b) {
    let count = 0;
    for (const item of a) {
        if (b.has(item)) count++;
    }
    return count;
}

function compareProblems(a, b) {
    const sameSource = !!sharedCount(a.refs, b.refs);
    const sameSample = !!a.sampleHash && a.sampleHash === b.sampleHash;
    const titleScore = jaccard(a.titleSet, b.titleSet);
    const bodyScore = jaccard(a.bodySet, b.bodySet);
    const sampleScore = sameSample ? 1 : jaccard(a.sampleSet, b.sampleSet);
    const tagScore = jaccard(a.tagSet, b.tagSet);
    let score = titleScore * 0.2 + bodyScore * 0.45 + sampleScore * 0.25 + tagScore * 0.1;
    if (sameSource) score = Math.max(score, 0.98);
    if (sameSample) score = Math.max(score, 0.9);
    if (a.titleNorm && a.titleNorm === b.titleNorm) score = Math.max(score, 0.88);

    const evidence = [];
    if (sameSource) evidence.push('来源/原题引用相同');
    if (sameSample) evidence.push('样例代码块完全相同');
    if (a.titleNorm && a.titleNorm === b.titleNorm) evidence.push('标题完全相同');
    else if (titleScore >= 0.6) evidence.push(`标题相似 ${Math.round(titleScore * 100)}%`);
    if (bodyScore >= 0.35) evidence.push(`题面相似 ${Math.round(bodyScore * 100)}%`);
    if (!sameSample && sampleScore >= 0.45) evidence.push(`样例相似 ${Math.round(sampleScore * 100)}%`);
    if (tagScore >= 0.5) evidence.push(`标签相似 ${Math.round(tagScore * 100)}%`);

    return {
        score,
        scoreText: `${Math.round(score * 100)}%`,
        level: score >= 0.95 ? '几乎确定重复' : score >= 0.85 ? '高度疑似重复' : '可能相似',
        titleScore: Math.round(titleScore * 100),
        bodyScore: Math.round(bodyScore * 100),
        sampleScore: Math.round(sampleScore * 100),
        tagScore: Math.round(tagScore * 100),
        evidence,
    };
}

function shouldCompare(a, b) {
    if (sharedCount(a.refs, b.refs)) return true;
    if (a.sampleHash && a.sampleHash === b.sampleHash) return true;
    if (a.titleNorm && a.titleNorm === b.titleNorm) return true;
    if (jaccard(a.titleSet, b.titleSet) >= 0.28) return true;
    if (jaccard(a.bodySet, b.bodySet) >= 0.18) return true;
    return false;
}

async function loadProblems(domainId, limit) {
    return await DocumentModel
        .getMulti(domainId, DocumentModel.TYPE_PROBLEM, {})
        .sort({ docId: -1 })
        .limit(limit)
        .toArray();
}

async function scanDomain(domainId, options) {
    const limit = Math.min(Math.max(Number(options.limit) || DEFAULT_LIMIT, 20), MAX_LIMIT);
    const threshold = Math.min(Math.max(Number(options.threshold) || DEFAULT_THRESHOLD, 50), 99) / 100;
    const includeIgnored = !!options.includeIgnored;
    const rawProblems = await loadProblems(domainId, limit);
    const problems = rawProblems
        .map(prepareProblem)
        .filter((problem) => problem.docId);
    const ignores = await collIgnore.find({ domainId }).toArray();
    const ignoredMap = new Map(ignores.map((doc) => [doc.pairKey, doc]));
    const results = [];
    let checkedPairs = 0;
    let ignoredPairs = 0;

    for (let i = 0; i < problems.length; i++) {
        for (let j = i + 1; j < problems.length; j++) {
            const a = problems[i];
            const b = problems[j];
            if (!shouldCompare(a, b)) continue;
            checkedPairs++;
            const key = pairKey(a.docId, b.docId);
            const ignored = ignoredMap.get(key);
            if (ignored && !includeIgnored) {
                ignoredPairs++;
                continue;
            }
            const similarity = compareProblems(a, b);
            if (similarity.score < threshold) continue;
            results.push({
                pairKey: key,
                a: viewProblem(a),
                b: viewProblem(b),
                ignored,
                ...similarity,
            });
        }
    }
    results.sort((x, y) => y.score - x.score || x.a.docId - y.a.docId);
    return {
        limit,
        threshold: Math.round(threshold * 100),
        includeIgnored,
        results: results.slice(0, 200),
        stats: {
            scanned: problems.length,
            checkedPairs,
            ignoredPairs,
            shown: Math.min(results.length, 200),
            totalMatched: results.length,
        },
        ignores: ignores.slice(0, 50),
    };
}

class ProblemDuplicateDetectorHandler extends Handler {
    async prepare() {
        this.checkPerm(PERM.PERM_EDIT_DOMAIN);
    }

    async render(extra = {}) {
        const limit = Number(extra.limit || this.args.limit || DEFAULT_LIMIT);
        const threshold = Number(extra.threshold || this.args.threshold || DEFAULT_THRESHOLD);
        this.response.template = 'problem_duplicate_detector.html';
        this.response.body = {
            page_name: 'problem_duplicate_detector',
            limit,
            threshold,
            includeIgnored: !!extra.includeIgnored,
            results: extra.results || [],
            stats: extra.stats || null,
            ignores: extra.ignores || await collIgnore.find({ domainId: this.domain._id }).sort({ createdAt: -1 }).limit(50).toArray(),
            messages: extra.messages || [],
            scanned: !!extra.scanned,
        };
    }

    async get() {
        await this.render();
    }

    async postScan() {
        const limit = Math.min(Math.max(Number(this.args.limit) || DEFAULT_LIMIT, 20), MAX_LIMIT);
        const threshold = Math.min(Math.max(Number(this.args.threshold) || DEFAULT_THRESHOLD, 50), 99);
        const includeIgnored = this.args.includeIgnored === 'on' || this.args.includeIgnored === 'true';
        const state = await scanDomain(this.domain._id, { limit, threshold, includeIgnored });
        await this.render({
            ...state,
            scanned: true,
            messages: [`扫描完成：读取 ${state.stats.scanned} 道题，命中 ${state.stats.totalMatched} 组疑似重复。`],
        });
    }

    async postIgnore() {
        const pair = asText(this.args.pairKey).trim();
        if (!/^\d+:\d+$/.test(pair)) throw new ValidationError('pairKey', null, '无效的题目对。');
        const [a, b] = pair.split(':').map((item) => Number(item));
        await collIgnore.updateOne(
            { domainId: this.domain._id, pairKey: pair },
            {
                $set: {
                    domainId: this.domain._id,
                    pairKey: pair,
                    docIds: [a, b],
                    reason: asText(this.args.reason).trim().slice(0, 160),
                    updatedAt: new Date(),
                    updatedBy: this.user._id,
                },
                $setOnInsert: {
                    createdAt: new Date(),
                    createdBy: this.user._id,
                },
            },
            { upsert: true },
        );
        await this.render({ messages: [`已忽略题目对 ${pair}。`] });
    }

    async postUnignore() {
        const pair = asText(this.args.pairKey).trim();
        if (!/^\d+:\d+$/.test(pair)) throw new ValidationError('pairKey', null, '无效的题目对。');
        await collIgnore.deleteOne({ domainId: this.domain._id, pairKey: pair });
        await this.render({ messages: [`已恢复题目对 ${pair} 的提示。`] });
    }
}

async function apply(ctx) {
    await db.ensureIndexes(
        collIgnore,
        { key: { domainId: 1, pairKey: 1 }, name: 'problem_duplicate_ignore_pair', unique: true },
        { key: { domainId: 1, createdAt: -1 }, name: 'problem_duplicate_ignore_time' },
    );
    ctx.Route('problem_duplicate_detector', '/domain/problem-duplicates', ProblemDuplicateDetectorHandler, PERM.PERM_EDIT_DOMAIN);
    ctx.injectUI('DomainManage', 'problem_duplicate_detector', { family: 'Problem', icon: 'search' }, PERM.PERM_EDIT_DOMAIN);
    ctx.i18n.load('zh', {
        problem_duplicate_detector: '重复题检测',
    });
    ctx.i18n.load('en', {
        problem_duplicate_detector: 'Duplicate Problems',
    });
}

module.exports = { apply };
