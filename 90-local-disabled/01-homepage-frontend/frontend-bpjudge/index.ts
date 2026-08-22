import {
    UserModel, db, DomainModel, BaseUserDict, SystemModel,
} from 'hydrooj';

const collUser = db.collection('domain.user');
export const coll: Collection<Udoc> = db.collection('user');
export const collV: Collection<VUdoc> = db.collection('vuser');
export const collGroup: Collection<GDoc> = db.collection('user.group');

const DIFFICULTY_TAG_GROUP = [
    '暂无评定',
    '入门',
    '普及-',
    '普及',
    '普及+/提高-',
    '提高',
    '提高+/省选-',
    '省选/NOI-',
    'NOI/NOI+/CTS',
];

function replaceDifficultyTagGroup(source: string) {
    const lines = String(source || '').split(/\r?\n/);
    const next = [];
    let skippingDifficulty = false;
    let replaced = false;
    for (const line of lines) {
        if (line.startsWith('难度:')) {
            next.push('难度:');
            for (const tag of DIFFICULTY_TAG_GROUP) next.push(`  - ${tag}`);
            skippingDifficulty = true;
            replaced = true;
            continue;
        }
        if (skippingDifficulty) {
            if (/^\S.*:/.test(line)) {
                skippingDifficulty = false;
                next.push(line);
            }
            continue;
        }
        next.push(line);
    }
    if (!replaced) {
        if (next.length && next[next.length - 1] !== '') next.push('');
        next.push('难度:');
        for (const tag of DIFFICULTY_TAG_GROUP) next.push(`  - ${tag}`);
    }
    return next.join('\n').replace(/\n+$/, '');
}

function dumpCategoryYaml(categories: Record<string, any>) {
    const lines = [];
    for (const [group, tags] of Object.entries(categories)) {
        lines.push(`${group}:`);
        for (const tag of Array.isArray(tags) ? tags : []) lines.push(`  - ${tag}`);
    }
    return lines.join('\n');
}

async function ensureLuoguDifficultyTagGroup() {
    const current = SystemModel.get('problem.categories');
    let next: string;
    if (current && typeof current === 'object' && !Array.isArray(current)) {
        next = dumpCategoryYaml({ ...current, 难度: DIFFICULTY_TAG_GROUP });
    } else {
        next = replaceDifficultyTagGroup(typeof current === 'string' ? current : '');
    }
    if (next && next !== current) await SystemModel.set('problem.categories', next);
}

export async function apply(ctx) {
    await ensureLuoguDifficultyTagGroup();

    UserModel.getListForRender = async function (domainId: string, uids: number[], arg: string[] | boolean) {
        const fields = ['_id', 'uname', 'mail', 'avatar', 'school', 'studentId'].concat(arg instanceof Array ? arg : []);
        const showDisplayName = arg instanceof Array ? fields.includes('displayName') : arg;
        const [vudocs, dudocs] = await Promise.all([
            // UserModel.getMulti({ _id: { $in: uids } }, fields).toArray(),
            collV.find({ _id: { $in: uids } }).toArray(),
            DomainModel.getDomainUserMulti(domainId, uids).project({ uid: 1, ...(showDisplayName ? { displayName: 1 } : {}) }).toArray(),
        ]);
        const udocs = [];
        // eslint-disable-next-line no-await-in-loop
        for (const i of uids) udocs.push(await UserModel.getById(domainId, i));
        const udict = {};
        for (const udoc of udocs) udict[udoc._id] = udoc;
        for (const udoc of vudocs) udict[udoc._id] = udoc;
        if (showDisplayName) for (const dudoc of dudocs) udict[dudoc.uid].displayName = dudoc.displayName;
        for (const uid of uids) udict[uid] ||= { ...UserModel.defaultUser };
        for (const key in udict) {
            udict[key].school ||= '';
            udict[key].studentId ||= '';
            udict[key].displayName ||= udict[key].uname;
            udict[key].avatar ||= `gravatar:${udict[key].mail}`;
        }
        return udict as BaseUserDict;
    };
    ctx.on('handler/after/SystemUserPriv#get', async (that) => {
        const udocs = that.response.body.udocs;
        const udict = [];
        for (const udoc of udocs) {
            udict.push(await UserModel.getById('system', udoc._id));
        }
        that.response.body.udocs = udict;
    });
}
