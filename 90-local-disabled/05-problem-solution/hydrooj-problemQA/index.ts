import {
    Context, db, DocumentModel, DomainModel, Filter, ForbiddenError, Handler, MessageModel, Mutation, NotFoundError, NumberKeys, ObjectId, OplogModel, param, PERM, PermissionError, PRIV, ProblemModel, ProblemNotFoundError, Schema, SettingModel, Types, UserModel,
    UserNotFoundError,
    ValidationError,
} from 'hydrooj';
import { escapeRegExp } from 'lodash';

export const TYPE_QUESTION = 700 as const;
export const TYPE_QUESTION_POST = 701 as const;

export enum QuestionStatus {
    OPEN = 1, // 待认领
    PROCESSING = 2, // 处理中
    WAITING_FOR_USER = 3, // 已回复/待补充
    RESOLVED = 5, // 已解决
    CLOSED = 6, // 已关闭
}
export enum QuestionSystemOperation {
    ASSIGNED = 'assigned',
    STATUS_CHANGED = 'status_changed',
    TITLE_CHANGED = 'title_changed',
    QUESTION_CHANGED = 'question_changed',
    QUESTION_CLOSED = 'question_closed',
    QUESTION_REOPENED = 'question_reopened',
}

export interface QuestionDoc {
    _id?: ObjectId;
    domainId: string;
    owner: number;
    assignee?: number;
    title: string;
    status: QuestionStatus;
    problemId: number;
    updateAt: Date;
    content: string;
    ip: string;
    nReply: number;
}

export interface QuestionSystemPostData {
    operation: QuestionSystemOperation;
    operator: number;
    target?: number;
    data?: any;
}


export interface QuestionPostDoc {
    _id?: ObjectId;
    qid: ObjectId;
    owner: number;
    content: string | QuestionSystemPostData;
    ip: string;
    isSystem?: boolean;
    target?: number;
}

declare module 'hydrooj' {
    interface DocType {
        [TYPE_QUESTION]: QuestionDoc;
        [TYPE_QUESTION_POST]: QuestionPostDoc;
    }

    interface Collections {
        question: QuestionDoc;
        question_post: QuestionPostDoc;
    }

    interface Model {
        question: typeof QuestionModel;
    }
}

export class QuestionModel {
    static async add(
        domainId: string, owner: number, title: string, problemId: number, content: string, ip?: string,
    ): Promise<ObjectId> {
        const payload: Partial<QuestionDoc> = {
            content,
            owner,
            title,
            problemId,
            ip,
            status: QuestionStatus.OPEN,
            nReply: 0,
            updateAt: new Date(),
        };
        const res = await DocumentModel.add(
            domainId, payload.content!, payload.owner!, TYPE_QUESTION,
            null, null, null, payload,
        );
        return res;
    }

    static async get(domainId: string, qid: ObjectId): Promise<QuestionDoc> {
        const doc = await DocumentModel.get(domainId, TYPE_QUESTION, qid);
        if (!doc) throw new NotFoundError(domainId, qid);
        return doc;
    }

    static async edit(domainId: string, qid: ObjectId, $set: Partial<QuestionDoc>): Promise<QuestionDoc> {
        $set.updateAt ||= new Date();
        return await DocumentModel.set(domainId, TYPE_QUESTION, qid, $set);
    }

    static inc(domainId: string, qid: ObjectId, key: NumberKeys<QuestionDoc>, value: number): Promise<QuestionDoc | null> {
        return DocumentModel.inc(domainId, TYPE_QUESTION, qid, key, value);
    }

    static async del(domainId: string, qid: ObjectId): Promise<void> {
        await Promise.all([
            DocumentModel.deleteOne(domainId, TYPE_QUESTION, qid),
            DocumentModel.deleteMultiStatus(domainId, TYPE_QUESTION, { docId: qid }),
            DocumentModel.deleteMulti(domainId, TYPE_QUESTION_POST, {
                parentType: TYPE_QUESTION, parentId: qid
            }),
        ]);
    }

