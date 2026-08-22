import {
    Context, db, DocumentModel, DomainModel, Handler, JudgeResultCallbackContext, NotFoundError,
    ObjectId, param, PERM, PRIV, ProblemModel, RecordModel, STATUS, STATUS_SHORT_TEXTS,
    Types, UserModel, ValidationError,
} from 'hydrooj';

const coll = db.collection('domain.learning.mistakeReflection' as any);
const collGroup = db.collection('user.group' as any);
const collPending = db.collection('domain.learning.mistakeReflectionPending' as any);
const PENDING_STATUS = STATUS.STATUS_WRONG_ANSWER;

const CAUSES = [
    ['reading', '读题理解'],
    ['edge', '边界条件'],
    ['algorithm', '算法选择'],
    ['complexity', '复杂度估计'],
    ['implementation', '代码实现'],
    ['debug', '调试习惯'],
    ['math', '数学推导'],
    ['other', '其他'],
];

interface CourseRef {
    courseId: any;
    courseTitle: string;
    sectionId: any;
    sectionTitle: string;
    subsecId: any;
    subsecTitle: string;
    sectionOrder: number;
    subsecOrder: number;
}

function causeLabel(cause: string) {
    return CAUSES.find(([key]) => key === cause)?.[1] || '其他';
}

function idText(value: any) {
    return value?.toHexString?.() || value?.toString?.() || String(value);
}

function titleText(value: any, fallback: string) {
    return String(value || fallback).split('\n')[0];
}

function causeSummary(causeCounts: Record<string, number>) {
    return Object.entries(causeCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([cause, count]) => `${causeLabel(cause)} ${count}`)
        .join(' / ');
}

async function getReflection(domainId: string, rid: ObjectId) {
    const doc = await coll.findOne({ domainId, _id: rid });
    if (!doc) throw new NotFoundError('错因卡不存在。');
    return doc;
}

async function hasReflection(domainId: string, uid: number, pid: number) {
    return await coll.countDocuments({ domainId, uid, pid }) > 0;
}

function isNormalAcceptedRecord(rdoc: any) {
    return rdoc?.status === STATUS.STATUS_ACCEPTED && !rdoc.contest;
}

