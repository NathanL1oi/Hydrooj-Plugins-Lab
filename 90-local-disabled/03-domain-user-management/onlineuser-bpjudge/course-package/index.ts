import {
    Context,
    DocumentModel,
    DocumentNotFoundError,
    Filter,
    Handler,
    NotFoundError,
    ObjectId,
    param,
    PERM,
    ProblemModel,
    ProblemNotFoundError,
    SettingModel,
    Types,
    UserModel,
    ValidationError,
    yaml,
} from 'hydrooj';

export const TYPE_COURSE_PACKAGE = 10880 as const;
export const TYPE_COURSE_PACKAGE_VERSION = 10881 as const;

export interface CoursePackageLesson {
    id: string;
    title: string;
    content: string;
    pids: number[];
    tags: string[];
}

export interface CoursePackageChapter {
    id: string;
    title: string;
    content: string;
    lessons: CoursePackageLesson[];
}

export interface CoursePackageStage {
    id: string;
    title: string;
    content: string;
    chapters: CoursePackageChapter[];
}

export interface CoursePackageDoc {
    _id: ObjectId;
    docType: 10880;
    docId: ObjectId;
    domainId: string;
    owner: number;
    title: string;
    content: string;
    pin?: number;
    hidden?: boolean;
    tags?: string[];
    nVersion?: number;
    updateAt?: Date;
}

export interface CoursePackageVersionDoc {
    _id: ObjectId;
    docType: 10881;
    docId: ObjectId;
    parentType: 10880;
    parentId: ObjectId;
    domainId: string;
    owner: number;
    title: string;
    content: string;
    version: string;
    treeText: string;
    stages: CoursePackageStage[];
    pin?: number;
    updateAt?: Date;
}

interface CoursePackageExportPayload {
    format: 'hydrooj-course-package';
    formatVersion: 1;
    exportedAt: string;
    package: {
        title: string;
        content: string;
        pin: number;
        tags: string[];
    };
    version: {
        title: string;
        version: string;
        content: string;
        treeText: string;
        stages: CoursePackageStage[];
    };
}

type CopyMode = 'package' | 'stage' | 'chapter' | 'lesson';

declare module 'hydrooj' {
    interface Model {
        coursePackage: typeof CoursePackageModel;
    }
    interface DocType {
        [TYPE_COURSE_PACKAGE]: CoursePackageDoc;
        [TYPE_COURSE_PACKAGE_VERSION]: CoursePackageVersionDoc;
    }
}

function uid() {
    return new ObjectId().toHexString();
}

function asText(value: any, fallback = '') {
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return fallback;
    return String(value);
}

function asArray(value: any) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

function normalizeIds(value: any): number[] {
    if (typeof value === 'string') {
        value = value.split(/[,，\s]+/).filter(Boolean);
    }
    return Array.from(new Set(asArray(value)
        .map((item) => Number(asText(item).trim().replace(/^P/i, '')))
        .filter((item) => Number.isInteger(item) && item > 0)));
}

function normalizeTags(value: any): string[] {
    if (typeof value === 'string') {
        value = value.split(/[,，\s]+/).filter(Boolean);
    }
    return Array.from(new Set(asArray(value).map((item) => asText(item).trim()).filter(Boolean)));
}

function parseTree(treeText: string): CoursePackageStage[] {
    let raw: any;
    try {
        raw = yaml.load(treeText || 'stages: []');
    } catch (e) {
        throw new ValidationError('treeText', null, `课程包结构解析失败：${e.message}`);
    }
    const stages = Array.isArray(raw) ? raw : raw?.stages;
    if (!Array.isArray(stages)) throw new ValidationError('treeText', null, '课程包结构必须包含 stages 数组。');
    return stages.map((stage, stageIndex) => {
        const chapters = asArray(stage?.chapters).map((chapter, chapterIndex) => {
            const lessons = asArray(chapter?.lessons).map((lesson, lessonIndex) => {
                const title = asText(lesson?.title).trim();
                if (!title) throw new ValidationError('treeText', null, `第 ${stageIndex + 1} 阶段第 ${chapterIndex + 1} 章第 ${lessonIndex + 1} 节缺少 title。`);
                return {
                    id: asText(lesson?.id, uid()),
                    title,
                    content: asText(lesson?.content),
                    pids: normalizeIds(lesson?.pids ?? lesson?.pid),
                    tags: normalizeTags(lesson?.tags),
                };
            });
            const title = asText(chapter?.title).trim();
            if (!title) throw new ValidationError('treeText', null, `第 ${stageIndex + 1} 阶段第 ${chapterIndex + 1} 章缺少 title。`);
            return {
                id: asText(chapter?.id, uid()),
                title,
                content: asText(chapter?.content),
                lessons,
            };
        });
        const title = asText(stage?.title).trim();
        if (!title) throw new ValidationError('treeText', null, `第 ${stageIndex + 1} 阶段缺少 title。`);
        return {
            id: asText(stage?.id, uid()),
            title,
            content: asText(stage?.content),
            chapters,
        };
    });
}