    static count(domainId: string, query: Filter<QuestionDoc>) {
        return DocumentModel.count(domainId, TYPE_QUESTION, query);
    }

    static getMulti(domainId: string, query: Filter<QuestionDoc> = {}) {
        return DocumentModel.getMulti(domainId, TYPE_QUESTION, query)
            .sort({ updateAt: -1 });
    }

    static async addPost(domainId: string, qid: ObjectId, owner: number, content: string, ip: string): Promise<ObjectId> {
        const [postId] = await Promise.all([
            DocumentModel.add(
                domainId, content, owner, TYPE_QUESTION_POST,
                null, TYPE_QUESTION, qid, { ip, isSystem: false },
            ),
            DocumentModel.incAndSet(domainId, TYPE_QUESTION, qid, 'nReply', 1, { updateAt: new Date() }),
        ]);
        return postId;
    }

    static async addSystemPost(
        domainId: string,
        qid: ObjectId,
        operator: number,
        operation: QuestionSystemOperation,
        targetUid?: number,
        data?: any
    ): Promise<ObjectId> {
        const content = JSON.stringify({ operation, target: targetUid, data, operator });
        const [postId] = await Promise.all([
            DocumentModel.add(
                domainId, content, 1, TYPE_QUESTION_POST,
                null, TYPE_QUESTION, qid, { isSystem: true, target: targetUid },
            ),
            DocumentModel.set(domainId, TYPE_QUESTION, qid, { updateAt: new Date() }),
        ]);
        return postId;
    }

    static async getPost(domainId: string, postId: ObjectId): Promise<QuestionPostDoc> {
        const doc = await DocumentModel.get(domainId, TYPE_QUESTION_POST, postId);
        if (!doc) throw new NotFoundError(domainId, postId);
        return doc;
    }

    static getMultiPosts(domainId: string, qid: ObjectId) {
        return DocumentModel.getMulti(
            domainId, TYPE_QUESTION_POST,
            { parentType: TYPE_QUESTION, parentId: qid },
        ).sort({ _id: 1 });
    }

    static async editPost(domainId: string, postId: ObjectId, content: string): Promise<QuestionPostDoc> {
        return await DocumentModel.set(domainId, TYPE_QUESTION_POST, postId, { content });
    }

    static async delPost(domainId: string, postId: ObjectId) {
        const post = await QuestionModel.getPost(domainId, postId);
        await Promise.all([
            DocumentModel.deleteOne(domainId, TYPE_QUESTION_POST, postId),
            DocumentModel.inc(domainId, TYPE_QUESTION, post.qid, 'nReply', -1),
        ]);
    }

    static async assign(domainId: string, qid: ObjectId, assignee: number): Promise<QuestionDoc> {
        return await QuestionModel.edit(domainId, qid, {
            assignee,
            status: QuestionStatus.PROCESSING,
            updateAt: new Date(),
        });
    }

    static async setStatus(domainId: string, qid: ObjectId, status: QuestionStatus): Promise<QuestionDoc> {
        return await QuestionModel.edit(domainId, qid, {
            status,
            updateAt: new Date(),
        });
    }
}

global.Hydro.model.question = QuestionModel;

class QuestionHandler extends Handler {
    qdoc?: QuestionDoc;

    @param('qid', Types.ObjectId, true)
    async _prepare(domainId: string, qid: ObjectId) {
        if (qid) {
            this.qdoc = await QuestionModel.get(domainId, qid);
            if (!this.qdoc) throw new NotFoundError(domainId, qid);
        }
    }
}

class QuestionListHandler extends QuestionHandler {
    @param('problemId', Types.UnsignedInt, true)
    @param('uidOrName', Types.UidOrName, true)
    @param('status', Types.Int, true)
    @param('page', Types.PositiveInt, true)
    @param('q', Types.String, true)
    async get(domainId: string, problemId?: number, uidOrName?: string, status: number = -1, page = 1, q = '') {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);

