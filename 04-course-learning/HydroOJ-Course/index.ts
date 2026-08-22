import { escapeRegExp, pick } from 'lodash';
import {
    Context, DiscussionModel, DocumentModel, DomainModel, FileLimitExceededError,
    FileUploadError, Filter, Handler, NotFoundError, ObjectId, PERM, PermissionError,
    ProblemModel, ProblemNotAllowCopyError, ProblemNotFoundError, PRIV, RecordModel,
    sortFiles, StorageModel, SystemModel, UserModel, ValidationError,
} from 'hydrooj';
import { param, post, Types } from 'hydrooj';

// Extend document types for Course
declare module 'hydrooj' {
    interface DocType {
        50: CourseDoc; // TYPE_COURSE
    }
}

// Course document interface
export interface CourseDoc {
    _id: ObjectId;
    docType: 50;
    docId: ObjectId;
    domainId: string;
    owner: number;
    maintainer?: number[];
    title: string;
    content: string; // Course introduction/description
    attend: number; // Number of students enrolled
    pids: number[]; // Problem IDs
    chapters?: CourseChapter[]; // Nested course chapters
    files?: Array<{ _id: string; name: string; size?: number; lastModified?: Date; etag?: string }>;
    assign?: string[]; // Assigned classes/groups
    classes?: string[]; // Multiple classes support
    teachers?: number[]; // Multiple teachers
    reference?: { domainId: string; docId: ObjectId }; // Original course for shared copies
    sharedTo?: Array<{ domainId: string; docId: ObjectId }>; // Domains this course has been shared to
}

// A nested course chapter. Chapters can contain problems directly and/or
// contain nested child chapters.
export interface CourseChapter {
    _id: number;
    title: string;
    content?: string;
    pids?: (number | string)[];
    children?: CourseChapter[];
}

// Course status document interface (per student progress)
export interface CourseStatusDoc {
    _id: ObjectId;
    docType: 50;
    docId: ObjectId;
    domainId: string;
    uid: number;
    enroll?: number;
    attend?: number;
    startAt?: Date;
    progress?: Record<number, { rid?: ObjectId; score?: number; status?: number }>;
    journal?: Array<{ pid: number; rid: ObjectId; score: number; status: number }>;
}

const TYPE_COURSE = 50 as const;

// Collect every problem id from a nested chapter tree. Used to keep the
// legacy `cdoc.pids` field in sync for permissions, progress, sharing, and
// fallback rendering.
function flattenCoursePids(chapters: CourseChapter[] = []): (number | string)[] {
    const pids = new Set<number | string>();
    const visit = (nodes: CourseChapter[]) => {
        for (const node of nodes) {
            (node.pids || []).forEach((pid) => pids.add(pid));
            visit(node.children || []);
        }
    };
    visit(chapters);
    return Array.from(pids);
}

// Rewrite problem ids in a nested chapter tree after cross-domain copying.
// Missing mappings are dropped.
function remapCourseChapters(
    chapters: CourseChapter[] = [],
    pidMap: Record<string, number>,
): CourseChapter[] {
    return chapters.map((chapter) => ({
        _id: chapter._id,
        title: chapter.title,
        content: chapter.content,
        pids: (chapter.pids || []).map((pid) => pidMap[String(pid)]).filter((pid) => pid != null),
        children: remapCourseChapters(chapter.children || [], pidMap),
    }));
}

// Parse and validate the JSON produced by the chapter editor. The structure
// is intentionally simple so older clients can keep using the flat `pids`
// field without affecting courses that have nested chapters.
function parseCourseChapters(source: string): CourseChapter[] {
    if (!source) return [];
    let parsed: any;
    try {
        parsed = JSON.parse(source);
    } catch (e) {
        throw new ValidationError('chapters', null, 'Invalid chapter JSON');
    }
    if (!Array.isArray(parsed)) throw new ValidationError('chapters', null, 'Chapters must be an array');
    const ids = new Set<number>();
    const pids = new Set<number>();
    const validate = (nodes: any[]): CourseChapter[] => nodes.map((node) => {
        const _id = Number(node?._id);
        const title = String(node?.title || '').trim();
        if (!_id || !Number.isSafeInteger(_id)) throw new ValidationError('chapters', null, 'Each chapter needs a numeric _id');
        if (ids.has(_id)) throw new ValidationError('chapters', null, 'Chapter _id must be unique');
        if (!title) throw new ValidationError('chapters', null, 'Each chapter needs a title');
        ids.add(_id);
        const nodePids = Array.isArray(node?.pids)
            ? node.pids.map((pid: any) => String(pid).trim()).filter((pid: string) => pid)
            : [];
        nodePids.forEach((pid: string) => pids.add(pid));
        return {
            _id,
            title,
            content: typeof node?.content === 'string' ? node.content : '',
            pids: Array.from(new Set(nodePids)),
            children: Array.isArray(node?.children) ? validate(node.children) : [],
        };
    });
    return validate(parsed);
}

function courseChaptersForEditor(cdoc: CourseDoc | null): CourseChapter[] {
    if (cdoc?.chapters?.length) return cdoc.chapters;
    if (cdoc?.pids?.length) return [{ _id: 1, title: 'Chapter 1', pids: cdoc.pids }];
    return [];
}

// Locate a chapter by its globally-unique `_id` inside the nested chapter tree
// and return the path from the root chapter down to (and including) it.
function findChapterPath(chapters: CourseChapter[], targetId: number): CourseChapter[] | null {
    const visit = (nodes: CourseChapter[], path: CourseChapter[]): CourseChapter[] | null => {
        for (const node of nodes) {
            const nextPath = [...path, node];
            if (node._id === targetId) return nextPath;
            const found = visit(node.children || [], nextPath);
            if (found) return found;
        }
        return null;
    };
    return visit(chapters, []);
}

// Return a new chapter id that does not collide with any existing chapter id.
function nextChapterId(chapters: CourseChapter[]): number {
    let max = 0;
    const visit = (nodes: CourseChapter[]) => {
        for (const node of nodes) {
            if (Number(node._id) > max) max = Number(node._id);
            visit(node.children || []);
        }
    };
    visit(chapters);
    return max + 1;
}

// Mutate the chapter with `targetId` in-place. Returns true when found.
function updateChapterInTree(
    chapters: CourseChapter[],
    targetId: number,
    updater: (chapter: CourseChapter) => CourseChapter,
): boolean {
    for (let i = 0; i < chapters.length; i++) {
        if (Number(chapters[i]._id) === targetId) {
            chapters[i] = updater(chapters[i]);
            return true;
        }
        if (updateChapterInTree(chapters[i].children || [], targetId, updater)) return true;
    }
    return false;
}

// Add a child chapter under `parentId` in-place. Returns true when found.
function addChildChapter(chapters: CourseChapter[], parentId: number, child: CourseChapter): boolean {
    for (const node of chapters) {
        if (Number(node._id) === parentId) {
            node.children = node.children || [];
            node.children.push(child);
            return true;
        }
        if (addChildChapter(node.children || [], parentId, child)) return true;
    }
    return false;
}

// Resolve raw problem identifiers to numeric doc ids. Numeric strings are
// treated as doc ids (matching HydroOJ's own problem URL handling); anything
// else is treated as a problem pid string such as "P1001".
async function resolveProblemIds(
    domainId: string,
    rawPids: (number | string)[],
): Promise<{ pids: number[]; pidMap: Record<string, number> }> {
    const pids: number[] = [];
    const seen = new Set<number>();
    const pidMap: Record<string, number> = {};
    for (const raw of rawPids) {
        const key = String(raw).trim();
        if (!key) continue;
        let docId: number | null = null;
        if (/^[0-9]+$/.test(key)) {
            const n = Number(key);
            if (Number.isSafeInteger(n) && n > 0) docId = n;
        } else {
            const pdoc = await ProblemModel.get(domainId, key, ProblemModel.PROJECTION_PUBLIC, true);
            if (pdoc) docId = pdoc.docId;
        }
        if (docId == null) throw new ProblemNotFoundError(domainId, key);
        if (!seen.has(docId)) {
            seen.add(docId);
            pids.push(docId);
        }
        pidMap[key] = docId;
    }
    return { pids, pidMap };
}

