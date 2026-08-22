import {
    ContestModel, Context, DomainModel, ObjectId, PERM, PRIV, RecordModel, STATUS,
    Types, UserModel, ValidationError, db, param,
} from 'hydrooj';
import { ContestDetailBaseHandler } from 'hydrooj/src/handler/contest';

const collConfig = db.collection('domain.contestFun.config' as any);
const collGoal = db.collection('domain.contestFun.goal' as any);
const collTeam = db.collection('domain.contestFun.team' as any);
const collManagedStudent = db.collection('domain.studentAccount' as any);

interface ContestFunConfig {
    _id: string;
    domainId: string;
    tid: ObjectId;
    goalEnabled: boolean;
    taskEnabled: boolean;
    highlightEnabled: boolean;
    timelineEnabled: boolean;
    groupModeEnabled: boolean;
    groupSelectOpen: boolean;
    groupNames: string[];
    updatedAt: Date;
}

interface GoalDoc {
    _id: string;
    domainId: string;
    tid: ObjectId;
    uid: number;
    targetSolve: number;
    strategy: string;
    worry: string;
    createdAt: Date;
    updatedAt: Date;
}

interface TeamDoc {
    _id: string;
    domainId: string;
    tid: ObjectId;
    uid: number;
    teamName: string;
    source: 'admin' | 'self';
    updatedAt: Date;
}

function idText(id: ObjectId | string) {
    return typeof id === 'string' ? id : id.toHexString();
}

function configId(domainId: string, tid: ObjectId) {
    return `${domainId}:${idText(tid)}`;
}

function userScopedId(domainId: string, tid: ObjectId, uid: number) {
    return `${domainId}:${idText(tid)}:${uid}`;
}

function isOn(value: any) {
    return value === true || value === 'true' || value === '1' || value === 'on';
}

function uniqueTexts(values: string[]) {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of values) {
        const value = String(raw || '').trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        result.push(value);
    }
    return result;
}

function parseGroupNames(text: string) {
    return uniqueTexts(String(text || '').split(/\r?\n/));
}

function alphabetic(index: number) {
    let n = index + 1;
    let s = '';
    while (n > 0) {
        n -= 1;
        s = String.fromCharCode(65 + (n % 26)) + s;
        n = Math.floor(n / 26);
    }
    return s || '?';
}

function problemLabel(tdoc: any, pid: number) {
    const idx = (tdoc.pids || []).indexOf(pid);
    return idx >= 0 ? alphabetic(idx) : `P${pid}`;
}

function recordAt(rdoc: any) {
    return rdoc.judgeAt || rdoc._id?.getTimestamp?.() || new Date();
}

function minutesFromBegin(tdoc: any, at: Date) {
    const begin = new Date(tdoc.beginAt || at).getTime();
    return Math.max(0, Math.round((at.getTime() - begin) / 60000));
}

function statusLabel(status: number) {
    if (status === STATUS.STATUS_ACCEPTED) return 'AC';
    if (status === STATUS.STATUS_WRONG_ANSWER) return 'WA';
    if (status === STATUS.STATUS_COMPILE_ERROR) return 'CE';
    if (status === STATUS.STATUS_TIME_LIMIT_EXCEEDED) return 'TLE';
    if (status === STATUS.STATUS_RUNTIME_ERROR) return 'RE';
    if (status === STATUS.STATUS_MEMORY_LIMIT_EXCEEDED) return 'MLE';
    if (status === STATUS.STATUS_OUTPUT_LIMIT_EXCEEDED) return 'OLE';
    if (status === STATUS.STATUS_FORMAT_ERROR) return 'FE';
    if (status === STATUS.STATUS_WAITING) return '等待';
    return String(status);
}

function defaultConfig(domainId: string, tid: ObjectId): ContestFunConfig {
    return {
        _id: configId(domainId, tid),
        domainId,
        tid,
        goalEnabled: false,
        taskEnabled: false,
        highlightEnabled: false,
        timelineEnabled: false,
        groupModeEnabled: false,
        groupSelectOpen: true,
        groupNames: [],
        updatedAt: new Date(),
    };
}

async function getConfig(domainId: string, tid: ObjectId): Promise<ContestFunConfig> {
    const doc = await collConfig.findOne({ _id: configId(domainId, tid) }) as ContestFunConfig | null;
    return { ...defaultConfig(domainId, tid), ...doc, tid };
}

function anyFeatureEnabled(config: ContestFunConfig) {
    return config.goalEnabled || config.taskEnabled || config.highlightEnabled || config.timelineEnabled || config.groupModeEnabled;
}

function canManageContest(handler: any) {
    return handler.user?.own?.(handler.tdoc) || handler.user?.hasPerm?.(PERM.PERM_EDIT_CONTEST);
}

async function getGoal(domainId: string, tid: ObjectId, uid: number) {
    return await collGoal.findOne({ _id: userScopedId(domainId, tid, uid) }) as GoalDoc | null;
}