        const statusValues = Object.values(QuestionStatus);
        if (!statusValues.includes(status) && status !== -1) throw new ValidationError('status');

        const escaped = escapeRegExp(q.toLowerCase());
        const $regex = new RegExp(q.length >= 2 ? escaped : `\\A${escaped}`, 'gim');

        const ddoc = await DomainModel.get(domainId);
        const answerers: number[] = ddoc.answerers || [];

        const filter: any = {};
        // root
        if (!this.user.hasPerm(PERM.PERM_EDIT_DOMAIN) && !(answerers.length > 0 && answerers.includes(this.user._id))) {
            filter.owner = this.user._id;
        }
        if (status !== -1) {
            filter.status = status;
        }
        if (q.length > 0) {
            filter.title = $regex;
        }
        if (problemId) {
            filter.problemId = problemId;
        }
        if (uidOrName) {
            const udoc = await UserModel.getById(domainId, +uidOrName)
                || await UserModel.getByUname(domainId, uidOrName)
                || await UserModel.getByEmail(domainId, uidOrName);
            if (!udoc) throw new UserNotFoundError(uidOrName);
            filter.owner = udoc._id;
        }

        let qs = status ? `status=${status}` : '';
        if (problemId) qs += `${qs ? '&' : ''}problemId=${problemId}`;
        if (uidOrName) qs += `${qs ? '&' : ''}uidOrName=${uidOrName}`;
        if (q) qs += `${qs ? '&' : ''}q=${encodeURIComponent(q)}`;

        const [qdocs, qpcount] = await this.paginate(
            QuestionModel.getMulti(domainId, filter).sort({ updateAt: -1 }),
            page,
            this.ctx.setting.get('pagination.question') || 30,
        );

        qdocs.sort((a, b) => {
            if (a.status === 5 && b.status !== 5) return 1;
            if (a.status !== 5 && b.status === 5) return -1;
            return 0;
        });

        const uids = new Set(
            qdocs.flatMap(qdoc => [qdoc.owner, qdoc.assignee].filter(Boolean))
        );
        const udict = await UserModel.getList(domainId, Array.from(uids));
        const pdict = await ProblemModel.getList(domainId, qdocs.map((qdoc) => qdoc.problemId));

        const statusOptions = Object.entries(QuestionStatus)
            .filter(([key, value]) => typeof value === 'number')
            .map(([key, value]) => ({ key, value }));

        this.response.template = 'question_list.html';
        this.response.body = {
            qdocs, qpcount, page, udict, pdict, filterStatus: status, filterProblemId: problemId, filterUidOrName: uidOrName, statusOptions, qs, q,
        };
    }
}

class QuestionEditHandler extends QuestionHandler {
    @param('pid', Types.ProblemId, true)
    async get(domainId: string, pid: string | number) {
        if (this.qdoc && !this.user.own(this.qdoc!) && this.qdoc.assignee !== this.user._id) this.checkPerm(PERM.PERM_EDIT_DOMAIN);
        this.response.template = 'question_edit.html';
        if (!this.qdoc) {
            if (!pid) {
                throw new ValidationError('problemId');
            } else {
                const pdoc = await ProblemModel.get(domainId, pid);
                if (!pdoc) throw new ProblemNotFoundError(pid);
                this.response.body.pdoc = pdoc;
            }
        } else {
            const pdoc = await ProblemModel.get(domainId, this.qdoc.problemId);
            this.response.body.pdoc = pdoc;
        }
        this.response.body.qdoc = this.qdoc;
    }

