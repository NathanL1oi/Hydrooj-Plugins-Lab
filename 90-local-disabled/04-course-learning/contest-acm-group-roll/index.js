'use strict';

const {
  ContestModel,
  ForbiddenError,
  ObjectId,
  PERM,
  ProblemModel,
  RecordModel,
  STATUS,
  UserModel,
  ValidationError,
  db,
} = require('hydrooj');
const { ContestDetailBaseHandler } = require('hydrooj/src/handler/contest');

const PLUGIN_ID = 'contest-acm-group-roll';
const DEFAULT_FREEZE_MINUTES = 60;
const DEFAULT_PENALTY_MINUTES = 20;
const TEAM_SOURCE_CONTEST_FUN = 'contestFun';
const TEAM_SOURCE_CLASS_TEAM = 'classTeam';
const TEAM_SOURCE_DOMAIN_GROUP = 'domainGroup';
const TEAM_SOURCE_MANUAL = 'manual';
const TEAM_SOURCES = new Set([
  TEAM_SOURCE_CONTEST_FUN,
  TEAM_SOURCE_CLASS_TEAM,
  TEAM_SOURCE_DOMAIN_GROUP,
  TEAM_SOURCE_MANUAL,
]);
const ACM_LIKE_RULES = new Set(['acm', 'xcpc']);

const collConfig = db.collection('domain.contestAcmGroup.config');
const collManualTeam = db.collection('domain.contestAcmGroup.team');
const collContestFunTeam = db.collection('domain.contestFun.team');
const collGroup = db.collection('user.group');
const collManagedStudent = db.collection('domain.studentAccount');

function idText(value) {
  return value?.toHexString?.() || value?.toString?.() || String(value);
}

function configId(domainId, tid) {
  return `${domainId}:${idText(tid)}`;
}

function userScopedId(domainId, tid, uid) {
  return `${domainId}:${idText(tid)}:${uid}`;
}

function tidFrom(handler) {
  const raw = handler.args?.tid || handler.request?.params?.tid;
  if (raw?.toHexString) return raw;
  const text = String(raw || '').trim();
  if (!ObjectId.isValid(text)) throw new ValidationError('tid');
  return new ObjectId(text);
}

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function contestEndAt(tdoc) {
  const begin = asDate(tdoc?.beginAt);
  if (tdoc?.duration && begin) return new Date(begin.getTime() + Number(tdoc.duration) * 3600000);
  return asDate(tdoc?.endAt) || begin || new Date();
}

function contestBeginAt(tdoc) {
  return asDate(tdoc?.beginAt) || new Date();
}

function contestDone(tdoc, tsdoc) {
  try {
    return ContestModel.isDone(tdoc, tsdoc);
  } catch {
    const endAt = contestEndAt(tdoc);
    return endAt.getTime() <= Date.now();
  }
}

function canManageContest(handler, tdoc = handler.tdoc) {
  return handler.user?.own?.(tdoc)
    || handler.user?.hasPerm?.(PERM.PERM_EDIT_CONTEST)
    || handler.user?.hasPerm?.(PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD);
}

function isXcpcRule(tdoc) {
  if (!tdoc?.rule) return false;
  const ruleId = String(tdoc.rule).toLowerCase();
  if (ACM_LIKE_RULES.has(ruleId)) return true;
  const text = String(ContestModel.RULES?.[tdoc.rule]?.TEXT || '').toLowerCase();
  return text === 'xcpc' || text === 'acm';
}