async function getTeam(domainId: string, tid: ObjectId, uid: number) {
    return await collTeam.findOne({ _id: userScopedId(domainId, tid, uid) }) as TeamDoc | null;
}

async function setTeam(domainId: string, tid: ObjectId, uid: number, teamName: string, source: 'admin' | 'self') {
    const name = String(teamName || '').trim();
    if (!name) {
        await collTeam.deleteOne({ _id: userScopedId(domainId, tid, uid) });
        return;
    }
    await collTeam.updateOne(
        { _id: userScopedId(domainId, tid, uid) },
        {
            $set: {
                _id: userScopedId(domainId, tid, uid),
                domainId,
                tid,
                uid,
                teamName: name,
                source,
                updatedAt: new Date(),
            },
        },
        { upsert: true },
    );
}

function displayStudentName(raw: any) {
    const name = String(raw || '').trim();
    const realName = name.match(/[\(\uFF08]\s*([^\(\)\uFF08\uFF09]+?)\s*[\)\uFF09]\s*$/)?.[1]?.trim();
    return realName || name;
}

async function userNameMap(domainId: string, uids: number[]) {
    const unique = Array.from(new Set(uids.filter((i) => Number.isFinite(i))));
    if (!unique.length) return {};
    const [udict, domainUsers, managedStudents] = await Promise.all([
        UserModel.getListForRender(domainId, unique, ['displayName']) as Promise<Record<number, any>>,
        DomainModel.getDomainUserMulti(domainId, unique).project({ uid: 1, displayName: 1 }).toArray() as Promise<any[]>,
        collManagedStudent.find({ domainId, uid: { $in: unique } }).project({ uid: 1, name: 1 }).toArray() as Promise<any[]>,
    ]);
    const domainDisplayNames: Record<number, string> = {};
    const managedNames: Record<number, string> = {};
    for (const item of domainUsers) if (item?.uid) domainDisplayNames[item.uid] = item.displayName || '';
    for (const item of managedStudents) if (item?.uid) managedNames[item.uid] = item.name || '';
    const names: Record<number, string> = {};
    for (const uid of unique) {
        names[uid] = displayStudentName(
            managedNames[uid]
            || domainDisplayNames[uid]
            || udict?.[uid]?.displayName
            || udict?.[uid]?.uname
            || `U${uid}`,
        );
    }
    return names;
}

async function resolveUser(domainId: string, raw: string) {
    const token = String(raw || '').trim();
    if (!token) return null;
    try {
        if (/^\d+$/.test(token)) return await UserModel.getById(domainId, Number(token));
        if (token.includes('@')) return await UserModel.getByEmail(domainId, token);
        return await UserModel.getByUname(domainId, token);
    } catch (e) {
        return null;
    }
}

async function applyAssignments(domainId: string, tid: ObjectId, text: string) {
    await collTeam.deleteMany({ domainId, tid });
    const extraGroups: string[] = [];
    const messages: string[] = [];
    for (const [index, rawLine] of String(text || '').split(/\r?\n/).entries()) {
        const line = rawLine.trim();
        if (!line) continue;
        const pos = line.search(/[:：]/);
        if (pos < 0) {
            messages.push(`第 ${index + 1} 行缺少冒号，已跳过`);
            continue;
        }
        const teamName = line.slice(0, pos).trim();
        const users = line.slice(pos + 1).split(/[,，、\s]+/).map((i) => i.trim()).filter(Boolean);
        if (!teamName) {
            messages.push(`第 ${index + 1} 行缺少小组名，已跳过`);
            continue;
        }
        extraGroups.push(teamName);
        for (const token of users) {
            const udoc = await resolveUser(domainId, token);
            if (!udoc) {
                messages.push(`${teamName}: 未找到用户 ${token}`);
                continue;
            }
            await setTeam(domainId, tid, udoc._id, teamName, 'admin');
        }
    }
    return { extraGroups: uniqueTexts(extraGroups), messages };
}

async function exportAssignments(domainId: string, tid: ObjectId) {
    const docs = await collTeam.find({ domainId, tid }).sort({ teamName: 1, uid: 1 }).toArray() as TeamDoc[];
    const byTeam: Record<string, number[]> = {};
    for (const doc of docs) {
        byTeam[doc.teamName] ||= [];
        byTeam[doc.teamName].push(doc.uid);
    }
    return Object.entries(byTeam)
        .map(([team, uids]) => `${team}: ${uids.join(', ')}`)
        .join('\n');
}

async function getClassTeamSource(domainId: string) {
    const model = (globalThis as any).Hydro?.model?.classTeam;
    if (!model?.list) return { enabled: false, teams: [], groupNames: [], assignmentsText: '' };
    const teams = await model.list(domainId) as Array<{ name: string; members: number[] }>;
    return {
        enabled: true,
        teams,
        groupNames: teams.map((team) => team.name),
        assignmentsText: teams.map((team) => `${team.name}: ${team.members.join(', ')}`).join('\n'),
    };
}