    @param('problemId', Types.UnsignedInt)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postCreate(domainId: string, problemId: number, title: string, content: string) {
        const pdoc = await ProblemModel.get(domainId, problemId);
        if (!pdoc) throw new ProblemNotFoundError(problemId);
        await this.limitRate('add_question', 3600, 60);
        const qid = await QuestionModel.add(domainId, this.user._id, title, problemId, content, this.request.ip);

        const ddoc = await DomainModel.get(domainId);
        const answerers: number[] = ddoc.answerers || [];
        if (answerers.length > 0) {
            const link = `/d/${domainId}/question/${qid.toString()}`;
            await MessageModel.send(1, answerers, JSON.stringify({
                message: `「系统通知」题目 ${pdoc.title.length > 20 ? pdoc.title.substring(0, 20) + "..." : pdoc.title} 有新的答疑啦！{0:link}`,
                params: [link],
            }), MessageModel.FLAG_RICHTEXT | MessageModel.FLAG_UNREAD);
        }
        this.response.body = { qid };
        this.response.redirect = this.url('question_detail', { domainId, uid: this.user._id, qid });
    }

    @param('qid', Types.ObjectId)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postUpdate(domainId: string, qid: ObjectId, title: string, content: string) {
        const ddoc = await DomainModel.get(domainId);
        const answerers: number[] = ddoc.answerers || [];
        if (!this.user.own(this.qdoc!) && this.qdoc.assignee !== this.user._id && !(answerers.length > 0 && answerers.includes(this.user._id))) {
            this.checkPerm(PERM.PERM_EDIT_DOMAIN);
        }

        const oldTitle = this.qdoc!.title;

        await Promise.all([
            QuestionModel.edit(domainId, qid, { title, content }),
            OplogModel.log(this, 'question.edit', this.qdoc),
        ]);

        await QuestionModel.addSystemPost(domainId, qid, this.user._id, QuestionSystemOperation.QUESTION_CHANGED, this.qdoc.owner);
        if (oldTitle !== title) {
            await QuestionModel.addSystemPost(domainId, qid, this.user._id, QuestionSystemOperation.TITLE_CHANGED, this.qdoc.owner, { from: oldTitle, to: title });
        }

        this.response.body = { qid };
        this.response.redirect = this.url('question_detail', { domainId, uid: this.user._id, qid });
    }

    @param('qid', Types.ObjectId)
    async postDelete(domainId: string, qid: ObjectId) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM); // need root
        await Promise.all([
            QuestionModel.del(domainId, qid),
            OplogModel.log(this, 'question.delete', this.qdoc),
        ]);
        this.response.redirect = this.url('question_main', { domainId });
    }
}

