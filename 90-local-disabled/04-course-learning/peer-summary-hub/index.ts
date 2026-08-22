import {
    Context,
    db,
    ForbiddenError,
    Handler,
    NotFoundError,
    ObjectId,
    param,
    PERM,
    PRIV,
    Types,
    UserModel,
    ValidationError,
} from 'hydrooj';

interface SummaryHubComment {
    _id: ObjectId;
    domainId: string;
    submitId: ObjectId;
    uid: number;
    content: string;
    createdAt: Date;
    updatedAt: Date;
}

const collSubmit = db.collection('domain.learning.summarySubmit' as any);
const collTask = db.collection('domain.learning.summaryTask' as any);
const collVote = db.collection('domain.learning.summaryHubVote' as any);
const collComment = db.collection('domain.learning.summaryHubComment' as any);

function idText(value: any) {
    return value?.toHexString?.() || value?.toString?.() || String(value);
}

function stripSummaryText(content = '', limit = 140) {
    const text = String(content)
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
        .replace(/[#>*_\-~|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function userDisplayName(udoc: any, uid: number) {
    return udoc?.displayName || udoc?.uname || udoc?.name || `UID ${uid}`;
}

async function buildTaskDict(domainId: string, taskIds: any[]) {
    const validIds = Array.from(new Set(taskIds.filter(Boolean).map(idText)));
    if (!validIds.length) return {};
    const objectIds = validIds.map((item) => new ObjectId(item));
    const tasks = await collTask.find({ domainId, _id: { $in: objectIds } }).toArray();
    return Object.fromEntries(tasks.map((task: any) => [idText(task._id), task]));
}

async function buildVoteDict(domainId: string, submitIds: any[]) {
    const ids = submitIds.filter(Boolean);
    if (!ids.length) return {};
    const rows = await collVote.aggregate([
        { $match: { domainId, submitId: { $in: ids } } },
        { $group: { _id: '$submitId', count: { $sum: 1 } } },
    ]).toArray();
    return Object.fromEntries(rows.map((row: any) => [idText(row._id), row.count]));
}

class PeerSummaryHubHandler extends Handler {
    async get(domainId: string) {
        const submits = await collSubmit.find({ domainId, excellent: true }).sort({ updatedAt: -1 }).limit(80).toArray();
        const [udict, taskDict, voteDict] = await Promise.all([
            UserModel.getList(domainId, submits.map((item: any) => item.uid)),
            buildTaskDict(domainId, submits.map((item: any) => item.taskId)),
            buildVoteDict(domainId, submits.map((item: any) => item._id)),
        ]);
        this.response.template = 'peer_summary_hub.html';
        this.response.body = { page_name: 'peer_summary_hub', submits, udict, taskDict, voteDict };
    }
}

class PeerSummaryHomeFeedHandler extends Handler {
    async get(domainId: string) {
        const submits = await collSubmit.find({ domainId, excellent: true }).sort({ updatedAt: -1 }).limit(3).toArray();
        const [udict, taskDict, voteDict] = await Promise.all([
            UserModel.getList(domainId, submits.map((item: any) => item.uid)),
            buildTaskDict(domainId, submits.map((item: any) => item.taskId)),
            buildVoteDict(domainId, submits.map((item: any) => item._id)),
        ]);
        this.response.body = {
            items: submits.map((submit: any) => {
                const task = taskDict[idText(submit.taskId)];
                return {
                    id: idText(submit._id),
                    title: task?.title || '课程总结',
                    author: userDisplayName((udict as any)[submit.uid], submit.uid),
                    content: stripSummaryText(submit.content),
                    votes: voteDict[idText(submit._id)] || 0,
                    url: this.url('peer_summary_detail', { sid: submit._id }),
                };
            }),
            hubUrl: this.url('peer_summary_hub'),
        };
    }
}

class PeerSummaryDetailHandler extends Handler {
    @param('sid', Types.ObjectId)
    async get(domainId: string, sid: ObjectId) {
        const submit = await collSubmit.findOne({ _id: sid, domainId, excellent: true });
        if (!submit) throw new NotFoundError('summary');
        const comments = await collComment.find({ domainId, submitId: sid }).sort({ createdAt: 1 }).toArray();
        const uids = Array.from(new Set([submit.uid, ...comments.map((item: any) => item.uid)]));
        const [udict, taskDict, voteCount, myVote] = await Promise.all([
            UserModel.getList(domainId, uids),
            buildTaskDict(domainId, [submit.taskId]),
            collVote.countDocuments({ domainId, submitId: sid }),
            collVote.findOne({ domainId, submitId: sid, uid: this.user._id }),
        ]);
        this.response.template = 'peer_summary_detail.html';
        this.response.body = { page_name: 'peer_summary_detail', submit, comments, udict, taskDict, voteCount, myVote };
    }

    @param('sid', Types.ObjectId)
    async postVote(domainId: string, sid: ObjectId) {
        const submit = await collSubmit.findOne({ _id: sid, domainId, excellent: true });
        if (!submit) throw new NotFoundError('summary');
        if (submit.uid === this.user._id) throw new ForbiddenError('不能给自己的总结点赞');
        const existing = await collVote.findOne({ domainId, submitId: sid, uid: this.user._id });
        if (existing) await collVote.deleteOne({ _id: existing._id });
        else await collVote.insertOne({ _id: new ObjectId(), domainId, submitId: sid, uid: this.user._id, value: 1, createdAt: new Date(), updatedAt: new Date() });
        this.response.redirect = this.url('peer_summary_detail', { sid });
    }

    @param('sid', Types.ObjectId)
    @param('content', Types.Content)
    async postComment(domainId: string, sid: ObjectId, content: string) {
        const submit = await collSubmit.findOne({ _id: sid, domainId, excellent: true });
        if (!submit) throw new NotFoundError('summary');
        if (!content.trim()) throw new ValidationError('content');
        const doc: SummaryHubComment = {
            _id: new ObjectId(),
            domainId,
            submitId: sid,
            uid: this.user._id,
            content,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        await collComment.insertOne(doc as any);
        this.response.redirect = this.url('peer_summary_detail', { sid });
    }

    @param('sid', Types.ObjectId)
    @param('commentId', Types.ObjectId)
    async postDeleteComment(domainId: string, sid: ObjectId, commentId: ObjectId) {
        const comment = await collComment.findOne({ _id: commentId, domainId, submitId: sid });
        if (!comment) throw new NotFoundError('comment');
        if (comment.uid !== this.user._id) this.checkPerm(PERM.PERM_EDIT_TRAINING);
        await collComment.deleteOne({ _id: commentId });
        this.response.redirect = this.url('peer_summary_detail', { sid });
    }
}

export async function apply(ctx: Context) {
    ctx.Route('peer_summary_hub', '/domain/summary-hub', PeerSummaryHubHandler, PERM.PERM_VIEW_TRAINING);
    ctx.Route('peer_summary_home_feed', '/domain/summary-hub/feed', PeerSummaryHomeFeedHandler, PERM.PERM_VIEW_TRAINING);
    ctx.Route('peer_summary_detail', '/domain/summary-hub/:sid', PeerSummaryDetailHandler, PRIV.PRIV_USER_PROFILE);
    ctx.injectUI('DomainManage', 'peer_summary_hub', { family: '学习成长', icon: 'star' }, PERM.PERM_EDIT_TRAINING);
    ctx.i18n.load('zh', {
        peer_summary_hub: '优秀总结互评',
        peer_summary_home_feed: '优秀总结',
        peer_summary_detail: '优秀总结详情',
    });
    await db.ensureIndexes(collVote,
        { key: { domainId: 1, submitId: 1, uid: 1 }, unique: true, name: 'domain_submit_uid' },
        { key: { domainId: 1, submitId: 1 }, name: 'domain_submit' },
    );
    await db.ensureIndexes(collComment,
        { key: { domainId: 1, submitId: 1, createdAt: 1 }, name: 'domain_submit_created' },
        { key: { domainId: 1, uid: 1, createdAt: -1 }, name: 'domain_uid_created' },
    );
}