// Check whether a domain's `share` setting allows sharing to the target domain.
// The setting matches HydroOJ's "Share problem with domain (* for any)" domain
// option, which gates cross-domain problem copying.
function isTargetAllowed(share: string | undefined, target: string): boolean {
    const allowed = (share || '').split(',').map((s) => s.trim()).filter((s) => s);
    return allowed.includes('*') || allowed.includes(target);
}

// Copy course problems into the target domain as referenced copies, reusing any
// copies that already exist in the target domain to avoid duplicates.
// Returns a map from source pid to the pid in the target domain.
async function copyCourseProblems(
    domainId: string,
    pids: number[],
    target: string,
    canViewHidden: number | boolean,
): Promise<Record<string, number>> {
    const map: Record<string, number> = {};
    if (!pids?.length) return map;

    // Validate that the operator can view every problem (throws on missing/hidden).
    const pdict = await ProblemModel.getList(
        domainId,
        pids,
        canViewHidden,
        true,
        ProblemModel.PROJECTION_PUBLIC,
    );

    const existing = await ProblemModel.getMulti(
        target,
        { 'reference.domainId': domainId, 'reference.pid': { $in: pids } },
        ['docId', 'reference'],
    ).toArray();

    for (const pid of pids) {
        const pdoc = pdict[pid];
        if (!pdoc) throw new ProblemNotFoundError(domainId, pid);

        let sourceDomain = domainId;
        let sourcePid = pid;

        if (pdoc.reference) {
            // The source problem is itself a copied problem; resolve to its origin.
            sourceDomain = pdoc.reference.domainId;
            sourcePid = pdoc.reference.pid;
            const origin = await ProblemModel.get(sourceDomain, sourcePid, ProblemModel.PROJECTION_PUBLIC, true);
            if (!origin) throw new ProblemNotFoundError(sourceDomain, sourcePid);
            const originCopies = await ProblemModel.getMulti(
                target,
                { 'reference.domainId': sourceDomain, 'reference.pid': sourcePid },
                ['docId'],
            ).toArray();
            if (originCopies.length) {
                map[pid] = originCopies[0].docId;
                continue;
            }
        } else {
            const existingCopy = existing.find(
                (p) => p.reference?.domainId === domainId && p.reference?.pid === pid,
            );
            if (existingCopy) {
                map[pid] = existingCopy.docId;
                continue;
            }
        }

        // Enforce the source domain's cross-domain problem sharing policy.
        const sddoc = await DomainModel.get(sourceDomain);
        if (!sddoc) throw new NotFoundError(sourceDomain);
        if (!isTargetAllowed(sddoc.share, target)) throw new ProblemNotAllowCopyError(sourceDomain, target);
        map[pid] = await ProblemModel.copy(sourceDomain, sourcePid, target);
    }

    return map;
}

// Copy course files into the target domain, skipping files that no longer exist.
async function copyCourseFiles(
    domainId: string,
    cid: ObjectId,
    target: string,
    newCid: ObjectId,
    files: CourseDoc['files'] = [],
): Promise<CourseDoc['files']> {
    const copied: CourseDoc['files'] = [];
    for (const f of files) {
        if (!f?.name) continue;
        try {
            await StorageModel.copy(`course/${domainId}/${cid}/${f.name}`, `course/${target}/${newCid}/${f.name}`);
            copied.push(f);
        } catch (e) {
            // Source file missing; skip it rather than failing the whole share.
        }
    }
    return copied;
}

// Inject the course entry into the top navigation bar, after Training and
// before Contest. HydroOJ exposes this as `ctx.injectUI` (wired to the UI
// `inject` helper), with `global.Hydro.ui.inject` as a fallback for older
// releases. Note: `ctx.inject` is Cordis dependency injection, not the UI API.
function injectCourseNav(ctx: Context) {
    const ui = (ctx as any).injectUI ?? (globalThis as any).Hydro?.ui?.inject;
    if (typeof ui !== 'function') return;
    ui('Nav', 'course_main', { prefix: 'course', before: 'contest_main' }, PERM.PERM_VIEW_HOMEWORK);
}