class QuestionDetailHandler extends QuestionHandler {
    @param('qid', Types.ObjectId)
    async get(domainId: string, qid: ObjectId) {
        const ddoc = await DomainModel.get(domainId);
        const answerers: number[] = ddoc.answerers || [];
        if (!this.user.own(this.qdoc!) && this.qdoc?.assignee !== this.user._id && !(answerers.length > 0 && answerers.includes(this.user._id))) {
            this.checkPerm(PERM.PERM_EDIT_DOMAIN);
        }
        const udoc = await UserModel.getById(domainId, this.qdoc!.owner);
        const qpdocs = await QuestionModel.getMultiPosts(domainId, qid).toArray();

        const uids = new Set(qpdocs.map(({ owner }) => owner))
        if (this.qdoc.assignee) uids.add(this.qdoc.assignee);
        for (const qpdoc of qpdocs) {
            if (qpdoc.target) uids.add(qpdoc.target);
            if (!qpdoc.isSystem || !qpdoc.content) continue;
            // system post
            if (typeof qpdoc.content === 'string') {
                try {
                    const content = JSON.parse(qpdoc.content);
                    Object.assign(qpdoc, content);
                } catch (e) { }
            } else if (typeof qpdoc.content === 'object') {
                Object.assign(qpdoc, qpdoc.content);
            }
            // @ts-ignore
            if (qpdoc.operator) uids.add(qpdoc.operator);
        }
        const udict = await UserModel.getList(domainId, Array.from(uids));
        const pdoc = await ProblemModel.get(domainId, this.qdoc.problemId);

        this.response.template = 'question_detail.html';
        this.response.body = {
            qdoc: this.qdoc, qpdocs, QuestionStatus, udict, udoc, pdoc
        };
        this.UiContext.extraTitleContent = this.qdoc.title;

    }

    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }

    @param('qid', Types.ObjectId)
    @param('uidOrName', Types.UidOrName)
    async postAssign(domainId: string, qid: ObjectId, uidOrName: string) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM); // need root
        const udoc = await UserModel.getById(domainId, +uidOrName)
            || await UserModel.getByUname(domainId, uidOrName)
            || await UserModel.getByEmail(domainId, uidOrName);
        if (!udoc) throw new UserNotFoundError(uidOrName);

        await QuestionModel.assign(domainId, qid, udoc._id);
        const link = `/d/${domainId}/question/${qid.toString()}`;
        const msg = JSON.stringify({
            message: `「系统通知」您被指派了答疑 #${qid.toString()} "${this.qdoc.title}"。{0:link}`,
            params: [link],
        });
        await MessageModel.send(1, udoc._id, msg, MessageModel.FLAG_RICHTEXT | MessageModel.FLAG_UNREAD);
        await QuestionModel.addSystemPost(domainId, qid, this.user._id, QuestionSystemOperation.ASSIGNED, udoc._id);

        this.back();
    }

    @param('qid', Types.ObjectId)
    async postClaim(domainId: string, qid: ObjectId) {
        // domain root or answerer
        const ddoc = await DomainModel.get(domainId);
        const answerers: number[] = ddoc.answerers || [];
        if (!(answerers.length > 0 && answerers.includes(this.user._id))) {
            this.checkPerm(PERM.PERM_EDIT_DOMAIN);
        }
        if (!this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM) && this.qdoc.assignee) {
            throw new ForbiddenError('答疑已被认领，仅允许超管重新指派责任人。');
        }

        await QuestionModel.assign(domainId, qid, this.user._id);

        const link = `/d/${domainId}/question/${qid.toString()}`;
        const msg = JSON.stringify({
            message: `「系统通知」您的答疑 #${qid.toString()} 已被 {0} 认领。{1:link}`,
            params: [this.user.uname, link],
        });

        if (this.qdoc.owner !== this.user._id) {
            await MessageModel.send(1, this.qdoc.owner, msg, MessageModel.FLAG_RICHTEXT | MessageModel.FLAG_UNREAD);
        }

        await QuestionModel.addSystemPost(domainId, qid, this.user._id, QuestionSystemOperation.ASSIGNED, this.user._id);

        this.back();
    }

    @param('qid', Types.ObjectId)
    @param('status', Types.Range(Object.values(QuestionStatus)))
    async postSetStatus(domainId: string, qid: ObjectId, status: number) {
        const ddoc = await DomainModel.get(domainId);
        const answerers: number[] = ddoc.answerers || [];
        if (!this.user.hasPerm(PERM.PERM_EDIT_DOMAIN) && this.qdoc.assignee !== this.user._id && !(answerers.length > 0 && answerers.includes(this.user._id))) {
            if (this.user.own(this.qdoc!) && (status === QuestionStatus.CLOSED || status === QuestionStatus.RESOLVED)) {
                // ok
            } else if (!(answerers.length > 0 && answerers.includes(this.user._id))) {
                this.checkPerm(PERM.PERM_EDIT_DOMAIN);
            }
        }

        await QuestionModel.setStatus(domainId, qid, status);
        if (status === QuestionStatus.CLOSED) {
            await QuestionModel.addSystemPost(domainId, qid, this.user._id, QuestionSystemOperation.QUESTION_CLOSED, undefined, {
                from: this.qdoc.status,
                to: status
            });
        } else if (this.qdoc.status === QuestionStatus.CLOSED && status === QuestionStatus.PROCESSING) {
            await QuestionModel.addSystemPost(domainId, qid, this.user._id, QuestionSystemOperation.QUESTION_REOPENED, undefined, {
                from: this.qdoc.status,
                to: status
            });
        } else {
            await QuestionModel.addSystemPost(domainId, qid, this.user._id, QuestionSystemOperation.STATUS_CHANGED, undefined, {
                from: this.qdoc.status,
                to: status
            });
        }
        this.back();
    }

    @param('qid', Types.ObjectId)
    @param('content', Types.Content)
    async postReply(domainId: string, qid: ObjectId, content: string) {
        const qdoc = this.qdoc;
        await this.limitRate('add_question', 3600, 60);
        const targets = new Set(Array.from(content.matchAll(/@\[\]\(\/user\/(\d+)\)/g)).map((i) => +i[1]));
        const uids = Object.keys(await UserModel.getList(domainId, Array.from(targets))).map((i) => +i);
        const msg = JSON.stringify({
            message: 'User {0} mentioned you in question {1:link}',
            params: [this.user.uname, `/d/${domainId}${this.request.path}`],
        });
        await Promise.all(uids.map((i) => MessageModel.send(1, i, msg, MessageModel.FLAG_RICHTEXT | MessageModel.FLAG_UNREAD)));
        const qpid = await QuestionModel.addPost(domainId, qid, this.user._id, content, this.request.ip);

        if (this.qdoc.owner === this.user._id) {
            // User replied, change status to OPEN if it was WAITING_FOR_USER or RESOLVED
            if (this.qdoc.status === QuestionStatus.WAITING_FOR_USER || this.qdoc.status === QuestionStatus.RESOLVED) {
                await QuestionModel.setStatus(domainId, qid, QuestionStatus.OPEN);
            }
        } else if (this.qdoc.assignee === this.user._id) {
            // Assignee replied, set to WAITING_FOR_USER
            if (this.qdoc.status === QuestionStatus.OPEN) {
                await QuestionModel.setStatus(domainId, qid, QuestionStatus.WAITING_FOR_USER);
            }
        }

        const target = (this.user._id === this.qdoc.owner) ? this.qdoc.assignee : this.qdoc.owner;
        const link = `/d/${domainId}/question/${qid.toString()}`;

        if (target && target !== this.user._id && this.qdoc.status !== QuestionStatus.CLOSED) {
            await MessageModel.send(1, target, JSON.stringify({
                message: `「系统通知」您的答疑 #${qid.toString()} 有新回复。{0:link}`,
                params: [link],
            }), MessageModel.FLAG_RICHTEXT | MessageModel.FLAG_UNREAD);
        }

        this.back({ qpid });
    }

    @param('qpid', Types.ObjectId)
    @param('content', Types.Content)
    async postEditReply(domainId: string, qpid: ObjectId, content: string) {
        const qpdoc = await QuestionModel.getPost(domainId, qpid);
        if (!this.user.own(qpdoc)) {
            this.checkPerm(PERM.PERM_EDIT_DOMAIN);
        }
        await QuestionModel.editPost(domainId, qpid, content);
        this.back();
    }

    @param('qid', Types.ObjectId)
    @param('qpid', Types.ObjectId)
    async postDeleteReply(domainId: string, qid: ObjectId, qpid: ObjectId) {
        const qpdoc = await QuestionModel.getPost(domainId, qpid);
        const qdoc = this.qdoc;
        const deleteBy = qpdoc.owner === this.user._id ? 'Self' : qdoc.owner === this.user._id ? 'Question Owner' : 'Admin';
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM); // need root
        await QuestionModel.delPost(domainId, qpid);

        if (!qpdoc.isSystem) {
            const msg = JSON.stringify({
                message: '{0} {1} delete your question post {2} in "{3}"({4:link}).',
                params: [
                    deleteBy,
                    this.user.uname,
                    (qpdoc.content as string).length > 10 ? `${(qpdoc.content as string).substring(0, 10)}...` : qpdoc.content,
                    qdoc.title,
                    `/d/${domainId}${this.request.path}`,
                ],
            });

            if (deleteBy !== 'Self') {
                await MessageModel.send(1, qpdoc.owner, msg, MessageModel.FLAG_RICHTEXT | MessageModel.FLAG_UNREAD);
            }
        }
        this.back();
    }
}

