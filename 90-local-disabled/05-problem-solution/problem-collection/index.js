const {
    Handler,
    PRIV,
    ProblemModel,
    ValidationError,
    ForbiddenError,
    NotFoundError,
    ObjectId,
    db,
} = require('hydrooj');

const coll = db.collection('problem.collection');
const MAX_LISTS = 40;
const MAX_ITEMS_PER_LIST = 500;

function domainIdOf(handler) {
    return String(handler.args?.domainId || handler.domain?._id || 'system');
}

function userIdOf(handler) {
    return Number(handler.user?._id || 0);
}

function cleanText(value, max = 120) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanMultiline(value, max = 500) {
    return String(value || '').replace(/\r\n/g, '\n').trim().slice(0, max);
}

function asArray(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

function objectId(value) {
    try {
        return new ObjectId(String(value));
    } catch {
        throw new ValidationError('cid');
    }
}

function normalizePid(value) {
    const pid = Number(value);
    if (!Number.isInteger(pid) || pid <= 0) throw new ValidationError('pid');
    return pid;
}

function problemUrl(domainId, pid) {
    return `/d/${encodeURIComponent(domainId)}/p/${encodeURIComponent(String(pid))}`;
}

async function getProblem(domainId, pid) {
    return await ProblemModel.get(domainId, pid).catch(() => null);
}

async function ensureCollection(handler, cid) {
    const doc = await coll.findOne({ _id: objectId(cid), domainId: domainIdOf(handler), uid: userIdOf(handler) });
    if (!doc) throw new NotFoundError('problem collection');
    return doc;
}

async function userCollections(domainId, uid) {
    return await coll.find({ domainId, uid }).sort({ updatedAt: -1, createdAt: -1 }).toArray();
}

async function createCollection(domainId, uid, title, description = '') {
    const count = await coll.countDocuments({ domainId, uid });
    if (count >= MAX_LISTS) throw new ForbiddenError(`最多只能创建 ${MAX_LISTS} 个收藏题单。`);
    const cleanTitle = cleanText(title, 40);
    if (!cleanTitle) throw new ValidationError('title');
    const now = new Date();
    const doc = {
        _id: new ObjectId(),
        domainId,
        uid,
        title: cleanTitle,
        description: cleanMultiline(description),
        items: [],
        createdAt: now,
        updatedAt: now,
    };
    await coll.insertOne(doc);
    return doc;
}

function itemKey(domainId, pid) {
    return `${domainId}:${pid}`;
}

async function addProblemToCollection(collection, problem) {
    const exists = (collection.items || []).some((item) => itemKey(item.domainId, item.pid) === itemKey(problem.domainId, problem.pid));
    if (exists) return false;
    if ((collection.items || []).length >= MAX_ITEMS_PER_LIST) throw new ForbiddenError(`每个收藏题单最多保存 ${MAX_ITEMS_PER_LIST} 道题。`);
    await coll.updateOne(
        { _id: collection._id, uid: collection.uid },
        {
            $push: { items: { ...problem, addedAt: new Date() } },
            $set: { updatedAt: new Date() },
        },
    );
    return true;
}

async function removeProblemFromCollection(collection, domainId, pid) {
    await coll.updateOne(
        { _id: collection._id, uid: collection.uid },
        {
            $pull: { items: { domainId, pid } },
            $set: { updatedAt: new Date() },
        },
    );
}

async function enrichItems(items, fallbackDomainId) {
    const result = [];
    for (const item of items || []) {
        const itemDomainId = String(item.domainId || fallbackDomainId);
        const pdoc = await getProblem(itemDomainId, Number(item.pid));
        const urlPid = pdoc?.pid || pdoc?.docId || item.pid;
        result.push({
            ...item,
            domainId: itemDomainId,
            title: pdoc?.title || item.title || `P${item.pid}`,
            pidLabel: pdoc?.pid || `P${item.pid}`,
            url: problemUrl(itemDomainId, urlPid),
            hidden: !!pdoc?.hidden,
        });
    }
    return result;
}

function newestItems(lists, limit = 8) {
    const seen = new Set();
    const items = [];
    for (const list of lists) {
        for (const item of list.items || []) {
            const key = itemKey(item.domainId, item.pid);
            if (seen.has(key)) continue;
            seen.add(key);
            items.push({ ...item, listTitle: list.title, listId: String(list._id) });
        }
    }
    return items.sort((a, b) => +new Date(b.addedAt || 0) - +new Date(a.addedAt || 0)).slice(0, limit);
}

class ProblemCollectionMainHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }

    async get() {
        const domainId = domainIdOf(this);
        const uid = userIdOf(this);
        const lists = await userCollections(domainId, uid);
        const rows = [];
        for (const list of lists) {
            rows.push({
                ...list,
                id: String(list._id),
                itemCount: (list.items || []).length,
                previewItems: await enrichItems((list.items || []).slice(-4).reverse(), domainId),
            });
        }
        this.response.template = 'problem_collection_main.html';
        this.response.body = {
            page_name: 'problem_collection_main',
            lists: rows,
            recentItems: await enrichItems(newestItems(lists), domainId),
            maxLists: MAX_LISTS,
        };
    }

    async postCreate() {
        const doc = await createCollection(domainIdOf(this), userIdOf(this), this.args?.title, this.args?.description);
        this.response.redirect = this.url('problem_collection_detail', { cid: doc._id });
    }
}

class ProblemCollectionDetailHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        this.collection = await ensureCollection(this, this.args?.cid);
    }

    async get() {
        const domainId = domainIdOf(this);
        this.response.template = 'problem_collection_detail.html';
        this.response.body = {
            page_name: 'problem_collection_detail',
            collection: {
                ...this.collection,
                id: String(this.collection._id),
                items: await enrichItems([...(this.collection.items || [])].reverse(), domainId),
            },
        };
    }

    async postUpdate() {
        const title = cleanText(this.args?.title, 40);
        if (!title) throw new ValidationError('title');
        await coll.updateOne(
            { _id: this.collection._id, uid: this.collection.uid },
            {
                $set: {
                    title,
                    description: cleanMultiline(this.args?.description),
                    updatedAt: new Date(),
                },
            },
        );
        this.back();
    }

    async postDelete() {
        await coll.deleteOne({ _id: this.collection._id, uid: this.collection.uid });
        this.response.redirect = this.url('problem_collection_main');
    }

    async postRemoveProblem() {
        const pid = normalizePid(this.args?.pid);
        const itemDomainId = String(this.args?.itemDomainId || domainIdOf(this));
        await removeProblemFromCollection(this.collection, itemDomainId, pid);
        this.back();
    }
}

class ProblemCollectionPickHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const domainId = domainIdOf(this);
        const pid = normalizePid(this.args?.pid);
        this.pdoc = await getProblem(domainId, pid);
        if (!this.pdoc) throw new NotFoundError('problem');
    }

    async get() {
        const domainId = domainIdOf(this);
        const uid = userIdOf(this);
        const pid = Number(this.pdoc.docId || this.args?.pid);
        const lists = await userCollections(domainId, uid);
        this.response.template = 'problem_collection_pick.html';
        this.response.body = {
            page_name: 'problem_collection_pick',
            pdoc: this.pdoc,
            pid,
            lists: lists.map((list) => ({
                ...list,
                id: String(list._id),
                itemCount: (list.items || []).length,
                selected: (list.items || []).some((item) => itemKey(item.domainId, item.pid) === itemKey(domainId, pid)),
            })),
            problemUrl: problemUrl(domainId, this.pdoc.pid || this.pdoc.docId),
        };
    }

    async postSave() {
        const domainId = domainIdOf(this);
        const uid = userIdOf(this);
        const pid = Number(this.pdoc.docId || this.args?.pid);
        const problem = {
            domainId,
            pid,
            title: this.pdoc.title || `P${pid}`,
        };
        const selected = new Set(asArray(this.args?.listIds).map(String).filter(Boolean));
        const lists = await userCollections(domainId, uid);
        for (const list of lists) {
            if (selected.has(String(list._id))) await addProblemToCollection(list, problem);
            else await removeProblemFromCollection(list, domainId, pid);
        }
        const newTitle = cleanText(this.args?.newTitle, 40);
        if (newTitle) {
            const doc = await createCollection(domainId, uid, newTitle, '');
            await addProblemToCollection(doc, problem);
        }
        this.response.redirect = this.url('problem_collection_pick', { pid });
    }
}

async function setProblemCollectionUi(handler) {
    if (!handler.pdoc || !handler.user?.hasPriv?.(PRIV.PRIV_USER_PROFILE)) return;
    const pid = Number(handler.pdoc.docId || handler.pdoc.pid);
    if (!pid) return;
    const domainId = domainIdOf(handler);
    const uid = userIdOf(handler);
    const collectedCount = await coll.countDocuments({
        domainId,
        uid,
        items: { $elemMatch: { domainId, pid } },
    });
    handler.UiContext ||= {};
    handler.UiContext.problemCollection = {
        canUse: true,
        addUrl: handler.url('problem_collection_pick', { pid }),
        mainUrl: handler.url('problem_collection_main'),
        collected: collectedCount > 0,
        collectedCount,
    };
}

exports.apply = async (ctx) => {
    await coll.createIndex({ domainId: 1, uid: 1, updatedAt: -1 });
    await coll.createIndex({ domainId: 1, uid: 1, title: 1 });

    ctx.Route('problem_collection_pick', '/problem-collection/add/:pid', ProblemCollectionPickHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('problem_collection_detail', '/problem-collection/:cid', ProblemCollectionDetailHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('problem_collection_main', '/problem-collection', ProblemCollectionMainHandler, PRIV.PRIV_USER_PROFILE);
    ctx.injectUI('UserDropdown', 'problem_collection_main', { icon: 'star', displayName: '收藏题单' }, PRIV.PRIV_USER_PROFILE);

    ctx.on('handler/after/ProblemDetail#get', async (handler) => setProblemCollectionUi(handler));

    ctx.i18n.load('zh', {
        problem_collection_main: '收藏题单',
        problem_collection_detail: '收藏题单',
        problem_collection_pick: '收藏到题单',
    });
    ctx.i18n.load('en', {
        problem_collection_main: 'Problem Collections',
        problem_collection_detail: 'Problem Collection',
        problem_collection_pick: 'Add to Collection',
    });
};
