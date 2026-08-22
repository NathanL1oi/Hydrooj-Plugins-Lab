'use strict';

const {
    ContestModel,
    DomainModel,
    ForbiddenError,
    Handler,
    NotFoundError,
    ObjectId,
    PERM,
    PRIV,
    StorageModel,
    UserModel,
    ValidationError,
    db,
} = require('hydrooj');
const vodAdapter = require('./lib/vodAdapter');

const collAsset = db.collection('course.video.asset');
const collBinding = db.collection('course.video.binding');
const collSetting = db.collection('course.video.setting');
const collConfig = db.collection('course.video.config');
const collCategory = db.collection('course.video.category');
const collFolder = db.collection('course.video.folder');
const collPackageCopy = db.collection('course.video.package.copy');
const CONFIG_ID = 'vod';
const LOCAL_PROVIDER = 'local';
const VOD_PROVIDER = 'vod';
const DEFAULT_CATEGORIES = ['语法', '入门', '基础', '提高', '比赛-语法', '比赛-入门'];

function domainIdOf(handler) {
    return String(handler.args?.domainId || handler.domain?._id || 'system');
}

function idText(value) {
    return value?.toHexString?.() || value?.toString?.() || String(value || '');
}

function asDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}

function toObjectId(value, field = 'id') {
    try {
        if (value?.toHexString) return value;
        return new ObjectId(String(value));
    } catch {
        throw new ValidationError(field);
    }
}

function cleanText(value, max = 160) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanCredential(value, label, max = 180) {
    const text = cleanText(value, max);
    return text.replace(new RegExp(`^${label}\\s*[:\\uFF1A]\\s*`, 'i'), '');
}

function errorText(err) {
    if (!err) return '请求失败。';
    if (err.message && err.message !== err.name) return err.message;
    return err.params?.[0] || err.args?.[0] || err.name || String(err);
}

function isVodResourceMissing(err) {
    return /^ResourceNotFound\b/.test(errorText(err));
}

function firstValue(value) {
    return Array.isArray(value) ? value[0] : value;
}

function formValue(handler, name) {
    return firstValue(handler.args?.[name] ?? handler.request?.body?.[name] ?? handler.request?.query?.[name]);
}

function routeValue(handler, name) {
    return firstValue(handler.args?.[name] ?? handler.request?.params?.[name] ?? handler.request?.query?.[name]);
}

function withQuery(url, query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
    }
    const qs = params.toString();
    if (!qs) return url;
    return `${url}${url.includes('?') ? '&' : '?'}${qs}`;
}

function asBool(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on', 'enabled', 'show'].includes(String(value).toLowerCase());
}

function canBindVideo(user) {
    return !!user?.hasPriv?.(PRIV.PRIV_EDIT_SYSTEM);
}

function canToggleStudentVideo(user) {
    return canBindVideo(user) || !!user?.hasPerm?.(PERM.PERM_EDIT_DOMAIN);
}

function groupNames(groups) {
    return (groups || []).map((group) => group?.name || group).filter(Boolean);
}

async function canAccessCourse(handler, domainId, courseId, status) {
    if (status?.enroll) return true;
    const course = courseModel();
    if (!course?.get) return false;
    const cdoc = await course.get(domainId, toObjectId(courseId, 'courseId'));
    if (!cdoc?.assign?.length) return true;
    const names = groupNames(await UserModel.listGroup(domainId, handler.user._id));
    return cdoc.assign.some((name) => names.includes(name));
}

function assertCanBindVideo(handler) {
    if (!canBindVideo(handler.user)) throw new ForbiddenError('没有课程视频绑定权限。');
}

function assertCanToggleStudentVideo(handler) {
    if (!canToggleStudentVideo(handler.user)) throw new ForbiddenError('没有课程视频学生可见开关权限。');
}

function assertSystemVideoAdmin(handler) {
    handler.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
    if (domainIdOf(handler) !== 'system') throw new ForbiddenError('课程视频库只能在主域上传和管理。');
}

function courseModel() {
    return global.Hydro?.model?.course;
}

function coursePackageModel() {
    return global.Hydro?.model?.coursePackage;
}

async function listDomains() {
    try {
        return await DomainModel.getMulti({}).sort({ _id: 1 }).toArray();
    } catch (err) {
        return [];
    }
}

async function getVodConfig() {
    return await collConfig.findOne({ _id: CONFIG_ID }) || {};
}

function publicConfig(config) {
    return {
        appId: config.appId || '',
        subAppId: config.subAppId || '',
        playExpireSeconds: Number(config.playExpireSeconds || 1800),
        uploadExpireSeconds: Number(config.uploadExpireSeconds || 7200),
        hasSecretId: !!config.secretId,
        hasSecretKey: !!config.secretKey,
        hasPlayKey: !!config.playKey,
        ready: !!((config.appId || config.subAppId) && (config.playKey || (config.secretId && config.secretKey))),
    };
}

async function getCourseSetting(domainId, courseId) {
    const doc = await collSetting.findOne({ domainId, courseId: idText(courseId) });
    return {
        domainId,
        courseId: idText(courseId),
        studentVideoEnabled: doc?.studentVideoEnabled !== false,
    };
}

function assetPublic(asset) {
    if (!asset) return null;
    const folderCourseId = asset.folderCourseId || '';
    const folderCourseName = asset.folderCourseName || '';
    const folderChapterId = asset.folderChapterId || '';
    const folderChapterName = asset.folderChapterName || '';
    const hierarchy = [folderCourseName, folderChapterName].filter(Boolean).join(' / ');
    return {
        id: idText(asset._id),
        provider: asset.provider || (asset.storagePath ? LOCAL_PROVIDER : VOD_PROVIDER),
        fileId: asset.fileId || '',
        title: asset.title || asset.filename || asset.fileId,
        filename: asset.filename || '',
        categoryId: idText(asset.categoryId),
        categoryName: asset.categoryName || '',
        size: Number(asset.size || 0),
        duration: Number(asset.duration || 0),
        coverUrl: asset.coverUrl || '',
        status: asset.status || 'ready',
        folderCourseId,
        folderCourseName,
        folderChapterId,
        folderChapterName,
        courseId: folderCourseId,
        courseTitle: folderCourseName,
        sectionId: folderChapterId,
        sectionTitle: folderChapterName,
        subSectionId: '',
        subSectionTitle: '',
        hierarchyLabel: hierarchy || '',
    };
}

function folderPublic(folder) {
    return {
        id: idText(folder._id),
        type: folder.type,
        parentId: folder.parentId || '',
        name: folder.name || '',
        order: Number(folder.order || 0),
    };
}

function categoryPublic(category) {
    return {
        id: idText(category._id),
        name: category.name,
        order: Number(category.order || 0),
    };
}

function bindingPublic(binding, asset) {
    if (!binding) return null;
    return {
        id: idText(binding._id),
        kind: binding.kind,
        assetId: idText(binding.assetId),
        fileId: binding.fileId,
        studentVisible: binding.studentVisible !== false,
        required: !!binding.required,
        asset: assetPublic(asset),
    };
}

function packageBindingFilter(domainId, packageId, versionId, chapterId, lessonId) {
    return {
        domainId,
        kind: 'packageLesson',
        packageId: idText(packageId),
        versionId: idText(versionId),
        chapterId: String(chapterId || ''),
        lessonId: String(lessonId || ''),
    };
}

function courseBindingFilter(domainId, courseId, sectionId, subSectionId) {
    return {
        domainId,
        kind: 'courseSubsec',
        courseId: idText(courseId),
        sectionId: idText(sectionId),
        subSectionId: idText(subSectionId),
    };
}

function packageCopyFilter(sourceDomainId, packageId, versionId, chapterId, lessonId) {
    return {
        sourceDomainId: String(sourceDomainId || ''),
        packageId: idText(packageId),
        versionId: idText(versionId),
        chapterId: String(chapterId || ''),
        lessonId: String(lessonId || ''),
    };
}

function packageCopyDoc(sourceDomainId, targetDomainId, packageId, versionId, chapterId, lessonId, courseId, sectionId, subSectionId) {
    return {
        ...packageCopyFilter(sourceDomainId, packageId, versionId, chapterId, lessonId),
        targetDomainId: String(targetDomainId || ''),
        targetCourseId: idText(courseId),
        targetSectionId: idText(sectionId),
        targetSubSectionId: idText(subSectionId),
    };
}

async function listCategories() {
    return await collCategory.find({ status: { $ne: 'deleted' } }).sort({ order: 1, createdAt: 1 }).toArray();
}

async function getCategory(categoryId) {
    if (!categoryId) return null;
    const category = await collCategory.findOne({ _id: toObjectId(categoryId, 'categoryId'), status: { $ne: 'deleted' } });
    if (!category) throw new NotFoundError('course video category');
    return category;
}