class DomainSetAnswererHandler extends Handler {
    async prepare({ domainId }) {
        this.checkPerm(PERM.PERM_EDIT_DOMAIN);
        this.domain = await DomainModel.get(domainId);
    }

    async get({ domainId }) {
        this.response.template = 'domain_answerer.html';
        this.response.body = {
            domain: this.domain,
        };
    }

    @param('uids', Types.NumericArray)
    async postUpdate(domainId: string, uids: number[]) {
        if (uids.length > 0) {
            const existingUsers = await UserModel.getList(domainId, uids);
            const missingUids = uids.filter(uid => !existingUsers[uid]);
            if (missingUids.length > 0) {
                throw new ValidationError('uids', null, `用户 ${missingUids.join(', ')} 不存在`);
            }
        }
        await DomainModel.edit(domainId, { answerers: uids });
        this.back();
    }
}

export const AnswererApi = {
    'domain.answerer': Mutation(
        Schema.object({
            uids: Schema.array(Schema.number()),
        }),
        async (ctx, args) => {
            if (!ctx.user.hasPerm(PERM.PERM_EDIT_DOMAIN)) throw new PermissionError(PERM.PERM_EDIT_DOMAIN);
            if (args.uids?.length) {
                const existingUsers = await UserModel.getList(ctx.domain._id, args.uids);
                const missingUids = args.uids.filter(uid => !existingUsers[uid]);
                if (missingUids.length > 0) {
                    throw new ValidationError('uids', null, `用户 ${missingUids.join(', ')} 不存在`);
                }
                return await DomainModel.edit(ctx.domain._id, { answerers: args.uids });
            }
            return await DomainModel.edit(ctx.domain._id, { answerers: [] });
        },
    ),
} as const;