function sampleTree() {
    return [
        'stages:',
        '  - title: 第一阶段：基础语法',
        '    content: 阶段说明，可写 Markdown。',
        '    chapters:',
        '      - title: 输入输出与表达式',
        '        content: 章说明。',
        '        lessons:',
        '          - title: A+B Problem',
        '            content: 节说明，可写 Markdown。',
        '            pids: [1000]',
        '          - title: 多组输入',
        '            pids: [1001, 1002]',
        '',
    ].join('\n');
}

function safeFilename(text: string) {
    return (text || 'course-package').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/-+/g, '-').slice(0, 80);
}

function serializeTree(stages: CoursePackageStage[]) {
    return JSON.stringify({ stages }, null, 2);
}

function buildExport(pkg: CoursePackageDoc, ver: CoursePackageVersionDoc): CoursePackageExportPayload {
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
            treeText: ver.treeText || '',
            stages: ver.stages || [],
        },
    };
}

function getCourseModel() {
    return (global.Hydro.model as any).course;
}

function parseImportPayload(text: string): CoursePackageExportPayload {
    let payload: any;
    try {
        payload = JSON.parse(text);
    } catch (e) {
        throw new ValidationError('payload', null, `JSON 解析失败：${e.message}`);
    }
    if (payload?.format !== 'hydrooj-course-package') {
        throw new ValidationError('payload', null, '不是有效的课程包导出文件。');
    }
    const stages = parseTree(payload.version?.treeText || JSON.stringify({ stages: payload.version?.stages || [] }, null, 2));
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
            treeText: asText(payload.version?.treeText),
            stages,
        },
    };
}

function findStage(stages: CoursePackageStage[], id: string) {
    return stages.find((stage) => stage.id === id);
}

function findChapter(stages: CoursePackageStage[], id: string) {
    for (const stage of stages) {
        const chapter = stage.chapters.find((item) => item.id === id);
        if (chapter) return { stage, chapter };
    }
    return null;
}

function findLesson(stages: CoursePackageStage[], id: string) {
    for (const stage of stages) {
        for (const chapter of stage.chapters) {
            const lesson = chapter.lessons.find((item) => item.id === id);
            if (lesson) return { stage, chapter, lesson };
        }
    }
    return null;
}

function findChapterInStage(stage: CoursePackageStage, chapterId: string) {
    return stage.chapters.find((chapter) => chapter.id === chapterId);
}

function findLessonInChapter(chapter: CoursePackageChapter, lessonId: string) {
    return chapter.lessons.find((lesson) => lesson.id === lessonId);
}

async function ensureProblemIds(domainId: string, pids: number[]) {
    if (!pids.length) throw new ValidationError('pids', null, 'Please specify at least one problem');
    await Promise.all(pids.map(async (pid) => {
        const pdoc = await ProblemModel.get(domainId, pid);
        if (!pdoc) throw new ProblemNotFoundError(domainId, pid);
    }));
}

async function copyChapterToCourse(domainId: string, courseId: ObjectId, owner: number, title: string, content: string, chapter: CoursePackageChapter) {
    const course = getCourseModel();
    const sectionId = await course.addSection(domainId, courseId, owner, title, content || '', 0);
    for (const lesson of chapter.lessons) {
        await course.addSubSection(domainId, sectionId, owner, lesson.title, lesson.content || '', lesson.pids || [], 0);
    }
    return 1;
}