async function listAssets(domainId, limit = 80, options = {}) {
    const filter = { status: { $ne: 'deleted' } };
    if (!options.includeLegacyLocal) filter.provider = VOD_PROVIDER;
    if (options.categoryId) filter.categoryId = idText(options.categoryId);
    if (options.courseId || options.folderCourseId) filter.folderCourseId = idText(options.folderCourseId || options.courseId);
    if (options.chapterId || options.folderChapterId || options.sectionId) filter.folderChapterId = idText(options.folderChapterId || options.chapterId || options.sectionId);
    return await collAsset.find(filter).sort({ updatedAt: -1, createdAt: -1 }).limit(limit).toArray();
}

async function getAsset(domainId, assetId) {
    const asset = await collAsset.findOne({ _id: toObjectId(assetId, 'assetId'), status: { $ne: 'deleted' } });
    if (!asset) throw new NotFoundError('course video asset');
    return asset;
}

async function findBindingWithAsset(filter) {
    const binding = await collBinding.findOne(filter);
    if (!binding?.assetId) return { binding, asset: null };
    const asset = await collAsset.findOne({ _id: binding.assetId, status: { $ne: 'deleted' } });
    return { binding, asset };
}

async function listFolderTree() {
    const [courses, chapters] = await Promise.all([
        collFolder.find({ type: 'course', status: { $ne: 'deleted' } }).sort({ order: 1, createdAt: 1 }).toArray(),
        collFolder.find({ type: 'chapter', status: { $ne: 'deleted' } }).sort({ order: 1, createdAt: 1 }).toArray(),
    ]);
    const chapterMap = new Map();
    for (const chapter of chapters) {
        const key = chapter.parentId || '';
        if (!chapterMap.has(key)) chapterMap.set(key, []);
        chapterMap.get(key).push(folderPublic(chapter));
    }
    return courses.map((course) => ({
        ...folderPublic(course),
        chapters: chapterMap.get(idText(course._id)) || [],
    }));
}

async function getFolder(folderId, type, field) {
    if (!folderId) throw new ValidationError(field);
    const folder = await collFolder.findOne({
        _id: toObjectId(folderId, field),
        type,
        status: { $ne: 'deleted' },
    });
    if (!folder) throw new NotFoundError(`course video ${type}`);
    return folder;
}

async function getFolderById(folderId, field = 'folderId') {
    if (!folderId) throw new ValidationError(field);
    const folder = await collFolder.findOne({
        _id: toObjectId(folderId, field),
        status: { $ne: 'deleted' },
    });
    if (!folder) throw new NotFoundError('course video folder');
    return folder;
}

function deletedFolderName(folder) {
    return `${folder.name || 'folder'}#deleted#${idText(folder._id)}`.slice(0, 160);
}

async function resolveVideoFolder(courseId, chapterId, required = false) {
    const folderCourseId = idText(courseId);
    const folderChapterId = idText(chapterId);
    if (!folderCourseId && !folderChapterId) {
        if (required) throw new ValidationError('folderCourseId');
        return {
            folderCourseId: '',
            folderCourseName: '',
            folderChapterId: '',
            folderChapterName: '',
        };
    }
    if (!folderCourseId) throw new ValidationError('folderCourseId');
    if (!folderChapterId) throw new ValidationError('folderChapterId');
    const [course, chapter] = await Promise.all([
        getFolder(folderCourseId, 'course', 'folderCourseId'),
        getFolder(folderChapterId, 'chapter', 'folderChapterId'),
    ]);
    if (chapter.parentId !== idText(course._id)) throw new ValidationError('folderChapterId');
    return {
        folderCourseId: idText(course._id),
        folderCourseName: course.name,
        folderChapterId: idText(chapter._id),
        folderChapterName: chapter.name,
    };
}

function docTitle(doc, fallback = '') {
    return cleanText(doc?.title || doc?.name || fallback, 120);
}

async function listCourseTree(domainId) {
    const course = courseModel();
    if (!course?.getMulti || !course?.getMultiSection) return [];
    try {
        const cursor = course.getMulti(domainId, {});
        const cdocs = await (cursor.limit ? cursor.limit(120) : cursor).toArray();
        const rows = [];
        for (const cdoc of cdocs || []) {
            const courseId = idText(cdoc.docId);
            const sections = [];
            const sectionDocs = await course.getMultiSection(domainId, cdoc.docId).toArray();
            for (const section of sectionDocs || []) {
                const sectionId = idText(section.docId);
                const lessons = (section.dag || []).map((node, index) => ({
                    id: idText(node._id || node.docId || `lesson-${index + 1}`),
                    title: docTitle(node, `第 ${index + 1} 节`),
                }));
                sections.push({
                    id: sectionId,
                    title: docTitle(section, '未命名章节'),
                    lessons,
                });
            }
            rows.push({
                id: courseId,
                title: docTitle(cdoc, `课程 ${courseId}`),
                sections,
            });
        }
        return rows;
    } catch (err) {
        return [];
    }
}

async function resolveCoursePath(domainId, courseId, sectionId, subSectionId) {
    const courseIdText = idText(courseId);
    const sectionIdText = idText(sectionId);
    const subSectionIdText = idText(subSectionId);
    if (!courseIdText) return {};
    const course = courseModel();
    const path = {
        courseId: courseIdText,
        courseTitle: '',
        sectionId: sectionIdText,
        sectionTitle: '',
        subSectionId: subSectionIdText,
        subSectionTitle: '',
    };
    if (!course) return path;
    try {
        if (course.get) {
            const cdoc = await course.get(domainId, toObjectId(courseIdText, 'courseId'));
            path.courseTitle = docTitle(cdoc, `课程 ${courseIdText}`);
        }
    } catch (err) {
        path.courseTitle = `课程 ${courseIdText}`;
    }
    if (!sectionIdText) return path;
    try {
        if (course.getSubSection && subSectionIdText) {
            const [section, subSection] = await course.getSubSection(
                domainId,
                toObjectId(sectionIdText, 'sectionId'),
                toObjectId(subSectionIdText, 'subSectionId'),
            );
            path.sectionTitle = docTitle(section, `章 ${sectionIdText}`);
            path.subSectionTitle = docTitle(subSection, `节 ${subSectionIdText}`);
            return path;
        }
        if (course.getSection) {
            const section = await course.getSection(domainId, toObjectId(sectionIdText, 'sectionId'));
            path.sectionTitle = docTitle(section, `章 ${sectionIdText}`);
        }
    } catch (err) {
        path.sectionTitle ||= `章 ${sectionIdText}`;
        if (subSectionIdText) path.subSectionTitle ||= `节 ${subSectionIdText}`;
    }
    return path;
}

function buildAssetGroups(assets) {
    const courses = new Map();
    function ensure(map, key, create) {
        if (!map.has(key)) map.set(key, create());
        return map.get(key);
    }
    for (const asset of assets || []) {
        const courseKey = asset.courseId || '__unfiled_course';
        const course = ensure(courses, courseKey, () => ({
            id: asset.courseId || '',
            title: asset.courseTitle || '未归档课程',
            count: 0,
            sections: new Map(),
        }));
        course.count += 1;
        const sectionKey = asset.sectionId || '__unfiled_section';
        const section = ensure(course.sections, sectionKey, () => ({
            id: asset.sectionId || '',
            title: asset.sectionTitle || '未归档章节',
            count: 0,
            assets: [],
        }));
        section.count += 1;
        section.assets.push(asset);
    }
    return Array.from(courses.values()).map((course) => ({
        ...course,
        sections: Array.from(course.sections.values()),
    }));
}