declare module '@hydrooj/framework' {
    interface Apis {
        answerer: typeof AnswererApi;
    }
}

export async function apply(ctx: Context) {
    ctx.Route('question_main', '/question', QuestionListHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('question_create', '/question/create/:pid', QuestionEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('question_edit', '/question/:qid/edit', QuestionEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('question_detail', '/question/:qid', QuestionDetailHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('domain_answerer', '/domain/data/answerer', DomainSetAnswererHandler, PERM.PERM_EDIT_DOMAIN);

    await ctx.inject(['api'], ({ api }) => {
        api.provide(AnswererApi);
    });

    ctx.injectUI('DomainManage', 'domain_answerer', {
        family: 'Extend',
        icon: 'info',
    });

    ctx.inject(['setting'], (c) => {
        c.setting.SystemSetting(
            SettingModel.Setting('setting_limit', 'pagination.question', 20, 'number', 'pagination.question', 'Question per page'),
        );
    });

    ctx.i18n.load('zh', {
        Question: '答疑',
        question_list: '答疑列表',
        question_create: '创建答疑',
        question_edit: '修改答疑',
        question_detail: '答疑详情',
        domain_answerer: '设置答疑用户'
    });
    ctx.i18n.load('en', {
        Question: 'Question',
        question_list: 'Question List',
        question_create: 'Create Question',
        question_edit: 'Edit Question',
        question_detail: 'Question Detail',
        domain_answerer: 'Set Answerer'
    });

    ctx.injectUI('UserDropdown', 'question_main', (h: any) => ({ icon: 'help', displayName: 'Question' }), PRIV.PRIV_USER_PROFILE);
}