// Course Model
export const CourseModel = {
    TYPE_COURSE,

    async add(
        domainId: string,
        title: string,
        content: string,
        owner: number,
        pids: number[] = [],
        args: Partial<CourseDoc> = {},
    ): Promise<ObjectId> {
        const docId = await DocumentModel.add(
            domainId,
            content,
            owner,
            TYPE_COURSE,
            null,
            null,
            null,
            {
                title,
                pids,
                attend: 0,
                ...args,
            },
        );
        return docId as ObjectId;
    },

    async get(domainId: string, cid: ObjectId): Promise<CourseDoc | null> {
        const doc = await DocumentModel.get(domainId, TYPE_COURSE, cid);
        if (!doc) return null;
        const cdoc = doc as unknown as CourseDoc;
        if (cdoc.chapters?.length) cdoc.pids = flattenCoursePids(cdoc.chapters) as number[];
        return cdoc;
    },

    getMulti(domainId: string, query: Filter<CourseDoc> = {}) {
        return DocumentModel.getMulti(domainId, TYPE_COURSE, query).sort({ _id: -1 });
    },

    async edit(domainId: string, cid: ObjectId, $set: Partial<CourseDoc>) {
        return await DocumentModel.set(domainId, TYPE_COURSE, cid, $set as any);
    },

    async del(domainId: string, cid: ObjectId) {
        return await Promise.all([
            DocumentModel.deleteOne(domainId, TYPE_COURSE, cid),
            DocumentModel.deleteMultiStatus(domainId, TYPE_COURSE, { docId: cid }),
        ]);
    },

    async getStatus(domainId: string, cid: ObjectId, uid: number) {
        return await DocumentModel.getStatus(domainId, TYPE_COURSE, cid, uid);
    },

    getMultiStatus(domainId: string, query: Filter<CourseStatusDoc>) {
        return DocumentModel.getMultiStatus(domainId, TYPE_COURSE, query);
    },

    async setStatus(domainId: string, cid: ObjectId, uid: number, $set: Partial<CourseStatusDoc>) {
        return await DocumentModel.setStatus(domainId, TYPE_COURSE, cid, uid, $set);
    },

    async attend(domainId: string, cid: ObjectId, uid: number) {
        try {
            await DocumentModel.setIfNotStatus(domainId, TYPE_COURSE, cid, uid, 'attend', 1, 1, { enroll: 1, startAt: new Date() });
        } catch (e) {
            throw new Error('Already enrolled in this course');
        }
        return await DocumentModel.inc(domainId, TYPE_COURSE, cid, 'attend', 1);
    },

    async count(domainId: string, query: Filter<CourseDoc> = {}) {
        return await DocumentModel.count(domainId, TYPE_COURSE, query);
    },

    async share(
        domainId: string,
        cid: ObjectId,
        target: string,
        owner: number,
        canViewHidden: number | boolean = owner,
    ): Promise<ObjectId> {
        const cdoc = await CourseModel.get(domainId, cid);
        if (!cdoc) throw new CourseNotFoundError(domainId, cid);
        if (cdoc.reference) throw new ValidationError('reference');

        const targetDomain = await DomainModel.get(target);
        if (!targetDomain) throw new NotFoundError(target);

        const sourcePids = (flattenCoursePids(cdoc.chapters).length ? flattenCoursePids(cdoc.chapters) : cdoc.pids) as number[];
        const pidMap = await copyCourseProblems(domainId, sourcePids, target, canViewHidden);
        const pids = sourcePids.map((pid) => pidMap[pid]).filter((pid) => pid != null);
        const chapters = cdoc.chapters?.length ? remapCourseChapters(cdoc.chapters, pidMap) : undefined;
        const maintainer = [...new Set([...(cdoc.maintainer || []), cdoc.owner])];

        // Sharing to the same domain again updates the existing copy instead of
        // creating a duplicate.
        let newCid: ObjectId | null = (cdoc.sharedTo || []).find((s) => s.domainId === target)?.docId || null;
        if (newCid) {
            const tcdoc = await CourseModel.get(target, newCid);
            if (!tcdoc) {
                // The shared copy was deleted in the target domain; drop the
                // stale reference and create a fresh copy.
                await CourseModel.edit(domainId, cid, {
                    sharedTo: (cdoc.sharedTo || []).filter((s) => s.domainId !== target),
                } as any);
                newCid = null;
            } else {
                const mergedMaintainer = [...new Set([...(cdoc.maintainer || []), cdoc.owner, ...(tcdoc.maintainer || [])])];
                await CourseModel.edit(target, newCid, {
                    title: cdoc.title,
                    content: cdoc.content,
                    pids,
                    ...(chapters ? { chapters } : {}),
                    maintainer: mergedMaintainer,
                    teachers: cdoc.teachers,
                    assign: cdoc.assign,
                    classes: cdoc.classes,
                } as any);
            }
        }

        if (!newCid) {
            newCid = await CourseModel.add(
                target,
                cdoc.title,
                cdoc.content,
                owner,
                pids,
                {
                    maintainer,
                    teachers: cdoc.teachers,
                    assign: cdoc.assign,
                    classes: cdoc.classes,
                    ...(chapters ? { chapters } : {}),
                    reference: { domainId, docId: cid },
                },
            );
            await CourseModel.edit(domainId, cid, {
                sharedTo: [...(cdoc.sharedTo || []), { domainId: target, docId: newCid }],
            } as any);
        }

        const files = await copyCourseFiles(domainId, cid, target, newCid, cdoc.files);
        await CourseModel.edit(target, newCid, { files } as any);
        return newCid;
    },

    // Push the current state of a course to one of its shared copies.
    async sync(
        domainId: string,
        cid: ObjectId,
        target: string,
        canViewHidden: number | boolean = 0,
    ): Promise<ObjectId> {
        const cdoc = await CourseModel.get(domainId, cid);
        if (!cdoc) throw new CourseNotFoundError(domainId, cid);
        const ref = (cdoc.sharedTo || []).find((s) => s.domainId === target);
        if (!ref) throw new NotFoundError(target);
        const tcdoc = await CourseModel.get(target, ref.docId);
        if (!tcdoc) throw new CourseNotFoundError(target, ref.docId);

        const sourcePids = (flattenCoursePids(cdoc.chapters).length ? flattenCoursePids(cdoc.chapters) : cdoc.pids) as number[];
        const pidMap = await copyCourseProblems(domainId, sourcePids, target, canViewHidden);
        const pids = sourcePids.map((pid) => pidMap[pid]).filter((pid) => pid != null);
        const chapters = cdoc.chapters?.length ? remapCourseChapters(cdoc.chapters, pidMap) : undefined;
        const maintainer = [...new Set([...(cdoc.maintainer || []), cdoc.owner, ...(tcdoc.maintainer || [])])];
        const files = await copyCourseFiles(domainId, cid, target, ref.docId, cdoc.files);

        // Remove files from the copy that no longer exist in the source.
        const stale = (tcdoc.files || []).filter(
            (f) => f?.name && !(cdoc.files || []).some((sf) => sf?.name === f.name),
        );
        const finalFiles = (files || []).filter((f) => f?.name && !stale.some((s) => s.name === f.name));

        await CourseModel.edit(target, ref.docId, {
            title: cdoc.title,
            content: cdoc.content,
            pids,
            ...(chapters ? { chapters } : {}),
            maintainer,
            teachers: cdoc.teachers,
            assign: cdoc.assign,
            classes: cdoc.classes,
            files: finalFiles,
        } as any);

        if (stale.length) {
            await StorageModel.del(
                stale.map((f) => `course/${target}/${ref.docId}/${f.name}`),
                1,
            );
        }
        return ref.docId;
    },

    // Remove a shared copy in the target domain. Copied problems are kept,
    // since they may be referenced by other courses in the target domain.
    async unshare(domainId: string, cid: ObjectId, target: string): Promise<void> {
        const cdoc = await CourseModel.get(domainId, cid);
        if (!cdoc) throw new CourseNotFoundError(domainId, cid);
        const ref = (cdoc.sharedTo || []).find((s) => s.domainId === target);
        if (!ref) return;

        const tcdoc = await CourseModel.get(target, ref.docId);
        if (tcdoc) {
            await CourseModel.del(target, ref.docId);
            await StorageModel.del(
                (tcdoc.files || []).filter((f) => f?.name).map((f) => `course/${target}/${ref.docId}/${f.name}`),
                1,
            );
        }
        await CourseModel.edit(domainId, cid, {
            sharedTo: (cdoc.sharedTo || []).filter((s) => s.domainId !== target),
        } as any);
    },
};

// Error class for course not found
class CourseNotFoundError extends NotFoundError {
    constructor(domainId: string, cid: ObjectId) {
        super('Course', cid.toString());
        this.params = [domainId, cid];
    }
}

// Enforce class/group visibility for a restricted course. Every handler that
// exposes course content (detail, chapter, scoreboard, records, files) must
// route through this so the restriction cannot be bypassed via a sibling URL.
async function checkCourseAccess(handler: Handler, domainId: string, cdoc: CourseDoc) {
    if (!cdoc.assign?.length && !cdoc.classes?.length) return;
    if (handler.user.own(cdoc) || handler.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK)) return;
    const groups = (await UserModel.listGroup(domainId, handler.user._id)).map((g) => g.name);
    const hasAccess = (cdoc.assign || []).some((a) => groups.includes(a))
        || (cdoc.classes || []).some((c) => groups.includes(c))
        || (cdoc.teachers || []).includes(handler.user._id);
    if (!hasAccess) throw new NotFoundError('Course', cdoc.docId.toString());
}

// Main Course List Handler
class CourseMainHandler extends Handler {
    @param('page', Types.PositiveInt, true)
    @param('q', Types.String, true)
    @param('group', Types.Name, true)
    async get(domainId: string, page = 1, q = '', group = '') {
        const groups = (await UserModel.listGroup(domainId, this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK) ? undefined : this.user._id))
            .map((i) => i.name);

        const escaped = escapeRegExp(q.toLowerCase());

        const query: Filter<CourseDoc> = {};

        if (!(this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK) && !group)) {
            const accessConditions = [
                { maintainer: this.user._id },
                { owner: this.user._id },
                { teachers: this.user._id },
                { assign: { $in: groups } },
                { classes: { $in: groups } },
                // A course is open to everyone only when both assign and
                // classes are empty (or absent on legacy/shared documents).
                {
                    $and: [
                        { $or: [{ assign: { $size: 0 } }, { assign: null }] },
                        { $or: [{ classes: { $size: 0 } }, { classes: null }] },
                    ],
                },
            ];

            if (group) {
                accessConditions.push({ assign: { $in: [group] } });
                accessConditions.push({ classes: { $in: [group] } });
            }

            query.$or = accessConditions;
        }

        if (q) {
            query.title = { $regex: new RegExp(q.length >= 2 ? escaped : `^${escaped}`, 'gim') };
        }

        const cursor = CourseModel.getMulti(domainId, query);
        const [cdocs, cpcount] = await this.paginate(cursor, page, 'course');

        const tids: Set<ObjectId> = new Set();
        for (const cdoc of cdocs) tids.add(cdoc.docId);

        let csdict = {};
        if (this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) {
            const csdocs = await CourseModel.getMultiStatus(domainId, {
                uid: this.user._id,
                docId: { $in: Array.from(tids) },
            }).toArray();
            for (const csdoc of csdocs) csdict[csdoc.docId.toString()] = csdoc;
        }

        let qs = group ? `group=${group}` : '';
        if (q) qs += `${qs ? '&' : ''}q=${encodeURIComponent(q)}`;
        const groupsFilter = groups.filter((i) => !Number.isSafeInteger(+i));

        let enrolled: Array<{ cdoc: CourseDoc; csdoc: CourseStatusDoc }> = [];
        if (this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) {
            const esdocs = await CourseModel.getMultiStatus(domainId, { uid: this.user._id, attend: 1 }).toArray();
            if (esdocs.length) {
                const ecids = esdocs.map((s) => s.docId);
                const ecourses = await CourseModel.getMulti(domainId, { docId: { $in: ecids } }).toArray();
                const ecourseDict: Record<string, CourseDoc> = {};
                for (const cdoc of ecourses) ecourseDict[cdoc.docId.toString()] = cdoc;
                enrolled = esdocs
                    .map((csdoc) => ({ cdoc: ecourseDict[csdoc.docId.toString()], csdoc }))
                    .filter((e) => e.cdoc);
            }
        }

        this.response.body = {
            cdocs,
            csdict,
            page,
            cpcount,
            qs,
            groups: groupsFilter,
            group,
            q,
            enrolled,
        };
        this.response.template = 'course_main.html';
    }
}