async function copySelectionToCourse(domainId: string, courseId: ObjectId, owner: number, stages: CoursePackageStage[], mode: CopyMode, nodeId = '') {
    const course = getCourseModel();
    if (!course?.addSection || !course?.addSubSection) {
        throw new NotFoundError('hydrooj-course 未安装或未提供 course model，无法复制到课程。');
    }
    let count = 0;
    if (mode === 'package') {
        for (const stage of stages) {
            for (const chapter of stage.chapters) {
                count += await copyChapterToCourse(domainId, courseId, owner, `${stage.title} / ${chapter.title}`, chapter.content || stage.content || '', chapter);
            }
        }
    } else if (mode === 'stage') {
        const stage = findStage(stages, nodeId);
        if (!stage) throw new NotFoundError('阶段不存在。');
        for (const chapter of stage.chapters) {
            count += await copyChapterToCourse(domainId, courseId, owner, `${stage.title} / ${chapter.title}`, chapter.content || stage.content || '', chapter);
        }
    } else if (mode === 'chapter') {
        const found = findChapter(stages, nodeId);
        if (!found) throw new NotFoundError('章不存在。');
        count += await copyChapterToCourse(domainId, courseId, owner, found.chapter.title, found.chapter.content || found.stage.content || '', found.chapter);
    } else if (mode === 'lesson') {
        const found = findLesson(stages, nodeId);
        if (!found) throw new NotFoundError('节不存在。');
        const sectionId = await course.addSection(domainId, courseId, owner, found.lesson.title, found.lesson.content || found.chapter.content || '', 0);
        await course.addSubSection(domainId, sectionId, owner, found.lesson.title, found.lesson.content || '', found.lesson.pids || [], 0);
        count = 1;
    }
    return count;
}

export class CoursePackageModel {
    static async add(domainId: string, owner: number, title: string, content: string, pin = 0, tags: string[] = []) {
        const docId = await DocumentModel.add(
            domainId, content, owner, TYPE_COURSE_PACKAGE,
            null, null, null, { title, pin, tags, hidden: false, nVersion: 0, updateAt: new Date() },
        );
        return docId;
    }

    static async get(domainId: string, cpid: ObjectId): Promise<CoursePackageDoc | null> {
        return DocumentModel.get(domainId, TYPE_COURSE_PACKAGE, cpid);
    }

    static getMulti(domainId: string, query: Filter<CoursePackageDoc> = {}) {
        return DocumentModel.getMulti(domainId, TYPE_COURSE_PACKAGE, query).sort({ pin: -1, _id: -1 });
    }

    static edit(domainId: string, cpid: ObjectId, $set: Partial<CoursePackageDoc>) {
        return DocumentModel.set(domainId, TYPE_COURSE_PACKAGE, cpid, { ...$set, updateAt: new Date() });
    }

    static async del(domainId: string, cpid: ObjectId) {
        return Promise.all([
            DocumentModel.deleteOne(domainId, TYPE_COURSE_PACKAGE, cpid),
            DocumentModel.deleteMulti(domainId, TYPE_COURSE_PACKAGE_VERSION, { parentType: TYPE_COURSE_PACKAGE, parentId: cpid }),
        ]);
    }

    static async addVersion(domainId: string, cpid: ObjectId, owner: number, title: string, version: string, content: string, treeText: string, pin = 0) {
        const stages = parseTree(treeText);
        const docId = await DocumentModel.add(
            domainId, content, owner, TYPE_COURSE_PACKAGE_VERSION,
            null, TYPE_COURSE_PACKAGE, cpid, { title, version, treeText, stages, pin, updateAt: new Date() },
        );
        await DocumentModel.inc(domainId, TYPE_COURSE_PACKAGE, cpid, 'nVersion', 1);
        await CoursePackageModel.edit(domainId, cpid, {});
        return docId;
    }

    static async getVersion(domainId: string, vid: ObjectId): Promise<CoursePackageVersionDoc | null> {
        return DocumentModel.get(domainId, TYPE_COURSE_PACKAGE_VERSION, vid);
    }

    static getMultiVersion(domainId: string, cpid: ObjectId) {
        return DocumentModel.getMulti(
            domainId, TYPE_COURSE_PACKAGE_VERSION,
            { parentType: TYPE_COURSE_PACKAGE, parentId: cpid },
        ).sort({ pin: -1, _id: -1 });
    }

    static editVersion(domainId: string, vid: ObjectId, $set: Partial<CoursePackageVersionDoc>) {
        if ($set.treeText !== undefined) $set.stages = parseTree($set.treeText);
        return DocumentModel.set(domainId, TYPE_COURSE_PACKAGE_VERSION, vid, { ...$set, updateAt: new Date() });
    }

    static setVersionStages(domainId: string, vid: ObjectId, stages: CoursePackageStage[]) {
        return CoursePackageModel.editVersion(domainId, vid, { treeText: serializeTree(stages) });
    }

    static async delVersion(domainId: string, cpid: ObjectId, vid: ObjectId) {
        await DocumentModel.deleteOne(domainId, TYPE_COURSE_PACKAGE_VERSION, vid);
        await DocumentModel.inc(domainId, TYPE_COURSE_PACKAGE, cpid, 'nVersion', -1);
        await CoursePackageModel.edit(domainId, cpid, {});
    }
}