function buildFolderAssetGroups(assets, folderTree = []) {
    const courseOrder = new Map();
    const chapterOrder = new Map();
    for (const [courseIndex, course] of (folderTree || []).entries()) {
        courseOrder.set(course.id, Number(course.order || courseIndex));
        for (const [chapterIndex, chapter] of (course.chapters || []).entries()) {
            chapterOrder.set(chapter.id, Number(chapter.order || chapterIndex));
        }
    }
    const courses = new Map();
    function ensure(map, key, create) {
        if (!map.has(key)) map.set(key, create());
        return map.get(key);
    }
    for (const asset of assets || []) {
        const courseKey = asset.folderCourseId || '__unfiled_course';
        const course = ensure(courses, courseKey, () => ({
            id: asset.folderCourseId || '',
            title: asset.folderCourseName || '未归档课程',
            count: 0,
            chapters: new Map(),
        }));
        course.count += 1;
        const chapterKey = asset.folderChapterId || '__unfiled_chapter';
        const chapter = ensure(course.chapters, chapterKey, () => ({
            id: asset.folderChapterId || '',
            title: asset.folderChapterName || '未归档章',
            count: 0,
            assets: [],
        }));
        chapter.count += 1;
        chapter.assets.push(asset);
    }
    return Array.from(courses.values()).map((course) => ({
        ...course,
        chapters: Array.from(course.chapters.values()).sort((a, b) => (
            (chapterOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (chapterOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER)
            || String(a.title).localeCompare(String(b.title), 'zh-Hans-CN')
        )),
    })).sort((a, b) => (
        (courseOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (courseOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER)
        || String(a.title).localeCompare(String(b.title), 'zh-Hans-CN')
    ));
}

async function saveBinding(domainId, filter, assetId, options = {}) {
    const now = new Date();
    if (!assetId) {
        await collBinding.deleteOne(filter);
        return null;
    }
    const asset = await getAsset(domainId, assetId);
    const provider = asset.provider || (asset.storagePath ? LOCAL_PROVIDER : VOD_PROVIDER);
    if (provider !== VOD_PROVIDER) throw new ValidationError('assetId', null, '课程视频必须绑定腾讯云 VOD 视频，请重新上传到 VOD。');
    const doc = {
        ...filter,
        assetId: asset._id,
        fileId: asset.fileId || '',
        studentVisible: true,
        required: false,
        updatedAt: now,
    };
    await collBinding.updateOne(filter, { $set: doc, $setOnInsert: { _id: new ObjectId(), createdAt: now } }, { upsert: true });
    return await collBinding.findOne(filter);
}

async function applyPackageLessonBindingToCourseSubsec(sourceDomainId, targetDomainId, packageId, versionId, chapterId, lessonId, courseId, sectionId, subSectionId) {
    const source = await collBinding.findOne(packageBindingFilter(sourceDomainId, packageId, versionId, chapterId, lessonId));
    const targetFilter = courseBindingFilter(targetDomainId, courseId, sectionId, subSectionId);
    if (!source?.assetId) {
        await collBinding.deleteOne(targetFilter);
        return null;
    }
    return await saveBinding(
        targetDomainId,
        targetFilter,
        source.assetId,
        {},
    );
}

async function copyPackageLessonBindingToCourseSubsec(sourceDomainId, targetDomainId, packageId, versionId, chapterId, lessonId, courseId, sectionId, subSectionId) {
    return await applyPackageLessonBindingToCourseSubsec(
        sourceDomainId,
        targetDomainId,
        packageId,
        versionId,
        chapterId,
        lessonId,
        courseId,
        sectionId,
        subSectionId,
    );
}

async function recordPackageLessonCopy(sourceDomainId, targetDomainId, packageId, versionId, chapterId, lessonId, courseId, sectionId, subSectionId) {
    const doc = packageCopyDoc(sourceDomainId, targetDomainId, packageId, versionId, chapterId, lessonId, courseId, sectionId, subSectionId);
    if (!doc.sourceDomainId || !doc.packageId || !doc.versionId || !doc.chapterId || !doc.lessonId
        || !doc.targetDomainId || !doc.targetCourseId || !doc.targetSectionId || !doc.targetSubSectionId) {
        return { recorded: false, binding: null };
    }
    const now = new Date();
    await collPackageCopy.updateOne(
        doc,
        {
            $set: { ...doc, updatedAt: now },
            $setOnInsert: { _id: new ObjectId(), createdAt: now },
        },
        { upsert: true },
    );
    const binding = await applyPackageLessonBindingToCourseSubsec(
        doc.sourceDomainId,
        doc.targetDomainId,
        doc.packageId,
        doc.versionId,
        doc.chapterId,
        doc.lessonId,
        doc.targetCourseId,
        doc.targetSectionId,
        doc.targetSubSectionId,
    );
    return { recorded: true, binding };
}

async function recordPackageLessonCopies(sourceDomainId, targetDomainId, packageId, versionId, items = []) {
    const result = { recorded: 0, synced: 0, cleared: 0 };
    for (const item of items || []) {
        const row = await recordPackageLessonCopy(
            sourceDomainId,
            targetDomainId,
            packageId,
            versionId,
            item.chapterId,
            item.lessonId,
            item.courseId,
            item.sectionId,
            item.subSectionId,
        );
        if (!row.recorded) continue;
        result.recorded += 1;
        if (row.binding) result.synced += 1;
        else result.cleared += 1;
    }
    return result;
}

async function syncPackageLessonBindingToCopiedSubsecs(sourceDomainId, packageId, versionId, chapterId, lessonId) {
    const filter = packageCopyFilter(sourceDomainId, packageId, versionId, chapterId, lessonId);
    const copies = await collPackageCopy.find(filter).toArray();
    const result = { matched: copies.length, synced: 0, cleared: 0 };
    for (const copy of copies) {
        const binding = await applyPackageLessonBindingToCourseSubsec(
            filter.sourceDomainId,
            copy.targetDomainId,
            filter.packageId,
            filter.versionId,
            filter.chapterId,
            filter.lessonId,
            copy.targetCourseId,
            copy.targetSectionId,
            copy.targetSubSectionId,
        );
        if (binding) result.synced += 1;
        else result.cleared += 1;
    }
    return result;
}

function normalizeCopyMatchText(value) {
    return String(value || '')
        .normalize?.('NFKC')
        .replace(/\s+/g, '')
        .replace(/[()（）【】\[\]{}<>《》]/g, '')
        .toLowerCase();
}

function addCopyMatchKey(set, value) {
    const key = normalizeCopyMatchText(value);
    if (key) set.add(key);
}

function buildExpectedCopiedCourseTitleKeys(pkg, version, chapters) {
    const keys = new Set();
    const packageTitle = docTitle(pkg, '');
    const versionTitle = docTitle(version, '');
    addCopyMatchKey(keys, packageTitle);
    addCopyMatchKey(keys, versionTitle);
    if (packageTitle && versionTitle && packageTitle !== versionTitle) addCopyMatchKey(keys, `${packageTitle}-${versionTitle}`);
    for (const chapter of chapters || []) {
        addCopyMatchKey(keys, `${packageTitle}-${chapter.title}`);
        for (const lesson of chapter.lessons || []) addCopyMatchKey(keys, `${packageTitle}-${lesson.title}`);
    }
    return keys;
}

function copiedCourseTitleLooksRelated(title, expectedKeys) {
    const key = normalizeCopyMatchText(title);
    if (!key) return false;
    if (expectedKeys.has(key)) return true;
    for (const expected of expectedKeys) {
        if (expected.length >= 2 && (key.includes(expected) || expected.includes(key))) return true;
    }
    return false;
}

function filterPackageChaptersForBackfill(chapters, chapterId = '', lessonId = '') {
    const chapterKey = String(chapterId || '');
    const lessonKey = String(lessonId || '');
    return (chapters || []).map((chapter) => {
        if (chapterKey && String(chapter.id || '') !== chapterKey) return null;
        const lessons = (chapter.lessons || []).filter((lesson) => !lessonKey || String(lesson.id || '') === lessonKey);
        if (!lessons.length) return null;
        return { ...chapter, lessons };
    }).filter(Boolean);
}

async function backfillPackageCopyMappingsByStructure(sourceDomainId, packageId, versionId, options = {}) {
    const pkgModel = coursePackageModel();
    const course = courseModel();
    const result = { domains: 0, courses: 0, matched: 0, backfilled: 0 };
    if (!pkgModel?.get || !pkgModel?.getVersion || !course?.getMulti || !course?.getMultiSection) return result;
    const [pkg, version] = await Promise.all([
        pkgModel.get(sourceDomainId, toObjectId(packageId, 'packageId')),
        pkgModel.getVersion(sourceDomainId, toObjectId(versionId, 'versionId')),
    ]);
    if (!pkg || !version) return result;
    const chapters = filterPackageChaptersForBackfill(version.chapters || [], options.chapterId, options.lessonId);
    if (!chapters.length) return result;
    const expectedCourseTitleKeys = buildExpectedCopiedCourseTitleKeys(pkg, version, chapters);
    const domains = await listDomains();
    const domainIds = new Set(domains.map((domain) => idText(domain._id)).filter(Boolean));
    domainIds.add(String(sourceDomainId || ''));
    const now = new Date();
    for (const targetDomainId of domainIds) {
        result.domains += 1;
        const courses = await listCourseTree(targetDomainId);
        for (const targetCourse of courses || []) {
            if (!copiedCourseTitleLooksRelated(targetCourse.title, expectedCourseTitleKeys)) continue;
            result.courses += 1;
            for (const chapter of chapters) {
                const sectionKey = normalizeCopyMatchText(chapter.title);
                const sections = (targetCourse.sections || []).filter((section) => normalizeCopyMatchText(section.title) === sectionKey);
                for (const section of sections) {
                    for (const lesson of chapter.lessons || []) {
                        const lessonKey = normalizeCopyMatchText(lesson.title);
                        const lessonNodes = (section.lessons || []).filter((node) => normalizeCopyMatchText(node.title) === lessonKey);
                        for (const node of lessonNodes) {
                            const doc = packageCopyDoc(
                                sourceDomainId,
                                targetDomainId,
                                packageId,
                                versionId,
                                chapter.id,
                                lesson.id,
                                targetCourse.id,
                                section.id,
                                node.id,
                            );
                            if (!doc.targetDomainId || !doc.targetCourseId || !doc.targetSectionId || !doc.targetSubSectionId) continue;
                            result.matched += 1;
                            const write = await collPackageCopy.updateOne(
                                doc,
                                {
                                    $set: { ...doc, updatedAt: now },
                                    $setOnInsert: { _id: new ObjectId(), createdAt: now },
                                },
                                { upsert: true },
                            );
                            if (write.upsertedCount) result.backfilled += 1;
                        }
                    }
                }
            }
        }
    }
    return result;
}

async function syncPackageVersionBindingsToCopiedSubsecs(sourceDomainId, packageId, versionId) {
    const pkgModel = coursePackageModel();
    if (!pkgModel?.getVersion) throw new ForbiddenError('课程包插件尚未就绪。');
    const version = await pkgModel.getVersion(sourceDomainId, toObjectId(versionId, 'versionId'));
    if (!version) throw new NotFoundError('课程包版本不存在。');
    const backfill = await backfillPackageCopyMappingsByStructure(sourceDomainId, packageId, versionId);
    const result = { lessons: 0, matched: 0, synced: 0, cleared: 0, backfilled: backfill.backfilled };
    for (const chapter of version.chapters || []) {
        for (const lesson of chapter.lessons || []) {
            const chapterId = idText(chapter.id);
            const lessonId = idText(lesson.id);
            if (!chapterId || !lessonId) continue;
            result.lessons += 1;
            const row = await syncPackageLessonBindingToCopiedSubsecs(sourceDomainId, packageId, versionId, chapterId, lessonId);
            result.matched += row.matched || 0;
            result.synced += row.synced || 0;
            result.cleared += row.cleared || 0;
        }
    }
    return result;
}

async function assertCanPlayCourseVideo(handler, asset, query) {
    const domainId = domainIdOf(handler);
    if (canBindVideo(handler.user)) return { canManage: true };
    const canToggle = canToggleStudentVideo(handler.user);
    const courseId = query.courseId || query.cid;
    const sectionId = query.sectionId || query.csid;
    const subSectionId = query.subSectionId || query.ssid;
    if (!courseId || !sectionId || !subSectionId) throw new ForbiddenError('缺少课程上下文。');
    const course = courseModel();
    if (!course?.getStatus) throw new ForbiddenError('课程模型不可用。');
    const [setting, binding, status] = await Promise.all([
        getCourseSetting(domainId, courseId),
        collBinding.findOne(courseBindingFilter(domainId, courseId, sectionId, subSectionId)),
        course.getStatus(domainId, toObjectId(courseId, 'courseId'), handler.user._id),
    ]);
    if (!canToggle && !await canAccessCourse(handler, domainId, courseId, status)) throw new ForbiddenError('你没有查看该课程视频的权限。');
    if (!canToggle && !setting.studentVideoEnabled) throw new ForbiddenError('本节视频暂未对学生开放。');
    if (!binding || idText(binding.assetId) !== idText(asset._id)) throw new ForbiddenError('视频未绑定到该课程小节。');
    return { canManage: canToggle };
}

function contestPackageLessonVideo(tdoc) {
    const link = tdoc?.coursePackageLessonVideo || {};
    if (!link.sourceDomainId || !link.packageId || !link.versionId || !link.chapterId || !link.lessonId) return null;
    return {
        sourceDomainId: String(link.sourceDomainId),
        packageId: idText(link.packageId),
        versionId: idText(link.versionId),
        chapterId: String(link.chapterId),
        lessonId: String(link.lessonId),
    };
}

function canManageContestVideo(handler, tdoc) {
    return canBindVideo(handler.user)
        || handler.user?.own?.(tdoc)
        || !!handler.user?.hasPerm?.(PERM.PERM_EDIT_CONTEST);
}

function isVpLikeContestStatus(tdoc, tsdoc) {
    if (!tsdoc) return false;
    if (tsdoc.vp || tsdoc.virtual || tsdoc.vpStartAt) return true;
    const start = asDate(tsdoc.startAt);
    const contestEnd = asDate(tdoc?.endAt);
    return !!(start && contestEnd && contestEnd <= start);
}

function contestVideoParticipantEndAt(tdoc, tsdoc) {
    const explicitEnd = asDate(tsdoc?.vpEndAt || tsdoc?.endAt);
    if (explicitEnd) return explicitEnd;
    const start = asDate(tsdoc?.vpStartAt || tsdoc?.startAt);
    const duration = Number(tdoc?.duration || 0);
    if (start && Number.isFinite(duration) && duration > 0) {
        return new Date(start.getTime() + Math.floor(duration * 60 * 60 * 1000));
    }
    return null;
}

function isContestVideoDone(tdoc, tsdoc) {
    if (isVpLikeContestStatus(tdoc, tsdoc)) {
        const endAt = contestVideoParticipantEndAt(tdoc, tsdoc);
        return !!(endAt && endAt <= new Date());
    }
    return !!ContestModel.isDone?.(tdoc, tsdoc)
        || (!ContestModel.isDone && new Date(tdoc?.endAt || 0).getTime() <= Date.now());
}

async function contestVideoContext(handler, contestId) {
    const domainId = domainIdOf(handler);
    const tdoc = await ContestModel.get(domainId, toObjectId(contestId, 'contestId'));
    const link = contestPackageLessonVideo(tdoc);
    if (!link) throw new ForbiddenError('该比赛未关联课程包节视频。');
    const tsdoc = await ContestModel.getStatus(domainId, tdoc.docId, handler.user._id);
    const canManage = canManageContestVideo(handler, tdoc);
    const canView = canManage || (!!tsdoc?.attend && isContestVideoDone(tdoc, tsdoc));
    const filter = packageBindingFilter(link.sourceDomainId, link.packageId, link.versionId, link.chapterId, link.lessonId);
    const { binding, asset } = await findBindingWithAsset(filter);
    return { domainId, tdoc, tsdoc, link, binding, asset, canManage, canView };
}

async function assertCanPlayContestVideo(handler, asset, query) {
    const contestId = query.contestId || query.tid;
    if (!contestId) throw new ForbiddenError('缺少比赛上下文。');
    const context = await contestVideoContext(handler, contestId);
    if (!context.canView) throw new ForbiddenError('比赛完成后才能查看讲解视频。');
    if (!context.binding || idText(context.binding.assetId) !== idText(asset._id)) throw new ForbiddenError('视频未绑定到该比赛来源节。');
    return context;
}

class CourseVideoConfigHandler extends Handler {
    async prepare() {
        assertSystemVideoAdmin(this);
    }

    async get() {
        this.response.template = 'course_video_config.html';
        this.response.body = {
            page_name: 'course_video_config',
            config: publicConfig(await getVodConfig()),
        };
    }

    async postSave() {
        const current = await getVodConfig();
        const next = {
            _id: CONFIG_ID,
            appId: cleanText(formValue(this, 'appId'), 40),
            subAppId: cleanText(formValue(this, 'subAppId'), 40),
            secretId: cleanCredential(formValue(this, 'secretId'), 'SecretId', 120) || current.secretId || '',
            secretKey: cleanCredential(formValue(this, 'secretKey'), 'SecretKey', 180) || current.secretKey || '',
            playKey: cleanCredential(formValue(this, 'playKey'), 'PlayKey', 80) || current.playKey || '',
            playExpireSeconds: Number(formValue(this, 'playExpireSeconds') || 1800),
            uploadExpireSeconds: Number(formValue(this, 'uploadExpireSeconds') || 7200),
            updatedAt: new Date(),
            updatedBy: this.user._id,
        };
        await collConfig.updateOne({ _id: CONFIG_ID }, { $set: next }, { upsert: true });
        this.response.redirect = this.url('course_video_config');
    }
}

class CourseVideoMainHandler extends Handler {
    async prepare() {
        assertSystemVideoAdmin(this);
    }

    async get() {
        const domainId = domainIdOf(this);
        const courseId = cleanText(routeValue(this, 'courseId'), 80);
        const chapterId = cleanText(routeValue(this, 'chapterId') || routeValue(this, 'sectionId'), 80);
        const [assets, folderTree] = await Promise.all([
            listAssets(domainId, 300, { courseId, chapterId }),
            listFolderTree(),
        ]);
        const publicAssets = assets.map(assetPublic);
        const chapterCount = folderTree.reduce((sum, course) => sum + (course.chapters?.length || 0), 0);
        this.response.template = 'course_video_main.html';
        this.response.body = {
            page_name: 'course_video_main',
            assets: publicAssets,
            assetGroups: buildFolderAssetGroups(publicAssets, folderTree),
            folderTree,
            chapterCount,
            currentCourseId: courseId,
            currentChapterId: chapterId,
            config: publicConfig(await getVodConfig()),
        };
    }

    async postCreateCategory() {
        const name = cleanText(formValue(this, 'name'), 40);
        if (!name) throw new ValidationError('name');
        const now = new Date();
        const exists = await collCategory.findOne({ name, status: { $ne: 'deleted' } });
        if (!exists) {
            await collCategory.insertOne({
                _id: new ObjectId(),
                name,
                order: Number(formValue(this, 'order') || 100),
                status: 'ready',
                createdAt: now,
                updatedAt: now,
                createdBy: this.user._id,
            });
        }
        this.response.redirect = this.url('course_video_main');
    }

    async postCreateCourse() {
        const name = cleanText(formValue(this, 'name') || formValue(this, 'courseName'), 80);
        if (!name) throw new ValidationError('name');
        const now = new Date();
        let doc = await collFolder.findOne({ type: 'course', name, status: { $ne: 'deleted' } });
        if (!doc) {
            doc = {
                _id: new ObjectId(),
                type: 'course',
                parentId: '',
                name,
                order: Number(formValue(this, 'order') || 100),
                status: 'ready',
                createdAt: now,
                updatedAt: now,
                createdBy: this.user._id,
            };
            await collFolder.insertOne(doc);
        }
        this.response.redirect = withQuery(this.url('course_video_main'), { courseId: idText(doc._id) });
    }

    async postCreateChapter() {
        const parentId = idText(formValue(this, 'folderCourseId') || formValue(this, 'courseId'));
        const name = cleanText(formValue(this, 'name') || formValue(this, 'chapterName'), 80);
        if (!parentId) throw new ValidationError('folderCourseId');
        if (!name) throw new ValidationError('name');
        const course = await getFolder(parentId, 'course', 'folderCourseId');
        const now = new Date();
        let doc = await collFolder.findOne({
            type: 'chapter',
            parentId: idText(course._id),
            name,
            status: { $ne: 'deleted' },
        });
        if (!doc) {
            doc = {
                _id: new ObjectId(),
                type: 'chapter',
                parentId: idText(course._id),
                name,
                order: Number(formValue(this, 'order') || 100),
                status: 'ready',
                createdAt: now,
                updatedAt: now,
                createdBy: this.user._id,
            };
            await collFolder.insertOne(doc);
        }
        this.response.redirect = withQuery(this.url('course_video_main'), {
            courseId: idText(course._id),
            chapterId: idText(doc._id),
        });
    }

    async postUpdateFolder() {
        const folder = await getFolderById(formValue(this, 'folderId'));
        const order = Number(formValue(this, 'order') || 0);
        if (!Number.isFinite(order)) throw new ValidationError('order');
        await collFolder.updateOne(
            { _id: folder._id },
            { $set: { order, updatedAt: new Date(), updatedBy: this.user._id } },
        );
        this.response.redirect = withQuery(this.url('course_video_main'), {
            courseId: folder.type === 'course' ? idText(folder._id) : folder.parentId,
            chapterId: folder.type === 'chapter' ? idText(folder._id) : '',
        });
    }

    async postDeleteFolder() {
        const folder = await getFolderById(formValue(this, 'folderId'));
        const now = new Date();
        if (folder.type === 'course') {
            const courseId = idText(folder._id);
            await Promise.all([
                collFolder.updateOne(
                    { _id: folder._id },
                    {
                        $set: {
                            status: 'deleted',
                            name: deletedFolderName(folder),
                            originalName: folder.name,
                            deletedAt: now,
                            deletedBy: this.user._id,
                            updatedAt: now,
                        },
                    },
                ),
                collFolder.updateMany(
                    { type: 'chapter', parentId: courseId, status: { $ne: 'deleted' } },
                    { $set: { status: 'deleted', deletedAt: now, deletedBy: this.user._id, updatedAt: now } },
                ),
                collAsset.updateMany(
                    { folderCourseId: courseId, status: { $ne: 'deleted' } },
                    {
                        $set: { updatedAt: now },
                        $unset: {
                            folderCourseId: '',
                            folderCourseName: '',
                            folderChapterId: '',
                            folderChapterName: '',
                        },
                    },
                ),
            ]);
            this.response.redirect = this.url('course_video_main');
            return;
        }

        if (folder.type === 'chapter') {
            await Promise.all([
                collFolder.updateOne(
                    { _id: folder._id },
                    {
                        $set: {
                            status: 'deleted',
                            name: deletedFolderName(folder),
                            originalName: folder.name,
                            deletedAt: now,
                            deletedBy: this.user._id,
                            updatedAt: now,
                        },
                    },
                ),
                collAsset.updateMany(
                    { folderChapterId: idText(folder._id), status: { $ne: 'deleted' } },
                    {
                        $set: { updatedAt: now },
                        $unset: {
                            folderChapterId: '',
                            folderChapterName: '',
                        },
                    },
                ),
            ]);
            this.response.redirect = withQuery(this.url('course_video_main'), { courseId: folder.parentId });
            return;
        }

        throw new ValidationError('folderId');
    }

    async postUploadLocal() {
        throw new ValidationError('video', null, '课程视频必须上传到腾讯云 VOD，不能存储在 Hydro 硬盘。');
    }

    async postManualCreate() {
        const fileId = cleanText(formValue(this, 'fileId'), 80);
        if (!fileId) throw new ValidationError('fileId');
        const folder = await resolveVideoFolder(
            formValue(this, 'folderCourseId') || formValue(this, 'courseId'),
            formValue(this, 'folderChapterId') || formValue(this, 'chapterId'),
            true,
        );
        const title = cleanText(formValue(this, 'videoTitle') || formValue(this, 'title'), 160);
        if (!title) throw new ValidationError('videoTitle');
        const now = new Date();
        await collAsset.updateOne(
            { fileId },
            {
                $set: {
                    domainId: 'system',
                    scope: 'global',
                    provider: VOD_PROVIDER,
                    fileId,
                    title,
                    size: Number(formValue(this, 'size') || 0),
                    duration: Number(formValue(this, 'duration') || 0),
                    coverUrl: cleanText(formValue(this, 'coverUrl'), 500),
                    ...folder,
                    status: 'ready',
                    updatedAt: now,
                    owner: this.user._id,
                },
                $unset: {
                    categoryId: '',
                    categoryName: '',
                    courseId: '',
                    courseTitle: '',
                    sectionId: '',
                    sectionTitle: '',
                    subSectionId: '',
                    subSectionTitle: '',
                },
                $setOnInsert: { _id: new ObjectId(), createdAt: now },
            },
            { upsert: true },
        );
        this.response.redirect = withQuery(this.url('course_video_main'), {
            courseId: folder.folderCourseId,
            chapterId: folder.folderChapterId,
        });
    }

    async postDisable() {
        await collAsset.updateOne(
            { _id: toObjectId(formValue(this, 'assetId'), 'assetId') },
            { $set: { status: 'disabled', updatedAt: new Date() } },
        );
        this.back();
    }

    async postEnable() {
        await collAsset.updateOne(
            { _id: toObjectId(formValue(this, 'assetId'), 'assetId') },
            { $set: { status: 'ready', updatedAt: new Date() } },
        );
        this.back();
    }

    async postDelete() {
        const asset = await getAsset('system', formValue(this, 'assetId'));
        const provider = asset.provider || (asset.storagePath ? LOCAL_PROVIDER : VOD_PROVIDER);
        if (provider === VOD_PROVIDER) {
            try {
                await vodAdapter.deleteMedia(await getVodConfig(), asset);
            } catch (err) {
                if (!isVodResourceMissing(err)) throw err;
            }
        } else if (provider === LOCAL_PROVIDER && asset.storagePath) {
            await StorageModel.del([asset.storagePath], this.user._id).catch(() => null);
        }
        await Promise.all([
            collAsset.updateOne(
                { _id: asset._id },
                { $set: { status: 'deleted', updatedAt: new Date() } },
            ),
            collBinding.deleteMany({ assetId: asset._id }),
        ]);
        this.back();
    }
}

class CourseVideoFolderCreateHandler extends Handler {
    async prepare() {
        assertSystemVideoAdmin(this);
    }

    async get() {
        const courseId = cleanText(routeValue(this, 'courseId'), 80);
        const chapterId = cleanText(routeValue(this, 'chapterId'), 80);
        this.response.template = 'course_video_folder_create.html';
        this.response.body = {
            page_name: 'course_video_folder_create',
            folderTree: await listFolderTree(),
            currentCourseId: courseId,
            currentChapterId: chapterId,
        };
    }

    async postCreateCourse() {
        const name = cleanText(formValue(this, 'name') || formValue(this, 'courseName'), 80);
        if (!name) throw new ValidationError('name');
        const now = new Date();
        let doc = await collFolder.findOne({ type: 'course', name, status: { $ne: 'deleted' } });
        if (!doc) {
            doc = {
                _id: new ObjectId(),
                type: 'course',
                parentId: '',
                name,
                order: Number(formValue(this, 'order') || 100),
                status: 'ready',
                createdAt: now,
                updatedAt: now,
                createdBy: this.user._id,
            };
            await collFolder.insertOne(doc);
        }
        this.response.redirect = withQuery(this.url('course_video_folder_create'), { courseId: idText(doc._id) });
    }

    async postCreateChapter() {
        const parentId = idText(formValue(this, 'folderCourseId') || formValue(this, 'courseId'));
        const name = cleanText(formValue(this, 'name') || formValue(this, 'chapterName'), 80);
        if (!parentId) throw new ValidationError('folderCourseId');
        if (!name) throw new ValidationError('name');
        const course = await getFolder(parentId, 'course', 'folderCourseId');
        const now = new Date();
        let doc = await collFolder.findOne({
            type: 'chapter',
            parentId: idText(course._id),
            name,
            status: { $ne: 'deleted' },
        });
        if (!doc) {
            doc = {
                _id: new ObjectId(),
                type: 'chapter',
                parentId: idText(course._id),
                name,
                order: Number(formValue(this, 'order') || 100),
                status: 'ready',
                createdAt: now,
                updatedAt: now,
                createdBy: this.user._id,
            };
            await collFolder.insertOne(doc);
        }
        this.response.redirect = withQuery(this.url('course_video_folder_create'), {
            courseId: idText(course._id),
            chapterId: idText(doc._id),
        });
    }
}

class CourseVideoFolderManageHandler extends Handler {
    async prepare() {
        assertSystemVideoAdmin(this);
    }

    async get() {
        this.response.template = 'course_video_folder_manage.html';
        this.response.body = {
            page_name: 'course_video_folder_manage',
            folderTree: await listFolderTree(),
        };
    }

    async postUpdateFolder() {
        const folder = await getFolderById(formValue(this, 'folderId'));
        const order = Number(formValue(this, 'order') || 0);
        if (!Number.isFinite(order)) throw new ValidationError('order');
        await collFolder.updateOne(
            { _id: folder._id },
            { $set: { order, updatedAt: new Date(), updatedBy: this.user._id } },
        );
        this.response.redirect = this.url('course_video_folder_manage');
    }

    async postDeleteFolder() {
        const folder = await getFolderById(formValue(this, 'folderId'));
        const now = new Date();
        if (folder.type === 'course') {
            const courseId = idText(folder._id);
            await Promise.all([
                collFolder.updateOne(
                    { _id: folder._id },
                    {
                        $set: {
                            status: 'deleted',
                            name: deletedFolderName(folder),
                            originalName: folder.name,
                            deletedAt: now,
                            deletedBy: this.user._id,
                            updatedAt: now,
                        },
                    },
                ),
                collFolder.updateMany(
                    { type: 'chapter', parentId: courseId, status: { $ne: 'deleted' } },
                    { $set: { status: 'deleted', deletedAt: now, deletedBy: this.user._id, updatedAt: now } },
                ),
                collAsset.updateMany(
                    { folderCourseId: courseId, status: { $ne: 'deleted' } },
                    {
                        $set: { updatedAt: now },
                        $unset: {
                            folderCourseId: '',
                            folderCourseName: '',
                            folderChapterId: '',
                            folderChapterName: '',
                        },
                    },
                ),
            ]);
            this.response.redirect = this.url('course_video_folder_manage');
            return;
        }

        if (folder.type === 'chapter') {
            await Promise.all([
                collFolder.updateOne(
                    { _id: folder._id },
                    {
                        $set: {
                            status: 'deleted',
                            name: deletedFolderName(folder),
                            originalName: folder.name,
                            deletedAt: now,
                            deletedBy: this.user._id,
                            updatedAt: now,
                        },
                    },
                ),
                collAsset.updateMany(
                    { folderChapterId: idText(folder._id), status: { $ne: 'deleted' } },
                    {
                        $set: { updatedAt: now },
                        $unset: {
                            folderChapterId: '',
                            folderChapterName: '',
                        },
                    },
                ),
            ]);
            this.response.redirect = this.url('course_video_folder_manage');
            return;
        }

        throw new ValidationError('folderId');
    }
}

class CourseVideoManualRegisterHandler extends Handler {
    async prepare() {
        assertSystemVideoAdmin(this);
    }

    async get() {
        const courseId = cleanText(routeValue(this, 'courseId'), 80);
        const chapterId = cleanText(routeValue(this, 'chapterId'), 80);
        this.response.template = 'course_video_manual_register.html';
        this.response.body = {
            page_name: 'course_video_manual_register',
            folderTree: await listFolderTree(),
            currentCourseId: courseId,
            currentChapterId: chapterId,
        };
    }

    async postManualCreate() {
        const fileId = cleanText(formValue(this, 'fileId'), 80);
        if (!fileId) throw new ValidationError('fileId');
        const folder = await resolveVideoFolder(
            formValue(this, 'folderCourseId') || formValue(this, 'courseId'),
            formValue(this, 'folderChapterId') || formValue(this, 'chapterId'),
            true,
        );
        const title = cleanText(formValue(this, 'videoTitle') || formValue(this, 'title'), 160);
        if (!title) throw new ValidationError('videoTitle');
        const now = new Date();
        await collAsset.updateOne(
            { fileId },
            {
                $set: {
                    domainId: 'system',
                    scope: 'global',
                    provider: VOD_PROVIDER,
                    fileId,
                    title,
                    size: Number(formValue(this, 'size') || 0),
                    duration: Number(formValue(this, 'duration') || 0),
                    coverUrl: cleanText(formValue(this, 'coverUrl'), 500),
                    ...folder,
                    status: 'ready',
                    updatedAt: now,
                    owner: this.user._id,
                },
                $unset: {
                    categoryId: '',
                    categoryName: '',
                    courseId: '',
                    courseTitle: '',
                    sectionId: '',
                    sectionTitle: '',
                    subSectionId: '',
                    subSectionTitle: '',
                },
                $setOnInsert: { _id: new ObjectId(), createdAt: now },
            },
            { upsert: true },
        );
        this.response.redirect = withQuery(this.url('course_video_manual_register'), {
            courseId: folder.folderCourseId,
            chapterId: folder.folderChapterId,
        });
    }
}

class CourseVideoPackageLinkHandler extends Handler {
    async prepare() {
        assertSystemVideoAdmin(this);
    }

    async get() {
        const sourceDomainId = cleanText(routeValue(this, 'sourceDomainId') || domainIdOf(this), 80);
        const targetDomainId = cleanText(routeValue(this, 'targetDomainId') || sourceDomainId, 80);
        const packageId = cleanText(routeValue(this, 'packageId'), 80);
        const versionId = cleanText(routeValue(this, 'versionId'), 80);
        const chapterId = cleanText(routeValue(this, 'chapterId'), 120);
        const lessonId = cleanText(routeValue(this, 'lessonId'), 120);
        const targetCourseId = cleanText(routeValue(this, 'targetCourseId'), 80);
        const targetSectionId = cleanText(routeValue(this, 'targetSectionId'), 80);
        const targetSubSectionId = cleanText(routeValue(this, 'targetSubSectionId'), 80);
        const message = cleanText(routeValue(this, 'message'), 80);
        const pkgModel = coursePackageModel();
        const course = courseModel();
        const [domains, packages, targetCourses] = await Promise.all([
            listDomains(),
            pkgModel?.getMulti && sourceDomainId ? pkgModel.getMulti(sourceDomainId, {}).toArray() : Promise.resolve([]),
            course?.getMulti && targetDomainId ? course.getMulti(targetDomainId, {}).toArray() : Promise.resolve([]),
        ]);
        let versions = [];
        let chapters = [];
        let lessons = [];
        let targetSections = [];
        let targetSubSections = [];
        try {
            if (pkgModel?.getMultiVersion && packageId) {
                versions = await pkgModel.getMultiVersion(sourceDomainId, toObjectId(packageId, 'packageId')).toArray();
            }
            if (pkgModel?.getVersion && versionId) {
                const version = await pkgModel.getVersion(sourceDomainId, toObjectId(versionId, 'versionId'));
                chapters = version?.chapters || [];
                const chapter = chapters.find((item) => item.id === chapterId);
                lessons = chapter?.lessons || [];
            }
            if (course?.getMultiSection && targetCourseId) {
                targetSections = await course.getMultiSection(targetDomainId, toObjectId(targetCourseId, 'targetCourseId')).toArray();
            }
            if (course?.getSection && targetSectionId) {
                const section = await course.getSection(targetDomainId, toObjectId(targetSectionId, 'targetSectionId'));
                targetSubSections = (section?.dag || []).map((node, index) => ({
                    id: idText(node._id || node.docId || node.id || `lesson-${index + 1}`),
                    title: docTitle(node, `Lesson ${index + 1}`),
                }));
            }
        } catch (err) {
            // Invalid intermediate selections are rendered as empty options.
        }
        this.response.template = 'course_video_package_link.html';
        this.response.body = {
            page_name: 'course_video_package_link',
            domains: domains.map((domain) => ({
                id: idText(domain._id),
                name: domain.name || domain.displayName || idText(domain._id),
            })),
            packages: packages.map((item) => ({ ...item, docIdText: idText(item.docId) })),
            versions: versions.map((item) => ({ ...item, docIdText: idText(item.docId) })),
            chapters,
            lessons,
            targetCourses: targetCourses.map((item) => ({ ...item, docIdText: idText(item.docId) })),
            targetSections: targetSections.map((item) => ({ ...item, docIdText: idText(item.docId) })),
            targetSubSections,
            sourceDomainId,
            targetDomainId,
            packageId,
            versionId,
            chapterId,
            lessonId,
            targetCourseId,
            targetSectionId,
            targetSubSectionId,
            message,
            packagePluginReady: !!pkgModel,
            coursePluginReady: !!course,
        };
    }

    async post() {
        const sourceDomainId = cleanText(formValue(this, 'sourceDomainId'), 80);
        const targetDomainId = cleanText(formValue(this, 'targetDomainId'), 80);
        const packageId = cleanText(formValue(this, 'packageId'), 80);
        const versionId = cleanText(formValue(this, 'versionId'), 80);
        const chapterId = cleanText(formValue(this, 'chapterId'), 120);
        const lessonId = cleanText(formValue(this, 'lessonId'), 120);
        const targetCourseId = cleanText(formValue(this, 'targetCourseId'), 80);
        const targetSectionId = cleanText(formValue(this, 'targetSectionId'), 80);
        const targetSubSectionId = cleanText(formValue(this, 'targetSubSectionId'), 80);
        if (!sourceDomainId || !targetDomainId || !packageId || !versionId || !chapterId || !lessonId
            || !targetCourseId || !targetSectionId || !targetSubSectionId) {
            throw new ValidationError('packageLink');
        }
        const result = await recordPackageLessonCopy(
            sourceDomainId,
            targetDomainId,
            packageId,
            versionId,
            chapterId,
            lessonId,
            targetCourseId,
            targetSectionId,
            targetSubSectionId,
        );
        this.response.redirect = withQuery(this.url('course_video_package_link'), {
            sourceDomainId,
            targetDomainId,
            packageId,
            versionId,
            chapterId,
            lessonId,
            targetCourseId,
            targetSectionId,
            targetSubSectionId,
            message: result.binding ? 'synced' : 'recorded',
        });
    }
}

class CourseVideoPackageSyncHandler extends Handler {
    async post() {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        const sourceDomainId = cleanText(formValue(this, 'sourceDomainId') || domainIdOf(this), 80);
        const packageId = cleanText(formValue(this, 'packageId') || formValue(this, 'cpid'), 80);
        const versionId = cleanText(formValue(this, 'versionId') || formValue(this, 'vid'), 80);
        if (!sourceDomainId || !packageId || !versionId) throw new ValidationError('packageVideoSync');
        const result = await syncPackageVersionBindingsToCopiedSubsecs(sourceDomainId, packageId, versionId);
        this.response.redirect = withQuery(this.url('course_package_version_detail', {
            cpid: packageId,
            vid: versionId,
        }), {
            videoSync: 'done',
            videoSyncLessons: result.lessons,
            videoSyncTargets: result.matched,
            videoSyncSynced: result.synced,
            videoSyncCleared: result.cleared,
            videoSyncBackfilled: result.backfilled,
        });
    }
}

class CourseVideoUploadSignHandler extends Handler {
    async post() {
        assertSystemVideoAdmin(this);
        const config = await getVodConfig();
        this.response.body = await vodAdapter.createUploadSignature(config, {
            title: cleanText(formValue(this, 'videoTitle') || formValue(this, 'title'), 160),
            filename: cleanText(formValue(this, 'filename'), 260),
            size: Number(formValue(this, 'size') || 0),
            uid: this.user._id,
            domainId: domainIdOf(this),
        }, this);
    }
}

class CourseVideoUploadCompleteHandler extends Handler {
    async post() {
        assertSystemVideoAdmin(this);
        const fileId = cleanText(formValue(this, 'fileId'), 80);
        if (!fileId) throw new ValidationError('fileId');
        const now = new Date();
        const folder = await resolveVideoFolder(
            formValue(this, 'folderCourseId') || formValue(this, 'courseId'),
            formValue(this, 'folderChapterId') || formValue(this, 'chapterId'),
            true,
        );
        const title = cleanText(formValue(this, 'videoTitle') || formValue(this, 'title'), 160);
        if (!title) throw new ValidationError('videoTitle');
        await collAsset.updateOne(
            { fileId },
            {
                $set: {
                    domainId: 'system',
                    scope: 'global',
                    provider: VOD_PROVIDER,
                    fileId,
                    title,
                    filename: cleanText(formValue(this, 'filename'), 180),
                    size: Number(formValue(this, 'size') || 0),
                    duration: Number(formValue(this, 'duration') || 0),
                    coverUrl: cleanText(formValue(this, 'coverUrl'), 500),
                    ...folder,
                    status: cleanText(formValue(this, 'status') || 'ready', 40),
                    owner: this.user._id,
                    updatedAt: now,
                },
                $unset: {
                    categoryId: '',
                    categoryName: '',
                    courseId: '',
                    courseTitle: '',
                    sectionId: '',
                    sectionTitle: '',
                    subSectionId: '',
                    subSectionTitle: '',
                },
                $setOnInsert: { _id: new ObjectId(), createdAt: now },
            },
            { upsert: true },
        );
        this.response.body = { ok: true };
    }
}

class CourseVideoBindHandler extends Handler {
    async post() {
        assertCanBindVideo(this);
        const domainId = domainIdOf(this);
        const kind = cleanText(formValue(this, 'kind'), 40);
        let filter;
        let packageLesson = null;
        if (kind === 'packageLesson') {
            if (!formValue(this, 'lessonId')) throw new ValidationError('lessonId');
            packageLesson = {
                packageId: formValue(this, 'packageId'),
                versionId: formValue(this, 'versionId'),
                chapterId: formValue(this, 'chapterId'),
                lessonId: formValue(this, 'lessonId'),
            };
            filter = packageBindingFilter(domainId, packageLesson.packageId, packageLesson.versionId, packageLesson.chapterId, packageLesson.lessonId);
        } else if (kind === 'courseSubsec') {
            throw new ForbiddenError('请在课程包节里绑定视频。');
        } else {
            throw new ValidationError('kind');
        }
        await saveBinding(domainId, filter, formValue(this, 'assetId'), {});
        if (packageLesson) {
            await backfillPackageCopyMappingsByStructure(
                domainId,
                packageLesson.packageId,
                packageLesson.versionId,
                { chapterId: packageLesson.chapterId, lessonId: packageLesson.lessonId },
            );
            await syncPackageLessonBindingToCopiedSubsecs(
                domainId,
                packageLesson.packageId,
                packageLesson.versionId,
                packageLesson.chapterId,
                packageLesson.lessonId,
            );
        }
        this.back();
    }
}

class CourseVideoToggleCourseHandler extends Handler {
    async post() {
        assertCanToggleStudentVideo(this);
        const domainId = domainIdOf(this);
        const courseId = idText(formValue(this, 'courseId') || formValue(this, 'cid'));
        if (!courseId) throw new ValidationError('courseId');
        const current = await getCourseSetting(domainId, courseId);
        const enabled = formValue(this, 'enabled');
        const next = enabled === undefined ? !current.studentVideoEnabled : asBool(enabled, true);
        await collSetting.updateOne(
            { domainId, courseId },
            { $set: { domainId, courseId, studentVideoEnabled: next, updatedAt: new Date() } },
            { upsert: true },
        );
        this.back();
    }
}

class CourseVideoPlayHandler extends Handler {
    async get() {
        try {
            const domainId = domainIdOf(this);
            const asset = await getAsset(domainId, routeValue(this, 'assetId'));
            const query = {
                courseId: routeValue(this, 'courseId') || routeValue(this, 'cid') || '',
                sectionId: routeValue(this, 'sectionId') || routeValue(this, 'csid') || '',
                subSectionId: routeValue(this, 'subSectionId') || routeValue(this, 'ssid') || '',
                contestId: routeValue(this, 'contestId') || routeValue(this, 'tid') || '',
            };
            if (query.contestId) await assertCanPlayContestVideo(this, asset, query);
            else await assertCanPlayCourseVideo(this, asset, query);
            const provider = asset.provider || (asset.storagePath ? LOCAL_PROVIDER : VOD_PROVIDER);
            if (provider === LOCAL_PROVIDER) {
                throw new Error('这个视频是旧 Hydro Storage 数据。课程视频必须存储在腾讯云 VOD，请删除后重新上传到 VOD。');
            }
            this.response.body = await vodAdapter.createPlayInfo(await getVodConfig(), asset, {
                domainId,
                ...query,
                uid: this.user._id,
            });
        } catch (err) {
            this.response.body = {
                ok: false,
                type: 'error',
                message: errorText(err),
            };
        }
    }
}

async function attachCourseVideoUi(handler) {
    const body = handler.response?.body || {};
    const domainId = domainIdOf(handler);
    const template = handler.response?.template || '';
    const canBind = canBindVideo(handler.user);
    const canToggle = canToggleStudentVideo(handler.user);

    if (template === 'course_subsec_detail.html' && body.cdoc && body.csdoc && body.ssdoc) {
        const filter = courseBindingFilter(domainId, body.cdoc.docId, body.csdoc.docId, body.ssdoc._id || body.ssdoc.docId);
        const [{ binding, asset }, setting] = await Promise.all([
            findBindingWithAsset(filter),
            getCourseSetting(domainId, body.cdoc.docId),
        ]);
        const canView = !!asset && (canBind || canToggle || setting.studentVideoEnabled);
        handler.UiContext ||= {};
        handler.UiContext.courseVideoVod = {
            page: 'course_subsec_detail',
            canManage: canBind,
            canBindVideo: canBind,
            canToggleStudentVideo: canToggle,
            canView,
            course: {
                courseId: idText(body.cdoc.docId),
                sectionId: idText(body.csdoc.docId),
                subSectionId: idText(body.ssdoc._id || body.ssdoc.docId),
                studentVideoEnabled: setting.studentVideoEnabled,
            },
            binding: bindingPublic(binding, asset),
            assets: [],
            bindUrl: '',
            toggleCourseUrl: handler.url('course_video_toggle_course'),
            playUrl: asset ? withQuery(handler.url('course_video_play', {
                assetId: idText(asset._id),
            }), {
                courseId: idText(body.cdoc.docId),
                sectionId: idText(body.csdoc.docId),
                subSectionId: idText(body.ssdoc._id || body.ssdoc.docId),
            }) : '',
            libraryUrl: handler.url('course_video_main'),
        };
    }

    if (template === 'contest_detail.html' && body.tdoc) {
        const link = contestPackageLessonVideo(body.tdoc);
        if (link) {
            const tsdoc = body.tsdoc || await ContestModel.getStatus(domainId, body.tdoc.docId, handler.user._id);
            const canManage = canManageContestVideo(handler, body.tdoc);
            const canView = canManage || (!!tsdoc?.attend && isContestVideoDone(body.tdoc, tsdoc));
            const { binding, asset } = await findBindingWithAsset(
                packageBindingFilter(link.sourceDomainId, link.packageId, link.versionId, link.chapterId, link.lessonId),
            );
            handler.UiContext ||= {};
            handler.UiContext.courseVideoVod = {
                page: 'contest_detail',
                canManage,
                canView,
                done: isContestVideoDone(body.tdoc, tsdoc),
                attended: !!tsdoc?.attend,
                contest: {
                    contestId: idText(body.tdoc.docId),
                },
                binding: bindingPublic(binding, asset),
                playUrl: asset ? withQuery(handler.url('course_video_play', {
                    assetId: idText(asset._id),
                }), {
                    contestId: idText(body.tdoc.docId),
                }) : '',
                libraryUrl: handler.url('course_video_main'),
            };
        }
    }

    if ((body.page_name === 'course_package_lesson_edit' || body.page_name === 'course_package_lesson_create')
        && body.cpdoc && body.vpdoc && body.chapter) {
        const lessonId = body.lesson?.id || '';
        const filter = lessonId
            ? packageBindingFilter(domainId, body.cpdoc.docId, body.vpdoc.docId, body.chapter.id, lessonId)
            : null;
        const [{ binding, asset }, assets] = await Promise.all([
            filter ? findBindingWithAsset(filter) : Promise.resolve({ binding: null, asset: null }),
            canBind ? listAssets(domainId, 300) : Promise.resolve([]),
        ]);
        handler.UiContext ||= {};
        handler.UiContext.courseVideoVod = {
            page: 'course_package_lesson_edit',
            canManage: canBind,
            canBindVideo: canBind,
            canToggleStudentVideo: canToggle,
            savedLesson: !!lessonId,
            packageLesson: {
                packageId: idText(body.cpdoc.docId),
                versionId: idText(body.vpdoc.docId),
                chapterId: String(body.chapter.id || ''),
                lessonId,
            },
            binding: bindingPublic(binding, asset),
            assets: assets.map(assetPublic),
            bindUrl: handler.url('course_video_bind'),
            libraryUrl: handler.url('course_video_main'),
        };
    }
}

async function ensureDefaultCategories() {
    const count = await collCategory.countDocuments({ status: { $ne: 'deleted' } });
    if (count) return;
    const now = new Date();
    await collCategory.insertMany(DEFAULT_CATEGORIES.map((name, index) => ({
        _id: new ObjectId(),
        name,
        order: (index + 1) * 10,
        status: 'ready',
        createdAt: now,
        updatedAt: now,
    })));
}

async function apply(ctx) {
    await Promise.all([
        collAsset.createIndex({ domainId: 1, fileId: 1 }, { unique: true, name: 'course_video_asset_file' }).catch(() => null),
        collAsset.createIndex({ fileId: 1 }, { name: 'course_video_asset_file_global' }).catch(() => null),
        collAsset.createIndex({ categoryId: 1, updatedAt: -1 }, { name: 'course_video_asset_category' }).catch(() => null),
        collAsset.createIndex({ courseId: 1, sectionId: 1, subSectionId: 1, updatedAt: -1 }, { name: 'course_video_asset_course_path' }).catch(() => null),
        collAsset.createIndex({ folderCourseId: 1, folderChapterId: 1, updatedAt: -1 }, { name: 'course_video_asset_folder_path' }).catch(() => null),
        collAsset.createIndex({ updatedAt: -1 }, { name: 'course_video_asset_global_updated' }).catch(() => null),
        collCategory.createIndex({ name: 1 }, { unique: true, name: 'course_video_category_name' }).catch(() => null),
        collFolder.createIndex({ type: 1, parentId: 1, order: 1, createdAt: 1 }, { name: 'course_video_folder_tree' }).catch(() => null),
        collFolder.createIndex({ type: 1, parentId: 1, name: 1 }, { unique: true, name: 'course_video_folder_name' }).catch(() => null),
        collBinding.createIndex({ domainId: 1, kind: 1, packageId: 1, versionId: 1, chapterId: 1, lessonId: 1 }, { name: 'course_video_package_binding' }).catch(() => null),
        collBinding.createIndex({ domainId: 1, kind: 1, courseId: 1, sectionId: 1, subSectionId: 1 }, { name: 'course_video_course_binding' }).catch(() => null),
        collPackageCopy.createIndex({
            sourceDomainId: 1,
            packageId: 1,
            versionId: 1,
            chapterId: 1,
            lessonId: 1,
            targetDomainId: 1,
            targetCourseId: 1,
            targetSectionId: 1,
            targetSubSectionId: 1,
        }, { unique: true, name: 'course_video_package_copy_target' }).catch(() => null),
        collPackageCopy.createIndex({ sourceDomainId: 1, packageId: 1, versionId: 1, chapterId: 1, lessonId: 1 }, { name: 'course_video_package_copy_source' }).catch(() => null),
        collSetting.createIndex({ domainId: 1, courseId: 1 }, { unique: true, name: 'course_video_setting_course' }).catch(() => null),
    ]);

    ctx.Route('course_video_main', '/manage/course-video', CourseVideoMainHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('course_video_config', '/manage/course-video/config', CourseVideoConfigHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('course_video_folder_create', '/manage/course-video/folders/create', CourseVideoFolderCreateHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('course_video_folder_manage', '/manage/course-video/folders/manage', CourseVideoFolderManageHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('course_video_manual_register', '/manage/course-video/register', CourseVideoManualRegisterHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('course_video_package_link', '/manage/course-video/package-link', CourseVideoPackageLinkHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('course_video_package_sync', '/course-video/package/sync', CourseVideoPackageSyncHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('course_video_upload_sign', '/manage/course-video/upload/sign', CourseVideoUploadSignHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('course_video_upload_complete', '/manage/course-video/upload/complete', CourseVideoUploadCompleteHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('course_video_bind', '/course-video/bind', CourseVideoBindHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('course_video_toggle_course', '/course-video/toggle-course', CourseVideoToggleCourseHandler, PERM.PERM_EDIT_DOMAIN);
    ctx.Route('course_video_play', '/course-video/play/:assetId', CourseVideoPlayHandler, PRIV.PRIV_USER_PROFILE);

    ctx.injectUI('ControlPanel', 'course_video_main', { icon: 'play', displayName: '课程视频库' }, PRIV.PRIV_EDIT_SYSTEM);

    ctx.on('handler/after', attachCourseVideoUi);

    ctx.i18n.load('zh', {
        course_video_main: '课程视频库',
        course_video_config: 'VOD 兼容配置',
    });
    ctx.i18n.load('en', {
        course_video_main: 'Course Videos',
        course_video_config: 'VOD Compatibility',
        course_video_package_link: 'Course Package Video Link',
    });

    global.Hydro ||= {};
    global.Hydro.model ||= {};
    global.Hydro.model.courseVideoVod = {
        copyPackageLessonBindingToCourseSubsec,
        recordPackageLessonCopy,
        recordPackageLessonCopies,
        syncPackageLessonBindingToCopiedSubsecs,
        syncPackageVersionBindingsToCopiedSubsecs,
        listAssets,
        saveBinding,
        collections: { collAsset, collBinding, collSetting, collConfig, collCategory, collFolder, collPackageCopy },
    };
}

module.exports = { apply };