// Course Detail Handler
class CourseDetailHandler extends Handler {
    cdoc: CourseDoc;

    @param('cid', Types.ObjectId)
    async prepare(domainId: string, cid: ObjectId) {
        this.cdoc = await CourseModel.get(domainId, cid);
        if (!this.cdoc) throw new CourseNotFoundError(domainId, cid);
        await checkCourseAccess(this, domainId, this.cdoc);
    }

    @param('cid', Types.ObjectId)
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, cid: ObjectId, page = 1) {
        const csdoc = await CourseModel.getStatus(domainId, cid, this.user._id);

        const [ddocs, dpcount, dcount] = await this.paginate(
            DiscussionModel.getMulti(domainId, { parentType: TYPE_COURSE, parentId: cid }),
            page,
            'discussion',
        );

        const uids = [this.cdoc.owner, ...(this.cdoc.maintainer || []), ...(this.cdoc.teachers || [])];
        ddocs.forEach((ddoc) => uids.push(ddoc.owner));
        const udict = await UserModel.getList(domainId, uids);

        let enrolledUsers: number[] = [];
        if (this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) {
            enrolledUsers = (await CourseModel.getMultiStatus(domainId, { docId: cid, uid: { $gt: 1 }, attend: 1 })
                .project({ uid: 1 }).limit(100).toArray()).map((x) => +x.uid);
        }
        const enrolledUdict = await UserModel.getListForRender(domainId, enrolledUsers);

        // New courses store nested chapters, while the flat `pids` field is kept
        // in sync. Fall back to it for legacy data.
        const coursePids = (flattenCoursePids(this.cdoc.chapters).length
            ? flattenCoursePids(this.cdoc.chapters)
            : this.cdoc.pids) as number[];
        const pdict = await ProblemModel.getList(domainId, coursePids, true, true);

        let psdict = {};
        let rdict = {};
        if (csdoc) {
            const valid = (csdoc.journal || []).filter((p) => coursePids.includes(p.pid));
            for (const pdetail of valid) {
                psdict[pdetail.pid] = pdetail;
                rdict[pdetail.rid.toString()] = { _id: pdetail.rid };
            }
            if (valid.length) {
                rdict = await RecordModel.getList(domainId, valid.map((pdetail) => pdetail.rid));
            }
        }

        const chapterProgress: Record<number, { done: number; total: number }> = {};
        const computeChapterProgress = (chapters: CourseChapter[]): { done: number; total: number } => {
            let total = 0;
            let done = 0;
            for (const chapter of chapters) {
                const pids = (chapter.pids || []).map((pid) => Number(pid)).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
                const ownTotal = pids.length;
                const ownDone = pids.filter((pid) => psdict[pid] && psdict[pid].status === 1).length;
                const children = computeChapterProgress(chapter.children || []);
                chapterProgress[chapter._id] = {
                    total: ownTotal + children.total,
                    done: ownDone + children.done,
                };
                total += ownTotal + children.total;
                done += ownDone + children.done;
            }
            return { total, done };
        };
        computeChapterProgress(this.cdoc.chapters || []);

        const validFiles = (this.cdoc.files || []).filter((f) => f && f.name);

        let source: { ddoc: any; cdoc: CourseDoc } | null = null;
        if (this.cdoc.reference) {
            const [ddoc, scdoc] = await Promise.all([
                DomainModel.get(this.cdoc.reference.domainId),
                CourseModel.get(this.cdoc.reference.domainId, this.cdoc.reference.docId),
            ]);
            if (ddoc && scdoc) source = { ddoc, cdoc: scdoc };
        }

        const canShare = !this.cdoc.reference
            && (this.user.own(this.cdoc)
                || (this.cdoc.teachers || []).includes(this.user._id)
                || this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK));
        const canEditChapter = this.user.own(this.cdoc)
            ? this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK_SELF)
            : this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK);

        this.response.template = 'course_detail.html';
        this.response.body = {
            cdoc: this.cdoc,
            csdoc,
            udict,
            ddocs,
            page,
            dpcount,
            dcount,
            pdict,
            psdict,
            rdict,
            enrolledUsers,
            enrolledUdict,
            files: sortFiles(validFiles),
            source,
            canShare,
            canEditChapter,
            chapterProgress,
        };

        this.response.body.cdoc.content = this.response.body.cdoc.content
            .replace(/\(file:\/\//g, `(./${cid}/file/`)
            .replace(/="file:\/\//g, `="./${cid}/file/`);
    }

    @param('cid', Types.ObjectId)
    async postAttend(domainId: string, cid: ObjectId) {
        this.checkPerm(PERM.PERM_ATTEND_HOMEWORK);
        await CourseModel.attend(domainId, cid, this.user._id);
        this.back();
    }
}

// Course Chapter Handler
class CourseChapterHandler extends Handler {
    cdoc: CourseDoc;
    chapterPath: CourseChapter[];

    @param('cid', Types.ObjectId)
    @param('chapterId', Types.PositiveInt)
    async prepare(domainId: string, cid: ObjectId, chapterId: number) {
        this.cdoc = await CourseModel.get(domainId, cid);
        if (!this.cdoc) throw new CourseNotFoundError(domainId, cid);
        await checkCourseAccess(this, domainId, this.cdoc);

        const chapterPath = findChapterPath(this.cdoc.chapters || [], chapterId);
        if (!chapterPath) throw new NotFoundError('Chapter', String(chapterId));
        this.chapterPath = chapterPath;
    }

    @param('cid', Types.ObjectId)
    @param('chapterId', Types.PositiveInt)
    async get(domainId: string, cid: ObjectId, chapterId: number) {
        const chapter = this.chapterPath[this.chapterPath.length - 1];
        const chapterPids = (chapter.pids || []).map((pid) => Number(pid)).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
        const pdict = await ProblemModel.getList(domainId, chapterPids, true, true);

        const csdoc = await CourseModel.getStatus(domainId, cid, this.user._id);
        const psdict = {};
        let rdict = {};
        if (csdoc) {
            const valid = (csdoc.journal || []).filter((p) => chapterPids.includes(p.pid));
            for (const pdetail of valid) {
                psdict[pdetail.pid] = pdetail;
                rdict[pdetail.rid.toString()] = { _id: pdetail.rid };
            }
            if (valid.length) {
                rdict = await RecordModel.getList(domainId, valid.map((pdetail) => pdetail.rid));
            }
        }

        this.response.template = 'course_chapter.html';
        const canEditChapter = this.user.own(this.cdoc)
            ? this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK_SELF)
            : this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK);
        this.response.body = {
            cdoc: this.cdoc,
            chapter,
            chapterPath: this.chapterPath,
            chapterPids,
            pdict,
            psdict,
            rdict,
            canEditChapter,
        };
    }
}

// Course Chapter Edit Handler
class CourseChapterEditHandler extends Handler {
    cdoc: CourseDoc;
    chapterPath: CourseChapter[];
    chapters: CourseChapter[];

    @param('cid', Types.ObjectId)
    @param('chapterId', Types.PositiveInt)
    async prepare(domainId: string, cid: ObjectId, chapterId: number) {
        this.cdoc = await CourseModel.get(domainId, cid);
        if (!this.cdoc) throw new CourseNotFoundError(domainId, cid);

        if (!this.user.own(this.cdoc)) this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        else this.checkPerm(PERM.PERM_EDIT_HOMEWORK_SELF);

        this.chapters = JSON.parse(JSON.stringify(this.cdoc.chapters || []));
        const chapterPath = findChapterPath(this.chapters, chapterId);
        if (!chapterPath) throw new NotFoundError('Chapter', String(chapterId));
        this.chapterPath = chapterPath;
    }

    @param('cid', Types.ObjectId)
    @param('chapterId', Types.PositiveInt)
    async get(domainId: string, cid: ObjectId, chapterId: number) {
        const chapter = this.chapterPath[this.chapterPath.length - 1];
        const chapterPids = (chapter.pids || []).map((pid) => Number(pid)).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
        const pdict = await ProblemModel.getList(domainId, chapterPids, true, false);
        const problems = chapterPids.map((pid) => {
            const pdoc = pdict[pid];
            return {
                id: pid,
                pid: pdoc?.pid || '',
                title: pdoc?.title || String(pid),
                nSubmit: pdoc?.nSubmit || 0,
                nAccept: pdoc?.nAccept || 0,
                difficulty: pdoc?.difficulty || 0,
                tag: pdoc?.tag || [],
                hidden: !!pdoc?.hidden,
            };
        });
        this.response.template = 'course_chapter_edit.html';
        this.response.body = {
            cdoc: this.cdoc,
            chapter,
            chapterPath: this.chapterPath,
            pids: (chapter.pids || []).join(', '),
            problems,
        };
    }

    @param('cid', Types.ObjectId)
    @param('chapterId', Types.PositiveInt)
    @param('title', Types.Title)
    @param('content', Types.Content, true)
    @param('pids', Types.Content, true)
    async postUpdate(
        domainId: string,
        cid: ObjectId,
        chapterId: number,
        title: string,
        content = '',
        _pids: string = '',
    ) {
        const rawPids = _pids.replace(/，/g, ',').split(',').map((i) => i.trim()).filter((i) => i);
        const { pids } = await resolveProblemIds(domainId, rawPids);
        if (pids.length) {
            await ProblemModel.getList(domainId, pids, this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) || this.user._id, true);
        }
        if (!updateChapterInTree(this.chapters, chapterId, (chapter) => ({ ...chapter, title, content, pids }))) {
            throw new NotFoundError('Chapter', String(chapterId));
        }
        await CourseModel.edit(domainId, cid, {
            chapters: this.chapters,
            pids: flattenCoursePids(this.chapters) as number[],
        } as any);
        this.response.redirect = this.url('course_chapter', { cid, chapterId });
    }

    @param('cid', Types.ObjectId)
    @param('chapterId', Types.PositiveInt)
    @param('title', Types.Title)
    async postAddChild(domainId: string, cid: ObjectId, chapterId: number, title: string) {
        const child: CourseChapter = {
            _id: nextChapterId(this.chapters),
            title,
            content: '',
            pids: [],
            children: [],
        };
        if (!addChildChapter(this.chapters, chapterId, child)) {
            throw new NotFoundError('Chapter', String(chapterId));
        }
        await CourseModel.edit(domainId, cid, {
            chapters: this.chapters,
            pids: flattenCoursePids(this.chapters) as number[],
        } as any);
        this.response.redirect = this.url('course_chapter_edit', { cid, chapterId: child._id });
    }
}

// Course Edit Handler
class CourseEditHandler extends Handler {
    cdoc: CourseDoc | null;

    @param('cid', Types.ObjectId, true)
    async prepare(domainId: string, cid?: ObjectId) {
        if (cid) {
            this.cdoc = await CourseModel.get(domainId, cid);
            if (!this.cdoc) throw new CourseNotFoundError(domainId, cid);
            if (!this.user.own(this.cdoc)) this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
            else this.checkPerm(PERM.PERM_EDIT_HOMEWORK_SELF);
        } else {
            this.checkPerm(PERM.PERM_CREATE_HOMEWORK);
            this.cdoc = null;
        }
    }

    @param('cid', Types.ObjectId, true)
    async get(domainId: string, cid?: ObjectId) {
        const groups = await UserModel.listGroup(domainId);
        const chapters = courseChaptersForEditor(this.cdoc);

        let source: { ddoc: any; cdoc: CourseDoc } | null = null;
        if (this.cdoc?.reference) {
            const [ddoc, scdoc] = await Promise.all([
                DomainModel.get(this.cdoc.reference.domainId),
                CourseModel.get(this.cdoc.reference.domainId, this.cdoc.reference.docId),
            ]);
            if (ddoc && scdoc) source = { ddoc, cdoc: scdoc };
        }

        this.response.template = 'course_edit.html';
        this.response.body = {
            cdoc: this.cdoc,
            groups,
            page_name: cid ? 'course_edit' : 'course_create',
            pids: this.cdoc ? this.cdoc.pids.join(',') : '',
            chaptersJson: JSON.stringify(chapters),
            canShare: !!(cid && this.cdoc && !this.cdoc.reference),
            source,
        };
    }

    @param('cid', Types.ObjectId, true)
    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('pids', Types.Content, true)
    @param('chapters', Types.Content, true)
    @param('maintainer', Types.NumericArray, true)
    @param('teachers', Types.NumericArray, true)
    @param('assign', Types.CommaSeperatedArray, true)
    @param('classes', Types.CommaSeperatedArray, true)
    async postUpdate(
        domainId: string,
        cid: ObjectId | undefined,
        title: string,
        content: string,
        _pids: string = '',
        _chapters: string = '',
        maintainer: number[] = [],
        teachers: number[] = [],
        assign: string[] = [],
        classes: string[] = [],
    ) {
        const chapters = _chapters ? parseCourseChapters(_chapters) : [];
        const rawPids = _chapters
            ? flattenCoursePids(chapters)
            : _pids.replace(/，/g, ',').split(',').map((i) => i.trim()).filter((i) => i);
        const { pids, pidMap } = await resolveProblemIds(domainId, rawPids);
        const resolvedChapters = _chapters ? remapCourseChapters(chapters, pidMap) : [];

        if (pids.length) {
            await ProblemModel.getList(domainId, pids, this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) || this.user._id, true);
        }

        if (!cid) {
            cid = await CourseModel.add(domainId, title, content, this.user._id, pids, {
                maintainer,
                teachers,
                assign,
                classes,
                ...(_chapters ? { chapters: resolvedChapters } : {}),
            });
        } else {
            await CourseModel.edit(domainId, cid, {
                title,
                content,
                pids,
                maintainer,
                teachers,
                assign,
                classes,
                ...(_chapters ? { chapters: resolvedChapters } : {}),
            });
        }

        this.response.body = { cid };
        this.response.redirect = this.url('course_detail', { cid });
    }

    @param('cid', Types.ObjectId)
    async postDelete(domainId: string, cid: ObjectId) {
        if (!this.user.own(this.cdoc!)) this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        await Promise.all([
            CourseModel.del(domainId, cid),
            StorageModel.del(this.cdoc?.files?.map((i) => `course/${domainId}/${cid}/${i.name}`) || [], this.user._id),
        ]);
        this.response.redirect = this.url('course_main');
    }
}

// Course Files Handler
class CourseFilesHandler extends Handler {
    cdoc: CourseDoc;

    @param('cid', Types.ObjectId)
    async prepare(domainId: string, cid: ObjectId) {
        this.cdoc = await CourseModel.get(domainId, cid);
        if (!this.cdoc) throw new CourseNotFoundError(domainId, cid);
        if (!this.user.own(this.cdoc) && !(this.cdoc.teachers || []).includes(this.user._id)) {
            this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        } else {
            this.checkPerm(PERM.PERM_EDIT_HOMEWORK_SELF);
        }
    }

    @param('cid', Types.ObjectId)
    async get(domainId: string, cid: ObjectId) {
        const validFiles = (this.cdoc.files || []).filter((f) => f && f.name);
        this.response.body = {
            cdoc: this.cdoc,
            csdoc: await CourseModel.getStatus(domainId, cid, this.user._id),
            udoc: await UserModel.getById(domainId, this.cdoc.owner),
            files: sortFiles(validFiles),
            urlForFile: (filename: string) => this.url('course_file_download', { cid, filename }),
        };
        this.response.pjax = 'partials/files.html';
        this.response.template = 'course_files.html';
    }

    @param('cid', Types.ObjectId)
    @post('filename', Types.Filename, true)
    async postUploadFile(domainId: string, cid: ObjectId, filename: string) {
        if ((this.cdoc.files?.length || 0) >= SystemModel.get('limit.contest_files')) {
            throw new FileLimitExceededError('count');
        }
        const file = this.request.files?.file;
        if (!file) throw new ValidationError('file');
        const originalName = file.originalFilename || file.newFilename;
        const actualFilename = filename || originalName;
        if (!actualFilename) throw new ValidationError('filename');
        // Replacing an existing file does not add to the total size.
        const size = (this.cdoc.files || [])
            .filter((i) => i?.name && i.name !== actualFilename)
            .reduce((acc, i) => acc + (i.size || 0), 0) + file.size;
        if (size >= SystemModel.get('limit.contest_files_size')) {
            throw new FileLimitExceededError('size');
        }
        const target = `course/${domainId}/${cid}/${actualFilename}`;
        await StorageModel.put(target, file.filepath, this.user._id);
        const meta = await StorageModel.getMeta(target);
        if (!meta) {
            // Remove the orphaned object so a failed upload leaves no trace.
            await StorageModel.del([target], this.user._id).catch(() => null);
            throw new FileUploadError();
        }
        const payload = { _id: actualFilename, name: actualFilename, ...pick(meta, ['size', 'lastModified', 'etag']) };
        // Replace any existing entry with the same name instead of duplicating it.
        const files = (this.cdoc.files || []).filter((i) => i?.name && i.name !== actualFilename);
        await CourseModel.edit(domainId, cid, { files: [...files, payload] } as any);
        this.back();
    }

    @param('cid', Types.ObjectId)
    @post('files', Types.ArrayOf(Types.Filename))
    async postDeleteFiles(domainId: string, cid: ObjectId, files: string[]) {
        await Promise.all([
            StorageModel.del(files.map((t) => `course/${domainId}/${cid}/${t}`), this.user._id),
            CourseModel.edit(domainId, cid, { files: this.cdoc.files?.filter((i) => !files.includes(i.name)) } as any),
        ]);
        this.back();
    }
}

// Course File Download Handler
class CourseFileDownloadHandler extends Handler {
    @param('cid', Types.ObjectId)
    @param('filename', Types.Filename)
    @param('noDisposition', Types.Boolean, true)
    async get(domainId: string, cid: ObjectId, filename: string, noDisposition = false) {
        const cdoc = await CourseModel.get(domainId, cid);
        if (!cdoc) throw new CourseNotFoundError(domainId, cid);
        await checkCourseAccess(this, domainId, cdoc);

        this.response.addHeader('Cache-Control', 'public');
        const target = `course/${domainId}/${cid}/${filename}`;
        this.response.redirect = await StorageModel.signDownloadLink(
            target,
            noDisposition ? undefined : filename,
            false,
            'user',
        );
    }
}

// Course Share Handler
class CourseShareHandler extends Handler {
    cdoc: CourseDoc;

    @param('cid', Types.ObjectId)
    async prepare(domainId: string, cid: ObjectId) {
        this.cdoc = await CourseModel.get(domainId, cid);
        if (!this.cdoc) throw new CourseNotFoundError(domainId, cid);
        const canManage = this.user.own(this.cdoc) || (this.cdoc.teachers || []).includes(this.user._id);
        if (canManage) this.checkPerm(PERM.PERM_EDIT_HOMEWORK_SELF);
        else this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        if (this.cdoc.reference) throw new ValidationError('reference');
    }

    @param('cid', Types.ObjectId)
    async get(domainId: string, cid: ObjectId) {
        const dudict = await DomainModel.getDictUserByDomainId(this.user._id);
        const dids = Object.keys(dudict);
        const allDomains = await DomainModel.getMulti({ _id: { $in: dids } }).toArray();
        const sharePolicy = this.domain.share as string | undefined;
        const targets = [];

        for (const d of allDomains) {
            if (d._id === domainId) continue;
            const dudoc = await UserModel.getById(d._id, this.user._id);
            if (!dudoc || !dudoc.hasPerm(PERM.PERM_CREATE_HOMEWORK)) continue;
            if (this.cdoc.pids?.length && !isTargetAllowed(sharePolicy, d._id)) continue;
            targets.push(d);
        }

        const shares = [];
        for (const ref of this.cdoc.sharedTo || []) {
            const [ddoc, scdoc] = await Promise.all([
                DomainModel.get(ref.domainId),
                CourseModel.get(ref.domainId, ref.docId),
            ]);
            if (!ddoc) continue;
            shares.push({ domain: ddoc, cdoc: scdoc, ref });
        }

        this.response.template = 'course_share.html';
        this.response.body = {
            cdoc: this.cdoc,
            targets,
            shares,
        };
    }

    @param('cid', Types.ObjectId)
    @param('target', Types.Name)
    async postShare(domainId: string, cid: ObjectId, target: string) {
        if (this.cdoc.pids?.length && !isTargetAllowed(this.domain.share, target)) {
            throw new ValidationError('target');
        }
        const targetDomain = await DomainModel.get(target);
        if (!targetDomain) throw new NotFoundError(target);
        const dudoc = await UserModel.getById(target, this.user._id);
        if (!dudoc || !dudoc.hasPerm(PERM.PERM_CREATE_HOMEWORK)) throw new PermissionError(PERM.PERM_CREATE_HOMEWORK);
        const newCid = await CourseModel.share(
            domainId,
            cid,
            target,
            this.user._id,
            this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) || this.user._id,
        );
        this.response.redirect = this.url('course_detail', { domainId: target, cid: newCid });
    }

    @param('cid', Types.ObjectId)
    @param('target', Types.Name)
    async postSync(domainId: string, cid: ObjectId, target: string) {
        await CourseModel.sync(
            domainId,
            cid,
            target,
            this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) || this.user._id,
        );
        this.response.redirect = this.url('course_share', { cid });
    }

    @param('cid', Types.ObjectId)
    @param('target', Types.Name)
    async postUnshare(domainId: string, cid: ObjectId, target: string) {
        await CourseModel.unshare(domainId, cid, target);
        this.response.redirect = this.url('course_share', { cid });
    }
}

// Build a fully sorted scoreboard for a problem set, then slice out the
// requested page. Sorting must happen before pagination: slicing first (as
// framework `paginate()` does) would scramble ranks across pages.
async function buildCourseScoreboard(domainId: string, cid: ObjectId, pids: number[], page: number) {
    const pageSize = SystemModel.get('pagination.scoreboard');
    const csdocs = await CourseModel.getMultiStatus(domainId, { docId: cid, attend: 1 }).toArray();
    const udict = await UserModel.getListForRender(domainId, csdocs.map((csdoc) => csdoc.uid));
    const pdict = await ProblemModel.getList(domainId, pids, true, true);

    const rows: any[] = [];
    for (const csdoc of csdocs) {
        const row: any = {
            uid: csdoc.uid,
            user: udict[csdoc.uid],
            scores: {},
            totalScore: 0,
        };
        for (const pid of pids) {
            const progress = (csdoc.journal || []).find((j) => j.pid === pid);
            row.scores[pid] = progress?.score || 0;
            row.totalScore += progress?.score || 0;
        }
        rows.push(row);
    }
    rows.sort((a, b) => b.totalScore - a.totalScore || a.uid - b.uid);

    const start = (page - 1) * pageSize;
    return {
        rows: rows.slice(start, start + pageSize),
        pdict,
        cpcount: Math.ceil(rows.length / pageSize),
        rankBase: start,
    };
}

// Course Scoreboard Handler
class CourseScoreboardHandler extends Handler {
    cdoc: CourseDoc;

    @param('cid', Types.ObjectId)
    async prepare(domainId: string, cid: ObjectId) {
        this.cdoc = await CourseModel.get(domainId, cid);
        if (!this.cdoc) throw new CourseNotFoundError(domainId, cid);
        await checkCourseAccess(this, domainId, this.cdoc);
    }

    @param('cid', Types.ObjectId)
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, cid: ObjectId, page = 1) {
        this.checkPerm(PERM.PERM_VIEW_HOMEWORK_SCOREBOARD);
        const { rows, pdict, cpcount, rankBase } = await buildCourseScoreboard(domainId, cid, this.cdoc.pids, page);

        this.response.template = 'course_scoreboard.html';
        this.response.body = {
            cdoc: this.cdoc,
            chapter: null,
            pids: this.cdoc.pids,
            pdict,
            rows,
            page,
            cpcount,
            rankBase,
        };
    }
}

// Scoreboard for a single chapter and its nested subchapters.
class CourseChapterScoreboardHandler extends Handler {
    cdoc: CourseDoc;
    chapter: CourseChapter;
    chapterPids: number[];

    @param('cid', Types.ObjectId)
    @param('chapterId', Types.PositiveInt)
    async prepare(domainId: string, cid: ObjectId, chapterId: number) {
        this.cdoc = await CourseModel.get(domainId, cid);
        if (!this.cdoc) throw new CourseNotFoundError(domainId, cid);
        await checkCourseAccess(this, domainId, this.cdoc);
        const chapterPath = findChapterPath(this.cdoc.chapters || [], chapterId);
        if (!chapterPath) throw new NotFoundError('Chapter', String(chapterId));
        this.chapter = chapterPath[chapterPath.length - 1];
        this.chapterPids = (flattenCoursePids([this.chapter]) as number[])
            .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
    }

    @param('cid', Types.ObjectId)
    @param('chapterId', Types.PositiveInt)
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, cid: ObjectId, chapterId: number, page = 1) {
        this.checkPerm(PERM.PERM_VIEW_HOMEWORK_SCOREBOARD);
        const { rows, pdict, cpcount, rankBase } = await buildCourseScoreboard(domainId, cid, this.chapterPids, page);

        this.response.template = 'course_scoreboard.html';
        this.response.body = {
            cdoc: this.cdoc,
            chapter: this.chapter,
            pids: this.chapterPids,
            pdict,
            rows,
            page,
            cpcount,
            rankBase,
        };
    }
}

// Course Records Handler
class CourseRecordsHandler extends Handler {
    cdoc: CourseDoc;

    @param('cid', Types.ObjectId)
    async prepare(domainId: string, cid: ObjectId) {
        this.cdoc = await CourseModel.get(domainId, cid);
        if (!this.cdoc) throw new CourseNotFoundError(domainId, cid);
        await checkCourseAccess(this, domainId, this.cdoc);
    }

    @param('cid', Types.ObjectId)
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, cid: ObjectId, page = 1) {
        const cdoc = this.cdoc;

        // Only standalone submissions belong to a course; contest records are
        // excluded to match the record/judge hook, which ignores them.
        const query: any = {
            pid: { $in: cdoc.pids },
            contest: { $exists: false },
        };

        if (!this.user.hasPerm(PERM.PERM_VIEW_HOMEWORK_SCOREBOARD)) {
            query.uid = this.user._id;
        }

        const cursor = RecordModel.getMulti(domainId, query).sort({ _id: -1 });
        const [rdocs, rpcount] = await this.paginate(cursor, page, 'record');

        const uids = [...new Set(rdocs.map((r) => r.uid))];
        const udict = await UserModel.getListForRender(domainId, uids);
        const pdict = await ProblemModel.getList(domainId, cdoc.pids, true, true);

        this.response.template = 'course_records.html';
        this.response.body = {
            cdoc,
            rdocs,
            pdict,
            udict,
            page,
            rpcount,
        };
    }
}

// Problem quick-search endpoint used by the chapter editor autocomplete.
class CourseProblemSearchHandler extends Handler {
    @param('q', Types.Content, true)
    async get(domainId: string, q = '') {
        const qq = (q || '').trim();
        if (!qq) {
            this.response.body = [];
            return;
        }
        const escaped = escapeRegExp(qq.toLowerCase());
        const regex = new RegExp(qq.length >= 2 ? escaped : `^${escaped}`, 'i');
        const query: Filter<any> = {
            $or: [
                { pid: regex },
                { title: regex },
                ...(qq.length >= 2 ? [{ tag: qq }] : []),
            ],
        };
        const projection = ['docId', 'pid', 'title', 'nSubmit', 'nAccept', 'difficulty', 'tag', 'hidden', 'owner'];
        let pdocs = await ProblemModel.getMulti(domainId, query, projection as any).limit(20).toArray();
        const numeric = Number.isSafeInteger(+qq) ? +qq : null;
        if (numeric) {
            const exact = await ProblemModel.get(domainId, numeric, projection as any, true);
            if (exact && !pdocs.some((p) => p.docId === exact.docId)) pdocs.unshift(exact);
        }
        const canViewHidden = this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN);
        pdocs = pdocs.filter((p) => canViewHidden || p.owner === this.user._id || !p.hidden);
        this.response.body = pdocs.map((p) => ({
            docId: p.docId,
            pid: p.pid || '',
            title: p.title || '*',
            nSubmit: p.nSubmit || 0,
            nAccept: p.nAccept || 0,
            difficulty: p.difficulty || 0,
            tag: p.tag || [],
            hidden: !!p.hidden,
        }));
    }
}

// Plugin apply function
export async function apply(ctx: Context) {
    ctx.Route('course_main', '/course', CourseMainHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('course_create', '/course/create', CourseEditHandler);
    ctx.Route('course_problem_search', '/course/problem-search', CourseProblemSearchHandler, PERM.PERM_VIEW_PROBLEM);
    ctx.Route('course_detail', '/course/:cid', CourseDetailHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('course_chapter', '/course/:cid/chapter/:chapterId', CourseChapterHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('course_chapter_edit', '/course/:cid/chapter/:chapterId/edit', CourseChapterEditHandler);
    ctx.Route('course_chapter_scoreboard', '/course/:cid/chapter/:chapterId/scoreboard', CourseChapterScoreboardHandler, PERM.PERM_VIEW_HOMEWORK_SCOREBOARD);
    ctx.Route('course_edit', '/course/:cid/edit', CourseEditHandler);
    ctx.Route('course_files', '/course/:cid/file', CourseFilesHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('course_file_download', '/course/:cid/file/:filename', CourseFileDownloadHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('course_scoreboard', '/course/:cid/scoreboard', CourseScoreboardHandler, PERM.PERM_VIEW_HOMEWORK_SCOREBOARD);
    ctx.Route('course_records', '/course/:cid/records', CourseRecordsHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('course_share', '/course/:cid/share', CourseShareHandler, PERM.PERM_VIEW_HOMEWORK);

    // Navigation entry: after Training, before Contest.
    injectCourseNav(ctx);

    // Track course problem status whenever a submission is judged.
    ctx.on('record/judge', async (rdoc) => {
        if (!rdoc || rdoc.contest) return;
        const { domainId, pid, uid } = rdoc as any;
        if (!domainId || !pid || !uid) return;
        const cdocs = await CourseModel.getMulti(domainId, { pids: pid }).toArray();
        for (const cdoc of cdocs) {
            const csdoc = await CourseModel.getStatus(domainId, cdoc.docId, uid);
            if (!csdoc || (!csdoc.enroll && !csdoc.attend)) continue;
            const journal = csdoc.journal || [];
            const idx = journal.findIndex((j) => j.pid === pid);
            const current = idx >= 0 ? journal[idx] : undefined;
            const sameRecord = !!current?.rid && current.rid.toString() === rdoc._id.toString();
            // Keep the best-scoring submission per problem. Only a rejudge of
            // the very same record may lower the stored score.
            if (current && !sameRecord && (rdoc.score || 0) < (current.score || 0)) continue;
            const entry = { pid, rid: rdoc._id, score: rdoc.score || 0, status: rdoc.status };
            if (idx >= 0) journal[idx] = entry;
            else journal.push(entry);
            const progress = csdoc.progress || {};
            progress[pid] = entry;
            await CourseModel.setStatus(domainId, cdoc.docId, uid, { journal, progress } as any);
        }
    });

    ctx.i18n.load('zh', {
        course: '课程',
        course_main: '课程',
        course_detail: '课程详情',
        course_create: '创建课程',
        course_edit: '编辑课程',
        course_files: '课程文件',
        course_scoreboard: '成绩表',
        course_records: '提交记录',
        course_share: '分享课程',
        'Create Course': '创建课程',
        'Edit Course': '编辑课程',
        'Course List': '课程列表',
        'All Courses': '课程',
        'Search courses...': '搜索课程...',
        '{0} chapters': '{0} 个章节',
        '{0} problems': '{0} 道题',
        'New Course': '新建课程',
        'You can create your own courses and share them with others.': '你可以创建自己的课程并与他人分享。',
        'Complete': '完成',
        'Course': '课程',
        'You have not enrolled in any course.': '你还没有加入任何课程。',
        'Not Enrolled': '未参加',
        'Enrollees': '加入人数',
        'Created By': '创建者',
        'Chapter': '章节',
        'Chapter List': '章节列表',
        'Expand all': '展开全部章节',
        'Collapse all': '收起全部章节',
        'Expand': '展开',
        'Collapse': '收起',
        'Course Detail': '课程详情',
        'Course Files': '课程文件',
        'Course Scoreboard': '成绩表',
        'Course Records': '提交记录',
        'Join Course': '加入课程',
        'Course Introduction': '课程介绍',
        'Course Materials': '课程资料',
        'Enrolled Students': '已加入学生',
        'Problem List': '题目列表',
        'Teachers': '教师',
        'Classes': '班级',
        'Already enrolled in this course': '已加入该课程',
        'Course not found': '课程未找到',
        'Chapters': '章节',
        'Add chapters and nested subchapters. Each chapter can contain problems or child chapters.': '添加章节与嵌套子章节。每个章节可包含题目或子章节。',
        'Course Content': '课程内容',
        'problems': '道题',
        'subchapters': '个子章节',
        'Subchapters': '子章节',
        'Problems': '题目',
        'Edit Chapter': '编辑章节',
        'No subchapters yet.': '暂无子章节。',
        'New subchapter title': '新子章节标题',
        'Add Subchapter': '添加子章节',
        'Back to Chapter': '返回章节',
        'Back to Course': '返回课程',
        'Move up': '上移',
        'Move down': '下移',
        'Remove': '移除',
        'Add': '添加',
        'No problems in this chapter.': '本章节暂无题目。',
        'No courses found.': '暂无课程。',
        'enrolled': '已参加',
        'Enrolled': '已参加',
        'Shared': '已分享',
        'Not Submitted': '未提交',
        'Upload Lecture': '上传讲义',
        'Manage Files': '管理文件',
        'Total Score': '总分',
        'Progress': '进度',
        'Student': '学生',
        'Records': '提交记录',
        'Quick Links': '快速链接',
        'New Discussion': '发起讨论',
        'No discussions yet.': '暂无讨论。',
        'Discussion': '讨论',
        'Submitter': '提交者',
        'Submit Time': '提交时间',
        'No records yet.': '暂无提交记录。',
        'Share Course': '分享课程',
        'Share to Domain': '分享到域',
        'Target Domain': '目标域',
        'Select a domain to share this course to': '选择要分享课程的目标域',
        'Share': '分享',
        'Available Domains': '可用域',
        'No domains available to share to.': '没有可分享的目标域。',
        'Shared Courses': '已分享的课程',
        'Sync': '同步',
        'Revoke': '撤销分享',
        'Domain': '域',
        'Actions': '操作',
        'Domain share setting hint': '可在当前域的“域设置”中配置允许分享的域(填写 * 表示允许所有域)。',
        'Shared from domain': '来自域',
        'Revoke hint': '撤销分享会删除目标域中的课程副本(保留已复制的题目)。',
    });

    ctx.i18n.load('en', {
        course: 'Course',
        course_main: 'Course',
        course_detail: 'Course Detail',
        course_create: 'Create Course',
        course_edit: 'Edit Course',
        course_files: 'Course Files',
        course_scoreboard: 'Scoreboard',
        course_records: 'Records',
        course_share: 'Share Course',
        'Create Course': 'Create Course',
        'Edit Course': 'Edit Course',
        'Course List': 'Course List',
        'All Courses': 'All Courses',
        'Search courses...': 'Search courses...',
        '{0} chapters': '{0} chapters',
        '{0} problems': '{0} problems',
        'New Course': 'New Course',
        'You can create your own courses and share them with others.': 'You can create your own courses and share them with others.',
        'Complete': 'Complete',
        'Course': 'Course',
        'You have not enrolled in any course.': 'You have not enrolled in any course.',
        'Not Enrolled': 'Not Enrolled',
        'Enrollees': 'Enrollees',
        'Created By': 'Created By',
        'Chapter': 'Chapter',
        'Chapter List': 'Chapter List',
        'Expand all': 'Expand all',
        'Collapse all': 'Collapse all',
        'Expand': 'Expand',
        'Collapse': 'Collapse',
        'Course Detail': 'Course Detail',
        'Course Files': 'Course Files',
        'Course Scoreboard': 'Scoreboard',
        'Course Records': 'Records',
        'Join Course': 'Join Course',
        'Course Introduction': 'Course Introduction',
        'Course Materials': 'Course Materials',
        'Enrolled Students': 'Enrolled Students',
        'Problem List': 'Problem List',
        'Teachers': 'Teachers',
        'Classes': 'Classes',
        'Already enrolled in this course': 'Already enrolled in this course',
        'Course not found': 'Course not found',
        'Chapters': 'Chapters',
        'Add chapters and nested subchapters. Each chapter can contain problems or child chapters.': 'Add chapters and nested subchapters. Each chapter can contain problems or child chapters.',
        'Course Content': 'Course Content',
        'problems': 'problems',
        'subchapters': 'subchapters',
        'Subchapters': 'Subchapters',
        'Problems': 'Problems',
        'Edit Chapter': 'Edit Chapter',
        'No subchapters yet.': 'No subchapters yet.',
        'New subchapter title': 'New subchapter title',
        'Add Subchapter': 'Add Subchapter',
        'Back to Chapter': 'Back to Chapter',
        'Back to Course': 'Back to Course',
        'Move up': 'Move up',
        'Move down': 'Move down',
        'Remove': 'Remove',
        'Add': 'Add',
        'No problems in this chapter.': 'No problems in this chapter.',
        'No courses found.': 'No courses found.',
        'enrolled': 'enrolled',
        'Enrolled': 'Enrolled',
        'Shared': 'Shared',
        'Not Submitted': 'Not Submitted',
        'Upload Lecture': 'Upload Lecture',
        'Manage Files': 'Manage Files',
        'Total Score': 'Total Score',
        'Progress': 'Progress',
        'Student': 'Student',
        'Records': 'Records',
        'Quick Links': 'Quick Links',
        'New Discussion': 'New Discussion',
        'No discussions yet.': 'No discussions yet.',
        'Discussion': 'Discussion',
        'Submitter': 'Submitter',
        'Submit Time': 'Submit Time',
        'No records yet.': 'No records yet.',
        'Share Course': 'Share Course',
        'Share to Domain': 'Share to Domain',
        'Target Domain': 'Target Domain',
        'Select a domain to share this course to': 'Select a domain to share this course to',
        'Share': 'Share',
        'Available Domains': 'Available Domains',
        'No domains available to share to.': 'No domains available to share to.',
        'Shared Courses': 'Shared Courses',
        'Sync': 'Sync',
        'Revoke': 'Revoke',
        'Domain': 'Domain',
        'Actions': 'Actions',
        'Domain share setting hint': 'Configure allowed target domains in the "Share problem with domain" domain setting of the source domain (use * to allow all domains).',
        'Shared from domain': 'Shared from domain',
        'Revoke hint': 'Revoking deletes the course copy in the target domain (copied problems are kept).',
    });

    (global as any).Hydro.model.course = CourseModel;
}