async function markReflectionPending(rdoc: any) {
    const current = await DocumentModel.getStatus(rdoc.domainId, DocumentModel.TYPE_PROBLEM, rdoc.pid, rdoc.uid) as any;
    if (current?.status === STATUS.STATUS_ACCEPTED) return false;
    const score = Math.min(Number(rdoc.score || 0), 99);
    await DocumentModel.setStatus(rdoc.domainId, DocumentModel.TYPE_PROBLEM, rdoc.pid, rdoc.uid, {
        rid: rdoc._id,
        status: PENDING_STATUS,
        score,
        reflectionPending: true,
        reflectionRequired: true,
        reflectionAcceptedRid: rdoc._id,
    } as any);
    await collPending.updateOne({
        domainId: rdoc.domainId,
        uid: rdoc.uid,
        pid: rdoc.pid,
    }, {
        $set: {
            rid: rdoc._id,
            score: rdoc.score,
            time: rdoc.time,
            memory: rdoc.memory,
            length: rdoc.code?.length || 0,
            lang: rdoc.lang,
            updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
    }, { upsert: true });
    return true;
}

async function promoteReflectionAccepted(domainId: string, uid: number, pid: number) {
    const rdoc = await RecordModel.coll.find({
        domainId,
        uid,
        pid,
        status: STATUS.STATUS_ACCEPTED,
        contest: { $exists: false },
    }).sort({ _id: -1 }).limit(1).next() as any;
    if (!rdoc) return false;
    const current = await DocumentModel.getStatus(domainId, DocumentModel.TYPE_PROBLEM, pid, uid) as any;
    if (current?.status === STATUS.STATUS_ACCEPTED) {
        await collPending.deleteOne({ domainId, uid, pid });
        return false;
    }
    await DocumentModel.setStatus(domainId, DocumentModel.TYPE_PROBLEM, pid, uid, {
        rid: rdoc._id,
        status: STATUS.STATUS_ACCEPTED,
        score: rdoc.score,
        reflectionPending: false,
        reflectionRequired: true,
        reflectionCompletedAt: new Date(),
    } as any);
    await Promise.all([
        RecordModel.collStat.updateOne({ _id: rdoc._id }, {
            $set: {
                domainId,
                pid,
                uid,
                time: rdoc.time,
                memory: rdoc.memory,
                length: rdoc.code?.length || 0,
                lang: rdoc.lang,
            },
        }, { upsert: true }),
        ProblemModel.inc(domainId, pid, 'nAccept' as any, 1),
        ProblemModel.inc(domainId, pid, `stats.${STATUS_SHORT_TEXTS[STATUS.STATUS_ACCEPTED]}` as any, 1),
        ProblemModel.inc(domainId, pid, `stats.s${Math.floor(rdoc.score || 0)}` as any, 1),
        DomainModel.incUserInDomain(domainId, uid, 'nAccept' as any, 1),
        collPending.deleteOne({ domainId, uid, pid }),
    ]);
    return true;
}

async function demoteReflectionAccepted(domainId: string, uid: number, pid: number) {
    if (await hasReflection(domainId, uid, pid)) return false;
    const rdoc = await RecordModel.coll.find({
        domainId,
        uid,
        pid,
        status: STATUS.STATUS_ACCEPTED,
        contest: { $exists: false },
    }).sort({ _id: -1 }).limit(1).next() as any;
    if (!rdoc) return false;
    const current = await DocumentModel.getStatus(domainId, DocumentModel.TYPE_PROBLEM, pid, uid) as any;
    if (current?.status !== STATUS.STATUS_ACCEPTED) return false;
    await markReflectionPending(rdoc);
    await Promise.all([
        RecordModel.collStat.deleteMany({ domainId, uid, pid }),
        ProblemModel.inc(domainId, pid, 'nAccept' as any, -1),
        DomainModel.incUserInDomain(domainId, uid, 'nAccept' as any, -1),
    ]);
    return true;
}

async function getGroupUids(domainId: string, groupName = '') {
    if (!groupName || groupName === 'all') return null;
    const gdoc = await collGroup.findOne({ domainId, name: groupName }) as any;
    if (!gdoc) throw new ValidationError('groupName', groupName, '小组不存在');
    return new Set<number>((gdoc.uids || []).map((uid: any) => Number(uid)).filter(Boolean));
}

function getCourseModel() {
    return (globalThis as any).Hydro?.model?.course || null;
}

async function buildCourseIndex(domainId: string) {
    const course = getCourseModel();
    const pidMap = new Map<number, CourseRef[]>();
    if (!course) return { enabled: false, pidMap };
    const courses = await course.getMulti(domainId, {}).limit(120).toArray();
    for (const cdoc of courses as any[]) {
        const courseId = cdoc.docId || cdoc._id;
        let sections: any[] = [];
        try {
            sections = await course.getMultiSection(domainId, courseId).toArray();
        } catch (e) {
            sections = [];
        }
        let sectionOrder = 0;
        for (const csdoc of sections) {
            sectionOrder += 1;
            const sectionId = csdoc.docId || csdoc._id;
            let subsecOrder = 0;
            for (const node of csdoc.dag || []) {
                subsecOrder += 1;
                const ref: CourseRef = {
                    courseId,
                    courseTitle: titleText(cdoc.title, `课程 ${idText(courseId)}`),
                    sectionId,
                    sectionTitle: titleText(csdoc.title, `第 ${sectionOrder} 章`),
                    subsecId: node._id || node.docId,
                    subsecTitle: titleText(node.title, `第 ${subsecOrder} 小节`),
                    sectionOrder,
                    subsecOrder,
                };
                for (const pid of node.pids || []) {
                    const key = Number(pid);
                    if (!key) continue;
                    if (!pidMap.has(key)) pidMap.set(key, []);
                    pidMap.get(key)!.push(ref);
                }
            }
        }
    }
    return { enabled: true, pidMap };
}

function firstCourseRef(index: Awaited<ReturnType<typeof buildCourseIndex>>, pid: number) {
    return index.pidMap.get(Number(pid))?.[0] || null;
}

function emptyBucket(extra: Record<string, any>) {
    return {
        ...extra,
        count: 0,
        users: new Set<number>(),
        pids: new Set<number>(),
        causeCounts: {} as Record<string, number>,
    };
}

function countInto(bucket: any, doc: any) {
    bucket.count += 1;
    bucket.users.add(Number(doc.uid));
    bucket.pids.add(Number(doc.pid));
    bucket.causeCounts[doc.cause] = (bucket.causeCounts[doc.cause] || 0) + 1;
}

function finalizeBuckets(map: Map<any, any>) {
    return Array.from(map.values()).map((row) => ({
        ...row,
        userCount: row.users.size,
        problemCount: row.pids.size,
        causeText: causeSummary(row.causeCounts),
    })).sort((a, b) => b.count - a.count);
}

function enrichDoc(index: Awaited<ReturnType<typeof buildCourseIndex>>, doc: any) {
    return { ...doc, courseRef: firstCourseRef(index, doc.pid) };
}

class ReflectionListHandler extends Handler {
    @param('page', Types.PositiveInt, true)
    async get({ domainId }, page = 1) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const [docs, count] = await this.paginate(
            coll.find({ domainId, uid: this.user._id }).sort({ updatedAt: -1 }),
            page,
            20,
        );
        this.response.template = 'mistake_reflection_list.html';
        this.response.body = { page_name: 'mistake_reflection_list', docs, count, page, causeLabel };
    }
}