async function ensurePluginIndexes(collection: any, ...indexes: any[]) {
    try {
        await db.ensureIndexes(collection, ...indexes);
    } catch (e: any) {
        console.warn('[contest-fun-kit] failed to ensure indexes:', e?.message || e);
    }
}

async function acceptedRecords(domainId: string, tid: ObjectId, pids: number[]) {
    return await RecordModel.getMulti(domainId, {
        contest: tid,
        pid: { $in: pids },
        status: STATUS.STATUS_ACCEPTED,
        rejudged: { $ne: true },
    })
        .project({ _id: 1, uid: 1, pid: 1, judgeAt: 1, status: 1 })
        .sort({ _id: 1 })
        .toArray() as any[];
}

async function buildTaskCard(domainId: string, tid: ObjectId, tdoc: any, tsdoc: any, uid: number, goal: GoalDoc | null) {
    const records = await RecordModel.getMulti(domainId, {
        contest: tid,
        uid,
        pid: { $in: tdoc.pids || [] },
        rejudged: { $ne: true },
    })
        .project({ _id: 1, uid: 1, pid: 1, judgeAt: 1, status: 1 })
        .sort({ _id: 1 })
        .toArray() as any[];

    const acPids: number[] = [];
    const acSet = new Set<number>();
    const failedBeforeAc = new Set<number>();
    const hadFail = new Set<number>();
    const endAt = tsdoc?.endAt || tdoc.endAt;
    const sprintStart = endAt ? new Date(new Date(endAt).getTime() - 30 * 60 * 1000) : null;
    let sprintAc = false;

    for (const rdoc of records) {
        if (rdoc.status === STATUS.STATUS_ACCEPTED) {
            if (!acSet.has(rdoc.pid)) {
                acSet.add(rdoc.pid);
                acPids.push(rdoc.pid);
                if (hadFail.has(rdoc.pid)) failedBeforeAc.add(rdoc.pid);
            }
            const at = recordAt(rdoc);
            if (sprintStart && at >= sprintStart) sprintAc = true;
        } else if (rdoc.status !== STATUS.STATUS_WAITING) {
            hadFail.add(rdoc.pid);
        }
    }

    const target = Math.max(0, Number(goal?.targetSolve || 0));
    const items = [
        { key: 'first-ac', title: '完成第一题', done: acPids.length >= 1, detail: acPids[0] ? `${problemLabel(tdoc, acPids[0])} 题` : '等待第一道 AC' },
        { key: 'two-ac', title: '解锁两题', done: acPids.length >= 2, detail: `${acPids.length}/${Math.min(2, tdoc.pids?.length || 2)}` },
        { key: 'recover-ac', title: '从失败到 AC', done: failedBeforeAc.size > 0, detail: failedBeforeAc.size ? `${failedBeforeAc.size} 题完成修正` : 'WA/CE/RE 后再 AC 即可完成' },
        { key: 'sprint-ac', title: '冲刺阶段突破', done: sprintAc, detail: '最后 30 分钟 AC' },
    ];
    if (target) items.push({
        key: 'goal-met',
        title: '达成赛前目标',
        done: acPids.length >= target,
        detail: `${acPids.length}/${target}`,
    });
    return {
        solved: acPids.length,
        total: tdoc.pids?.length || 0,
        done: items.filter((i) => i.done).length,
        count: items.length,
        items,
    };
}

async function buildGroupProgress(domainId: string, tid: ObjectId, tdoc: any, teamName: string) {
    if (!teamName) return null;
    const members = await collTeam.find({ domainId, tid, teamName }).project({ uid: 1 }).toArray() as TeamDoc[];
    const uids = members.map((i) => i.uid);
    if (!uids.length) return { teamName, members: 0, solved: 0, total: tdoc.pids?.length || 0 };
    const records = await RecordModel.getMulti(domainId, {
        contest: tid,
        uid: { $in: uids },
        pid: { $in: tdoc.pids || [] },
        status: STATUS.STATUS_ACCEPTED,
        rejudged: { $ne: true },
    }).project({ pid: 1 }).toArray() as any[];
    return {
        teamName,
        members: uids.length,
        solved: new Set(records.map((i) => i.pid)).size,
        total: tdoc.pids?.length || 0,
    };
}

