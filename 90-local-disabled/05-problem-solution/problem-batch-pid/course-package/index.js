"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CoursePackageModel = exports.TYPE_COURSE_PACKAGE_VERSION = exports.TYPE_COURSE_PACKAGE = void 0;
exports.apply = apply;
const hydrooj_1 = require("hydrooj");
const fs_1 = require("fs");
const stream_1 = require("stream");
exports.TYPE_COURSE_PACKAGE = 10880;
exports.TYPE_COURSE_PACKAGE_VERSION = 10881;
function uid() {
    return new hydrooj_1.ObjectId().toHexString();
}
function asText(value, fallback = '') {
    if (typeof value === 'string')
        return value;
    if (value === undefined || value === null)
        return fallback;
    return String(value);
}
function asArray(value) {
    if (!value)
        return [];
    return Array.isArray(value) ? value : [value];
}
function normalizeIds(value) {
    if (typeof value === 'string') {
        value = value.split(/[,，\s]+/).filter(Boolean);
    }
    return Array.from(new Set(asArray(value)
        .map((item) => Number(asText(item).trim().replace(/^P/i, '')))
        .filter((item) => Number.isInteger(item) && item > 0)));
}
function normalizeTags(value) {
    if (typeof value === 'string') {
        value = value.split(/[,，\s]+/).filter(Boolean);
    }
    return Array.from(new Set(asArray(value).map((item) => asText(item).trim()).filter(Boolean)));
}
function normalizeLesson(lesson, chapterIndex, lessonIndex) {
    const title = asText(lesson?.title).trim();
    if (!title)
        throw new hydrooj_1.ValidationError('treeText', null, `第 ${chapterIndex + 1} 章第 ${lessonIndex + 1} 节缺少 title。`);
    return {
        id: asText(lesson?.id, uid()),
        title,
        content: asText(lesson?.content),
        pids: normalizeIds(lesson?.pids ?? lesson?.pid),
        tags: normalizeTags(lesson?.tags),
    };
}
function normalizeChapter(chapter, chapterIndex) {
    const title = asText(chapter?.title).trim();
    if (!title)
        throw new hydrooj_1.ValidationError('treeText', null, `第 ${chapterIndex + 1} 章缺少 title。`);
    const lessons = asArray(chapter?.lessons).map((lesson, lessonIndex) => normalizeLesson(lesson, chapterIndex, lessonIndex));
    return {
        id: asText(chapter?.id, uid()),
        title,
        content: asText(chapter?.content),
        lessons,
    };
}
function flattenLegacyStages(stages) {
    const chapters = [];
    stages.forEach((stage, stageIndex) => {
        const title = asText(stage?.title).trim();
        if (!title)
            throw new hydrooj_1.ValidationError('treeText', null, `第 ${stageIndex + 1} 章缺少 title。`);
        const legacyChapters = asArray(stage?.chapters);
        if (legacyChapters.length) {
            legacyChapters.forEach((legacyChapter, chapterIndex) => {
                chapters.push(normalizeChapter({
                    id: legacyChapter?.id,
                    title: asText(legacyChapter?.title, title),
                    content: asText(legacyChapter?.content, asText(stage?.content)),
                    lessons: legacyChapter?.lessons || [],
                }, chapters.length + chapterIndex));
            });
            return;
        }
        const lessons = [];
        for (const lesson of asArray(stage?.lessons)) {
            lessons.push(normalizeLesson(lesson, stageIndex, lessons.length));
        }
        chapters.push({
            id: asText(stage?.id, uid()),
            title,
            content: asText(stage?.content),
            lessons,
        });
    });
    return chapters;
}
function parseTree(treeText) {
    let raw;
    try {
        raw = hydrooj_1.yaml.load(treeText || 'chapters: []');
    }
    catch (e) {
        throw new hydrooj_1.ValidationError('treeText', null, `课程包结构解析失败：${e.message}`);
    }
    const chapters = Array.isArray(raw) ? raw : raw?.chapters;
    if (Array.isArray(chapters))
        return chapters.map((chapter, chapterIndex) => normalizeChapter(chapter, chapterIndex));
    if (Array.isArray(raw?.stages))
        return flattenLegacyStages(raw.stages);
    throw new hydrooj_1.ValidationError('treeText', null, '课程包结构必须包含 chapters 数组。');
}
function sampleTree() {
    return [
        'chapters:',
        '  - title: 输入输出与表达式',
        '    content: 章说明，可写 Markdown。',
        '    lessons:',
        '      - title: A+B Problem',
        '        content: 节说明，可写 Markdown。',
        '        pids: [1000]',
        '      - title: 多组输入',
        '        pids: [1001, 1002]',
        '',
    ].join('\n');
}
function safeFilename(text) {
    return (text || 'course-package').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/-+/g, '-').slice(0, 80);
}
function serializeTree(chapters) {
    return JSON.stringify({ chapters }, null, 2);
}
function getVersionChapters(ver) {
    if (!ver)
        return [];
    if (Array.isArray(ver.chapters))
        return ver.chapters;
    if (Array.isArray(ver.stages))
        return flattenLegacyStages(ver.stages);
    if (ver.treeText)
        return parseTree(ver.treeText);
    return [];
}
function buildExport(pkg, ver) {
    const chapters = getVersionChapters(ver);
    return {
        format: 'hydrooj-course-package',
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        package: {
            title: pkg.title,
            content: pkg.content || '',
            pin: pkg.pin || 0,
            tags: pkg.tags || [],
        },
        version: {
            title: ver.title,
            version: ver.version,
            content: ver.content || '',
            treeText: serializeTree(chapters),
            chapters,
        },
    };
}
function getCourseModel() {
    return global.Hydro.model.course;
}
function summarizeChapters(chapters = []) {
    const pids = new Set();
    let lessonCount = 0;
    for (const chapter of chapters) {
        lessonCount += chapter.lessons.length;
        for (const lesson of chapter.lessons) {
            for (const pid of lesson.pids || [])
                pids.add(pid);
        }
    }
    return {
        chapterCount: chapters.length,
        lessonCount,
        problemCount: pids.size,
    };
}
function getSelectedLessons(chapters, mode, nodeId = '') {
    if (mode === 'package')
        return chapters.flatMap((chapter) => chapter.lessons);
    if (mode === 'chapter') {
        const chapter = findChapter(chapters, nodeId);
        if (!chapter)
            throw new hydrooj_1.NotFoundError('章不存在。');
        return chapter.lessons;
    }
    const found = findLesson(chapters, nodeId);
    if (!found)
        throw new hydrooj_1.NotFoundError('节不存在。');
    return [found.lesson];
}
function collectProblemIds(chapters, mode = 'package', nodeId = '') {
    return Array.from(new Set(getSelectedLessons(chapters, mode, nodeId)
        .flatMap((lesson) => lesson.pids || [])
        .filter((pid) => Number.isInteger(pid) && pid > 0)));
}
function remapChapters(chapters, pidMap) {
    return chapters.map((chapter) => ({
        ...chapter,
        lessons: chapter.lessons.map((lesson) => ({
            ...lesson,
            pids: (lesson.pids || []).map((pid) => pidMap.get(pid) || pid),
        })),
    }));
}
function parseImportPayload(text) {
    let payload;
    try {
        payload = JSON.parse(text);
    }
    catch (e) {
        throw new hydrooj_1.ValidationError('payload', null, `JSON 解析失败：${e.message}`);
    }
    if (payload?.format !== 'hydrooj-course-package') {
        throw new hydrooj_1.ValidationError('payload', null, '不是有效的课程包导出文件。');
    }
    const treeText = payload.version?.treeText || JSON.stringify(payload.version?.chapters
        ? { chapters: payload.version.chapters }
        : { stages: payload.version?.stages || [] }, null, 2);
    const chapters = parseTree(treeText);
    return {
        format: 'hydrooj-course-package',
        formatVersion: 1,
        exportedAt: payload.exportedAt || new Date().toISOString(),
        package: {
            title: asText(payload.package?.title).trim(),
            content: asText(payload.package?.content),
            pin: Number(payload.package?.pin) || 0,
            tags: normalizeTags(payload.package?.tags),
        },
        version: {
            title: asText(payload.version?.title, '默认版本').trim(),
            version: asText(payload.version?.version, 'v1').trim(),
            content: asText(payload.version?.content),
            treeText: serializeTree(chapters),
            chapters,
        },
        problems: payload.problems,
    };
}
function findChapter(chapters, id) {
    return chapters.find((chapter) => chapter.id === id);
}
function findLesson(chapters, id) {
    for (const chapter of chapters) {
        const lesson = chapter.lessons.find((item) => item.id === id);
        if (lesson)
            return { chapter, lesson };
    }
    return null;
}
function findLessonInChapter(chapter, lessonId) {
    return chapter.lessons.find((lesson) => lesson.id === lessonId);
}
async function ensureProblemIds(domainId, pids) {
    if (!pids.length)
        throw new hydrooj_1.ValidationError('pids', null, 'Please specify at least one problem');
    await Promise.all(pids.map(async (pid) => {
        const pdoc = await hydrooj_1.ProblemModel.get(domainId, pid);
        if (!pdoc)
            throw new hydrooj_1.ProblemNotFoundError(domainId, pid);
    }));
}
async function getProblemRaw(domainId, pid) {
    const pdoc = await hydrooj_1.ProblemModel.get(domainId, pid, hydrooj_1.ProblemModel.PROJECTION_PUBLIC, true);
    if (!pdoc)
        throw new hydrooj_1.ProblemNotFoundError(domainId, pid);
    if (pdoc.reference)
        return getProblemRaw(pdoc.reference.domainId, pdoc.reference.pid);
    return pdoc;
}
async function ensureProblemCreatePerm(domainId, uid) {
    const udoc = await hydrooj_1.UserModel.getById(domainId, uid);
    if (!udoc?.hasPerm?.(hydrooj_1.PERM.PERM_CREATE_PROBLEM)) {
        throw new hydrooj_1.ValidationError('targetDomainId', null, '目标子域缺少 Hydro 复制题时，需要拥有创建题目的权限。');
    }
}
async function resolveProblemCopySource(domainId, pid) {
    let pdoc = await hydrooj_1.ProblemModel.get(domainId, pid, hydrooj_1.ProblemModel.PROJECTION_PUBLIC, true);
    if (!pdoc)
        throw new hydrooj_1.ProblemNotFoundError(domainId, pid);
    if (pdoc.reference) {
        const sourcePdoc = await hydrooj_1.ProblemModel.get(pdoc.reference.domainId, pdoc.reference.pid, hydrooj_1.ProblemModel.PROJECTION_PUBLIC, true);
        if (!sourcePdoc)
            throw new hydrooj_1.ProblemNotFoundError(pdoc.reference.domainId, pdoc.reference.pid);
        pdoc = sourcePdoc;
    }
    return pdoc;
}
async function assertProblemCopyAllowed(sourceDomainId, targetDomainId) {
    const sourceDomain = await hydrooj_1.DomainModel.get(sourceDomainId);
    if (!sourceDomain)
        throw new hydrooj_1.NotFoundError(sourceDomainId);
    const share = `,${sourceDomain.share || ''},`;
    if (share !== ',*,' && !share.includes(`,${targetDomainId},`)) {
        throw new hydrooj_1.ProblemNotAllowCopyError(sourceDomain._id, targetDomainId);
    }
}
async function findProblemReference(targetDomainId, sourceDomainId, sourcePid) {
    const [pdoc] = await hydrooj_1.ProblemModel.getMulti(targetDomainId, {
        'reference.domainId': sourceDomainId,
        'reference.pid': sourcePid,
    }, hydrooj_1.ProblemModel.PROJECTION_PUBLIC).limit(1).toArray();
    return pdoc || null;
}
async function copyProblemSolutions(sourceDomainId, sourcePid, targetDomainId, targetPid, operator) {
    const exists = await hydrooj_1.SolutionModel.getMulti(targetDomainId, targetPid).limit(1).toArray();
    if (exists.length)
        return;
    const solutions = await hydrooj_1.SolutionModel.getMulti(sourceDomainId, sourcePid).toArray();
    for (const psdoc of solutions) {
        const psid = await hydrooj_1.SolutionModel.add(targetDomainId, targetPid, psdoc.owner || operator, psdoc.content || '');
        for (const reply of psdoc.reply || []) {
            await hydrooj_1.SolutionModel.reply(targetDomainId, psid, reply.owner || operator, reply.content || '');
        }
    }
}
async function syncProblemToDomain(sourceDomainId, sourcePid, targetDomainId, operator) {
    if (sourceDomainId === targetDomainId)
        return sourcePid;
    const source = await resolveProblemCopySource(sourceDomainId, sourcePid);
    const existingRef = await findProblemReference(targetDomainId, source.domainId, source.docId);
    if (existingRef)
        return existingRef.docId;
    await assertProblemCopyAllowed(source.domainId, targetDomainId);
    await ensureProblemCreatePerm(targetDomainId, operator);
    const targetPid = await hydrooj_1.ProblemModel.copy(source.domainId, source.docId, targetDomainId, undefined, source.hidden);
    await copyProblemSolutions(source.domainId, source.docId, targetDomainId, targetPid, operator);
    return targetPid;
}
async function syncSelectedProblems(sourceDomainId, targetDomainId, chapters, mode, nodeId, operator) {
    const pidMap = new Map();
    for (const pid of collectProblemIds(chapters, mode, nodeId)) {
        pidMap.set(pid, await syncProblemToDomain(sourceDomainId, pid, targetDomainId, operator));
    }
    return pidMap;
}
async function addProblemToZip(zip, domainId, pid) {
    const pdoc = await getProblemRaw(domainId, pid);
    const folder = `problem-${pid}`;
    await zip.add(`${folder}/problem.yaml`, new hydrooj_1.Zip.TextReader(hydrooj_1.yaml.dump({
        pid: pdoc.pid || `P${pdoc.docId}`,
        owner: pdoc.owner,
        title: pdoc.title,
        tag: pdoc.tag,
        nSubmit: pdoc.nSubmit,
        nAccept: pdoc.nAccept,
        difficulty: pdoc.difficulty,
    })));
    try {
        const content = JSON.parse(pdoc.content);
        for (const key of Object.keys(content)) {
            await zip.add(`${folder}/problem_${key}.md`, new hydrooj_1.Zip.TextReader(typeof content[key] === 'string' ? content[key] : JSON.stringify(content[key])));
        }
    }
    catch (e) {
        await zip.add(`${folder}/problem.md`, new hydrooj_1.Zip.TextReader(pdoc.content || ''));
    }
    for (const file of pdoc.data || []) {
        const stream = await hydrooj_1.StorageModel.get(`problem/${pdoc.domainId}/${pdoc.docId}/testdata/${file.name}`);
        await zip.add(`${folder}/testdata/${file.name}`, stream_1.Readable.toWeb(stream));
    }
    for (const file of pdoc.additional_file || []) {
        const stream = await hydrooj_1.StorageModel.get(`problem/${pdoc.domainId}/${pdoc.docId}/additional_file/${file.name}`);
        await zip.add(`${folder}/additional_file/${file.name}`, stream_1.Readable.toWeb(stream));
    }
    const solutions = await hydrooj_1.SolutionModel.getMulti(pdoc.domainId, pdoc.docId).toArray();
    for (let i = 0; i < solutions.length; i++) {
        await zip.add(`${folder}/solution/solution-${i + 1}.md`, new hydrooj_1.Zip.TextReader(solutions[i].content || ''));
    }
    return {
        sourcePid: pid,
        folder,
        title: pdoc.title,
        pid: pdoc.pid || `P${pdoc.docId}`,
    };
}
async function buildCoursePackageZip(domainId, pkg, ver) {
    const zip = new hydrooj_1.Zip.ZipWriter(new hydrooj_1.Zip.BlobWriter('application/zip'), { bufferedWrite: true });
    const payload = buildExport(pkg, ver);
    const problemItems = [];
    for (const pid of collectProblemIds(getVersionChapters(ver))) {
        problemItems.push(await addProblemToZip(zip, domainId, pid));
    }
    payload.problems = { sourceDomainId: domainId, items: problemItems };
    await zip.add('course-package.json', new hydrooj_1.Zip.TextReader(JSON.stringify(payload, null, 2)));
    await zip.add('README.txt', new hydrooj_1.Zip.TextReader([
        `${pkg.title} / ${ver.version}`,
        '',
        'This archive contains course-package.json and Hydro problem folders.',
        'Import problem-* folders through Hydro problem import if you only need the problems.',
        '',
    ].join('\n')));
    return zip.close();
}
async function readCoursePackageZip(filepath) {
    const reader = new hydrooj_1.Zip.ZipReader(stream_1.Readable.toWeb((0, fs_1.createReadStream)(filepath)));
    try {
        const entries = await reader.getEntries();
        const manifest = entries.find((entry) => entry.filename === 'course-package.json');
        if (!manifest)
            throw new hydrooj_1.ValidationError('file', null, '课程包 ZIP 缺少 course-package.json。');
        const text = await manifest.getData(new hydrooj_1.Zip.TextWriter());
        return parseImportPayload(text);
    }
    finally {
        await reader.close();
    }
}
async function importZipProblemsAndBuildMap(domainId, filepath, payload, operator) {
    await hydrooj_1.ProblemModel.import(domainId, filepath, { operator, override: true });
    const pidMap = new Map();
    for (const item of payload.problems?.items || []) {
        if (!item.pid)
            continue;
        const pdoc = await hydrooj_1.ProblemModel.get(domainId, item.pid);
        if (pdoc)
            pidMap.set(item.sourcePid, pdoc.docId);
    }
    const missing = (payload.problems?.items || []).filter((item) => !pidMap.has(item.sourcePid));
    if (missing.length) {
        throw new hydrooj_1.ValidationError('file', null, `部分题目导入失败：${missing.map((item) => `P${item.sourcePid}`).join(', ')}`);
    }
    return pidMap;
}
function sameId(a, b) {
    return a?.toString?.() === b?.toString?.();
}
async function getWritableDomains(uid, fallbackDomainId) {
    const domains = await hydrooj_1.DomainModel.getMulti({}).sort({ _id: 1 }).toArray();
    const writable = [];
    await Promise.all(domains.map(async (ddoc) => {
        const udoc = await hydrooj_1.UserModel.getById(ddoc._id, uid);
        if (udoc?.hasPerm?.(hydrooj_1.PERM.PERM_EDIT_TRAINING))
            writable.push(ddoc);
    }));
    writable.sort((a, b) => String(a._id).localeCompare(String(b._id)));
    if (!writable.some((ddoc) => ddoc._id === fallbackDomainId)) {
        const ddoc = await hydrooj_1.DomainModel.get(fallbackDomainId);
        if (ddoc)
            writable.unshift(ddoc);
    }
    return writable;
}
async function assertWritableDomain(domainId, uid) {
    const ddoc = await hydrooj_1.DomainModel.get(domainId);
    if (!ddoc)
        throw new hydrooj_1.NotFoundError(`目标子域不存在：${domainId}`);
    const udoc = await hydrooj_1.UserModel.getById(ddoc._id, uid);
    if (!udoc?.hasPerm?.(hydrooj_1.PERM.PERM_EDIT_TRAINING)) {
        throw new hydrooj_1.ValidationError('targetDomainId', null, '你在目标子域没有编辑课程的权限。');
    }
    return ddoc._id;
}
async function ensureCourseSection(domainId, courseId, sectionId) {
    if (!sectionId)
        throw new hydrooj_1.ValidationError('targetSectionId', null, '请选择目标课程章。');
    const course = getCourseModel();
    const section = await course.getSection(domainId, sectionId);
    if (!section || !sameId(section.parentId, courseId)) {
        throw new hydrooj_1.NotFoundError('目标章不存在，或不属于所选课程。');
    }
    return section;
}
async function addLessonToCourseSection(domainId, sectionId, owner, lesson) {
    const course = getCourseModel();
    const [, subSectionId] = await course.addSubSection(domainId, sectionId, owner, lesson.title, lesson.content || '', lesson.pids || [], 0);
    return subSectionId;
}
async function copyChapterAsCourseSection(domainId, courseId, owner, title, content, chapter) {
    const course = getCourseModel();
    const sectionId = await course.addSection(domainId, courseId, owner, title, content || '', 0);
    let subSectionId;
    for (const lesson of chapter.lessons) {
        subSectionId = await addLessonToCourseSection(domainId, sectionId, owner, lesson);
    }
    return { count: 1, sectionId, subSectionId };
}
async function copyChapterIntoCourseSection(domainId, courseId, owner, sectionId, chapter) {
    await ensureCourseSection(domainId, courseId, sectionId);
    let subSectionId;
    for (const lesson of chapter.lessons) {
        subSectionId = await addLessonToCourseSection(domainId, sectionId, owner, lesson);
    }
    return { count: chapter.lessons.length, sectionId, subSectionId };
}
function getSelectionMeta(pkg, ver, mode, nodeId = '') {
    const packageTitle = `${pkg.title} / ${ver.version}`;
    const chapters = getVersionChapters(ver);
    if (mode === 'package') {
        return {
            title: packageTitle,
            defaultCourseTitle: pkg.title,
            defaultSectionTitle: pkg.title,
            modeLabel: '整个课程包',
        };
    }
    if (mode === 'chapter') {
        const chapter = findChapter(chapters, nodeId);
        if (!chapter)
            throw new hydrooj_1.NotFoundError('章不存在。');
        return {
            title: chapter.title,
            defaultCourseTitle: `${pkg.title} - ${chapter.title}`,
            defaultSectionTitle: chapter.title,
            modeLabel: '章',
        };
    }
    const found = findLesson(chapters, nodeId);
    if (!found)
        throw new hydrooj_1.NotFoundError('节不存在。');
    return {
        title: `${found.chapter.title} / ${found.lesson.title}`,
        defaultCourseTitle: `${pkg.title} - ${found.lesson.title}`,
        defaultSectionTitle: found.chapter.title,
        modeLabel: '节',
    };
}
async function copySelectionToCourse(domainId, courseId, owner, chapters, mode, nodeId = '', target = { position: 'root' }) {
    const course = getCourseModel();
    if (!course?.addSection || !course?.addSubSection || !course?.getSection) {
        throw new hydrooj_1.NotFoundError('hydrooj-course 未安装或未提供 course model，无法复制到课程。');
    }
    let result = { count: 0 };
    if (mode === 'package') {
        for (const chapter of chapters) {
            const current = await copyChapterAsCourseSection(domainId, courseId, owner, chapter.title, chapter.content || '', chapter);
            result = { ...current, count: result.count + current.count };
        }
    }
    else if (mode === 'chapter') {
        const chapter = findChapter(chapters, nodeId);
        if (!chapter)
            throw new hydrooj_1.NotFoundError('章不存在。');
        if (target.position === 'section') {
            result = await copyChapterIntoCourseSection(domainId, courseId, owner, target.sectionId, chapter);
        }
        else {
            result = await copyChapterAsCourseSection(domainId, courseId, owner, (target.newSectionTitle || chapter.title).trim(), chapter.content || '', chapter);
        }
    }
    else if (mode === 'lesson') {
        const found = findLesson(chapters, nodeId);
        if (!found)
            throw new hydrooj_1.NotFoundError('节不存在。');
        let sectionId = target.sectionId;
        if (target.position === 'section') {
            await ensureCourseSection(domainId, courseId, sectionId);
        }
        else {
            sectionId = await course.addSection(domainId, courseId, owner, (target.newSectionTitle || found.chapter.title).trim(), found.chapter.content || '', 0);
        }
        const subSectionId = await addLessonToCourseSection(domainId, sectionId, owner, found.lesson);
        result = { count: 1, sectionId, subSectionId };
    }
    return result;
}
class CoursePackageModel {
    static async add(domainId, owner, title, content, pin = 0, tags = []) {
        const docId = await hydrooj_1.DocumentModel.add(domainId, content, owner, exports.TYPE_COURSE_PACKAGE, null, null, null, { title, pin, tags, hidden: false, nVersion: 0, updateAt: new Date() });
        return docId;
    }
    static async get(domainId, cpid) {
        return hydrooj_1.DocumentModel.get(domainId, exports.TYPE_COURSE_PACKAGE, cpid);
    }
    static getMulti(domainId, query = {}) {
        return hydrooj_1.DocumentModel.getMulti(domainId, exports.TYPE_COURSE_PACKAGE, query).sort({ pin: -1, _id: -1 });
    }
    static edit(domainId, cpid, $set) {
        return hydrooj_1.DocumentModel.set(domainId, exports.TYPE_COURSE_PACKAGE, cpid, { ...$set, updateAt: new Date() });
    }
    static async del(domainId, cpid) {
        return Promise.all([
            hydrooj_1.DocumentModel.deleteOne(domainId, exports.TYPE_COURSE_PACKAGE, cpid),
            hydrooj_1.DocumentModel.deleteMulti(domainId, exports.TYPE_COURSE_PACKAGE_VERSION, { parentType: exports.TYPE_COURSE_PACKAGE, parentId: cpid }),
        ]);
    }
    static async addVersion(domainId, cpid, owner, title, version, content, treeText, pin = 0) {
        const chapters = parseTree(treeText);
        const docId = await hydrooj_1.DocumentModel.add(domainId, content, owner, exports.TYPE_COURSE_PACKAGE_VERSION, null, exports.TYPE_COURSE_PACKAGE, cpid, { title, version, treeText: serializeTree(chapters), chapters, pin, updateAt: new Date() });
        await hydrooj_1.DocumentModel.inc(domainId, exports.TYPE_COURSE_PACKAGE, cpid, 'nVersion', 1);
        await CoursePackageModel.edit(domainId, cpid, {});
        return docId;
    }
    static async getVersion(domainId, vid) {
        const doc = await hydrooj_1.DocumentModel.get(domainId, exports.TYPE_COURSE_PACKAGE_VERSION, vid);
        if (!doc)
            return null;
        doc.chapters = getVersionChapters(doc);
        doc.treeText = serializeTree(doc.chapters);
        return doc;
    }
    static getMultiVersion(domainId, cpid) {
        return hydrooj_1.DocumentModel.getMulti(domainId, exports.TYPE_COURSE_PACKAGE_VERSION, { parentType: exports.TYPE_COURSE_PACKAGE, parentId: cpid }).sort({ pin: -1, _id: -1 });
    }
    static editVersion(domainId, vid, $set) {
        if ($set.treeText !== undefined) {
            const chapters = parseTree($set.treeText);
            $set.chapters = chapters;
            $set.treeText = serializeTree(chapters);
        }
        return hydrooj_1.DocumentModel.set(domainId, exports.TYPE_COURSE_PACKAGE_VERSION, vid, { ...$set, updateAt: new Date() });
    }
    static setVersionChapters(domainId, vid, chapters) {
        return CoursePackageModel.editVersion(domainId, vid, { treeText: serializeTree(chapters) });
    }
    static async delVersion(domainId, cpid, vid) {
        await hydrooj_1.DocumentModel.deleteOne(domainId, exports.TYPE_COURSE_PACKAGE_VERSION, vid);
        await hydrooj_1.DocumentModel.inc(domainId, exports.TYPE_COURSE_PACKAGE, cpid, 'nVersion', -1);
        await CoursePackageModel.edit(domainId, cpid, {});
    }
}
exports.CoursePackageModel = CoursePackageModel;
global.Hydro.model.coursePackage = CoursePackageModel;
class CoursePackageBaseHandler extends hydrooj_1.Handler {
    async _prepare({ domainId }, cpid, vid) {
        if (cpid) {
            this.cpdoc = await CoursePackageModel.get(domainId, cpid);
            if (!this.cpdoc)
                throw new hydrooj_1.DocumentNotFoundError(domainId, cpid);
        }
        if (vid) {
            this.vpdoc = await CoursePackageModel.getVersion(domainId, vid);
            if (!this.vpdoc)
                throw new hydrooj_1.DocumentNotFoundError(domainId, vid);
            if (cpid && this.vpdoc.parentId.toHexString() !== cpid.toHexString())
                throw new hydrooj_1.DocumentNotFoundError(domainId, vid);
        }
    }
}
__decorate([
    (0, hydrooj_1.param)('cpid', hydrooj_1.Types.ObjectId, true),
    (0, hydrooj_1.param)('vid', hydrooj_1.Types.ObjectId, true)
], CoursePackageBaseHandler.prototype, "_prepare", null);
class CoursePackageMainHandler extends hydrooj_1.Handler {
    async get({ domainId }, page = 1, q = '') {
        const query = { hidden: false };
        if (q)
            query.title = { $regex: q, $options: 'i' };
        const [cpdocs, cpcount] = await this.paginate(CoursePackageModel.getMulti(domainId, query), page, this.ctx.setting.get('pagination.coursePackage') || 20);
        const udict = await hydrooj_1.UserModel.getList(domainId, cpdocs.map((doc) => doc.owner));
        this.response.template = 'course_package_main.html';
        this.response.body = { page_name: 'course_package_main', cpdocs, cpcount, page, q, udict };
    }
}
__decorate([
    (0, hydrooj_1.param)('page', hydrooj_1.Types.PositiveInt, true),
    (0, hydrooj_1.param)('q', hydrooj_1.Types.String, true)
], CoursePackageMainHandler.prototype, "get", null);
class CoursePackageEditHandler extends CoursePackageBaseHandler {
    async get({ domainId }, cpid) {
        if (cpid)
            this.checkPerm(hydrooj_1.PERM.PERM_EDIT_TRAINING);
        else
            this.checkPerm(hydrooj_1.PERM.PERM_CREATE_TRAINING);
        this.response.template = 'course_package_edit.html';
        this.response.body = { page_name: cpid ? 'course_package_edit' : 'course_package_create', cpdoc: this.cpdoc };
    }
    async post({ domainId }, title, content, pin = 0, tags = '', cpid) {
        if (!cpid) {
            this.checkPerm(hydrooj_1.PERM.PERM_CREATE_TRAINING);
            cpid = await CoursePackageModel.add(domainId, this.user._id, title, content, pin, normalizeTags(tags));
        }
        else {
            this.checkPerm(hydrooj_1.PERM.PERM_EDIT_TRAINING);
            await CoursePackageModel.edit(domainId, cpid, { title, content, pin, tags: normalizeTags(tags) });
        }
        this.response.redirect = this.url('course_package_detail', { cpid });
    }
    async postDelete({ domainId }, cpid) {
        this.checkPerm(hydrooj_1.PERM.PERM_EDIT_TRAINING);
        await CoursePackageModel.del(domainId, cpid);
        this.response.redirect = this.url('course_package_main');
    }
}
__decorate([
    (0, hydrooj_1.param)('cpid', hydrooj_1.Types.ObjectId, true)
], CoursePackageEditHandler.prototype, "get", null);
__decorate([
    (0, hydrooj_1.param)('title', hydrooj_1.Types.Title),
    (0, hydrooj_1.param)('content', hydrooj_1.Types.Content),
    (0, hydrooj_1.param)('pin', hydrooj_1.Types.UnsignedInt, true),
    (0, hydrooj_1.param)('tags', hydrooj_1.Types.String, true),
    (0, hydrooj_1.param)('cpid', hydrooj_1.Types.ObjectId, true)
], CoursePackageEditHandler.prototype, "post", null);
__decorate([
    (0, hydrooj_1.param)('cpid', hydrooj_1.Types.ObjectId)
], CoursePackageEditHandler.prototype, "postDelete", null);
class CoursePackageDetailHandler extends CoursePackageBaseHandler {
    async get({ domainId }, cpid) {
        const versions = (await CoursePackageModel.getMultiVersion(domainId, cpid).toArray())
            .map((ver) => ({ ...ver, summary: summarizeChapters(getVersionChapters(ver)) }));
        const udoc = await hydrooj_1.UserModel.getById(domainId, this.cpdoc.owner);
        this.response.template = 'course_package_detail.html';
        this.response.body = { page_name: 'course_package_detail', cpdoc: this.cpdoc, versions, udoc };
        this.UiContext.extraTitleContent = this.cpdoc.title;
    }
}
__decorate([
    (0, hydrooj_1.param)('cpid', hydrooj_1.Types.ObjectId)
], CoursePackageDetailHandler.prototype, "get", null);
class CoursePackageVersionEditHandler extends CoursePackageBaseHandler {
    async get({ domainId }, cpid, vid) {
        this.checkPerm(hydrooj_1.PERM.PERM_EDIT_TRAINING);
        this.response.template = 'course_package_version_edit.html';
        this.response.body = {
            page_name: vid ? 'course_package_version_edit' : 'course_package_version_create',
            cpdoc: this.cpdoc,
            vpdoc: this.vpdoc,
            sampleTree: sampleTree(),
        };
    }
    async post({ domainId }, cpid, title, version, content, treeText, pin = 0, vid) {
        this.checkPerm(hydrooj_1.PERM.PERM_EDIT_TRAINING);
        if (!vid) {
            vid = await CoursePackageModel.addVersion(domainId, cpid, this.user._id, title, version, content, treeText, pin);
        }
        else {
            await CoursePackageModel.editVersion(domainId, vid, { title, version, content, treeText, pin });
        }
        this.response.redirect = this.url('course_package_version_detail', { cpid, vid });
    }
    async postDelete({ domainId }, cpid, vid) {
        this.checkPerm(hydrooj_1.PERM.PERM_EDIT_TRAINING);
        await CoursePackageModel.delVersion(domainId, cpid, vid);
        this.response.redirect = this.url('course_package_detail', { cpid });
    }
}
__decorate([
    (0, hydrooj_1.param)('cpid', hydrooj_1.Types.ObjectId),
    (0, hydrooj_1.param)('vid', hydrooj_1.Types.ObjectId, true)
], CoursePackageVersionEditHandler.prototype, "get", null);
__decorate([
    (0, hydrooj_1.param)('cpid', hydrooj_1.Types.ObjectId),
    (0, hydrooj_1.param)('title', hydrooj_1.Types.Title),
    (0, hydrooj_1.param)('version', hydrooj_1.Types.String),
    (0, hydrooj_1.param)('content', hydrooj_1.Types.Content),
    (0, hydrooj_1.param)('treeText', hydrooj_1.Types.Content),
    (0, hydrooj_1.param)('pin', hydrooj_1.Types.UnsignedInt, true),
    (0, hydrooj_1.param)('vid', hydrooj_1.Types.ObjectId, true)
], CoursePackageVersionEditHandler.prototype, "post", null);
__decorate([
    (0, hydrooj_1.param)('cpid', hydrooj_1.Types.ObjectId),
    (0, hydrooj_1.param)('vid', hydrooj_1.Types.ObjectId)
], CoursePackageVersionEditHandler.prototype, "postDelete", null);
class CoursePackageVersionDetailHandler extends CoursePackageBaseHandler {
    async get({ domainId }, cpid, vid) {
        const udoc = await hydrooj_1.UserModel.getById(domainId, this.vpdoc.owner);
        const chapters = getVersionChapters(this.vpdoc);
        this.response.template = 'course_package_version_detail.html';
        this.response.body = {
            page_name: 'course_package_version_detail',
            cpdoc: this.cpdoc,
            vpdoc: this.vpdoc,
            chapters,
            udoc,
            summary: summarizeChapters(chapters),
        };
        this.UiContext.extraTitleContent = `${this.cpdoc.title} - ${this.vpdoc.version}`;
    }
}
__decorate([
    (0, hydrooj_1.param)('cpid', hydrooj_1.Types.ObjectId),
    (0, hydrooj_1.param)('vid', hydrooj_1.Types.ObjectId)
], CoursePackageVersionDetailHandler.prototype, "get", null);
class CoursePackageChapterEditHandler extends CoursePackageBaseHandler {
    async get({ domainId }, cpid, vid, chapterId = '') {
        this.checkPerm(hydrooj_1.PERM.PERM_EDIT_TRAINING);
        const chapters = getVersionChapters(this.vpdoc);
        const chapter = chapterId ? findChapter(chapters, chapterId) : null;
        if (chapterId && !chapter)
            throw new hydrooj_1.NotFoundError('章不存在。');
        this.response.template = 'course_package_chapter_edit.html';
        this.response.body = {
            page_name: chapterId ? 'course_package_chapter_edit' : 'course_package_chapter_create',
            cpdoc: this.cpdoc,
            vpdoc: this.vpdoc,
            chapter,
        };
    }
    async post({ domainId }, cpid, vid, chapterId, title, content = '') {
        this.checkPerm(hydrooj_1.PERM.PERM_EDIT_TRAINING);
        chapterId || (chapterId = '');
        const chapters = getVersionChapters(this.vpdoc);
        if (chapterId) {
            const chapter = findChapter(chapters, chapterId);
            if (!chapter)
                throw new hydrooj_1.NotFoundError('章不存在。');
            chapter.title = title;
            chapter.content = content || '';
        }
        else {
            chapters.push({ id: uid(), title, content: content || '', lessons: [] });
        }
        await CoursePackageModel.setVersionChapters(domainId, vid, chapters);
        this.response.redirect = this.url('course_package_version_detail', { cpid, vid });
    }
    async postDelete({ domainId }, cpid, vid, chapterId) {
        this.checkPerm(hydrooj_1.PERM.PERM_EDIT_TRAINING);
        const chapters = getVersionChapters(this.vpdoc);
        const length = chapters.length;
        const next = chapters.filter((chapter) => chapter.id !== chapterId);
        if (next.length === length)
            throw new hydrooj_1.NotFoundError('章不存在。');
        await CoursePackageModel.setVersionChapters(domainId, vid, next);
        this.response.redirect = this.url('course_package_version_detail', { cpid, vid });
    }
}
__decorate([
    (0, hydrooj_1.param)('cpid', hydrooj_1.Types.ObjectId),
    (0, hydrooj_1.param)('vid', hydrooj_1.Types.ObjectId),
    (0, hydrooj_1.param)('chapterId', hydrooj_1.Types.String, true)
], CoursePackageChapterEditHandler.prototype, "get", null);
__decorate([
    (0, hydrooj_1.param)('cpid', hydrooj_1.Types.ObjectId),
    (0, hydrooj_1.param)('vid', hydrooj_1.Types.ObjectId),
    (0, hydrooj_1.param)('chapterId', hydrooj_1.Types.String, true),
    (0, hydrooj_1.param)('title', hydrooj_1.Types.Title),
    (0, hydrooj_1.param)('content', hydrooj_1.Types.Content, true)
], CoursePackageChapterEditHandler.prototype, "post", null);
__decorate([
    (0, hydrooj_1.param)('cpid', hydrooj_1.Types.ObjectId),
    (0, hydrooj_1.param)('vid', hydrooj_1.Types.ObjectId),
    (0, hydrooj_1.param)('chapterId', hydrooj_1.Types.String)
], CoursePackageChapterEditHandler.prototype, "postDelete", null);
class CoursePackageLessonEditHandler extends CoursePackageBaseHandler {
    async get({ domainId }, cpid, vid, chapterId, lessonId = '') {
        this.checkPerm(hydrooj_1.PERM.PERM_EDIT_TRAINING);
        const chapters = getVersionChapters(this.vpdoc);
        const chapter = findChapter(chapters, chapterId);
        if (!chapter)
            throw new hydrooj_1.NotFoundError('章不存在。');
        const lesson = lessonId ? findLessonInChapter(chapter, lessonId) : null;
        if (lessonId && !lesson)
            throw new hydrooj_1.NotFoundError('节不存在。');
        this.response.template = 'course_package_lesson_edit.html';
        this.response.body = {
            page_name: lessonId ? 'course_package_lesson_edit' : 'course_package_lesson_create',
            cpdoc: this.cpdoc,
            vpdoc: this.vpdoc,
            chapter,
            lesson,
        };
    }
    async post({ domainId }, cpid, vid, chapterId, lessonId, title, content = '', pidsText, tags = '') {
        this.checkPerm(hydrooj_1.PERM.PERM_EDIT_TRAINING);
        lessonId || (lessonId = '');
        const chapters = getVersionChapters(this.vpdoc);
        const chapter = findChapter(chapters, chapterId);
        if (!chapter)
            throw new hydrooj_1.NotFoundError('章不存在。');
        const pids = normalizeIds(pidsText);
        await ensureProblemIds(domainId, pids);
        if (lessonId) {
            const lesson = findLessonInChapter(chapter, lessonId);
            if (!lesson)
                throw new hydrooj_1.NotFoundError('节不存在。');
            lesson.title = title;
            lesson.content = content || '';
            lesson.pids = pids;
            lesson.tags = normalizeTags(tags);
        }
        else {
            chapter.lessons.push({ id: uid(), title, content: content || '', pids, tags: normalizeTags(tags) });
        }
        await CoursePackageModel.setVersionChapters(domainId, vid, chapters);
        this.response.redirect = this.url('course_package_version_detail', { cpid, vid });
    }
    async postDelete({ domainId }, cpid, vid, chapterId, lessonId) {
        this.checkPerm(hydrooj_1.PERM.PERM_EDIT_TRAINING);
        const chapters = getVersionChapters(this.vpdoc);
        const chapter = findChapter(chapters, chapterId);
        if (!chapter)
            throw new hydrooj_1.NotFoundError('章不存在。');
        const length = chapter.lessons.length;
        chapter.lessons = chapter.lessons.filter((lesson) => lesson.id !== lessonId);
        if (chapter.lessons.length === length)
            throw new hydrooj_1.NotFoundError('节不存在。');
        await CoursePackageModel.setVersionChapters(domainId, vid, chapters);
        this.response.redirect = this.url('course_package_version_detail', { cpid, vid });
    }
}
__decorate([
    (0, hydrooj_1.param)('cpid', hydrooj_1.Types.ObjectId),
    (0, hydrooj_1.param)('vid', hydrooj_1.Types.ObjectId),
    (0, hydrooj_1.param)('chapterId', hydrooj_1.Types.String),
    (0, hydrooj_1.param)('lessonId', hydrooj_1.Types.String, true)
], CoursePackageLessonEditHandler.prototype, "get", null);
__decorate([
    (0, hydrooj_1.param)('cpid', hydrooj_1.Types.ObjectId),
    (0, hydrooj_1.param)('vid', hydrooj_1.Types.ObjectId),
    (0, hydrooj_1.param)('chapterId', hydrooj_1.Types.String),
    (0, hydrooj_1.param)('lessonId', hydrooj_1.Types.String, true),
    (0, hydrooj_1.param)('title', hydrooj_1.Types.Title),
    (0, hydrooj_1.param)('content', hydrooj_1.Types.Content, true),
    (0, hydrooj_1.param)('pids', hydrooj_1.Types.Content),
    (0, hydrooj_1.param)('tags', hydrooj_1.Types.String, true)
], CoursePackageLessonEditHandler.prototype, "post", null);
__decorate([
    (0, hydrooj_1.param)('cpid', hydrooj_1.Types.ObjectId),
    (0, hydrooj_1.param)('vid', hydrooj_1.Types.ObjectId),
    (0, hydrooj_1.param)('chapterId', hydrooj_1.Types.String),
    (0, hydrooj_1.param)('lessonId', hydrooj_1.Types.String)
], CoursePackageLessonEditHandler.prototype, "postDelete", null);
class CoursePackageExportHandler extends CoursePackageBaseHandler {
    async get({ domainId }, cpid, vid) {
        const blob = await buildCoursePackageZip(domainId, this.cpdoc, this.vpdoc);
        this.binary(blob, `${safeFilename(this.cpdoc.title)}-${safeFilename(this.vpdoc.version)}.zip`);
    }
}
__decorate([
    (0, hydrooj_1.param)('cpid', hydrooj_1.Types.ObjectId),
    (0, hydrooj_1.param)('vid', hydrooj_1.Types.ObjectId)
], CoursePackageExportHandler.prototype, "get", null);
class CoursePackageImportHandler extends hydrooj_1.Handler {
    async get() {
        this.checkPerm(hydrooj_1.PERM.PERM_CREATE_TRAINING);
        this.response.template = 'course_package_import.html';
        this.response.body = { page_name: 'course_package_import' };
    }
    async post({ domainId }, payloadText = '') {
        this.checkPerm(hydrooj_1.PERM.PERM_CREATE_TRAINING);
        const file = this.request.files?.file;
        let payload;
        let pidMap = new Map();
        if (file) {
            payload = await readCoursePackageZip(file.filepath);
            pidMap = await importZipProblemsAndBuildMap(domainId, file.filepath, payload, this.user._id);
        }
        else if (payloadText.trim()) {
            payload = parseImportPayload(payloadText);
        }
        else {
            throw new hydrooj_1.ValidationError('payload', null, '请上传课程包 ZIP 或粘贴课程包 JSON。');
        }
        if (!payload.package.title)
            throw new hydrooj_1.ValidationError('payload', null, '导入数据缺少课程包标题。');
        const chapters = pidMap.size ? remapChapters(payload.version.chapters || [], pidMap) : payload.version.chapters;
        const cpid = await CoursePackageModel.add(domainId, this.user._id, payload.package.title, payload.package.content, payload.package.pin, payload.package.tags);
        const treeText = serializeTree(chapters || []);
        const vid = await CoursePackageModel.addVersion(domainId, cpid, this.user._id, payload.version.title || payload.version.version || '默认版本', payload.version.version || 'v1', payload.version.content, treeText, 0);
        this.response.redirect = this.url('course_package_version_detail', { cpid, vid });
    }
}
__decorate([
    (0, hydrooj_1.param)('payload', hydrooj_1.Types.Content, true)
], CoursePackageImportHandler.prototype, "post", null);
class CoursePackageCopyHandler extends CoursePackageBaseHandler {
    async get({ domainId }, cpid, vid, mode = 'package', nodeId = '', targetDomainId = '', targetCourseId) {
        this.checkPerm(hydrooj_1.PERM.PERM_EDIT_TRAINING);
        const course = getCourseModel();
        const domains = await getWritableDomains(this.user._id, domainId);
        if (!targetDomainId || !domains.some((ddoc) => ddoc._id === targetDomainId)) {
            targetDomainId = domains.some((ddoc) => ddoc._id === domainId)
                ? domainId
                : domains[0]?._id || domainId;
        }
        const courses = course?.getMulti
            ? await course.getMulti(targetDomainId, {}).toArray()
            : [];
        if (!targetCourseId || !courses.some((cdoc) => sameId(cdoc.docId, targetCourseId))) {
            targetCourseId = courses[0]?.docId;
        }
        const sections = targetCourseId && course?.getMultiSection
            ? await course.getMultiSection(targetDomainId, targetCourseId).toArray()
            : [];
        const courseOptions = courses.map((cdoc) => ({ ...cdoc, docIdText: cdoc.docId?.toString?.() || '' }));
        const sectionOptions = sections.map((csdoc) => ({ ...csdoc, docIdText: csdoc.docId?.toString?.() || '' }));
        const meta = getSelectionMeta(this.cpdoc, this.vpdoc, mode, nodeId);
        const chapters = getVersionChapters(this.vpdoc);
        const selectedProblemCount = collectProblemIds(chapters, mode, nodeId).length;
        this.response.template = 'course_package_copy.html';
        this.response.body = {
            page_name: 'course_package_copy',
            cpdoc: this.cpdoc,
            vpdoc: this.vpdoc,
            mode,
            nodeId,
            domains,
            targetDomainId,
            courses: courseOptions,
            targetCourseId,
            targetCourseIdText: targetCourseId?.toString?.() || '',
            sections: sectionOptions,
            selectionTitle: meta.title,
            defaultCourseTitle: meta.defaultCourseTitle,
            defaultSectionTitle: meta.defaultSectionTitle,
            modeLabel: meta.modeLabel,
            selectedProblemCount,
        };
    }
    async post({ domainId }, cpid, vid, mode, nodeId, targetDomainId = '', targetMode = 'existing', targetCourseId, targetPosition = 'root', targetSectionId, newCourseTitle = '', newCourseContent = '', newCoursePin = 0, newSectionTitle = '') {
        this.checkPerm(hydrooj_1.PERM.PERM_EDIT_TRAINING);
        targetDomainId = await assertWritableDomain(targetDomainId || domainId, this.user._id);
        const course = getCourseModel();
        if (!course?.add || !course?.get) {
            throw new hydrooj_1.NotFoundError('hydrooj-course 未安装或未提供 course model，无法复制到课程。');
        }
        const meta = getSelectionMeta(this.cpdoc, this.vpdoc, mode, nodeId);
        let owner = this.user._id;
        let title = '';
        if (targetMode === 'create') {
            title = (newCourseTitle || meta.defaultCourseTitle).trim();
            if (!title)
                throw new hydrooj_1.ValidationError('newCourseTitle', null, '请填写新课程标题。');
            if (targetPosition === 'section')
                targetPosition = mode === 'lesson' ? 'new_section' : 'root';
        }
        else {
            if (!targetCourseId)
                throw new hydrooj_1.ValidationError('targetCourseId', null, '请选择目标课程。');
            const cdoc = await course.get(targetDomainId, targetCourseId);
            if (!cdoc)
                throw new hydrooj_1.NotFoundError('目标课程不存在。');
            owner = cdoc.owner || this.user._id;
        }
        const chapters = getVersionChapters(this.vpdoc);
        const pidMap = await syncSelectedProblems(domainId, targetDomainId, chapters, mode, nodeId, this.user._id);
        const mappedChapters = remapChapters(chapters, pidMap);
        if (targetMode === 'create') {
            targetCourseId = await course.add(targetDomainId, this.user._id, title, newCourseContent || this.cpdoc.content || '', [], newCoursePin || 0);
        }
        if (mode === 'package')
            targetPosition = 'root';
        if (mode === 'lesson' && targetPosition === 'root')
            targetPosition = targetSectionId ? 'section' : 'new_section';
        const result = await copySelectionToCourse(targetDomainId, targetCourseId, owner, mappedChapters, mode, nodeId, {
            position: targetPosition,
            sectionId: targetSectionId,
            newSectionTitle: (newSectionTitle || meta.defaultSectionTitle).trim(),
        });
        if (mode === 'lesson' && result.subSectionId) {
            this.response.redirect = this.url('course_subsec_detail', {
                domainId: targetDomainId,
                cid: targetCourseId,
                csid: result.sectionId,
                ssid: result.subSectionId,
            });
        }
        else if (result.sectionId && mode === 'chapter') {
            this.response.redirect = this.url('course_section_detail', {
                domainId: targetDomainId,
                cid: targetCourseId,
                csid: result.sectionId,
            });
        }
        else {
            this.response.redirect = this.url('course_detail', { domainId: targetDomainId, cid: targetCourseId });
        }
    }
}
__decorate([
    (0, hydrooj_1.param)('cpid', hydrooj_1.Types.ObjectId),
    (0, hydrooj_1.param)('vid', hydrooj_1.Types.ObjectId),
    (0, hydrooj_1.param)('mode', hydrooj_1.Types.Range(['package', 'chapter', 'lesson']), true),
    (0, hydrooj_1.param)('nodeId', hydrooj_1.Types.String, true),
    (0, hydrooj_1.param)('targetDomainId', hydrooj_1.Types.String, true),
    (0, hydrooj_1.param)('targetCourseId', hydrooj_1.Types.ObjectId, true)
], CoursePackageCopyHandler.prototype, "get", null);
__decorate([
    (0, hydrooj_1.param)('cpid', hydrooj_1.Types.ObjectId),
    (0, hydrooj_1.param)('vid', hydrooj_1.Types.ObjectId),
    (0, hydrooj_1.param)('mode', hydrooj_1.Types.Range(['package', 'chapter', 'lesson'])),
    (0, hydrooj_1.param)('nodeId', hydrooj_1.Types.String, true),
    (0, hydrooj_1.param)('targetDomainId', hydrooj_1.Types.String, true),
    (0, hydrooj_1.param)('targetMode', hydrooj_1.Types.Range(['existing', 'create']), true),
    (0, hydrooj_1.param)('targetCourseId', hydrooj_1.Types.ObjectId, true),
    (0, hydrooj_1.param)('targetPosition', hydrooj_1.Types.Range(['root', 'section', 'new_section']), true),
    (0, hydrooj_1.param)('targetSectionId', hydrooj_1.Types.ObjectId, true),
    (0, hydrooj_1.param)('newCourseTitle', hydrooj_1.Types.String, true),
    (0, hydrooj_1.param)('newCourseContent', hydrooj_1.Types.Content, true),
    (0, hydrooj_1.param)('newCoursePin', hydrooj_1.Types.UnsignedInt, true),
    (0, hydrooj_1.param)('newSectionTitle', hydrooj_1.Types.String, true)
], CoursePackageCopyHandler.prototype, "post", null);
async function apply(ctx) {
    ctx.Route('course_package_main', '/course-package', CoursePackageMainHandler, hydrooj_1.PERM.PERM_VIEW_TRAINING);
    ctx.Route('course_package_create', '/course-package/create', CoursePackageEditHandler, hydrooj_1.PERM.PERM_CREATE_TRAINING);
    ctx.Route('course_package_import', '/course-package/import', CoursePackageImportHandler, hydrooj_1.PERM.PERM_CREATE_TRAINING);
    ctx.Route('course_package_detail', '/course-package/:cpid', CoursePackageDetailHandler, hydrooj_1.PERM.PERM_VIEW_TRAINING);
    ctx.Route('course_package_edit', '/course-package/:cpid/edit', CoursePackageEditHandler, hydrooj_1.PERM.PERM_EDIT_TRAINING);
    ctx.Route('course_package_version_create', '/course-package/:cpid/version/create', CoursePackageVersionEditHandler, hydrooj_1.PERM.PERM_EDIT_TRAINING);
    ctx.Route('course_package_version_detail', '/course-package/:cpid/version/:vid', CoursePackageVersionDetailHandler, hydrooj_1.PERM.PERM_VIEW_TRAINING);
    ctx.Route('course_package_version_edit', '/course-package/:cpid/version/:vid/edit', CoursePackageVersionEditHandler, hydrooj_1.PERM.PERM_EDIT_TRAINING);
    ctx.Route('course_package_chapter_create', '/course-package/:cpid/version/:vid/chapter/create', CoursePackageChapterEditHandler, hydrooj_1.PERM.PERM_EDIT_TRAINING);
    ctx.Route('course_package_chapter_edit', '/course-package/:cpid/version/:vid/chapter/:chapterId/edit', CoursePackageChapterEditHandler, hydrooj_1.PERM.PERM_EDIT_TRAINING);
    ctx.Route('course_package_lesson_create', '/course-package/:cpid/version/:vid/chapter/:chapterId/lesson/create', CoursePackageLessonEditHandler, hydrooj_1.PERM.PERM_EDIT_TRAINING);
    ctx.Route('course_package_lesson_edit', '/course-package/:cpid/version/:vid/chapter/:chapterId/lesson/:lessonId/edit', CoursePackageLessonEditHandler, hydrooj_1.PERM.PERM_EDIT_TRAINING);
    ctx.Route('course_package_export', '/course-package/:cpid/version/:vid/export', CoursePackageExportHandler, hydrooj_1.PERM.PERM_VIEW_TRAINING);
    ctx.Route('course_package_copy', '/course-package/:cpid/version/:vid/copy', CoursePackageCopyHandler, hydrooj_1.PERM.PERM_EDIT_TRAINING);
    ctx.injectUI('Nav', 'course_package_main', { prefix: 'course-package', before: 'course_main' });
    ctx.inject(['setting'], (c) => {
        c.setting.SystemSetting(hydrooj_1.SettingModel.Setting('setting_basic', 'pagination.coursePackage', 20, 'number', 'pagination.coursePackage', 'Course packages per page'));
    });
    ctx.i18n.load('zh', {
        course_package_main: '课程包',
        course_package_create: '创建课程包',
        course_package_edit: '编辑课程包',
        course_package_detail: '课程包详情',
        course_package_version_create: '创建课程包版本',
        course_package_version_edit: '编辑课程包版本',
        course_package_version_detail: '课程包版本',
        course_package_chapter_create: '创建章',
        course_package_chapter_edit: '编辑章',
        course_package_lesson_create: '创建节',
        course_package_lesson_edit: '编辑节',
        course_package_import: '导入课程包',
        course_package_copy: '复制到课程',
        CoursePackage: '课程包',
    });
    ctx.i18n.load('en', {
        course_package_main: 'Course Package',
        course_package_create: 'Create Course Package',
        course_package_edit: 'Edit Course Package',
        course_package_detail: 'Course Package Detail',
        course_package_version_create: 'Create Course Package Version',
        course_package_version_edit: 'Edit Course Package Version',
        course_package_version_detail: 'Course Package Version',
        course_package_chapter_create: 'Create Chapter',
        course_package_chapter_edit: 'Edit Chapter',
        course_package_lesson_create: 'Create Lesson',
        course_package_lesson_edit: 'Edit Lesson',
        course_package_import: 'Import Course Package',
        course_package_copy: 'Copy to Course',
        CoursePackage: 'Course Package',
    });
}