class ReflectionCardHandler extends Handler {
    @param('pid', Types.PositiveInt)
    async get({ domainId }, pid: number) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const accepted = await RecordModel.coll.countDocuments({
            domainId,
            uid: this.user._id,
            pid,
            status: STATUS.STATUS_ACCEPTED,
            contest: { $exists: false },
        }) > 0;
        if (!accepted) {
            this.response.body = { accepted: false };
            return;
        }
        const doc = await coll.find({ domainId, uid: this.user._id, pid }).sort({ updatedAt: -1 }).limit(1).next();
        const pending = await collPending.findOne({ domainId, uid: this.user._id, pid });
        this.response.body = {
            accepted: true,
            hasReflection: !!doc,
            pending: !!pending && !doc,
            createUrl: this.url('mistake_reflection_create', { pid }),
            editUrl: doc ? this.url('mistake_reflection_edit', { rid: doc._id }) : '',
            cause: doc ? causeLabel(doc.cause) : '',
            next: doc?.next || '',
            updatedAt: doc?.updatedAt || null,
        };
    }
}

class ReflectionEditHandler extends Handler {
    doc: any;

    @param('rid', Types.ObjectId, true)
    async prepare({ domainId }, rid?: ObjectId) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        if (rid) {
            this.doc = await getReflection(domainId, rid);
            if (this.doc.uid !== this.user._id) this.checkPerm(PERM.PERM_EDIT_TRAINING);
        }
    }

    @param('pid', Types.PositiveInt, true)
    @param('rid', Types.ObjectId, true)
    async get({ domainId }, pid = 0, rid?: ObjectId) {
        const pdoc = pid ? await ProblemModel.get(domainId, pid) : null;
        if (pid && !pdoc) throw new NotFoundError(`P${pid}`);
        this.response.template = 'mistake_reflection_edit.html';
        this.response.body = {
            page_name: this.doc ? 'mistake_reflection_edit' : 'mistake_reflection_create',
            doc: this.doc,
            pid: this.doc?.pid || pid,
            causes: CAUSES,
        };
    }

    @param('rid', Types.ObjectId, true)
    @param('pid', Types.PositiveInt)
    @param('cause', Types.String)
    @param('fix', Types.Content)
    @param('next', Types.Content)
    @param('note', Types.Content, true)
    async post({ domainId }, rid: ObjectId | undefined, pid: number, cause: string, fix: string, next: string, note = '') {
        if (!CAUSES.some(([key]) => key === cause)) throw new ValidationError('cause', null, '请选择错因类型。');
        if (!fix.trim() || !next.trim()) throw new ValidationError('fix', null, '请填写修正方式和下次策略。');
        const pdoc = await ProblemModel.get(domainId, pid);
        if (!pdoc) throw new NotFoundError(`P${pid}`);
        const now = new Date();
        let ownerUid = this.user._id;
        if (rid) {
            const doc = await getReflection(domainId, rid);
            if (doc.uid !== this.user._id) this.checkPerm(PERM.PERM_EDIT_TRAINING);
            ownerUid = doc.uid;
            await coll.updateOne({ domainId, _id: rid }, { $set: { pid, cause, fix, next, note, updatedAt: now } });
        } else {
            const existing = await coll.find({ domainId, uid: this.user._id, pid }).sort({ updatedAt: -1 }).limit(1).next();
            if (existing) {
                await coll.updateOne(
                    { domainId, _id: existing._id },
                    { $set: { cause, fix, next, note, updatedAt: now } },
                );
            } else {
                await coll.insertOne({
                    _id: new ObjectId(),
                    domainId,
                    uid: this.user._id,
                    pid,
                    cause,
                    fix,
                    next,
                    note,
                    createdAt: now,
                    updatedAt: now,
                });
            }
        }
        await promoteReflectionAccepted(domainId, ownerUid, pid);
        this.response.redirect = this.url('problem_detail', { pid });
    }

    @param('rid', Types.ObjectId)
    async postDelete({ domainId }, rid: ObjectId) {
        const doc = await getReflection(domainId, rid);
        if (doc.uid !== this.user._id) this.checkPerm(PERM.PERM_EDIT_TRAINING);
        await coll.deleteOne({ domainId, _id: rid });
        await demoteReflectionAccepted(domainId, doc.uid, doc.pid);
        this.response.redirect = this.url('mistake_reflection_list');
    }
}