async function buildHighlights(domainId: string, tid: ObjectId, tdoc: any, limit = 20) {
    const records = await acceptedRecords(domainId, tid, tdoc.pids || []);
    const firstByPid: Record<number, any> = {};
    const solvedByUser: Record<number, number> = {};
    const events: any[] = [];
    const endAt = tdoc.endAt ? new Date(tdoc.endAt) : null;
    const sprintStart = endAt ? new Date(endAt.getTime() - 30 * 60 * 1000) : null;

    for (const rdoc of records) {
        const at = recordAt(rdoc);
        if (!firstByPid[rdoc.pid]) {
            firstByPid[rdoc.pid] = rdoc;
            events.push({
                type: 'first',
                uid: rdoc.uid,
                pid: rdoc.pid,
                at,
                minute: minutesFromBegin(tdoc, at),
                title: `${problemLabel(tdoc, rdoc.pid)} 题首杀`,
            });
        }
        solvedByUser[rdoc.uid] = (solvedByUser[rdoc.uid] || 0) + 1;
        if (solvedByUser[rdoc.uid] === 2) events.push({
            type: 'streak',
            uid: rdoc.uid,
            pid: rdoc.pid,
            at,
            minute: minutesFromBegin(tdoc, at),
            title: '连续推进两题',
        });
        if (sprintStart && at >= sprintStart) events.push({
            type: 'sprint',
            uid: rdoc.uid,
            pid: rdoc.pid,
            at,
            minute: minutesFromBegin(tdoc, at),
            title: '冲刺阶段 AC',
        });
    }

    const uids = events.map((i) => i.uid);
    const [names, teams] = await Promise.all([
        userNameMap(domainId, uids),
        collTeam.find({ domainId, tid, uid: { $in: Array.from(new Set(uids)) } }).toArray() as Promise<TeamDoc[]>,
    ]);
    const teamMap: Record<number, string> = {};
    for (const team of teams) teamMap[team.uid] = team.teamName;
    for (const event of events) {
        event.uname = names[event.uid] || `U${event.uid}`;
        event.teamName = teamMap[event.uid] || '';
        event.problemLabel = problemLabel(tdoc, event.pid);
    }
    events.sort((a, b) => b.at.getTime() - a.at.getTime());
    return {
        firstSolves: Object.values(firstByPid).map((rdoc: any) => ({
            pid: rdoc.pid,
            problemLabel: problemLabel(tdoc, rdoc.pid),
            uid: rdoc.uid,
            uname: names[rdoc.uid] || `U${rdoc.uid}`,
            teamName: teamMap[rdoc.uid] || '',
            at: recordAt(rdoc),
            minute: minutesFromBegin(tdoc, recordAt(rdoc)),
        })),
        events: events.slice(0, limit),
    };
}

async function buildTimelineFilters(domainId: string, tid: ObjectId) {
    const [teamNames, teamDocs, recordUids] = await Promise.all([
        collTeam.distinct('teamName', { domainId, tid }),
        collTeam.find({ domainId, tid }).project({ uid: 1, teamName: 1 }).toArray() as Promise<TeamDoc[]>,
        RecordModel.coll.distinct('uid', { domainId, contest: tid }) as Promise<number[]>,
    ]);
    const uids = Array.from(new Set([...teamDocs.map((i) => i.uid), ...recordUids]));
    const names = await userNameMap(domainId, uids);
    return {
        teams: uniqueTexts(teamNames as string[]),
        users: uids.sort((a, b) => a - b).map((uid) => ({ uid, name: names[uid] || `U${uid}` })),
    };
}

function personalScoreFromStatus(tdoc: any, tsdoc: any) {
    if (!tsdoc) return { score: 0, solved: 0, submissions: 0, attended: false };
    const attended = !!tsdoc.attend || !!tsdoc.startAt || (tsdoc.journal || []).length > 0 || typeof tsdoc.score === 'number' || typeof tsdoc.accept === 'number';
    if (typeof tsdoc.score === 'number') {
        return {
            score: tsdoc.score,
            solved: Object.values(tsdoc.detail || {}).filter((i: any) => i?.status === STATUS.STATUS_ACCEPTED).length,
            submissions: (tsdoc.journal || []).length,
            attended,
        };
    }
    if (typeof tsdoc.accept === 'number') {
        return {
            score: tsdoc.accept * 100,
            solved: tsdoc.accept,
            submissions: (tsdoc.journal || []).length,
            attended,
        };
    }
    let score = 0;
    let solved = 0;
    for (const pid of tdoc.pids || Object.keys(tsdoc.detail || {})) {
        const detail = tsdoc.detail?.[pid];
        if (!detail) continue;
        if (typeof detail.score === 'number') score += detail.score;
        else if (detail.status === STATUS.STATUS_ACCEPTED) score += 100;
        if (detail.status === STATUS.STATUS_ACCEPTED) solved++;
    }
    return { score, solved, submissions: (tsdoc.journal || []).length, attended };
}