global.Hydro.model.coursePackage = CoursePackageModel;

class CoursePackageBaseHandler extends Handler {
    cpdoc?: CoursePackageDoc;
    vpdoc?: CoursePackageVersionDoc;

    @param('cpid', Types.ObjectId, true)
    @param('vid', Types.ObjectId, true)
    async _prepare({ domainId }, cpid?: ObjectId, vid?: ObjectId) {
        if (cpid) {
            this.cpdoc = await CoursePackageModel.get(domainId, cpid);
            if (!this.cpdoc) throw new DocumentNotFoundError(domainId, cpid);
        }
        if (vid) {
            this.vpdoc = await CoursePackageModel.getVersion(domainId, vid);
            if (!this.vpdoc) throw new DocumentNotFoundError(domainId, vid);
            if (cpid && this.vpdoc.parentId.toHexString() !== cpid.toHexString()) throw new DocumentNotFoundError(domainId, vid);
        }
    }
}

class CoursePackageMainHandler extends Handler {
    @param('page', Types.PositiveInt, true)
    @param('q', Types.String, true)
    async get({ domainId }, page = 1, q = '') {
        const query: Filter<CoursePackageDoc> = { hidden: false };
        if (q) query.title = { $regex: q, $options: 'i' } as any;
        const [cpdocs, cpcount] = await this.paginate(CoursePackageModel.getMulti(domainId, query), page, this.ctx.setting.get('pagination.coursePackage') || 20);
        const udict = await UserModel.getList(domainId, cpdocs.map((doc) => doc.owner));
        this.response.template = 'course_package_main.html';
        this.response.body = { page_name: 'course_package_main', cpdocs, cpcount, page, q, udict };
    }
}

class CoursePackageEditHandler extends CoursePackageBaseHandler {
    @param('cpid', Types.ObjectId, true)
    async get({ domainId }, cpid?: ObjectId) {
        if (cpid) this.checkPerm(PERM.PERM_EDIT_TRAINING);
        else this.checkPerm(PERM.PERM_CREATE_TRAINING);
        this.response.template = 'course_package_edit.html';
        this.response.body = { page_name: cpid ? 'course_package_edit' : 'course_package_create', cpdoc: this.cpdoc };
    }

    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('pin', Types.UnsignedInt, true)
    @param('tags', Types.String, true)
    @param('cpid', Types.ObjectId, true)
    async post({ domainId }, title: string, content: string, pin = 0, tags = '', cpid?: ObjectId) {
        if (!cpid) {
            this.checkPerm(PERM.PERM_CREATE_TRAINING);
            cpid = await CoursePackageModel.add(domainId, this.user._id, title, content, pin, normalizeTags(tags));
        } else {
            this.checkPerm(PERM.PERM_EDIT_TRAINING);
            await CoursePackageModel.edit(domainId, cpid, { title, content, pin, tags: normalizeTags(tags) });
        }
        this.response.redirect = this.url('course_package_detail', { cpid });
    }

    @param('cpid', Types.ObjectId)
    async postDelete({ domainId }, cpid: ObjectId) {
        this.checkPerm(PERM.PERM_EDIT_TRAINING);
        await CoursePackageModel.del(domainId, cpid);
        this.response.redirect = this.url('course_package_main');
    }
}

class CoursePackageDetailHandler extends CoursePackageBaseHandler {
    @param('cpid', Types.ObjectId)
    async get({ domainId }, cpid: ObjectId) {
        const versions = await CoursePackageModel.getMultiVersion(domainId, cpid).toArray();
        const udoc = await UserModel.getById(domainId, this.cpdoc!.owner);
        this.response.template = 'course_package_detail.html';
        this.response.body = { page_name: 'course_package_detail', cpdoc: this.cpdoc, versions, udoc };
        this.UiContext.extraTitleContent = this.cpdoc!.title;
    }
}

class CoursePackageVersionEditHandler extends CoursePackageBaseHandler {
    @param('cpid', Types.ObjectId)
    @param('vid', Types.ObjectId, true)
    async get({ domainId }, cpid: ObjectId, vid?: ObjectId) {
        this.checkPerm(PERM.PERM_EDIT_TRAINING);
        this.response.template = 'course_package_version_edit.html';
        this.response.body = {
            page_name: vid ? 'course_package_version_edit' : 'course_package_version_create',
            cpdoc: this.cpdoc,
            vpdoc: this.vpdoc,
            sampleTree: sampleTree(),
        };
    }