class ReflectionInsightsHandler extends Handler {
    @param('groupName', Types.String, true)
    async get({ domainId }, groupName = '') {
        this.checkPerm(PERM.PERM_EDIT_TRAINING);
        const [groups, groupUids, courseIndex] = await Promise.all([
            UserModel.listGroup(domainId),
            getGroupUids(domainId, groupName),
            buildCourseIndex(domainId),
        ]);
        const query: any = { domainId };
        if (groupUids) query.uid = { $in: Array.from(groupUids) };
        const docs = await coll.find(query).sort({ updatedAt: -1 }).limit(5000).toArray();

        const byCauseMap = new Map<string, any>();
        const byProblemMap = new Map<number, any>();
        const bySectionMap = new Map<string, any>();
        const bySubsectionMap = new Map<string, any>();
        const byUserMap = new Map<number, any>();

        for (const doc of docs as any[]) {
            const causeBucket = byCauseMap.get(doc.cause) || emptyBucket({ cause: doc.cause, label: causeLabel(doc.cause) });
            byCauseMap.set(doc.cause, causeBucket);
            countInto(causeBucket, doc);

            const problemBucket = byProblemMap.get(doc.pid) || emptyBucket({ pid: doc.pid });
            byProblemMap.set(doc.pid, problemBucket);
            countInto(problemBucket, doc);

            const userBucket = byUserMap.get(doc.uid) || emptyBucket({ uid: doc.uid, recent: [] as any[] });
            byUserMap.set(doc.uid, userBucket);
            countInto(userBucket, doc);
            if (userBucket.recent.length < 6) userBucket.recent.push(enrichDoc(courseIndex, doc));

            const refs = courseIndex.pidMap.get(Number(doc.pid)) || [];
            if (!refs.length) {
                const sectionBucket = bySectionMap.get('unmapped') || emptyBucket({
                    key: 'unmapped',
                    courseTitle: '未绑定课程',
                    sectionTitle: '未绑定章节',
                    sectionOrder: 0,
                    url: '',
                });
                bySectionMap.set('unmapped', sectionBucket);
                countInto(sectionBucket, doc);
                const subsecBucket = bySubsectionMap.get(`unmapped:${doc.pid}`) || emptyBucket({
                    key: `unmapped:${doc.pid}`,
                    courseTitle: '未绑定课程',
                    sectionTitle: '未绑定章节',
                    subsecTitle: `P${doc.pid}`,
                    subsecOrder: 0,
                    url: this.url('problem_detail', { pid: doc.pid }),
                });
                bySubsectionMap.set(`unmapped:${doc.pid}`, subsecBucket);
                countInto(subsecBucket, doc);
                continue;
            }
            for (const ref of refs) {
                const sectionKey = `${idText(ref.courseId)}:${idText(ref.sectionId)}`;
                const sectionBucket = bySectionMap.get(sectionKey) || emptyBucket({
                    key: sectionKey,
                    courseTitle: ref.courseTitle,
                    sectionTitle: ref.sectionTitle,
                    sectionOrder: ref.sectionOrder,
                    url: this.url('course_section_detail', { cid: ref.courseId, csid: ref.sectionId }),
                });
                bySectionMap.set(sectionKey, sectionBucket);
                countInto(sectionBucket, doc);

                const subsecKey = `${sectionKey}:${idText(ref.subsecId)}`;
                const subsecBucket = bySubsectionMap.get(subsecKey) || emptyBucket({
                    key: subsecKey,
                    courseTitle: ref.courseTitle,
                    sectionTitle: ref.sectionTitle,
                    subsecTitle: ref.subsecTitle,
                    subsecOrder: ref.subsecOrder,
                    url: this.url('course_subsec_detail', { cid: ref.courseId, csid: ref.sectionId, ssid: ref.subsecId }),
                });
                bySubsectionMap.set(subsecKey, subsecBucket);
                countInto(subsecBucket, doc);
            }
        }

        const recent = docs.slice(0, 40).map((doc: any) => enrichDoc(courseIndex, doc));
        const uids = Array.from(new Set([
            ...recent.map((doc: any) => doc.uid),
            ...Array.from(byUserMap.keys()),
        ]));
        const udict = await UserModel.getList(domainId, uids);
        this.response.template = 'mistake_reflection_insights.html';
        this.response.body = {
            page_name: 'mistake_reflection_insights',
            byCause: finalizeBuckets(byCauseMap),
            byProblem: finalizeBuckets(byProblemMap as any).slice(0, 20),
            bySection: finalizeBuckets(bySectionMap).slice(0, 30),
            bySubsection: finalizeBuckets(bySubsectionMap).slice(0, 40),
            byUser: finalizeBuckets(byUserMap).slice(0, 80),
            recent,
            udict,
            causeLabel,
            groups,
            filterGroupName: groupName || 'all',
            courseEnabled: courseIndex.enabled,
        };
    }
}