async function buildTeamRanking(domainId: string, tid: ObjectId, tdoc: any, groupNames: string[]) {
    const [teamDocs, tsdocs] = await Promise.all([
        collTeam.find({ domainId, tid }).sort({ teamName: 1, uid: 1 }).toArray() as Promise<TeamDoc[]>,
        ContestModel.getMultiStatus(domainId, { docId: tid })
            .project({ uid: 1, score: 1, accept: 1, detail: 1, journal: 1, attend: 1 })
            .toArray() as Promise<any[]>,
    ]);
    const scoreMap: Record<number, { score: number; solved: number; submissions: number; attended: boolean }> = {};
    for (const tsdoc of tsdocs) scoreMap[tsdoc.uid] = personalScoreFromStatus(tdoc, tsdoc);

    const rows: Record<string, any> = {};
    for (const name of groupNames || []) {
        if (!name) continue;
        rows[name] = {
            teamName: name,
            members: 0,
            assignedMembers: 0,
            totalScore: 0,
            solved: 0,
            submissions: 0,
            memberScores: [],
        };
    }
    for (const doc of teamDocs) {
        rows[doc.teamName] ||= {
            teamName: doc.teamName,
            members: 0,
            assignedMembers: 0,
            totalScore: 0,
            solved: 0,
            submissions: 0,
            memberScores: [],
        };
        rows[doc.teamName].assignedMembers++;
        const stat = scoreMap[doc.uid];
        if (!stat?.attended) continue;
        rows[doc.teamName].members++;
        rows[doc.teamName].totalScore += stat.score;
        rows[doc.teamName].solved += stat.solved;
        rows[doc.teamName].submissions += stat.submissions;
        rows[doc.teamName].memberScores.push(stat.score);
    }

    const list = Object.values(rows)
        .filter((row: any) => row.members > 0 || groupNames.includes(row.teamName))
        .map((row: any) => ({
            ...row,
            averageScore: row.members ? row.totalScore / row.members : 0,
            topScore: row.memberScores.length ? Math.max(...row.memberScores) : 0,
        }))
        .sort((a: any, b: any) => b.averageScore - a.averageScore || b.solved - a.solved || b.totalScore - a.totalScore || a.teamName.localeCompare(b.teamName));

    let rank = 0;
    let lastKey = '';
    return list.map((row: any, index) => {
        const key = `${row.averageScore}:${row.solved}:${row.totalScore}`;
        if (key !== lastKey) rank = index + 1;
        lastKey = key;
        return {
            ...row,
            rank,
            totalScoreText: Number.isInteger(row.totalScore) ? String(row.totalScore) : row.totalScore.toFixed(1),
            averageScoreText: Number.isInteger(row.averageScore) ? String(row.averageScore) : row.averageScore.toFixed(1),
            topScoreText: Number.isInteger(row.topScore) ? String(row.topScore) : row.topScore.toFixed(1),
        };
    });
}

async function targetUidsForTimeline(domainId: string, tid: ObjectId, canManage: boolean, selfUid: number, selectedUid = 0, selectedTeam = '') {
    if (!canManage) return [selfUid];
    if (selectedUid) return [selectedUid];
    if (selectedTeam) {
        const docs = await collTeam.find({ domainId, tid, teamName: selectedTeam }).project({ uid: 1 }).toArray() as TeamDoc[];
        return docs.map((i) => i.uid);
    }
    return [];
}

