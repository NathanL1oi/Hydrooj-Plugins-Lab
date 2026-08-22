import {
    Context, Handler, ObjectId, PERM, Types, UserModel, ValidationError, db, param,
} from 'hydrooj';

const PLUGIN_ID = 'class-team-hub';
const collTeam = db.collection('domain.classTeam.team' as any);
const collManagedStudent = db.collection('domain.studentAccount' as any);

interface ClassTeamDoc {
    _id: string;
    domainId: string;
    teamId: string;
    name: string;
    members: number[];
    note: string;
    createdAt?: Date;
    updatedAt: Date;
    updatedBy: number;
}

function scopedId(domainId: string, teamId: string) {
    return `${domainId}:${teamId}`;
}

function runtimeEnabled() {
    const pluginSwitch = (globalThis as any).Hydro?.model?.pluginSwitch;
    return pluginSwitch?.isEnabledSync?.(PLUGIN_ID) !== false;
}

function normalizeTeamName(raw: string) {
    return String(raw || '').trim().replace(/\s+/g, ' ');
}

function splitTokens(text: string) {
    return String(text || '')
        .split(/[,\s;，；、]+/)
        .map((item) => item.trim())
        .filter(Boolean);
}

async function resolveUser(domainId: string, raw: string) {
    const token = String(raw || '').trim();
    if (!token) return null;
    try {
        if (/^\d+$/.test(token)) return await UserModel.getById(domainId, Number(token));
        if (token.includes('@')) return await UserModel.getByEmail(domainId, token);
        return await UserModel.getByUname(domainId, token);
    } catch {
        return null;
    }
}

async function parseMembers(domainId: string, membersText: string) {
    const members: number[] = [];
    const messages: string[] = [];
    for (const token of splitTokens(membersText)) {
        const udoc = await resolveUser(domainId, token);
        if (!udoc?._id || udoc._id <= 1) {
            messages.push(`未找到学生：${token}`);
            continue;
        }
        if (!members.includes(udoc._id)) members.push(udoc._id);
    }
    if (members.length < 2 || members.length > 3) {
        throw new ValidationError('members', members.length, '每个班级小队需要 2-3 名学生。');
    }
    return { members, messages };
}

async function listTeams(domainId: string) {
    return await collTeam.find({ domainId }).sort({ name: 1, teamId: 1 }).toArray() as ClassTeamDoc[];
}

async function userNameMap(domainId: string, uids: number[]) {
    const unique = Array.from(new Set(uids.filter(Boolean)));
    if (!unique.length) return {};
    const [udict, managed] = await Promise.all([
        UserModel.getListForRender(domainId, unique, ['displayName']) as Promise<Record<number, any>>,
        collManagedStudent.find({ domainId, uid: { $in: unique } }).project({ uid: 1, name: 1, studentId: 1 }).toArray() as Promise<any[]>,
    ]);
    const managedMap = new Map<number, any>();
    for (const item of managed) managedMap.set(Number(item.uid), item);
    const result: Record<number, string> = {};
    for (const uid of unique) {
        const item = managedMap.get(uid);
        const udoc = udict?.[uid];
        result[uid] = item?.name
            ? `${item.name}${item.studentId ? ` (${item.studentId})` : ''}`
            : (udoc?.displayName || udoc?.uname || `UID ${uid}`);
    }
    return result;
}

function exportAssignments(teams: ClassTeamDoc[]) {
    return teams.map((team) => `${team.name}: ${team.members.join(', ')}`).join('\n');
}

async function publicTeams(domainId: string) {
    if (!runtimeEnabled()) return [];
    const teams = await listTeams(domainId);
    return teams.map((team) => ({
        teamId: team.teamId,
        name: team.name,
        members: team.members,
        note: team.note || '',
    }));
}

function publishModel() {
    const hydro = (globalThis as any).Hydro;
    if (!hydro?.model) return;
    hydro.model.classTeam = {
        id: PLUGIN_ID,
        list: publicTeams,
        exportAssignments: async (domainId: string) => exportAssignments(await listTeams(domainId)),
    };
}

class DomainClassTeamHandler extends Handler {
    async prepare() {
        this.checkPerm(PERM.PERM_EDIT_DOMAIN);
    }

    async buildBody(domainId: string, messages: string[] = []) {
        const teams = await listTeams(domainId);
        const allUids = teams.flatMap((team) => team.members);
        const names = await userNameMap(domainId, allUids);
        const students = await collManagedStudent.find({ domainId })
            .sort({ studentId: 1, name: 1 })
            .project({ uid: 1, name: 1, studentId: 1, uname: 1 })
            .toArray() as any[];
        return {
            page_name: 'domain_class_teams',
            teams: teams.map((team) => ({
                ...team,
                membersText: team.members.join(', '),
                memberNames: team.members.map((uid) => names[uid] || `UID ${uid}`),
            })),
            students,
            messages,
        };
    }

    async get({ domainId }: any) {
        this.response.template = 'domain_class_teams.html';
        this.response.body = await this.buildBody(domainId);
    }

    @param('teamId', Types.String, true)
    @param('name', Types.String)
    @param('membersText', Types.Content)
    @param('note', Types.Content, true)
    async postSave({ domainId }: any, teamId = '', name: string, membersText: string, note = '') {
        const cleanName = normalizeTeamName(name);
        if (!cleanName) throw new ValidationError('name');
        const parsed = await parseMembers(domainId, membersText);
        const now = new Date();
        const nextTeamId = teamId || new ObjectId().toHexString();
        await collTeam.updateOne(
            { _id: scopedId(domainId, nextTeamId) },
            {
                $set: {
                    _id: scopedId(domainId, nextTeamId),
                    domainId,
                    teamId: nextTeamId,
                    name: cleanName,
                    members: parsed.members,
                    note: String(note || '').trim(),
                    updatedAt: now,
                    updatedBy: this.user._id,
                },
                $setOnInsert: { createdAt: now },
            },
            { upsert: true },
        );
        this.response.template = 'domain_class_teams.html';
        this.response.body = await this.buildBody(domainId, [`已保存小队：${cleanName}`, ...parsed.messages]);
    }

    @param('teamId', Types.String)
    async postDelete({ domainId }: any, teamId: string) {
        await collTeam.deleteOne({ _id: scopedId(domainId, teamId) });
        this.response.template = 'domain_class_teams.html';
        this.response.body = await this.buildBody(domainId, ['已删除班级小队。']);
    }
}

export async function apply(ctx: Context) {
    await db.ensureIndexes(
        collTeam,
        { key: { domainId: 1, name: 1 }, name: 'class_team_name', unique: true },
        { key: { domainId: 1, teamId: 1 }, name: 'class_team_id', unique: true },
    );
    publishModel();
    ctx.Route('domain_class_teams', '/domain/class-teams', DomainClassTeamHandler, PERM.PERM_EDIT_DOMAIN);
    ctx.injectUI('DomainManage', 'domain_class_teams', { family: 'Contest', icon: 'user' }, PERM.PERM_EDIT_DOMAIN);
    ctx.i18n.load('zh', {
        domain_class_teams: '班级小队',
    });
    ctx.i18n.load('en', {
        domain_class_teams: 'Class Teams',
    });
}