    @param('cpid', Types.ObjectId)
    @param('title', Types.Title)
    @param('version', Types.String)
    @param('content', Types.Content)
    @param('treeText', Types.Content)
    @param('pin', Types.UnsignedInt, true)
    @param('vid', Types.ObjectId, true)
    async post({ domainId }, cpid: ObjectId, title: string, version: string, content: string, treeText: string, pin = 0, vid?: ObjectId) {
        this.checkPerm(PERM.PERM_EDIT_TRAINING);
        if (!vid) {
            vid = await CoursePackageModel.addVersion(domainId, cpid, this.user._id, title, version, content, treeText, pin);
        } else {
            await CoursePackageModel.editVersion(domainId, vid, { title, version, content, treeText, pin });
        }
        this.response.redirect = this.url('course_package_version_detail', { cpid, vid });
    }

    @param('cpid', Types.ObjectId)
    @param('vid', Types.ObjectId)
    async postDelete({ domainId }, cpid: ObjectId, vid: ObjectId) {
        this.checkPerm(PERM.PERM_EDIT_TRAINING);
        await CoursePackageModel.delVersion(domainId, cpid, vid);
        this.response.redirect = this.url('course_package_detail', { cpid });
    }
}

class CoursePackageVersionDetailHandler extends CoursePackageBaseHandler {
    @param('cpid', Types.ObjectId)
    @param('vid', Types.ObjectId)
    async get({ domainId }, cpid: ObjectId, vid: ObjectId) {
        const udoc = await UserModel.getById(domainId, this.vpdoc!.owner);
        this.response.template = 'course_package_version_detail.html';
        this.response.body = { page_name: 'course_package_version_detail', cpdoc: this.cpdoc, vpdoc: this.vpdoc, udoc };
        this.UiContext.extraTitleContent = `${this.cpdoc!.title} - ${this.vpdoc!.version}`;
    }
}

class CoursePackageStageEditHandler extends CoursePackageBaseHandler {
    @param('cpid', Types.ObjectId)
    @param('vid', Types.ObjectId)
    @param('stageId', Types.String, true)
    async get({ domainId }, cpid: ObjectId, vid: ObjectId, stageId = '') {
        this.checkPerm(PERM.PERM_EDIT_TRAINING);
        const stage = stageId ? findStage(this.vpdoc!.stages || [], stageId) : null;
        if (stageId && !stage) throw new NotFoundError('阶段不存在。');
        this.response.template = 'course_package_stage_edit.html';
        this.response.body = {
            page_name: stageId ? 'course_package_stage_edit' : 'course_package_stage_create',
            cpdoc: this.cpdoc,
            vpdoc: this.vpdoc,
            stage,
        };
    }

    @param('cpid', Types.ObjectId)
    @param('vid', Types.ObjectId)
    @param('stageId', Types.String, true)
    @param('title', Types.Title)
    @param('content', Types.Content, true)
    async post({ domainId }, cpid: ObjectId, vid: ObjectId, stageId: string, title: string, content = '') {
        this.checkPerm(PERM.PERM_EDIT_TRAINING);
        stageId ||= '';
        const stages = this.vpdoc!.stages || [];
        if (stageId) {
            const stage = findStage(stages, stageId);
            if (!stage) throw new NotFoundError('阶段不存在。');
            stage.title = title;
            stage.content = content || '';
        } else {
            stages.push({ id: uid(), title, content: content || '', chapters: [] });
        }
        await CoursePackageModel.setVersionStages(domainId, vid, stages);
        this.response.redirect = this.url('course_package_version_detail', { cpid, vid });
    }

    @param('cpid', Types.ObjectId)
    @param('vid', Types.ObjectId)
    @param('stageId', Types.String)
    async postDelete({ domainId }, cpid: ObjectId, vid: ObjectId, stageId: string) {
        this.checkPerm(PERM.PERM_EDIT_TRAINING);
        const stages = (this.vpdoc!.stages || []).filter((stage) => stage.id !== stageId);
        if (stages.length === (this.vpdoc!.stages || []).length) throw new NotFoundError('阶段不存在。');
        await CoursePackageModel.setVersionStages(domainId, vid, stages);
        this.response.redirect = this.url('course_package_version_detail', { cpid, vid });
    }
}