async function buildPostContestTimeline(domainId: string, tid: ObjectId, tdoc: any, targetUids: number[] = [], groupNames: string[] = []) {
    const query: any = {
        contest: tid,
        pid: { $in: tdoc.pids || [] },
        rejudged: { $ne: true },
    };
    if (targetUids.length) query.uid = { $in: targetUids };
    const records = await RecordModel.getMulti(domainId, query)
        .project({ _id: 1, uid: 1, pid: 1, judgeAt: 1, status: 1, score: 1, lang: 1 })
        .sort({ _id: 1 })
        .limit(800)
        .toArray() as any[];

    const uids = Array.from(new Set(records.map((i) => i.uid)));
    const [names, teams, goals, teamRows] = await Promise.all([
        userNameMap(domainId, uids),
        collTeam.find({ domainId, tid, uid: { $in: uids } }).toArray() as Promise<TeamDoc[]>,
        collGoal.find({ domainId, tid, uid: { $in: uids } }).toArray() as Promise<GoalDoc[]>,
        buildTeamRanking(domainId, tid, tdoc, groupNames),
    ]);
    const teamMap: Record<number, string> = {};
    for (const team of teams) teamMap[team.uid] = team.teamName;
    const goalMap: Record<number, GoalDoc> = {};
    for (const goal of goals) goalMap[goal.uid] = goal;

    const problemStats: Record<number, any> = {};
    for (const pid of tdoc.pids || []) {
        problemStats[pid] = {
            pid,
            label: problemLabel(tdoc, pid),
            submissions: 0,
            acUsers: new Set<number>(),
            firstAc: null,
        };
    }

    const userStats: Record<number, any> = {};
    const events: any[] = [];
    for (const rdoc of records) {
        const at = recordAt(rdoc);
        const isAc = rdoc.status === STATUS.STATUS_ACCEPTED;
        problemStats[rdoc.pid] ||= {
            pid: rdoc.pid,
            label: problemLabel(tdoc, rdoc.pid),
            submissions: 0,
            acUsers: new Set<number>(),
            firstAc: null,
        };
        problemStats[rdoc.pid].submissions++;
        if (isAc) {
            problemStats[rdoc.pid].acUsers.add(rdoc.uid);
            if (!problemStats[rdoc.pid].firstAc) problemStats[rdoc.pid].firstAc = { uid: rdoc.uid, at, minute: minutesFromBegin(tdoc, at) };
        }

        userStats[rdoc.uid] ||= {
            uid: rdoc.uid,
            uname: names[rdoc.uid] || `U${rdoc.uid}`,
            teamName: teamMap[rdoc.uid] || '',
            submissions: 0,
            solvedSet: new Set<number>(),
            failedBeforeAc: new Set<number>(),
            seenFail: new Set<number>(),
            firstMinute: minutesFromBegin(tdoc, at),
            lastMinute: minutesFromBegin(tdoc, at),
            goal: goalMap[rdoc.uid] || null,
        };
        const stat = userStats[rdoc.uid];
        stat.submissions++;
        stat.lastMinute = minutesFromBegin(tdoc, at);
        if (isAc) {
            if (stat.seenFail.has(rdoc.pid)) stat.failedBeforeAc.add(rdoc.pid);
            stat.solvedSet.add(rdoc.pid);
        } else if (rdoc.status !== STATUS.STATUS_WAITING) {
            stat.seenFail.add(rdoc.pid);
        }

        events.push({
            uid: rdoc.uid,
            uname: stat.uname,
            teamName: stat.teamName,
            pid: rdoc.pid,
            problemLabel: problemLabel(tdoc, rdoc.pid),
            status: rdoc.status,
            statusText: statusLabel(rdoc.status),
            score: rdoc.score || 0,
            lang: rdoc.lang || '',
            minute: minutesFromBegin(tdoc, at),
            at,
            isAc,
        });
    }

    const problemRows = Object.values(problemStats).map((row: any) => {
        const first = row.firstAc;
        return {
            pid: row.pid,
            label: row.label,
            submissions: row.submissions,
            acUsers: row.acUsers.size,
            firstAc: first ? {
                uid: first.uid,
                uname: names[first.uid] || `U${first.uid}`,
                teamName: teamMap[first.uid] || '',
                minute: first.minute,
            } : null,
        };
    });
    const userRows = Object.values(userStats).map((row: any) => ({
        uid: row.uid,
        uname: row.uname,
        teamName: row.teamName,
        submissions: row.submissions,
        solved: row.solvedSet.size,
        fixed: row.failedBeforeAc.size,
        firstMinute: row.firstMinute,
        lastMinute: row.lastMinute,
        targetSolve: row.goal?.targetSolve || 0,
        goalMet: row.goal?.targetSolve ? row.solvedSet.size >= row.goal.targetSolve : false,
    })).sort((a: any, b: any) => b.solved - a.solved || a.submissions - b.submissions);

    return {
        summary: {
            participants: userRows.length,
            submissions: records.length,
            acSubmissions: records.filter((i) => i.status === STATUS.STATUS_ACCEPTED).length,
            solvedProblems: problemRows.filter((i) => i.acUsers > 0).length,
            totalProblems: tdoc.pids?.length || 0,
            teams: teamRows.length,
        },
        problemRows,
        userRows,
        teamRows,
        events,
    };
}

class ContestFunSettingsHandler extends ContestDetailBaseHandler {
    async prepare() {
        if (!canManageContest(this)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
    }

    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: ObjectId) {
        const config = await getConfig(domainId, tid);
        const [ownerUdoc, classTeamSource] = await Promise.all([
            UserModel.getById(domainId, this.tdoc.owner),
            getClassTeamSource(domainId),
        ]);
        this.response.template = 'contest_fun_settings.html';
        this.response.body = {
            page_name: 'contest_fun_settings',
            tdoc: this.tdoc,
            tsdoc: this.tsdocAsPublic(),
            owner_udoc: ownerUdoc,
            config,
            groupNamesText: config.groupNames.join('\n'),
            assignmentsText: await exportAssignments(domainId, tid),
            classTeamSource,
            messages: [],
        };
    }

    @param('tid', Types.ObjectId)
    @param('enableGoal', Types.String, true)
    @param('enableTask', Types.String, true)
    @param('enableHighlight', Types.String, true)
    @param('enableTimeline', Types.String, true)
    @param('enableGroupMode', Types.String, true)
    @param('groupSelectOpen', Types.String, true)
    @param('useClassTeams', Types.String, true)
    @param('groupNames', Types.Content, true)
    @param('teamAssignments', Types.Content, true)
    async post(
        domainId: string, tid: ObjectId,
        enableGoal = '', enableTask = '', enableHighlight = '', enableTimeline = '', enableGroupMode = '', groupSelectOpen = '',
        useClassTeams = '', groupNames = '', teamAssignments = '',
    ) {
        const parsedGroups = parseGroupNames(groupNames);
        const classTeamSource = await getClassTeamSource(domainId);
        const applyClassTeams = isOn(useClassTeams) && classTeamSource.enabled;
        const assignmentText = applyClassTeams ? classTeamSource.assignmentsText : teamAssignments;
        const groupBase = applyClassTeams ? classTeamSource.groupNames : parsedGroups;
        const assignmentResult = await applyAssignments(domainId, tid, assignmentText);
        const finalGroups = uniqueTexts([...groupBase, ...assignmentResult.extraGroups]);
        const config: ContestFunConfig = {
            ...defaultConfig(domainId, tid),
            goalEnabled: isOn(enableGoal),
            taskEnabled: isOn(enableTask),
            highlightEnabled: isOn(enableHighlight),
            timelineEnabled: isOn(enableTimeline),
            groupModeEnabled: isOn(enableGroupMode),
            groupSelectOpen: isOn(groupSelectOpen),
            groupNames: finalGroups,
            updatedAt: new Date(),
        };
        await collConfig.updateOne({ _id: config._id }, { $set: config }, { upsert: true });
        const ownerUdoc = await UserModel.getById(domainId, this.tdoc.owner);
        this.response.template = 'contest_fun_settings.html';
        this.response.body = {
            page_name: 'contest_fun_settings',
            tdoc: this.tdoc,
            tsdoc: this.tsdocAsPublic(),
            owner_udoc: ownerUdoc,
            config,
            groupNamesText: finalGroups.join('\n'),
            assignmentsText: await exportAssignments(domainId, tid),
            classTeamSource,
            messages: [
                '设置已保存',
                ...(applyClassTeams ? [`已套用 ${classTeamSource.groupNames.length} 个班级小队`] : []),
                ...assignmentResult.messages,
            ],
        };
    }
}