export async function apply(ctx: Context) {
    const judge = JudgeResultCallbackContext as any;
    if (!judge.__mistakeReflectionPostJudgePatched) {
        judge.__mistakeReflectionPostJudgePatched = true;
        judge.__mistakeReflectionOriginalPostJudge = JudgeResultCallbackContext.postJudge.bind(JudgeResultCallbackContext);
        JudgeResultCallbackContext.postJudge = async (rdoc: any, context?: any) => {
            if (isNormalAcceptedRecord(rdoc) && !await hasReflection(rdoc.domainId, rdoc.uid, rdoc.pid)) {
                await markReflectionPending(rdoc);
                return;
            }
            return judge.__mistakeReflectionOriginalPostJudge(rdoc, context);
        };
    }
    ctx.Route('mistake_reflection_list', '/reflection', ReflectionListHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mistake_reflection_card', '/reflection/card/:pid', ReflectionCardHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mistake_reflection_create', '/reflection/create/:pid', ReflectionEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mistake_reflection_edit', '/reflection/:rid/edit', ReflectionEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mistake_reflection_insights', '/domain/reflection-insights', ReflectionInsightsHandler, PERM.PERM_EDIT_TRAINING);
    ctx.injectUI('DomainManage', 'mistake_reflection_insights', { family: '学习成长', icon: 'edit' }, PERM.PERM_EDIT_TRAINING);
    ctx.i18n.load('zh', {
        mistake_reflection_list: '我的错因复盘',
        mistake_reflection_card: '错因总结',
        mistake_reflection_create: '新建错因复盘',
        mistake_reflection_edit: '编辑错因复盘',
        mistake_reflection_insights: '错因复盘',
    });
    await db.ensureIndexes(coll,
        { key: { domainId: 1, uid: 1, updatedAt: -1 }, name: 'domain_uid_time' },
        { key: { domainId: 1, cause: 1 }, name: 'domain_cause' },
        { key: { domainId: 1, uid: 1, pid: 1 }, name: 'domain_uid_pid' },
        { key: { domainId: 1, pid: 1, updatedAt: -1 }, name: 'domain_pid_time' },
    );
    await db.ensureIndexes(collPending,
        { key: { domainId: 1, uid: 1, pid: 1 }, unique: true, name: 'domain_uid_pid' },
        { key: { domainId: 1, updatedAt: -1 }, name: 'domain_time' },
    );
}