class CoursePackageChapterEditHandler extends CoursePackageBaseHandler {
    @param('cpid', Types.ObjectId)
    @param('vid', Types.ObjectId)
    @param('stageId', Types.String)
    @param('chapterId', Types.String, true)
    async get({ domainId }, cpid: ObjectId, vid: ObjectId, stageId: string, chapterId = '') {
        this.checkPerm(PERM.PERM_EDIT_TRAINING);
        const stage = findStage(this.vpdoc!.stages || [], stageId);
        if (!stage) throw new NotFoundError('阶段不存在。');
        const chapter = chapterId ? findChapterInStage(stage, chapterId) : null;
        if (chapterId && !chapter) throw new NotFoundError('章不存在。');
        this.response.template = 'course_package_chapter_edit.html';
        this.response.body = {
            page_name: chapterId ? 'course_package_chapter_edit' : 'course_package_chapter_create',
            cpdoc: this.cpdoc,
            vpdoc: this.vpdoc,
            stage,
            chapter,
        };
    }

    @param('cpid', Types.ObjectId)
    @param('vid', Types.ObjectId)
    @param('stageId', Types.String)
    @param('chapterId', Types.String, true)
    @param('title', Types.Title)
    @param('content', Types.Content, true)
    async post({ domainId }, cpid: ObjectId, vid: ObjectId, stageId: string, chapterId: string, title: string, content = '') {
        this.checkPerm(PERM.PERM_EDIT_TRAINING);
        chapterId ||= '';
        const stages = this.vpdoc!.stages || [];
        const stage = findStage(stages, stageId);
        if (!stage) throw new NotFoundError('阶段不存在。');
        if (chapterId) {
            const chapter = findChapterInStage(stage, chapterId);
            if (!chapter) throw new NotFoundError('章不存在。');
            chapter.title = title;
            chapter.content = content || '';
        } else {
            stage.chapters.push({ id: uid(), title, content: content || '', lessons: [] });
        }
        await CoursePackageModel.setVersionStages(domainId, vid, stages);
        this.response.redirect = this.url('course_package_version_detail', { cpid, vid });
    }

    @param('cpid', Types.ObjectId)
    @param('vid', Types.ObjectId)
    @param('stageId', Types.String)
    @param('chapterId', Types.String)
    async postDelete({ domainId }, cpid: ObjectId, vid: ObjectId, stageId: string, chapterId: string) {
        this.checkPerm(PERM.PERM_EDIT_TRAINING);
        const stages = this.vpdoc!.stages || [];
        const stage = findStage(stages, stageId);
        if (!stage) throw new NotFoundError('阶段不存在。');
        const length = stage.chapters.length;
        stage.chapters = stage.chapters.filter((chapter) => chapter.id !== chapterId);
        if (stage.chapters.length === length) throw new NotFoundError('章不存在。');
        await CoursePackageModel.setVersionStages(domainId, vid, stages);
        this.response.redirect = this.url('course_package_version_detail', { cpid, vid });
    }
}

class CoursePackageLessonEditHandler extends CoursePackageBaseHandler {
    @param('cpid', Types.ObjectId)
    @param('vid', Types.ObjectId)
    @param('stageId', Types.String)
    @param('chapterId', Types.String)
    @param('lessonId', Types.String, true)
    async get({ domainId }, cpid: ObjectId, vid: ObjectId, stageId: string, chapterId: string, lessonId = '') {
        this.checkPerm(PERM.PERM_EDIT_TRAINING);
        const stage = findStage(this.vpdoc!.stages || [], stageId);
        if (!stage) throw new NotFoundError('阶段不存在。');
        const chapter = findChapterInStage(stage, chapterId);
        if (!chapter) throw new NotFoundError('章不存在。');
        const lesson = lessonId ? findLessonInChapter(chapter, lessonId) : null;
        if (lessonId && !lesson) throw new NotFoundError('节不存在。');
        this.response.template = 'course_package_lesson_edit.html';
        this.response.body = {
            page_name: lessonId ? 'course_package_lesson_edit' : 'course_package_lesson_create',
            cpdoc: this.cpdoc,
            vpdoc: this.vpdoc,
            stage,
            chapter,
            lesson,
        };
    }

    @param('cpid', Types.ObjectId)
    @param('vid', Types.ObjectId)
    @param('stageId', Types.String)
    @param('chapterId', Types.String)
    @param('lessonId', Types.String, true)
    @param('title', Types.Title)
    @param('content', Types.Content, true)
    @param('pids', Types.Content)
    @param('tags', Types.String, true)
    async post(
        { domainId },
        cpid: ObjectId, vid: ObjectId, stageId: string, chapterId: string, lessonId: string,
        title: string, content = '', pidsText: string, tags = '',
    ) {
        this.checkPerm(PERM.PERM_EDIT_TRAINING);
        lessonId ||= '';
        const stages = this.vpdoc!.stages || [];
        const stage = findStage(stages, stageId);
        if (!stage) throw new NotFoundError('阶段不存在。');
        const chapter = findChapterInStage(stage, chapterId);
        if (!chapter) throw new NotFoundError('章不存在。');
        const pids = normalizeIds(pidsText);
        await ensureProblemIds(domainId, pids);
        if (lessonId) {
            const lesson = findLessonInChapter(chapter, lessonId);
            if (!lesson) throw new NotFoundError('节不存在。');
            lesson.title = title;
            lesson.content = content || '';
            lesson.pids = pids;
            lesson.tags = normalizeTags(tags);
        } else {
            chapter.lessons.push({ id: uid(), title, content: content || '', pids, tags: normalizeTags(tags) });
        }
        await CoursePackageModel.setVersionStages(domainId, vid, stages);
        this.response.redirect = this.url('course_package_version_detail', { cpid, vid });
    }