class ContestFunGoalHandler extends ContestDetailBaseHandler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }

    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: ObjectId) {
        const config = await getConfig(domainId, tid);
        const [goal, team, ownerUdoc] = await Promise.all([
            getGoal(domainId, tid, this.user._id),
            getTeam(domainId, tid, this.user._id),
            UserModel.getById(domainId, this.tdoc.owner),
        ]);
        this.response.template = 'contest_fun_goal.html';
        this.response.body = {
            page_name: 'contest_fun_goal',
            tdoc: this.tdoc,
            tsdoc: this.tsdocAsPublic(),
            owner_udoc: ownerUdoc,
            config,
            goal,
            team,
            canSubmit: !!this.tsdoc?.attend,
            messages: [],
        };
    }

    @param('tid', Types.ObjectId)
    @param('targetSolve', Types.Int, true)
    @param('strategy', Types.Content, true)
    @param('worry', Types.Content, true)
    @param('teamName', Types.String, true)
    async post(domainId: string, tid: ObjectId, targetSolve = 0, strategy = '', worry = '', teamName = '') {
        const config = await getConfig(domainId, tid);
        if (!config.goalEnabled && !config.groupModeEnabled) throw new ValidationError('contest fun');
        if (!this.tsdoc?.attend) throw new ValidationError('contest attend');
        if (config.groupModeEnabled && config.groupSelectOpen && teamName) {
            if (!config.groupNames.includes(teamName)) throw new ValidationError('teamName');
            await setTeam(domainId, tid, this.user._id, teamName, 'self');
        }
        if (config.goalEnabled) {
            const now = new Date();
            const id = userScopedId(domainId, tid, this.user._id);
            await collGoal.updateOne(
                { _id: id },
                {
                    $set: {
                        _id: id,
                        domainId,
                        tid,
                        uid: this.user._id,
                        targetSolve: Math.max(0, Number(targetSolve) || 0),
                        strategy: String(strategy || '').trim(),
                        worry: String(worry || '').trim(),
                        updatedAt: now,
                    },
                    $setOnInsert: { createdAt: now },
                },
                { upsert: true },
            );
        }
        this.response.redirect = this.url('contest_fun_goal', { tid });
    }
}

class ContestFunHighlightsHandler extends ContestDetailBaseHandler {
    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: ObjectId) {
        const config = await getConfig(domainId, tid);
        const ownerUdoc = await UserModel.getById(domainId, this.tdoc.owner);
        const highlights = config.highlightEnabled || canManageContest(this)
            ? await buildHighlights(domainId, tid, this.tdoc, 60)
            : { firstSolves: [], events: [] };
        this.response.template = 'contest_fun_highlights.html';
        this.response.body = {
            page_name: 'contest_fun_highlights',
            tdoc: this.tdoc,
            tsdoc: this.tsdocAsPublic(),
            owner_udoc: ownerUdoc,
            config,
            highlights,
            canManage: canManageContest(this),
        };
    }
}

class ContestFunTimelineHandler extends ContestDetailBaseHandler {
    @param('tid', Types.ObjectId)
    @param('uid', Types.Int, true)
    @param('teamName', Types.String, true)
    async get(domainId: string, tid: ObjectId, uid = 0, teamName = '') {
        const config = await getConfig(domainId, tid);
        const canManage = canManageContest(this);
        const isDone = ContestModel.isDone(this.tdoc, this.tsdoc);
        const ownerUdoc = await UserModel.getById(domainId, this.tdoc.owner);
        const filters = await buildTimelineFilters(domainId, tid);
        const selectedUid = canManage ? Number(uid || 0) : this.user._id;
        const selectedTeam = canManage ? String(teamName || '').trim() : '';
        const targetUids = await targetUidsForTimeline(domainId, tid, canManage, this.user._id, selectedUid, selectedTeam);
        const visible = (config.timelineEnabled && isDone) || canManage;
        const timeline = visible
            ? await buildPostContestTimeline(domainId, tid, this.tdoc, targetUids, config.groupNames || [])
            : { summary: null, problemRows: [], userRows: [], teamRows: [], events: [] };
        this.response.template = 'contest_fun_timeline.html';
        this.response.body = {
            page_name: 'contest_fun_timeline',
            tdoc: this.tdoc,
            tsdoc: this.tsdocAsPublic(),
            owner_udoc: ownerUdoc,
            config,
            canManage,
            isDone,
            visible,
            filters,
            selectedUid,
            selectedTeam,
            timeline,
        };
    }
}

