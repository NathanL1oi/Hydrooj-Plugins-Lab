'use strict';

const HydroDefault = require('hydrooj');

let activeCourseModel = null;
let Hydro = HydroDefault;
let collSession = null;
const registeredContexts = new WeakSet();

const EXAM_RULES = {
  oi: {
    value: 'oi',
    label: 'OI',
    description: '按每题最高得分累计总分排名。',
  },
  ioi: {
    value: 'ioi',
    label: 'IOI',
    description: '支持部分分，按实时最高得分累计总分排名。',
  },
  acm: {
    value: 'acm',
    label: 'ACM/ICPC',
    description: '按解题数量与罚时排名，同题通过前错误提交每次罚时 20 分钟。',
  },
};

const EXAM_RULE_OPTIONS = Object.values(EXAM_RULES);

function idText(value) {
  return String(value && typeof value.toString === 'function' ? value.toString() : value);
}

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function uniq(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const item = Number(value);
    if (!Number.isInteger(item) || item <= 0 || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function parsePids(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[,，\s]+/);
  return uniq(raw.map((item) => String(item).trim().replace(/^P/i, '')));
}

function normalizeRule(value) {
  const rule = String(first(value) || 'oi').toLowerCase();
  return EXAM_RULES[rule] ? rule : 'oi';
}

function parseBool(value) {
  const text = String(first(value) || '').toLowerCase();
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(text);
}

function positiveNumber(value, fallback, min, max) {
  const n = Number(first(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function getDomainId(handler) {
  return handler.args?.domainId || handler.domain?._id || 'system';
}

function routeParam(handler, name, fallback) {
  return handler.args?.[name] || handler.request?.params?.[name] || fallback;
}

function toObjectId(value, field) {
  if (value?.toHexString) return value;
  if (!value) throw new Hydro.ValidationError(field);
  try {
    return new Hydro.ObjectId(String(value));
  } catch (err) {
    throw new Hydro.ValidationError(field);
  }
}

function resolveSubsecRoute(handler, args, cidArg, csidArg, ssidArg) {
  return {
    domainId: handler.args?.domainId || handler.request?.params?.domainId || args?.domainId || handler.domain?._id || 'system',
    cid: toObjectId(routeParam(handler, 'cid', cidArg), 'cid'),
    csid: toObjectId(routeParam(handler, 'csid', csidArg), 'csid'),
    ssid: toObjectId(routeParam(handler, 'ssid', ssidArg), 'ssid'),
  };
}

function isCourseModel(model) {
  return !!(
    model
    && typeof model.get === 'function'
    && typeof model.getSection === 'function'
    && typeof model.getSubSection === 'function'
    && typeof model.getStatus === 'function'
    && typeof model.editSubSection === 'function'
  );
}

function getCourseModel() {
  const candidates = [
    activeCourseModel,
    global.Hydro?.model?.course,
    Hydro?.model?.course,
  ];
  const model = candidates.find(isCourseModel);
  if (!model) {
    throw new Error('Course model is not ready. Please make sure course-atr is loaded before course-atr-exam-mode.');
  }
  activeCourseModel = model;
  return model;
}

function canManage(user) {
  return !!(
    user?.hasPerm?.(Hydro.PERM.PERM_EDIT_TRAINING)
    || user?.hasPerm?.(Hydro.PERM.PERM_EDIT_DOMAIN)
  );
}

function isHidden(doc) {
  return doc?.hidden === true || doc?.hidden === 1 || doc?.hidden === '1';
}

function sessionId(domainId, cid, csid, ssid, uid) {
  return [domainId, idText(cid), idText(csid), idText(ssid), uid].join(':');
}

function getSessionCollection() {
  if (!collSession) {
    if (!Hydro.db?.collection) throw new Error('Hydro db collection API is not ready.');
    collSession = Hydro.db.collection('course.exam.session');
  }
  return collSession;
}

function fmt(date) {
  if (!date) return '';
  if (Hydro.moment) return Hydro.moment(date).format('YYYY-MM-DD HH:mm:ss');
  return new Date(date).toLocaleString();
}

function fmtSeconds(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function decorateMethod(target, key, decorators) {
  let descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (!descriptor || typeof descriptor.value !== 'function') return false;
  for (let i = decorators.length - 1; i >= 0; i--) {
    descriptor = decorators[i](target, key, descriptor) || descriptor;
  }
  Object.defineProperty(target, key, descriptor);
  return true;
}

function normalizeExam(ssdoc) {
  const raw = ssdoc.exam || {};
  const rule = normalizeRule(raw.rule);
  const allPids = uniq(ssdoc.pids || []);
  const selected = uniq(raw.pids || []).filter((pid) => allPids.includes(pid));
  const pids = selected.length ? selected : allPids;
  const scorePerProblem = positiveNumber(raw.scorePerProblem, 100, 1, 1000);
  const maxScore = pids.length * scorePerProblem;
  return {
    enabled: raw.enabled === true || raw.enabled === 1 || raw.enabled === '1',
    title: String(raw.title || ssdoc.title || '小节考试'),
    content: String(raw.content || ''),
    rule,
    ruleLabel: EXAM_RULES[rule].label,
    ruleDescription: EXAM_RULES[rule].description,
    pids,
    allPids,
    duration: Math.floor(positiveNumber(raw.duration, 120, 1, 10080)),
    scorePerProblem,
    maxScore,
  };
}

function snapshotExam(exam) {
  return {
    enabled: exam.enabled,
    title: exam.title,
    content: exam.content,
    rule: exam.rule,
    ruleLabel: exam.ruleLabel,
    ruleDescription: exam.ruleDescription,
    pids: [...exam.pids],
    duration: exam.duration,
    scorePerProblem: exam.scorePerProblem,
    maxScore: exam.maxScore,
  };
}

function withSessionExam(exam, session) {
  if (!session?.exam) return exam;
  const pids = uniq(session.exam.pids || exam.pids);
  const scorePerProblem = positiveNumber(session.exam.scorePerProblem, exam.scorePerProblem, 1, 1000);
  const maxScore = pids.length * scorePerProblem;
  const rule = normalizeRule(session.exam.rule || exam.rule);
  const duration = Math.floor(positiveNumber(session.exam.duration, exam.duration, 1, 10080));
  return {
    ...exam,
    ...session.exam,
    rule,
    ruleLabel: EXAM_RULES[rule].label,
    ruleDescription: EXAM_RULES[rule].description,
    pids,
    duration,
    scorePerProblem,
    maxScore,
  };
}

async function requireDocs(domainId, cid, csid, ssid) {
  const courseModel = getCourseModel();
  cid = toObjectId(cid, 'cid');
  csid = toObjectId(csid, 'csid');
  ssid = toObjectId(ssid, 'ssid');
  const cdoc = await courseModel.get(domainId, cid);
  if (!cdoc) throw new Hydro.NotFoundError('Course not found.');
  const csdoc = await courseModel.getSection(domainId, csid);
  if (!csdoc || idText(csdoc.parentId) !== idText(cid)) throw new Hydro.NotFoundError('Section not found.');
  let sub;
  try {
    sub = await courseModel.getSubSection(domainId, csid, ssid);
  } catch (err) {
    throw new Hydro.NotFoundError('Subsection not found.');
  }
  const ssdoc = sub?.[1];
  if (!ssdoc) throw new Hydro.NotFoundError('Subsection not found.');
  return { cdoc, csdoc, ssdoc, courseModel };
}

async function checkLearnerAccess(handler, domainId, cdoc, csdoc, ssdoc) {
  if (canManage(handler.user)) return;
  if (isHidden(cdoc) || isHidden(csdoc) || isHidden(ssdoc)) {
    throw new Hydro.ForbiddenError('This course item is hidden.');
  }
  if (cdoc.assign?.length) {
    const groups = await Hydro.UserModel.listGroup(domainId, handler.user._id);
    const names = new Set((groups || []).map((item) => item.name));
    if (!cdoc.assign.some((name) => names.has(name))) throw new Hydro.NotAssignedError('course', cdoc.docId);
  }
  const cstdoc = await getCourseModel().getStatus(domainId, cdoc.docId, handler.user._id);
  if (!cstdoc?.enroll) throw new Hydro.ForbiddenError('You have not yet joined this course.');
}

function recordTimeQuery(startAt, endAt) {
  if (Hydro.Time?.getObjectID) {
    return { _id: { $gte: Hydro.Time.getObjectID(startAt), $lte: Hydro.Time.getObjectID(endAt) } };
  }
  return { createdAt: { $gte: startAt, $lte: endAt } };
}

function clampRawScore(value, status) {
  let rawScore = Number(value);
  if (!Number.isFinite(rawScore)) rawScore = status === Hydro.STATUS.STATUS_ACCEPTED ? 100 : 0;
  if (status === Hydro.STATUS.STATUS_ACCEPTED) rawScore = Math.max(rawScore, 100);
  return Math.max(0, Math.min(100, rawScore));
}

function recordTimestamp(row) {
  return row._id?.getTimestamp?.() || row.createdAt || row.judgeAt || row.time || null;
}

function minutesFrom(startAt, at) {
  if (!at) return 0;
  return Math.max(0, Math.floor((new Date(at).getTime() - new Date(startAt).getTime()) / 60000));
}

function isSessionEnded(session, now = new Date()) {
  if (!session) return false;
  if (session.finished) return true;
  if (!session.deadlineAt) return false;
  return now >= new Date(session.deadlineAt);
}

async function getActiveOiExamPids(domainId, uid) {
  if (!uid) return new Set();
  const rows = await getSessionCollection().find({
    domainId,
    uid: Number(uid),
    finished: false,
    deadlineAt: { $gt: new Date() },
    'exam.rule': 'oi',
  }).project({ pids: 1, exam: 1 }).toArray();
  const pids = new Set();
  for (const row of rows) {
    for (const pid of uniq(row.pids || row.exam?.pids || [])) pids.add(Number(pid));
  }
  return pids;
}

async function hasActiveOiExamForPid(handler, domainId, pid, uid = handler.user?._id) {
  if (!uid || canManage(handler.user)) return false;
  const row = await getSessionCollection().findOne({
    domainId,
    uid: Number(uid),
    pids: Number(pid),
    finished: false,
    deadlineAt: { $gt: new Date() },
    'exam.rule': 'oi',
  }, { projection: { _id: 1 } });
  return !!row;
}

function maskRecordForOiExam(rdoc) {
  const status = Hydro.STATUS.STATUS_JUDGING ?? Hydro.STATUS.STATUS_WAITING ?? rdoc.status;
  return {
    ...rdoc,
    status,
    score: undefined,
    time: 0,
    memory: 0,
    testCases: [],
    subtasks: {},
    compilerTexts: [],
    judgeTexts: [],
    code: '',
    files: {},
    progress: 0,
    courseExamOiHidden: true,
  };
}

async function fetchRecordRows(domainId, uid, pids, begin, end) {
  if (!pids.length || begin > end) return [];
  const match = {
    domainId,
    uid: Number(uid),
    pid: { $in: pids },
    ...recordTimeQuery(begin, end),
  };
  const ignored = [
    Hydro.RecordModel.RECORD_PRETEST,
    Hydro.RecordModel.RECORD_GENERATE,
  ].filter((item) => item !== undefined);
  if (ignored.length) match.contest = { $nin: ignored };
  return await Hydro.RecordModel.coll.find(match)
    .project({ _id: 1, pid: 1, score: 1, status: 1, createdAt: 1, judgeAt: 1, time: 1 })
    .sort({ _id: 1 })
    .toArray();
}

async function computeResult(domainId, uid, exam, startAt, endAt) {
  const now = new Date();
  const begin = startAt ? new Date(startAt) : now;
  const end = endAt ? new Date(endAt) : now;
  const pids = exam.pids || [];
  const rule = normalizeRule(exam.rule);
  const rows = await fetchRecordRows(domainId, uid, pids, begin, end);
  const best = {};
  const acmState = {};
  for (const row of rows) {
    const pid = Number(row.pid);
    if (!pids.includes(pid)) continue;
    const rawScore = clampRawScore(row.score, row.status);
    const accepted = row.status === Hydro.STATUS.STATUS_ACCEPTED || rawScore >= 100;
    const at = recordTimestamp(row);

    if (rule === 'acm') {
      const state = acmState[pid] || { wrong: 0, accepted: false };
      if (!state.accepted) {
        if (accepted) {
          state.accepted = true;
          state.rid = row._id;
          state.status = row.status;
          state.at = at;
          state.rawScore = 100;
          state.penalty = minutesFrom(begin, at) + state.wrong * 20;
          state.score = exam.scorePerProblem;
        } else {
          state.wrong += 1;
        }
      }
      acmState[pid] = state;
      continue;
    }

    const current = best[pid];
    if (!current || rawScore > current.rawScore || (rawScore === current.rawScore && idText(row._id) > idText(current.rid))) {
      best[pid] = {
        pid,
        rawScore,
        score: Math.round((rawScore * exam.scorePerProblem / 100) * 100) / 100,
        status: row.status,
        accepted,
        rid: row._id,
        at,
        penalty: accepted ? minutesFrom(begin, at) : 0,
      };
    }
  }
  let score = 0;
  let solved = 0;
  let penalty = 0;
  const details = {};
  for (const pid of pids) {
    const fallback = {
      pid,
      rawScore: 0,
      score: 0,
      status: null,
      accepted: false,
      rid: null,
      at: null,
      penalty: 0,
      wrong: acmState[pid]?.wrong || 0,
    };
    const item = rule === 'acm'
      ? (acmState[pid]?.accepted ? { pid, ...acmState[pid], accepted: true } : fallback)
      : (best[pid] || fallback);
    score += Number(item.score) || 0;
    if (item.accepted) {
      solved++;
      penalty += Number(item.penalty) || 0;
    }
    details[pid] = item;
  }
  score = Math.round(score * 100) / 100;
  return {
    rule,
    ruleLabel: EXAM_RULES[rule].label,
    score,
    maxScore: exam.maxScore,
    solved,
    total: pids.length,
    penalty,
    details,
  };
}

async function getProblemItems(domainId, user, exam, result) {
  const canView = user.hasPerm(Hydro.PERM.PERM_VIEW_PROBLEM_HIDDEN) || user._id;
  const pdict = exam.pids.length ? await Hydro.ProblemModel.getList(domainId, exam.pids, canView, true) : {};
  return exam.pids.map((pid, index) => ({
    index: index + 1,
    pid,
    pdoc: pdict[pid] || pdict[String(pid)] || { _id: pid, docId: pid, pid: `P${pid}`, hidden: true, title: '*' },
    best: result?.details?.[pid] || result?.details?.[String(pid)] || null,
  }));
}

function scoreboardCompare(rule, a, b) {
  if (a.resultHidden && !b.resultHidden) return 1;
  if (!a.resultHidden && b.resultHidden) return -1;
  if (a.resultHidden && b.resultHidden) return idText(a.startedAt || '').localeCompare(idText(b.startedAt || ''));
  const ar = a.result || {};
  const br = b.result || {};
  if (rule === 'acm') {
    if ((br.solved || 0) !== (ar.solved || 0)) return (br.solved || 0) - (ar.solved || 0);
    if ((ar.penalty || 0) !== (br.penalty || 0)) return (ar.penalty || 0) - (br.penalty || 0);
    return idText(a.startedAt || '').localeCompare(idText(b.startedAt || ''));
  }
  if ((br.score || 0) !== (ar.score || 0)) return (br.score || 0) - (ar.score || 0);
  if ((br.solved || 0) !== (ar.solved || 0)) return (br.solved || 0) - (ar.solved || 0);
  return idText(a.endedAt || a.updatedAt || '').localeCompare(idText(b.endedAt || b.updatedAt || ''));
}

function sameRank(rule, a, b) {
  if (a.resultHidden || b.resultHidden) return false;
  const ar = a.result || {};
  const br = b.result || {};
  if (rule === 'acm') return (ar.solved || 0) === (br.solved || 0) && (ar.penalty || 0) === (br.penalty || 0);
  return (ar.score || 0) === (br.score || 0) && (ar.solved || 0) === (br.solved || 0);
}

async function buildScoreboardRows(domainId, cid, csid, ssid, exam, revealAll = false) {
  const rows = await getSessionCollection().find({
    domainId,
    courseId: idText(cid),
    sectionId: idText(csid),
    subsecId: idText(ssid),
  }).sort({ updatedAt: -1 }).limit(1000).toArray();
  const now = new Date();
  const enriched = [];
  for (const row of rows) {
    const activeExam = withSessionExam(exam, row);
    const deadline = row.deadlineAt ? new Date(row.deadlineAt) : null;
    const deadlinePassed = !!(deadline && now > deadline);
    const resultHidden = !revealAll && !row.finished && !deadlinePassed;
    let result = row.result;
    if (row.startedAt && !resultHidden && (!row.finished || !result)) {
      const endAt = deadline && now > deadline ? deadline : now;
      result = await computeResult(domainId, row.uid, activeExam, row.startedAt, endAt);
    }
    enriched.push({
      ...row,
      exam: activeExam,
      result: resultHidden ? null : result,
      resultHidden,
      startedAtText: fmt(row.startedAt),
      deadlineAtText: fmt(row.deadlineAt),
      endedAtText: fmt(row.endedAt),
    });
  }
  const rule = normalizeRule(exam.rule);
  enriched.sort((a, b) => scoreboardCompare(rule, a, b));
  let last = null;
  let rank = 0;
  enriched.forEach((row, index) => {
    if (!last || !sameRank(rule, row, last)) rank = index + 1;
    row.rank = rank;
    last = row;
  });
  return enriched;
}

async function loadSession(domainId, cid, csid, ssid, uid) {
  return await getSessionCollection().findOne({ _id: sessionId(domainId, cid, csid, ssid, uid) });
}

async function startSession(handler, domainId, cid, csid, ssid, exam, restart = false) {
  const now = new Date();
  const prev = await loadSession(domainId, cid, csid, ssid, handler.user._id);
  if (prev && !prev.endedAt && !restart) return prev;
  const deadlineAt = exam.duration ? new Date(now.getTime() + exam.duration * 60000) : null;
  const doc = {
    _id: sessionId(domainId, cid, csid, ssid, handler.user._id),
    domainId,
    courseId: idText(cid),
    sectionId: idText(csid),
    subsecId: idText(ssid),
    uid: handler.user._id,
    pids: exam.pids,
    exam: snapshotExam(exam),
    startedAt: now,
    deadlineAt,
    endedAt: null,
    finished: false,
    expired: false,
    attemptNo: (Number(prev?.attemptNo) || 0) + 1,
    result: null,
    updatedAt: now,
  };
  await getSessionCollection().updateOne({ _id: doc._id }, { $set: doc, $setOnInsert: { createdAt: now } }, { upsert: true });
  await Hydro.OplogModel.log(handler, restart ? 'course.exam.restart' : 'course.exam.start', {
    cid, csid, ssid, uid: handler.user._id, pids: exam.pids,
  });
  return doc;
}

async function finishSession(handler, domainId, cid, csid, ssid, exam, expired = false) {
  const session = await loadSession(domainId, cid, csid, ssid, handler.user._id);
  if (!session) throw new Hydro.ValidationError('exam', null, 'Please start the exam first.');
  const activeExam = withSessionExam(exam, session);
  const now = new Date();
  const deadline = session.deadlineAt ? new Date(session.deadlineAt) : null;
  const endAt = expired && deadline ? deadline : (deadline && now > deadline ? deadline : now);
  const result = await computeResult(domainId, handler.user._id, activeExam, session.startedAt, endAt);
  const patch = {
    endedAt: endAt,
    finished: true,
    expired: !!(deadline && now > deadline) || expired,
    result,
    updatedAt: now,
  };
  await getSessionCollection().updateOne({ _id: session._id }, { $set: patch });
  await Hydro.OplogModel.log(handler, 'course.exam.finish', {
    cid, csid, ssid, uid: handler.user._id, result,
  });
  return { ...session, ...patch };
}

class CourseExamHandler extends Hydro.Handler {
  async get(args, cidArg, csidArg, ssidArg) {
    this.checkPriv(Hydro.PRIV.PRIV_USER_PROFILE);
    const { domainId, cid, csid, ssid } = resolveSubsecRoute(this, args, cidArg, csidArg, ssidArg);
    const docs = await requireDocs(domainId, cid, csid, ssid);
    const exam = normalizeExam(docs.ssdoc);
    if (!exam.enabled && !canManage(this.user)) throw new Hydro.NotFoundError('Exam not enabled.');
    await checkLearnerAccess(this, domainId, docs.cdoc, docs.csdoc, docs.ssdoc);

    let session = await loadSession(domainId, cid, csid, ssid, this.user._id);
    let activeExam = withSessionExam(exam, session);
    if (session && !session.finished && session.deadlineAt && new Date() > new Date(session.deadlineAt)) {
      session = await finishSession(this, domainId, cid, csid, ssid, activeExam, true);
      activeExam = withSessionExam(exam, session);
    }

    const hideLiveResult = activeExam.rule === 'oi' && session?.startedAt && !session?.finished;
    let result = hideLiveResult ? null : (session?.result || null);
    if (session?.startedAt && !session?.finished && !hideLiveResult) {
      const endAt = session.deadlineAt && new Date() > new Date(session.deadlineAt)
        ? new Date(session.deadlineAt)
        : new Date();
      result = await computeResult(domainId, this.user._id, activeExam, session.startedAt, endAt);
    }
    const pitems = await getProblemItems(domainId, this.user, activeExam, result);
    const remainingSeconds = session?.deadlineAt && !session?.finished
      ? Math.max(0, Math.floor((new Date(session.deadlineAt).getTime() - Date.now()) / 1000))
      : 0;
    const manager = canManage(this.user);
    const scoreboardAvailable = manager || isSessionEnded(session);
    this.response.template = 'course_subsec_exam.html';
    this.response.body = {
      page_name: 'course_subsec_exam',
      ...docs,
      exam: activeExam,
      session,
      result,
      hideLiveResult,
      pitems,
      canManage: manager,
      scoreboardAvailable,
      remainingSeconds,
      remainingText: fmtSeconds(remainingSeconds),
      startedAtText: fmt(session?.startedAt),
      deadlineAtText: fmt(session?.deadlineAt),
      endedAtText: fmt(session?.endedAt),
    };
  }

  async postStart(args, cidArg, csidArg, ssidArg) {
    this.checkPriv(Hydro.PRIV.PRIV_USER_PROFILE);
    const { domainId, cid, csid, ssid } = resolveSubsecRoute(this, args, cidArg, csidArg, ssidArg);
    const docs = await requireDocs(domainId, cid, csid, ssid);
    const exam = normalizeExam(docs.ssdoc);
    if (!exam.enabled && !canManage(this.user)) throw new Hydro.NotFoundError('Exam not enabled.');
    await checkLearnerAccess(this, domainId, docs.cdoc, docs.csdoc, docs.ssdoc);
    await startSession(this, domainId, cid, csid, ssid, exam, false);
    this.response.redirect = this.url('course_subsec_exam', { cid, csid, ssid });
  }

  async postRestart(args, cidArg, csidArg, ssidArg) {
    this.checkPriv(Hydro.PRIV.PRIV_USER_PROFILE);
    const { domainId, cid, csid, ssid } = resolveSubsecRoute(this, args, cidArg, csidArg, ssidArg);
    const docs = await requireDocs(domainId, cid, csid, ssid);
    const exam = normalizeExam(docs.ssdoc);
    if (!exam.enabled && !canManage(this.user)) throw new Hydro.NotFoundError('Exam not enabled.');
    await checkLearnerAccess(this, domainId, docs.cdoc, docs.csdoc, docs.ssdoc);
    await startSession(this, domainId, cid, csid, ssid, exam, true);
    this.response.redirect = this.url('course_subsec_exam', { cid, csid, ssid });
  }

  async postFinish(args, cidArg, csidArg, ssidArg) {
    throw new Hydro.ForbiddenError('比赛会在考试时长结束后自动结束。');
  }
}

class CourseExamEditHandler extends Hydro.Handler {
  async get(args, cidArg, csidArg, ssidArg) {
    this.checkPerm(Hydro.PERM.PERM_EDIT_TRAINING || Hydro.PERM.PERM_EDIT_DOMAIN);
    const { domainId, cid, csid, ssid } = resolveSubsecRoute(this, args, cidArg, csidArg, ssidArg);
    const docs = await requireDocs(domainId, cid, csid, ssid);
    const exam = normalizeExam(docs.ssdoc);
    const canView = this.user.hasPerm(Hydro.PERM.PERM_VIEW_PROBLEM_HIDDEN) || this.user._id;
    const pdict = exam.allPids.length ? await Hydro.ProblemModel.getList(domainId, exam.allPids, canView, true) : {};
    this.response.template = 'course_subsec_exam_edit.html';
    this.response.body = { page_name: 'course_subsec_exam_edit', ...docs, exam, pdict, ruleOptions: EXAM_RULE_OPTIONS };
  }

  async post(args, cidArg, csidArg, ssidArg) {
    this.checkPerm(Hydro.PERM.PERM_EDIT_TRAINING || Hydro.PERM.PERM_EDIT_DOMAIN);
    const { domainId, cid, csid, ssid } = resolveSubsecRoute(this, args, cidArg, csidArg, ssidArg);
    const docs = await requireDocs(domainId, cid, csid, ssid);
    const body = this.request.body || {};
    const allPids = uniq(docs.ssdoc.pids || []);
    const selected = parsePids(body.pids).filter((pid) => allPids.includes(pid));
    if (parseBool(body.enabled) && !selected.length) {
      throw new Hydro.ValidationError('pids', null, 'Please choose at least one problem.');
    }
    const scorePerProblem = positiveNumber(body.scorePerProblem, 100, 1, 1000);
    const maxScore = selected.length * scorePerProblem;
    const exam = {
      enabled: parseBool(body.enabled),
      title: String(first(body.title) || docs.ssdoc.title || '小节考试').trim(),
      content: String(first(body.content) || ''),
      rule: normalizeRule(body.rule),
      pids: selected,
      duration: Math.floor(positiveNumber(body.duration, 120, 1, 10080)),
      scorePerProblem,
    };
    await docs.courseModel.editSubSection(domainId, csid, ssid, { exam });
    await Hydro.OplogModel.log(this, 'course.exam.edit', { cid, csid, ssid, exam });
    this.response.redirect = this.url('course_subsec_exam', { cid, csid, ssid });
  }
}

class CourseExamResultsHandler extends Hydro.Handler {
  async get(args, cidArg, csidArg, ssidArg) {
    this.checkPerm(Hydro.PERM.PERM_EDIT_TRAINING || Hydro.PERM.PERM_EDIT_DOMAIN);
    const { domainId, cid, csid, ssid } = resolveSubsecRoute(this, args, cidArg, csidArg, ssidArg);
    const docs = await requireDocs(domainId, cid, csid, ssid);
    const exam = normalizeExam(docs.ssdoc);
    const rows = await getSessionCollection().find({
      domainId,
      courseId: idText(cid),
      sectionId: idText(csid),
      subsecId: idText(ssid),
    }).sort({ updatedAt: -1 }).limit(500).toArray();
    const uids = rows.map((row) => row.uid).filter(Boolean);
    const udict = await Hydro.UserModel.getListForRender(domainId, uids, this.user.hasPerm(Hydro.PERM.PERM_VIEW_DISPLAYNAME));
    this.response.template = 'course_subsec_exam_results.html';
    this.response.body = {
      page_name: 'course_subsec_exam_results',
      ...docs,
      exam,
      rows: rows.map((row) => ({
        ...row,
        startedAtText: fmt(row.startedAt),
        deadlineAtText: fmt(row.deadlineAt),
        endedAtText: fmt(row.endedAt),
      })),
      udict,
    };
  }
}

class CourseExamScoreboardHandler extends Hydro.Handler {
  async get(args, cidArg, csidArg, ssidArg) {
    this.checkPriv(Hydro.PRIV.PRIV_USER_PROFILE);
    const { domainId, cid, csid, ssid } = resolveSubsecRoute(this, args, cidArg, csidArg, ssidArg);
    const docs = await requireDocs(domainId, cid, csid, ssid);
    const exam = normalizeExam(docs.ssdoc);
    if (!exam.enabled && !canManage(this.user)) throw new Hydro.NotFoundError('Exam not enabled.');
    await checkLearnerAccess(this, domainId, docs.cdoc, docs.csdoc, docs.ssdoc);
    const manager = canManage(this.user);
    if (!manager) {
      let session = await loadSession(domainId, cid, csid, ssid, this.user._id);
      if (!session) throw new Hydro.ForbiddenError('请先参赛，比赛排名将在考试时长结束后开放。');
      if (!isSessionEnded(session)) throw new Hydro.ForbiddenError('比赛排名将在考试时长结束后开放。');
      if (!session.finished) session = await finishSession(this, domainId, cid, csid, ssid, exam, true);
    }
    const rows = await buildScoreboardRows(domainId, cid, csid, ssid, exam, manager);
    const uids = Array.from(new Set(rows.map((row) => row.uid).filter(Boolean)));
    const udict = await Hydro.UserModel.getListForRender(domainId, uids, this.user.hasPerm(Hydro.PERM.PERM_VIEW_DISPLAYNAME));
    this.response.template = 'course_subsec_exam_scoreboard.html';
    this.response.body = {
      page_name: 'course_subsec_exam_scoreboard',
      ...docs,
      exam,
      rows,
      udict,
      canManage: manager,
    };
  }
}

function bindParams(handler, methods) {
  for (const method of methods) {
    decorateMethod(handler.prototype, method, [
      Hydro.param('cid', Hydro.Types.ObjectId),
      Hydro.param('csid', Hydro.Types.ObjectId),
      Hydro.param('ssid', Hydro.Types.ObjectId),
    ]);
  }
}

class CourseExamPingHandler extends Hydro.Handler {
  async get() {
    this.response.body = {
      ok: true,
      plugin: 'hydrooj-course-atr-exam-mode',
      routeNames: [
        'course_subsec_exam',
        'course_subsec_exam_edit',
        'course_subsec_exam_results',
        'course_subsec_exam_scoreboard',
      ],
    };
  }
}

function exposeExamEntry(handler) {
  const body = handler.response?.body;
  if (!body?.cdoc || !body?.csdoc || !body?.ssdoc) return;
  const args = handler.args || handler.request?.params || {};
  const cid = args.cid || body.cdoc.docId || body.cdoc._id;
  const csid = args.csid || body.csdoc.docId || body.csdoc._id;
  const ssid = args.ssid || body.ssdoc._id;
  if (!cid || !csid || !ssid) return;

  const exam = normalizeExam(body.ssdoc);
  const canEdit = canManage(handler.user);
  if (!exam.enabled && !canEdit) return;

  let baseUrl = `/course/${cid}/s/${csid}/${ssid}`;
  try {
    baseUrl = handler.url('course_subsec_detail', { cid, csid, ssid });
  } catch (err) {
    // Fallback keeps the menu usable even if another addon changes URL helpers.
  }

  handler.UiContext ||= {};
  handler.UiContext.courseSubsecExamMode = {
    enabled: exam.enabled,
    canEdit,
    baseUrl,
  };
}

async function hideProblemScoreDuringOiExam(handler) {
  const body = handler.response?.body;
  const pdoc = body?.pdoc;
  if (!pdoc || body?.tdoc || canManage(handler.user)) return;
  if (!await hasActiveOiExamForPid(handler, getDomainId(handler), pdoc.docId)) return;
  body.rdoc = null;
  if (body.psdoc) {
    body.psdoc = {
      ...body.psdoc,
      rid: null,
      status: null,
      score: undefined,
    };
  }
  handler.UiContext ||= {};
  handler.UiContext.courseExamOiHidden = true;
  handler.UiContext.canViewRecord = false;
}

async function maskRecordListDuringOiExam(handler) {
  const body = handler.response?.body;
  if (!body?.rdocs?.length || canManage(handler.user)) return;
  const pids = await getActiveOiExamPids(getDomainId(handler), handler.user?._id);
  if (!pids.size) return;
  body.rdocs = body.rdocs.map((rdoc) => (
    rdoc.uid === handler.user._id && pids.has(Number(rdoc.pid))
      ? maskRecordForOiExam(rdoc)
      : rdoc
  ));
}

async function isHiddenOiRecord(handler, rdoc) {
  if (!rdoc || rdoc.uid !== handler.user?._id) return false;
  return await hasActiveOiExamForPid(handler, rdoc.domainId || getDomainId(handler), rdoc.pid, rdoc.uid);
}

async function blockRecordDownloadDuringOiExam(handler) {
  const download = String(handler.request?.query?.download || '').toLowerCase();
  if (!['1', 'true', 'yes', 'on'].includes(download)) return;
  if (await isHiddenOiRecord(handler, handler.rdoc)) {
    throw new Hydro.ForbiddenError('OI 赛制考试期间不能查看提交详情，比赛结束后开放。');
  }
}

async function hideRecordDetailDuringOiExam(handler) {
  const rdoc = handler.rdoc || handler.response?.body?.rdoc;
  if (!await isHiddenOiRecord(handler, rdoc)) return;
  handler.response.redirect = undefined;
  handler.response.type = undefined;
  handler.response.disposition = undefined;
  handler.response.template = 'course_subsec_exam_record_hidden.html';
  handler.response.body = {
    page_name: 'record_detail',
    rdoc: maskRecordForOiExam(rdoc),
    pdoc: handler.response?.body?.pdoc,
  };
}

function installRecordConnectionMask(ctx) {
  ctx.withHandlerClass('RecordMainConnectionHandler', (RecordMainConnectionHandler) => {
    const proto = RecordMainConnectionHandler.prototype;
    if (proto.__courseExamOiMaskInstalled) return;
    proto.__courseExamOiMaskInstalled = true;
    const original = proto.onRecordChange;
    proto.onRecordChange = async function onRecordChange(rdoc, ...rest) {
      if (rdoc?.uid === this.user?._id && await hasActiveOiExamForPid(this, rdoc.domainId || getDomainId(this), rdoc.pid, rdoc.uid)) {
        rdoc = maskRecordForOiExam(rdoc);
      }
      return await original.call(this, rdoc, ...rest);
    };
  });

  ctx.withHandlerClass('RecordDetailConnectionHandler', (RecordDetailConnectionHandler) => {
    const proto = RecordDetailConnectionHandler.prototype;
    if (proto.__courseExamOiMaskInstalled) return;
    proto.__courseExamOiMaskInstalled = true;
    const original = proto.sendUpdate;
    proto.sendUpdate = async function sendUpdate(rdoc) {
      if (rdoc?.uid === this.user?._id && await hasActiveOiExamForPid(this, rdoc.domainId || getDomainId(this), rdoc.pid, rdoc.uid)) {
        rdoc = maskRecordForOiExam(rdoc);
      }
      return await original.call(this, rdoc);
    };
  });
}

async function apply(ctx, CourseModel, hydro = HydroDefault) {
  if (registeredContexts.has(ctx)) return;
  registeredContexts.add(ctx);
  Hydro = hydro;
  activeCourseModel = isCourseModel(CourseModel) ? CourseModel : null;

  ctx.Route('course_exam_mode_ping', '/course-exam-mode/ping', CourseExamPingHandler, Hydro.PRIV.PRIV_USER_PROFILE);
  ctx.Route('course_subsec_exam', '/course/:cid/s/:csid/:ssid/exam', CourseExamHandler, Hydro.PRIV.PRIV_USER_PROFILE);
  ctx.Route('course_subsec_exam_edit', '/course/:cid/s/:csid/:ssid/exam/edit', CourseExamEditHandler, Hydro.PERM.PERM_EDIT_TRAINING || Hydro.PERM.PERM_EDIT_DOMAIN);
  ctx.Route('course_subsec_exam_results', '/course/:cid/s/:csid/:ssid/exam/results', CourseExamResultsHandler, Hydro.PERM.PERM_EDIT_TRAINING || Hydro.PERM.PERM_EDIT_DOMAIN);
  ctx.Route('course_subsec_exam_scoreboard', '/course/:cid/s/:csid/:ssid/exam/scoreboard', CourseExamScoreboardHandler, Hydro.PRIV.PRIV_USER_PROFILE);

  try {
    bindParams(CourseExamHandler, ['get', 'postStart', 'postRestart', 'postFinish']);
    bindParams(CourseExamEditHandler, ['get', 'post']);
    bindParams(CourseExamResultsHandler, ['get']);
    bindParams(CourseExamScoreboardHandler, ['get']);
  } catch (err) {
    console.error('[course-atr-exam-mode] route param binding failed:', err);
  }

  ctx.on('handler/after/W#get', exposeExamEntry);
  ctx.on('handler/after/CourseSubSectionDetail#get', exposeExamEntry);
  ctx.on('handler/after/CourseSubSectionDetailHandler#get', exposeExamEntry);
  ctx.on('handler/after/ProblemDetail#get', hideProblemScoreDuringOiExam);
  ctx.on('handler/after/RecordList#get', maskRecordListDuringOiExam);
  ctx.on('handler/before/RecordDetail#get', blockRecordDownloadDuringOiExam);
  ctx.on('handler/after/RecordDetail#get', hideRecordDetailDuringOiExam);
  installRecordConnectionMask(ctx);
  ctx.i18n.load('zh', {
    course_subsec_exam: '小节考试',
    course_subsec_exam_edit: '考试设置',
    course_subsec_exam_results: '考试记录',
    course_subsec_exam_scoreboard: '比赛排名',
  });
  ctx.i18n.load('en', {
    course_subsec_exam: 'Subsection Exam',
    course_subsec_exam_edit: 'Exam Settings',
    course_subsec_exam_results: 'Exam Attempts',
    course_subsec_exam_scoreboard: 'Exam Scoreboard',
  });

  try {
    const indexResult = getSessionCollection().createIndex?.({ domainId: 1, courseId: 1, sectionId: 1, subsecId: 1, uid: 1 });
    if (indexResult && typeof indexResult.catch === 'function') {
      indexResult.catch((err) => console.error('[course-atr] exam session index failed:', err));
    }
  } catch (err) {
    console.error('[course-atr] exam session index failed:', err);
  }
}

exports.apply = apply;