    @param('cpid', Types.ObjectId)
    @param('vid', Types.ObjectId)
    @param('stageId', Types.String)
    @param('chapterId', Types.String)
    @param('lessonId', Types.String)
    async postDelete({ domainId }, cpid: ObjectId, vid: ObjectId, stageId: string, chapterId: string, lessonId: string) {
        this.checkPerm(PERM.PERM_EDIT_TRAINING);
        const stages = this.vpdoc!.stages || [];
        const stage = findStage(stages, stageId);
        if (!stage) throw new NotFoundError('阶段不存在。');
        const chapter = findChapterInStage(stage, chapterId);
        if (!chapter) throw new NotFoundError('章不存在。');
        const length = chapter.lessons.length;
        chapter.lessons = chapter.lessons.filter((lesson) => lesson.id !== lessonId);
        if (chapter.lessons.length === length) throw new NotFoundError('节不存在。');
        await CoursePackageModel.setVersionStages(domainId, vid, stages);
        this.response.redirect = this.url('course_package_version_detail', { cpid, vid });
    }
}

class CoursePackageExportHandler extends CoursePackageBaseHandler {
    @param('cpid', Types.ObjectId)
    @param('vid', Types.ObjectId)
    async get({ domainId }, cpid: ObjectId, vid: ObjectId) {
        const payload = buildExport(this.cpdoc!, this.vpdoc!);
        this.binary(JSON.stringify(payload, null, 2), `${safeFilename(this.cpdoc!.title)}-${safeFilename(this.vpdoc!.version)}.json`);
    }
}

class CoursePackageImportHandler extends Handler {
    async get() {
        this.checkPerm(PERM.PERM_CREATE_TRAINING);
        this.response.template = 'course_package_import.html';
        this.response.body = { page_name: 'course_package_import' };
    }

    @param('payload', Types.Content)
    async post({ domainId }, payloadText: string) {
        this.checkPerm(PERM.PERM_CREATE_TRAINING);
        const payload = parseImportPayload(payloadText);
        if (!payload.package.title) throw new ValidationError('payload', null, '导入数据缺少课程包标题。');
        const cpid = await CoursePackageModel.add(domainId, this.user._id, payload.package.title, payload.package.content, payload.package.pin, payload.package.tags);
        const treeText = payload.version.treeText || JSON.stringify({ stages: payload.version.stages }, null, 2);
        const vid = await CoursePackageModel.addVersion(
            domainId, cpid, this.user._id,
            payload.version.title || payload.version.version || '默认版本',
            payload.version.version || 'v1',
            payload.version.content,
            treeText,
            0,
        );
        this.response.redirect = this.url('course_package_version_detail', { cpid, vid });
    }
}

class CoursePackageCopyHandler extends CoursePackageBaseHandler {
    @param('cpid', Types.ObjectId)
    @param('vid', Types.ObjectId)
    @param('mode', Types.Range(['package', 'stage', 'chapter', 'lesson']), true)
    @param('nodeId', Types.String, true)
    async get({ domainId }, cpid: ObjectId, vid: ObjectId, mode: CopyMode = 'package', nodeId = '') {
        this.checkPerm(PERM.PERM_EDIT_TRAINING);
        const course = getCourseModel();
        const courses = course?.getMulti
            ? await course.getMulti(domainId, {}).toArray()
            : [];
        this.response.template = 'course_package_copy.html';
        this.response.body = { page_name: 'course_package_copy', cpdoc: this.cpdoc, vpdoc: this.vpdoc, mode, nodeId, courses };
    }