function isOn(value) {
  return value === true || value === 'true' || value === '1' || value === 'on';
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function normalizeSource(value) {
  const source = String(value || TEAM_SOURCE_CONTEST_FUN).trim();
  return TEAM_SOURCES.has(source) ? source : TEAM_SOURCE_CONTEST_FUN;
}

function defaultConfig(domainId, tid) {
  return {
    _id: configId(domainId, tid),
    domainId,
    tid,
    enabled: false,
    teamSource: TEAM_SOURCE_CONTEST_FUN,
    freezeMinutes: DEFAULT_FREEZE_MINUTES,
    penaltyMinutes: DEFAULT_PENALTY_MINUTES,
    showBeforeFreeze: true,
    showHiddenAttempts: true,
    updatedAt: new Date(),
    updatedBy: 0,
  };
}

function normalizeConfig(domainId, tid, raw = null) {
  const base = defaultConfig(domainId, tid);
  return {
    ...base,
    ...raw,
    _id: base._id,
    domainId,
    tid,
    enabled: !!raw?.enabled,
    teamSource: normalizeSource(raw?.teamSource),
    freezeMinutes: clampInt(raw?.freezeMinutes, DEFAULT_FREEZE_MINUTES, 0, 10080),
    penaltyMinutes: clampInt(raw?.penaltyMinutes, DEFAULT_PENALTY_MINUTES, 0, 240),
    showBeforeFreeze: true,
    showHiddenAttempts: raw?.showHiddenAttempts !== false,
  };
}

async function getConfig(domainId, tid) {
  const doc = await collConfig.findOne({ _id: configId(domainId, tid) });
  return normalizeConfig(domainId, tid, doc);
}

function uniqueTexts(values) {
  const seen = new Set();
  const result = [];
  for (const raw of values || []) {
    const value = String(raw || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function splitUserTokens(text) {
  return String(text || '').split(/[,，、;\s]+/).map((item) => item.trim()).filter(Boolean);
}

async function resolveUser(domainId, raw) {
  const token = String(raw || '').trim();
  if (!token) return null;
  try {
    if (/^\d+$/.test(token)) return await UserModel.getById(domainId, Number(token));
  } catch {}
  try {
    if (token.includes('@') && UserModel.getByEmail) return await UserModel.getByEmail(domainId, token);
  } catch {}
  try {
    if (UserModel.getByUname) return await UserModel.getByUname(domainId, token);
  } catch {}
  try {
    if (UserModel.getByUname) return await UserModel.getByUname('system', token);
  } catch {}
  return null;
}

async function applyManualAssignments(domainId, tid, text) {
  await collManualTeam.deleteMany({ domainId, tid });
  const messages = [];
  const teamNames = [];
  for (const [index, rawLine] of String(text || '').split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const pos = line.search(/[:：]/);
    if (pos < 0) {
      messages.push(`第 ${index + 1} 行缺少冒号，已跳过`);
      continue;
    }
    const teamName = line.slice(0, pos).trim();
    const tokens = splitUserTokens(line.slice(pos + 1));
    if (!teamName) {
      messages.push(`第 ${index + 1} 行缺少小组名，已跳过`);
      continue;
    }
    teamNames.push(teamName);
    for (const token of tokens) {
      const udoc = await resolveUser(domainId, token);
      if (!udoc?._id || udoc._id <= 1) {
        messages.push(`${teamName}: 未找到用户 ${token}`);
        continue;
      }
      await collManualTeam.updateOne(
        { _id: userScopedId(domainId, tid, udoc._id) },
        {
          $set: {
            _id: userScopedId(domainId, tid, udoc._id),
            domainId,
            tid,
            uid: udoc._id,
            teamName,
            updatedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true },
      );
    }
  }
  return { teamNames: uniqueTexts(teamNames), messages };
}

async function exportManualAssignments(domainId, tid) {
  const docs = await collManualTeam.find({ domainId, tid }).sort({ teamName: 1, uid: 1 }).toArray();
  const byTeam = {};
  for (const doc of docs) {
    byTeam[doc.teamName] ||= [];
    byTeam[doc.teamName].push(doc.uid);
  }
  return Object.entries(byTeam).map(([team, uids]) => `${team}: ${uids.join(', ')}`).join('\n');
}

async function teamSourcePreview(domainId, tid) {
  const [contestFunTeams, manualTeams, domainGroups] = await Promise.all([
    collContestFunTeam.distinct('teamName', { domainId, tid }),
    collManualTeam.distinct('teamName', { domainId, tid }),
    collGroup.find({ domainId }).project({ name: 1, uids: 1 }).toArray(),
  ]);
  const classModel = global.Hydro?.model?.classTeam;
  let classTeams = [];
  if (classModel?.list) {
    try {
      classTeams = await classModel.list(domainId);
    } catch {
      classTeams = [];
    }
  }
  return {
    contestFun: uniqueTexts(contestFunTeams).length,
    manual: uniqueTexts(manualTeams).length,
    domainGroup: domainGroups.length,
    classTeam: Array.isArray(classTeams) ? classTeams.length : 0,
  };
}

function normalizeTeamDocs(items, source) {
  const teams = new Map();
  for (const item of items || []) {
    const teamName = String(item.teamName || item.name || '').trim();
    if (!teamName) continue;
    const members = Array.isArray(item.members)
      ? item.members
      : Array.isArray(item.uids)
        ? item.uids
        : item.uid
          ? [item.uid]
          : [];
    if (!teams.has(teamName)) teams.set(teamName, { teamName, source, uids: [] });
    const team = teams.get(teamName);
    for (const rawUid of members) {
      const uid = Number(rawUid);
      if (Number.isFinite(uid) && uid > 1 && !team.uids.includes(uid)) team.uids.push(uid);
    }
  }
  return Array.from(teams.values())
    .filter((team) => team.uids.length)
    .sort((a, b) => compareTeamName(a.teamName, b.teamName));
}

async function loadTeams(domainId, tid, config) {
  if (config.teamSource === TEAM_SOURCE_CLASS_TEAM) {
    const model = global.Hydro?.model?.classTeam;
    if (!model?.list) return [];
    return normalizeTeamDocs(await model.list(domainId), TEAM_SOURCE_CLASS_TEAM);
  }
  if (config.teamSource === TEAM_SOURCE_DOMAIN_GROUP) {
    const groups = await collGroup.find({ domainId }).project({ name: 1, uids: 1 }).toArray();
    return normalizeTeamDocs(groups, TEAM_SOURCE_DOMAIN_GROUP);
  }
  if (config.teamSource === TEAM_SOURCE_MANUAL) {
    const docs = await collManualTeam.find({ domainId, tid }).project({ teamName: 1, uid: 1 }).toArray();
    return normalizeTeamDocs(docs, TEAM_SOURCE_MANUAL);
  }
  const docs = await collContestFunTeam.find({ domainId, tid }).project({ teamName: 1, uid: 1 }).toArray();
  return normalizeTeamDocs(docs, TEAM_SOURCE_CONTEST_FUN);
}

async function userNameMap(domainId, uids) {
  const unique = Array.from(new Set((uids || []).map(Number).filter((uid) => uid > 1)));
  if (!unique.length) return {};
  const [udict, managed] = await Promise.all([
    UserModel.getListForRender(domainId, unique, ['displayName']).catch(() => UserModel.getList(domainId, unique)),
    collManagedStudent.find({ domainId, uid: { $in: unique } }).project({ uid: 1, name: 1, studentId: 1 }).toArray().catch(() => []),
  ]);
  const managedMap = new Map();
  for (const item of managed || []) managedMap.set(Number(item.uid), item);
  const result = {};
  for (const uid of unique) {
    const item = managedMap.get(uid);
    const udoc = udict?.[uid];
    result[uid] = item?.name
      ? `${item.name}${item.studentId ? ` (${item.studentId})` : ''}`
      : (udoc?.displayName || udoc?.uname || `U${uid}`);
  }
  return result;
}

function alphabetic(index) {
  let n = index + 1;
  let result = '';
  while (n > 0) {
    n -= 1;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result || '?';
}

function problemLabel(tdoc, pid) {
  const index = (tdoc.pids || []).map(Number).indexOf(Number(pid));
  return index >= 0 ? alphabetic(index) : `P${pid}`;
}

function recordAt(rdoc) {
  return rdoc._id?.getTimestamp?.() || asDate(rdoc.createdAt) || asDate(rdoc.judgeAt) || new Date();
}

function minutesFromBegin(beginAt, at) {
  return Math.max(0, Math.floor((at.getTime() - beginAt.getTime()) / 60000));
}

function formatMinutes(minutes) {
  const value = Math.max(0, Math.floor(Number(minutes) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

function isPenaltyStatus(status) {
  return ![
    STATUS.STATUS_ACCEPTED,
    STATUS.STATUS_WAITING,
    STATUS.STATUS_FETCHED,
    STATUS.STATUS_COMPILING,
    STATUS.STATUS_JUDGING,
    STATUS.STATUS_CANCELED,
    STATUS.STATUS_IGNORED,
  ].includes(status);
}

async function loadRecords(domainId, tid, tdoc, uids, endAt) {
  if (!uids.length || !(tdoc.pids || []).length) return [];
  const query = {
    contest: tid,
    uid: { $in: uids },
    pid: { $in: (tdoc.pids || []).map(Number) },
    rejudged: { $ne: true },
  };
  const records = await RecordModel.getMulti(domainId, query)
    .project({ _id: 1, uid: 1, pid: 1, judgeAt: 1, createdAt: 1, status: 1, score: 1, lang: 1 })
    .sort({ _id: 1 })
    .limit(20000)
    .toArray();
  const beginAt = contestBeginAt(tdoc);
  const beginMs = beginAt.getTime();
  const endMs = endAt.getTime();
  return records
    .map((rdoc) => ({ ...rdoc, at: recordAt(rdoc) }))
    .filter((rdoc) => {
      const ms = rdoc.at.getTime();
      return ms >= beginMs && ms <= endMs;
    })
    .sort((a, b) => a.at.getTime() - b.at.getTime() || idText(a._id).localeCompare(idText(b._id)));
}

function compareTeamName(a, b) {
  return String(a || '').localeCompare(String(b || ''), 'zh-Hans-CN', {
    numeric: true,
    sensitivity: 'base',
  });
}

function compareRows(a, b) {
  if (b.solved !== a.solved) return b.solved - a.solved;
  if (a.penalty !== b.penalty) return a.penalty - b.penalty;
  if (a.lastAcceptedMinute !== b.lastAcceptedMinute) return a.lastAcceptedMinute - b.lastAcceptedMinute;
  return compareTeamName(a.teamName, b.teamName);
}

function sameRank(a, b) {
  return a.solved === b.solved && a.penalty === b.penalty;
}

function visibleCutoff(tdoc, config, manager, forceFull, now = new Date()) {
  const endAt = contestEndAt(tdoc);
  const beginAt = contestBeginAt(tdoc);
  const freezeAt = new Date(endAt.getTime() - config.freezeMinutes * 60000);
  const done = contestDone(tdoc);
  if (manager && forceFull) return { mode: 'full', cutoff: endAt, beginAt, freezeAt, endAt, done, frozen: false };
  if (done) return { mode: 'final', cutoff: endAt, beginAt, freezeAt, endAt, done, frozen: false };
  if (config.freezeMinutes > 0 && now >= freezeAt) {
    return { mode: 'frozen', cutoff: freezeAt, beginAt, freezeAt, endAt, done, frozen: true };
  }
  return { mode: 'live', cutoff: now < endAt ? now : endAt, beginAt, freezeAt, endAt, done, frozen: false };
}

function buildBoardFromRecords(tdoc, teams, records, cutoff, config) {
  const pids = (tdoc.pids || []).map(Number);
  const uidToTeam = new Map();
  const rows = teams.map((team) => {
    const row = {
      rank: 0,
      teamName: team.teamName,
      source: team.source,
      uids: team.uids,
      memberText: '',
      solved: 0,
      penalty: 0,
      submissions: 0,
      hiddenSubmissions: 0,
      lastAcceptedMinute: 0,
      problems: {},
      revealIndex: 0,
      revealSolved: 0,
      revealPenalty: 0,
    };
    for (const pid of pids) {
      row.problems[pid] = {
        pid,
        label: problemLabel(tdoc, pid),
        solved: false,
        wrong: 0,
        minute: 0,
        penalty: 0,
        attempts: 0,
        hidden: 0,
        firstUid: 0,
        rid: null,
        display: '-',
      };
    }
    for (const uid of team.uids) uidToTeam.set(Number(uid), row);
    return row;
  });

  const cutoffMs = cutoff.getTime();
  for (const rdoc of records) {
    const row = uidToTeam.get(Number(rdoc.uid));
    if (!row || !row.problems[Number(rdoc.pid)]) continue;
    const cell = row.problems[Number(rdoc.pid)];
    const atMs = rdoc.at.getTime();
    if (atMs > cutoffMs) {
      row.hiddenSubmissions++;
      cell.hidden++;
      continue;
    }
    row.submissions++;
    if (cell.solved) continue;
    cell.attempts++;
    if (rdoc.status === STATUS.STATUS_ACCEPTED) {
      cell.solved = true;
      cell.minute = minutesFromBegin(contestBeginAt(tdoc), rdoc.at);
      cell.penalty = cell.minute + cell.wrong * config.penaltyMinutes;
      cell.firstUid = Number(rdoc.uid);
      cell.rid = rdoc._id;
      row.solved++;
      row.penalty += cell.penalty;
      row.lastAcceptedMinute = Math.max(row.lastAcceptedMinute, cell.minute);
    } else if (isPenaltyStatus(rdoc.status)) {
      cell.wrong++;
    }
  }

  for (const row of rows) {
    for (const pid of pids) {
      const cell = row.problems[pid];
      if (cell.solved) cell.display = `+${cell.wrong ? cell.wrong : ''}`;
      else if (cell.wrong) cell.display = `-${cell.wrong}`;
      else cell.display = '-';
    }
  }

  rows.sort(compareRows);
  let rank = 0;
  for (let i = 0; i < rows.length; i++) {
    if (i === 0 || !sameRank(rows[i], rows[i - 1])) rank = i + 1;
    rows[i].rank = rank;
  }
  return rows;
}

function buildRevealPlan(finalRows, frozenRows) {
  const frozenByTeam = new Map(frozenRows.map((row) => [row.teamName, row]));
  const order = [...finalRows].sort((a, b) => {
    const fa = frozenByTeam.get(a.teamName) || {};
    const fb = frozenByTeam.get(b.teamName) || {};
    if ((fa.rank || 999999) !== (fb.rank || 999999)) return (fb.rank || 999999) - (fa.rank || 999999);
    return a.rank - b.rank;
  });
  return order.map((row, index) => ({
    teamName: row.teamName,
    memberText: row.memberText,
    fromRank: frozenByTeam.get(row.teamName)?.rank || '-',
    toRank: row.rank,
    fromSolved: frozenByTeam.get(row.teamName)?.solved || 0,
    fromPenalty: frozenByTeam.get(row.teamName)?.penalty || 0,
    solved: row.solved,
    penalty: row.penalty,
    deltaSolved: row.solved - (frozenByTeam.get(row.teamName)?.solved || 0),
    deltaPenalty: row.penalty - (frozenByTeam.get(row.teamName)?.penalty || 0),
    revealIndex: index + 1,
  }));
}

function buildNativeScoreboard(context) {
  const pdict = { ...(context.pdict || {}) };
  const columns = [
    { type: 'rank', value: '#' },
    { type: 'user', value: '用户' },
    { type: 'solved', value: '解决\n总耗时' },
  ];
  for (const problem of context.pids) {
    const pdoc = {
      ...(pdict[problem.pid] || pdict[String(problem.pid)] || {}),
      title: problem.title,
      nAccept: 0,
      nSubmit: 0,
    };
    pdict[problem.pid] = pdoc;
    pdict[String(problem.pid)] = pdoc;
    columns.push({ type: 'problem', value: problem.label, raw: problem.pid });
  }

  const rows = [columns];
  for (const [index, row] of context.rows.entries()) {
    const nativeRow = [
      { type: 'rank', value: String(row.rank) },
      { type: 'group_user', value: row.teamName, raw: 900000000 + index, memberText: row.memberText },
      {
        type: 'time',
        value: `${row.solved || 0}\n${formatMinutes(row.penalty || 0)}`,
        hover: `${row.solved || 0} 题，罚时 ${row.penalty || 0} 分钟`,
      },
    ];
    for (const problem of context.pids) {
      const cell = row.problems[problem.pid] || {};
      const pdoc = pdict[problem.pid];
      if (cell.solved || cell.wrong || cell.hidden) pdoc.nSubmit++;
      if (cell.solved) pdoc.nAccept++;
      let value = '';
      if (cell.solved) value = `${cell.wrong ? `+${cell.wrong}` : '<span class="icon icon-check"></span>'}\n${formatMinutes(cell.minute || 0)}`;
      else if (cell.wrong) value = `-${cell.wrong}`;
      if (context.config.showHiddenAttempts && context.cutoff.frozen && cell.hidden) {
        value += `${value ? ' ' : ''}<span style="color:orange">+${cell.hidden}</span>`;
      }
      nativeRow.push({
        type: 'record',
        score: cell.solved ? 100 : 0,
        value,
        hover: cell.solved ? `通过于 ${formatMinutes(cell.minute || 0)}` : '',
        raw: cell.rid,
        style: cell.solved ? 'background-color: rgb(217, 240, 199);' : undefined,
      });
    }
    rows.push(nativeRow);
  }
  return { rows, pdict };
}

async function buildBoardContext(handler, options = {}) {
  const domainId = handler.args?.domainId || handler.domain?._id || 'system';
  const tid = tidFrom(handler);
  const tdoc = handler.tdoc || await ContestModel.get(domainId, tid);
  if (!tdoc) throw new ValidationError('tid');
  const config = await getConfig(domainId, tid);
  const manager = canManageContest(handler, tdoc);
  if (!config.enabled && !manager && !options.allowDisabled) throw new ForbiddenError('本场比赛尚未开启 XCPC 小组榜。');
  const teams = await loadTeams(domainId, tid, config);
  const allUids = Array.from(new Set(teams.flatMap((team) => team.uids)));
  const cutoff = visibleCutoff(tdoc, config, manager, !!options.forceFull);
  const finalEndAt = contestEndAt(tdoc);
  const records = await loadRecords(domainId, tid, tdoc, allUids, finalEndAt);
  const visibleRows = buildBoardFromRecords(tdoc, teams, records, cutoff.cutoff, config);
  const finalRows = buildBoardFromRecords(tdoc, teams, records, finalEndAt, config);
  const frozenRows = buildBoardFromRecords(tdoc, teams, records, cutoff.freezeAt, config);
  const uidsForNames = Array.from(new Set(teams.flatMap((team) => team.uids)));
  const names = await userNameMap(domainId, uidsForNames);
  for (const row of [...visibleRows, ...finalRows, ...frozenRows]) {
    row.memberText = row.uids.map((uid) => names[uid] || `U${uid}`).join('、');
  }
  const pdict = tdoc.pids?.length
    ? await ProblemModel.getList(domainId, tdoc.pids, true, true).catch(() => ({}))
    : {};
  const pids = (tdoc.pids || []).map((pid, index) => ({
    pid: Number(pid),
    label: alphabetic(index),
    title: pdict[pid]?.title || pdict[String(pid)]?.title || `P${pid}`,
  }));
  return {
    domainId,
    tid,
    tdoc,
    config,
    manager,
    teams,
    pids,
    pdict,
    rows: visibleRows,
    finalRows,
    frozenRows,
    revealPlan: buildRevealPlan(finalRows, frozenRows),
    cutoff,
    officialBoard: !!options.officialBoard,
    stats: {
      teamCount: teams.length,
      memberCount: allUids.length,
      submissionCount: records.length,
      hiddenSubmissionCount: visibleRows.reduce((sum, row) => sum + row.hiddenSubmissions, 0),
    },
  };
}

async function renderGroupBoardOnHandler(handler, options = {}) {
  const context = await buildBoardContext(handler, options);
  const native = buildNativeScoreboard(context);
  handler.response.template = 'contest_acm_group_scoreboard.html';
  handler.response.body = {
    page_name: 'contest_scoreboard',
    tdoc: context.tdoc,
    tsdoc: handler.tsdocAsPublic ? handler.tsdocAsPublic() : handler.tsdoc,
    owner_udoc: await UserModel.getById(context.domainId, context.tdoc.owner),
    scoreboardRows: native.rows,
    scoreboardPdict: native.pdict,
    availableViews: handler.ctx?.scoreboard?.getAvailableViews?.(context.tdoc.rule) || {},
    ...context,
  };
}

async function shouldUseGroupBoardForOfficialScoreboard(handler, tdoc) {
  if (!isXcpcRule(tdoc)) return false;
  return true;
}

function wrapScoreboardView(view) {
  if (!view || view.__contestAcmGroupRollWrapped) return;
  if (view.id && view.id !== 'default') return;
  const originalDisplay = view.display;
  if (typeof originalDisplay !== 'function') return;
  view.display = async function contestAcmGroupDisplay(args) {
    const tdoc = args?.tdoc || this.tdoc;
    if (await shouldUseGroupBoardForOfficialScoreboard(this, tdoc)) {
      await renderGroupBoardOnHandler(this, { forceFull: false, allowDisabled: true, officialBoard: true });
      return;
    }
    return originalDisplay.call(this, args);
  };
  view.__contestAcmGroupRollWrapped = true;
}

function guardScoreboardService(scoreboard) {
  if (!scoreboard || scoreboard.__contestAcmGroupRollGuarded) return;
  for (const view of Object.values(scoreboard.views || {})) wrapScoreboardView(view);
  const originalAddView = scoreboard.addView.bind(scoreboard);
  scoreboard.addView = function contestAcmGroupAddView(id, name, args, options) {
    if (id !== 'default' || typeof options?.display !== 'function') {
      return originalAddView(id, name, args, options);
    }
    return originalAddView(id, name, args, {
      ...options,
      display: async function contestAcmGroupDefaultDisplay(displayArgs) {
        const tdoc = displayArgs?.tdoc || this.tdoc;
        if (await shouldUseGroupBoardForOfficialScoreboard(this, tdoc)) {
          await renderGroupBoardOnHandler(this, { forceFull: false, allowDisabled: true, officialBoard: true });
          return;
        }
        return options.display.call(this, displayArgs);
      },
    });
  };
  scoreboard.__contestAcmGroupRollGuarded = true;
}

function installOfficialScoreboardHandlerOverride(ctx) {
  if (typeof ctx.withHandlerClass !== 'function') return;
  ctx.withHandlerClass('ContestScoreboardHandler', (ContestScoreboardHandler) => {
    const proto = ContestScoreboardHandler.prototype;
    if (proto.__contestAcmGroupRollOfficialOverride) return;
    const originalGet = proto.get;
    if (typeof originalGet !== 'function') return;
    proto.__contestAcmGroupRollOfficialOverride = true;
    proto.get = async function contestAcmGroupOfficialScoreboardGet(domainId, tid, viewId = 'default', ...rest) {
      const requestedView = String(viewId || this.args?.view || this.request?.params?.view || 'default');
      if (requestedView === 'default') {
        const tdoc = this.tdoc || await ContestModel.get(domainId || this.args?.domainId || this.domain?._id || 'system', tid || tidFrom(this));
        if (await shouldUseGroupBoardForOfficialScoreboard(this, tdoc)) {
          await renderGroupBoardOnHandler(this, { forceFull: false, allowDisabled: true, officialBoard: true });
          return;
        }
      }
      return originalGet.call(this, domainId, tid, viewId, ...rest);
    };
  });
}

class ContestAcmGroupSettingsHandler extends ContestDetailBaseHandler {
  async prepare() {
    if (!canManageContest(this)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
  }

  async get() {
    const domainId = this.args?.domainId || this.domain?._id || 'system';
    const tid = tidFrom(this);
    const [config, ownerUdoc, sourcePreview] = await Promise.all([
      getConfig(domainId, tid),
      UserModel.getById(domainId, this.tdoc.owner),
      teamSourcePreview(domainId, tid),
    ]);
    this.response.template = 'contest_acm_group_settings.html';
    this.response.body = {
      page_name: 'contest_acm_group_settings',
      tdoc: this.tdoc,
      tsdoc: this.tsdocAsPublic ? this.tsdocAsPublic() : this.tsdoc,
      owner_udoc: ownerUdoc,
      config,
      sourcePreview,
      manualAssignmentsText: await exportManualAssignments(domainId, tid),
      messages: [],
    };
  }

  async post() {
    const domainId = this.args?.domainId || this.domain?._id || 'system';
    const tid = tidFrom(this);
    const body = this.request.body || {};
    const teamSource = normalizeSource(body.teamSource);
    const manualResult = teamSource === TEAM_SOURCE_MANUAL
      ? await applyManualAssignments(domainId, tid, body.manualAssignments || '')
      : { messages: [] };
    const config = normalizeConfig(domainId, tid, {
      ...(await getConfig(domainId, tid)),
      enabled: isOn(body.enabled),
      teamSource,
      freezeMinutes: clampInt(body.freezeMinutes, DEFAULT_FREEZE_MINUTES, 0, 10080),
      penaltyMinutes: clampInt(body.penaltyMinutes, DEFAULT_PENALTY_MINUTES, 0, 240),
      showBeforeFreeze: true,
      showHiddenAttempts: isOn(body.showHiddenAttempts),
      updatedAt: new Date(),
      updatedBy: this.user._id,
    });
    await collConfig.updateOne({ _id: config._id }, { $set: config, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
    const [ownerUdoc, sourcePreview] = await Promise.all([
      UserModel.getById(domainId, this.tdoc.owner),
      teamSourcePreview(domainId, tid),
    ]);
    this.response.template = 'contest_acm_group_settings.html';
    this.response.body = {
      page_name: 'contest_acm_group_settings',
      tdoc: this.tdoc,
      tsdoc: this.tsdocAsPublic ? this.tsdocAsPublic() : this.tsdoc,
      owner_udoc: ownerUdoc,
      config,
      sourcePreview,
      manualAssignmentsText: await exportManualAssignments(domainId, tid),
      messages: ['设置已保存', ...manualResult.messages],
    };
  }
}

class ContestAcmGroupScoreboardHandler extends ContestDetailBaseHandler {
  async get() {
    const context = await buildBoardContext(this, { forceFull: this.request.query?.full === '1' });
    if (!context.config.enabled && !context.manager) throw new ForbiddenError('本场比赛尚未开启 XCPC 小组榜。');
    this.response.template = 'contest_acm_group_scoreboard.html';
    const native = buildNativeScoreboard(context);
    this.response.body = {
      page_name: 'contest_scoreboard',
      tdoc: context.tdoc,
      tsdoc: this.tsdocAsPublic ? this.tsdocAsPublic() : this.tsdoc,
      owner_udoc: await UserModel.getById(context.domainId, context.tdoc.owner),
      scoreboardRows: native.rows,
      scoreboardPdict: native.pdict,
      availableViews: this.ctx?.scoreboard?.getAvailableViews?.(context.tdoc.rule) || {},
      ...context,
    };
  }
}

class ContestAcmGroupRollHandler extends ContestDetailBaseHandler {
  async get() {
    const context = await buildBoardContext(this, { forceFull: true });
    if (!context.manager && !contestDone(context.tdoc, this.tsdoc)) {
      throw new ForbiddenError('比赛结束后才能查看滚榜。');
    }
    this.UiContext ||= {};
    this.UiContext.acmGroupRoll = {
      revealPlan: context.revealPlan,
      rows: context.finalRows.map((row) => ({
        rank: row.rank,
        teamName: row.teamName,
        solved: row.solved,
        penalty: row.penalty,
        memberText: row.memberText,
      })),
    };
    this.response.template = 'contest_acm_group_roll.html';
    this.response.body = {
      page_name: 'contest_acm_group_roll',
      tdoc: context.tdoc,
      tsdoc: this.tsdocAsPublic ? this.tsdocAsPublic() : this.tsdoc,
      owner_udoc: await UserModel.getById(context.domainId, context.tdoc.owner),
      ...context,
    };
  }
}

class ContestAcmGroupWidgetHandler extends ContestDetailBaseHandler {
  async get() {
    const domainId = this.args?.domainId || this.domain?._id || 'system';
    const tid = tidFrom(this);
    const config = await getConfig(domainId, tid);
    const manager = canManageContest(this);
    this.response.body = {
      ok: true,
      enabled: config.enabled || manager,
      configEnabled: config.enabled,
      canManage: manager,
      isDone: contestDone(this.tdoc, this.tsdoc),
      urls: {
        board: this.url('contest_acm_group_scoreboard', { tid }),
        roll: this.url('contest_acm_group_roll', { tid }),
        settings: this.url('contest_acm_group_settings', { tid }),
      },
    };
  }
}

function sidebarArgs(handler) {
  return { tid: idText(handler.args?.tid || handler.tdoc?.docId || handler.tdoc?._id || '') };
}

async function apply(ctx) {
  await db.ensureIndexes(
    collConfig,
    { key: { domainId: 1, tid: 1 }, name: 'contest_acm_group_config_tid' },
  ).catch(() => null);
  await db.ensureIndexes(
    collManualTeam,
    { key: { domainId: 1, tid: 1, uid: 1 }, name: 'contest_acm_group_team_uid', unique: true },
    { key: { domainId: 1, tid: 1, teamName: 1 }, name: 'contest_acm_group_team_name' },
  ).catch(() => null);

  ctx.Route('contest_acm_group_settings', '/contest/:tid/acm-group/settings', ContestAcmGroupSettingsHandler, PERM.PERM_VIEW_CONTEST);
  ctx.Route('contest_acm_group_scoreboard', '/contest/:tid/acm-group', ContestAcmGroupScoreboardHandler, PERM.PERM_VIEW_CONTEST);
  ctx.Route('contest_acm_group_roll', '/contest/:tid/acm-group/roll', ContestAcmGroupRollHandler, PERM.PERM_VIEW_CONTEST);
  ctx.Route('contest_acm_group_widget', '/contest/:tid/acm-group/widget', ContestAcmGroupWidgetHandler, PERM.PERM_VIEW_CONTEST);

  await ctx.inject(['scoreboard'], ({ scoreboard }) => {
    guardScoreboardService(scoreboard);
  });
  installOfficialScoreboardHandlerOverride(ctx);

  ctx.injectUI('ContestDetail', 'contest_acm_group_scoreboard', (handler) => ({
    icon: 'statistics',
    displayName: 'XCPC 小组榜',
    args: sidebarArgs(handler),
  }), (handler) => isXcpcRule(handler.tdoc));
  ctx.injectUI('ContestDetail', 'contest_acm_group_roll', (handler) => ({
    icon: 'flag',
    displayName: 'XCPC 滚榜',
    args: sidebarArgs(handler),
  }), (handler) => isXcpcRule(handler.tdoc) && contestDone(handler.tdoc, handler.tsdoc));
  ctx.injectUI('ContestDetail', 'contest_acm_group_settings', (handler) => ({
    icon: 'settings',
    displayName: 'XCPC 榜设置',
    args: sidebarArgs(handler),
  }), (handler) => isXcpcRule(handler.tdoc) && canManageContest(handler));

  ctx.i18n.load('zh', {
    contest_acm_group_settings: 'XCPC 小组榜设置',
    contest_acm_group_scoreboard: 'XCPC 小组榜',
    contest_acm_group_roll: 'XCPC 滚榜',
  });
  ctx.i18n.load('en', {
    contest_acm_group_settings: 'XCPC Group Board Settings',
    contest_acm_group_scoreboard: 'XCPC Group Board',
    contest_acm_group_roll: 'XCPC Rolling Board',
  });

  global.Hydro ||= {};
  global.Hydro.model ||= {};
  global.Hydro.model.contestAcmGroupRoll = {
    PLUGIN_ID,
    getConfig,
    loadTeams,
    buildBoardContext,
    isXcpcRule,
  };
}

module.exports = { apply };