class ContestFunWidgetHandler extends ContestDetailBaseHandler {
    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: ObjectId) {
        const config = await getConfig(domainId, tid);
        const canManage = canManageContest(this);
        const enabled = anyFeatureEnabled(config);
        if (!enabled && !canManage) {
            this.response.body = { ok: true, enabled: false, showMenu: false };
            return;
        }
        const [goal, team] = this.user.hasPriv(PRIV.PRIV_USER_PROFILE)
            ? await Promise.all([getGoal(domainId, tid, this.user._id), getTeam(domainId, tid, this.user._id)])
            : [null, null];
        const task = (config.taskEnabled && this.user.hasPriv(PRIV.PRIV_USER_PROFILE))
            ? await buildTaskCard(domainId, tid, this.tdoc, this.tsdoc, this.user._id, goal)
            : null;
        const groupProgress = (config.groupModeEnabled && team?.teamName)
            ? await buildGroupProgress(domainId, tid, this.tdoc, team.teamName)
            : null;
        const highlights = config.highlightEnabled
            ? await buildHighlights(domainId, tid, this.tdoc, 5)
            : { firstSolves: [], events: [] };
        this.response.body = {
            ok: true,
            enabled,
            showMenu: enabled || canManage,
            canManage,
            goalEnabled: config.goalEnabled,
            taskEnabled: config.taskEnabled,
            highlightEnabled: config.highlightEnabled,
            timelineEnabled: config.timelineEnabled,
            groupModeEnabled: config.groupModeEnabled,
            groupSelectOpen: config.groupSelectOpen,
            teamName: team?.teamName || '',
            groupProgress,
            goal: goal ? {
                targetSolve: goal.targetSolve,
                strategy: goal.strategy,
                worry: goal.worry,
                updatedAt: goal.updatedAt,
            } : null,
            task,
            highlights: highlights.events.slice(0, 3),
            urls: {
                settings: this.url('contest_fun_settings', { tid }),
                goal: this.url('contest_fun_goal', { tid }),
                highlights: this.url('contest_fun_highlights', { tid }),
                timeline: this.url('contest_fun_timeline', { tid }),
            },
        };
    }
}

export async function apply(ctx: Context) {
    await ensurePluginIndexes(
        collConfig,
        { key: { domainId: 1, tid: 1 }, name: 'contest_fun_config', unique: true },
    );
    await ensurePluginIndexes(
        collGoal,
        { key: { domainId: 1, tid: 1, uid: 1 }, name: 'contest_fun_goal_user', unique: true },
    );
    await ensurePluginIndexes(
        collTeam,
        { key: { domainId: 1, tid: 1, uid: 1 }, name: 'contest_fun_team_user', unique: true },
        { key: { domainId: 1, tid: 1, teamName: 1 }, name: 'contest_fun_team_name' },
    );

    ctx.Route('contest_fun_settings', '/contest/:tid/fun/settings', ContestFunSettingsHandler, PERM.PERM_VIEW_CONTEST);
    ctx.Route('contest_fun_goal', '/contest/:tid/fun/goal', ContestFunGoalHandler, PERM.PERM_VIEW_CONTEST);
    ctx.Route('contest_fun_highlights', '/contest/:tid/fun/highlights', ContestFunHighlightsHandler, PERM.PERM_VIEW_CONTEST);
    ctx.Route('contest_fun_timeline', '/contest/:tid/fun/timeline', ContestFunTimelineHandler, PERM.PERM_VIEW_CONTEST);
    ctx.Route('contest_fun_widget', '/contest/:tid/fun/widget', ContestFunWidgetHandler, PERM.PERM_VIEW_CONTEST);

    ctx.on('contest/del', async (domainId: string, tid: ObjectId) => {
        await Promise.all([
            collConfig.deleteMany({ domainId, tid }),
            collGoal.deleteMany({ domainId, tid }),
            collTeam.deleteMany({ domainId, tid }),
        ]);
    });

    ctx.i18n.load('zh', {
        contest_fun_settings: '比赛互动设置',
        contest_fun_goal: '赛前目标卡',
        contest_fun_highlights: '首杀与高光',
        contest_fun_timeline: '赛后复盘时间线',
        '比赛互动设置': '比赛互动设置',
    });
    ctx.i18n.load('en', {
        contest_fun_settings: 'Contest Fun Settings',
        contest_fun_goal: 'Contest Goal',
        contest_fun_highlights: 'Highlights',
        contest_fun_timeline: 'Review Timeline',
    });
}