    @param('cpid', Types.ObjectId)
    @param('vid', Types.ObjectId)
    @param('mode', Types.Range(['package', 'stage', 'chapter', 'lesson']))
    @param('nodeId', Types.String, true)
    @param('targetCourseId', Types.ObjectId)
    async post({ domainId }, cpid: ObjectId, vid: ObjectId, mode: CopyMode, nodeId: string, targetCourseId: ObjectId) {
        this.checkPerm(PERM.PERM_EDIT_TRAINING);
        await copySelectionToCourse(domainId, targetCourseId, this.user._id, this.vpdoc!.stages || [], mode, nodeId);
        this.response.redirect = this.url('course_detail', { cid: targetCourseId });
    }
}

export async function apply(ctx: Context) {
    ctx.Route('course_package_main', '/course-package', CoursePackageMainHandler, PERM.PERM_VIEW_TRAINING);
    ctx.Route('course_package_create', '/course-package/create', CoursePackageEditHandler, PERM.PERM_CREATE_TRAINING);
    ctx.Route('course_package_import', '/course-package/import', CoursePackageImportHandler, PERM.PERM_CREATE_TRAINING);
    ctx.Route('course_package_detail', '/course-package/:cpid', CoursePackageDetailHandler, PERM.PERM_VIEW_TRAINING);
    ctx.Route('course_package_edit', '/course-package/:cpid/edit', CoursePackageEditHandler, PERM.PERM_EDIT_TRAINING);
    ctx.Route('course_package_version_create', '/course-package/:cpid/version/create', CoursePackageVersionEditHandler, PERM.PERM_EDIT_TRAINING);
    ctx.Route('course_package_version_detail', '/course-package/:cpid/version/:vid', CoursePackageVersionDetailHandler, PERM.PERM_VIEW_TRAINING);
    ctx.Route('course_package_version_edit', '/course-package/:cpid/version/:vid/edit', CoursePackageVersionEditHandler, PERM.PERM_EDIT_TRAINING);
    ctx.Route('course_package_stage_create', '/course-package/:cpid/version/:vid/stage/create', CoursePackageStageEditHandler, PERM.PERM_EDIT_TRAINING);
    ctx.Route('course_package_stage_edit', '/course-package/:cpid/version/:vid/stage/:stageId/edit', CoursePackageStageEditHandler, PERM.PERM_EDIT_TRAINING);
    ctx.Route('course_package_chapter_create', '/course-package/:cpid/version/:vid/stage/:stageId/chapter/create', CoursePackageChapterEditHandler, PERM.PERM_EDIT_TRAINING);
    ctx.Route('course_package_chapter_edit', '/course-package/:cpid/version/:vid/stage/:stageId/chapter/:chapterId/edit', CoursePackageChapterEditHandler, PERM.PERM_EDIT_TRAINING);
    ctx.Route('course_package_lesson_create', '/course-package/:cpid/version/:vid/stage/:stageId/chapter/:chapterId/lesson/create', CoursePackageLessonEditHandler, PERM.PERM_EDIT_TRAINING);
    ctx.Route('course_package_lesson_edit', '/course-package/:cpid/version/:vid/stage/:stageId/chapter/:chapterId/lesson/:lessonId/edit', CoursePackageLessonEditHandler, PERM.PERM_EDIT_TRAINING);
    ctx.Route('course_package_export', '/course-package/:cpid/version/:vid/export', CoursePackageExportHandler, PERM.PERM_VIEW_TRAINING);
    ctx.Route('course_package_copy', '/course-package/:cpid/version/:vid/copy', CoursePackageCopyHandler, PERM.PERM_EDIT_TRAINING);

    ctx.injectUI('Nav', 'course_package_main', { prefix: 'course-package', before: 'course_main' });
    ctx.inject(['setting'], (c) => {
        c.setting.SystemSetting(
            SettingModel.Setting('setting_basic', 'pagination.coursePackage', 20, 'number', 'pagination.coursePackage', 'Course packages per page'),
        );
    });
    ctx.i18n.load('zh', {
        course_package_main: '课程包',
        course_package_create: '创建课程包',
        course_package_edit: '编辑课程包',
        course_package_detail: '课程包详情',
        course_package_version_create: '创建课程包版本',
        course_package_version_edit: '编辑课程包版本',
        course_package_version_detail: '课程包版本',
        course_package_stage_create: '创建阶段',
        course_package_stage_edit: '编辑阶段',
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
        course_package_stage_create: 'Create Stage',
        course_package_stage_edit: 'Edit Stage',
        course_package_chapter_create: 'Create Chapter',
        course_package_chapter_edit: 'Edit Chapter',
        course_package_lesson_create: 'Create Lesson',
        course_package_lesson_edit: 'Edit Lesson',
        course_package_import: 'Import Course Package',
        course_package_copy: 'Copy to Course',
        CoursePackage: 'Course Package',
    });
}
