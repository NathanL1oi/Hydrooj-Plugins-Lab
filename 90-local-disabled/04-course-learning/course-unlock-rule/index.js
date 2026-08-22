'use strict';

const {
  db,
  ForbiddenError,
  Handler,
  NotFoundError,
  ObjectId,
  PERM,
  PRIV,
  ProblemModel,
  STATUS,
  ValidationError,
} = require('hydrooj');

const coll = db.collection('course.unlockRule');
const EDIT_COURSE = PERM.PERM_EDIT_TRAINING || PERM.PERM_EDIT_DOMAIN;
const VIEW_COURSE = PERM.PERM_VIEW_TRAINING || PRIV.PRIV_USER_PROFILE;
const ACCEPTED = STATUS.STATUS_ACCEPTED === undefined ? 1 : STATUS.STATUS_ACCEPTED;

function getDomainId(handler) {
  return handler.args?.domainId || handler.domain?._id || 'system';
}

function idText(value) {
  return value?.toHexString?.() || String(value || '');
}

function toObjectId(value) {
  if (value?.toHexString) return value;
  try {
    return new ObjectId(String(value));
  } catch (err) {
    throw new ValidationError('cid');
  }
}

function configId(domainId, cid) {
  return `${domainId}:${idText(cid)}`;
}

function getCourseModel() {
  const model = global.Hydro?.model?.course;
  if (!model) throw new ForbiddenError('请先安装并启用 Hydro 课程插件。');
  return model;
}

function canManageCourse(handler) {
  return handler.user?.hasPerm?.(EDIT_COURSE) || handler.user?.hasPerm?.(PERM.PERM_EDIT_DOMAIN);
}

function checkViewCourse(handler) {
  if (PERM.PERM_VIEW_TRAINING) handler.checkPerm(PERM.PERM_VIEW_TRAINING);
  else handler.checkPriv(PRIV.PRIV_USER_PROFILE);
}

function normalizePids(pids) {
  return Array.from(new Set((pids || []).map(Number).filter(Number.isSafeInteger)));
}

function normalizeRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 100;
  return Math.max(0, Math.min(100, Math.round(number)));
}

async function getRule(domainId, cid) {
  const text = idText(cid);
  const rule = await coll.findOne({ _id: configId(domainId, text) });
  return {
    _id: configId(domainId, text),
    domainId,
    cid: text,
    enabled: false,
    mode: 'previous-node',
    requiredRate: 100,
    ...rule,
  };
}

async function saveRule(domainId, cid, data, uid) {
  const text = idText(cid);
  const rule = {
    domainId,
    cid: text,
    enabled: !!data.enabled,
    mode: data.mode === 'previous-section' ? 'previous-section' : 'previous-node',
    requiredRate: normalizeRate(data.requiredRate),
    updatedAt: new Date(),
    updatedBy: uid,
  };
  await coll.findOneAndUpdate(
    { _id: configId(domainId, text) },
    { $set: rule, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
  return { _id: configId(domainId, text), ...rule };
}

async function flattenCourse(domainId, cid) {
  const course = getCourseModel();
  const oid = toObjectId(cid);
  const [cdoc, sections] = await Promise.all([
    course.get(domainId, oid),
    course.getMultiSection(domainId, oid).toArray(),
  ]);
  if (!cdoc) throw new NotFoundError('course');
  const nodes = [];
  for (const section of sections) {
    for (const node of section.dag || []) {
      nodes.push({
        order: nodes.length + 1,
        cidText: idText(oid),
        csid: section.docId || section._id,
        csidText: idText(section.docId || section._id),
        ssid: node._id,
        ssidText: idText(node._id),
        sectionTitle: section.title,
        title: node.title,
        pids: normalizePids(node.pids),
      });
    }
  }
  return { cdoc, sections, nodes };
}

function findNodeIndex(nodes, csid, ssid) {
  const csidText = idText(csid);
  const ssidText = idText(ssid);
  return nodes.findIndex((node) => node.csidText === csidText && node.ssidText === ssidText);
}

function getPreviousNode(nodes, index, mode) {
  if (index <= 0) return null;
  if (mode !== 'previous-section') return nodes[index - 1];
  const current = nodes[index];
  for (let i = index - 1; i >= 0; i -= 1) {
    if (nodes[i].csidText !== current.csidText) return nodes[i];
  }
  return nodes[index - 1];
}

async function problemProgress(domainId, uid, pids) {
  const unique = normalizePids(pids);
  if (!unique.length) return { total: 0, accepted: 0, percent: 100, text: '无前置题目' };
  const psdict = await ProblemModel.getListStatus(domainId, uid, unique);
  let accepted = 0;
  for (const pid of unique) {
    const psdoc = psdict[pid] || psdict[String(pid)];
    if (psdoc?.status === ACCEPTED || psdoc?.accept) accepted += 1;
  }
  const percent = Math.floor((accepted / unique.length) * 100);
  return { total: unique.length, accepted, percent, text: `${accepted}/${unique.length}` };
}

async function buildNodeStatus(domainId, cid, uid, rule) {
  const course = await flattenCourse(domainId, cid);
  const rows = [];
  for (let i = 0; i < course.nodes.length; i += 1) {
    const node = course.nodes[i];
    const prereq = getPreviousNode(course.nodes, i, rule.mode);
    const prereqProgress = prereq
      ? await problemProgress(domainId, uid, prereq.pids)
      : { total: 0, accepted: 0, percent: 100, text: '第一小节' };
    const selfProgress = await problemProgress(domainId, uid, node.pids);
    rows.push({
      ...node,
      prereqTitle: prereq ? `${prereq.sectionTitle} / ${prereq.title}` : '无',
      prereqProgress,
      selfProgress,
      unlocked: prereqProgress.percent >= rule.requiredRate,
    });
  }
  return { ...course, rows };
}

async function guardCourseSubsection(handler) {
  const args = handler.args || {};
  if (!args.cid || !args.csid || !args.ssid) return;
  if (canManageCourse(handler)) return;
  const uid = handler.user?._id;
  if (!uid || uid <= 1) return;
  const domainId = getDomainId(handler);
  const cid = toObjectId(args.cid);
  const rule = await getRule(domainId, cid);
  if (!rule.enabled) return;

  const course = getCourseModel();
  const cstdoc = await course.getStatus(domainId, cid, uid);
  if (!cstdoc?.enroll) return;

  const { nodes } = await flattenCourse(domainId, cid);
  const index = findNodeIndex(nodes, args.csid, args.ssid);
  if (index <= 0) return;
  const prereq = getPreviousNode(nodes, index, rule.mode);
  if (!prereq) return;
  const progress = await problemProgress(domainId, uid, prereq.pids);
  if (progress.percent >= rule.requiredRate) return;
  throw new ForbiddenError(`课程小节尚未解锁：请先完成「${prereq.sectionTitle} / ${prereq.title}」中的前置题目（${progress.text}，要求 ${rule.requiredRate}%）。`);
}

class CourseUnlockRuleIndexHandler extends Handler {
  async prepare() {
    this.checkPerm(EDIT_COURSE);
  }

  async get() {
    const domainId = getDomainId(this);
    const course = getCourseModel();
    const courses = await course.getMulti(domainId, {}).limit(200).toArray();
    const rules = await coll.find({ domainId, cid: { $in: courses.map((cdoc) => idText(cdoc.docId)) } }).toArray();
    const ruleMap = Object.fromEntries(rules.map((rule) => [rule.cid, rule]));
    const rows = courses.map((cdoc) => {
      const cid = idText(cdoc.docId);
      return { cdoc, cidText: cid, rule: { enabled: false, requiredRate: 100, mode: 'previous-node', ...ruleMap[cid] } };
    });
    this.response.template = 'course_unlock_rule_index.html';
    this.response.body = { rows };
  }
}

class CourseUnlockRuleSettingHandler extends Handler {
  async prepare() {
    this.checkPerm(EDIT_COURSE);
  }

  async get() {
    const domainId = getDomainId(this);
    const cid = toObjectId(this.args?.cid || this.request.params?.cid);
    const rule = await getRule(domainId, cid);
    const course = await flattenCourse(domainId, cid);
    const rows = course.nodes.map((node, index) => ({
      ...node,
      prereqTitle: getPreviousNode(course.nodes, index, rule.mode)
        ? `${getPreviousNode(course.nodes, index, rule.mode).sectionTitle} / ${getPreviousNode(course.nodes, index, rule.mode).title}`
        : '无',
    }));
    this.response.template = 'course_unlock_rule_setting.html';
    this.response.body = { cdoc: course.cdoc, cidText: idText(cid), rule, rows };
  }

  async post() {
    const domainId = getDomainId(this);
    const cid = toObjectId(this.args?.cid || this.request.params?.cid);
    const body = this.request.body || {};
    const rule = await saveRule(domainId, cid, {
      enabled: body.enabled === '1' || body.enabled === 'on' || body.enabled === true,
      mode: body.mode,
      requiredRate: body.requiredRate,
    }, this.user?._id);
    const course = await flattenCourse(domainId, cid);
    const rows = course.nodes.map((node, index) => ({
      ...node,
      prereqTitle: getPreviousNode(course.nodes, index, rule.mode)
        ? `${getPreviousNode(course.nodes, index, rule.mode).sectionTitle} / ${getPreviousNode(course.nodes, index, rule.mode).title}`
        : '无',
    }));
    this.response.template = 'course_unlock_rule_setting.html';
    this.response.body = { cdoc: course.cdoc, cidText: idText(cid), rule, rows, saved: true };
  }
}

class CourseUnlockRuleStatusHandler extends Handler {
  async prepare() {
    checkViewCourse(this);
  }

  async get() {
    const domainId = getDomainId(this);
    const cid = toObjectId(this.args?.cid || this.request.params?.cid);
    const rule = await getRule(domainId, cid);
    const status = await buildNodeStatus(domainId, cid, this.user._id, rule);
    this.response.template = 'course_unlock_rule_status.html';
    this.response.body = { cdoc: status.cdoc, cidText: idText(cid), rule, rows: status.rows };
  }
}

async function apply(ctx) {
  await coll.createIndex({ domainId: 1, cid: 1 }, { unique: true });
  ctx.Route('course_unlock_rule_index', '/domain/course-unlock-rules', CourseUnlockRuleIndexHandler, EDIT_COURSE);
  ctx.Route('course_unlock_rule_setting', '/course/:cid/unlock-rule', CourseUnlockRuleSettingHandler, EDIT_COURSE);
  ctx.Route('course_unlock_rule_status', '/course/:cid/unlock-status', CourseUnlockRuleStatusHandler, VIEW_COURSE);
  ctx.on('handler/before/CourseSubSectionDetail#get', guardCourseSubsection);
  ctx.on('handler/before/CourseSubSectionDetailHandler#get', guardCourseSubsection);
  ctx.injectUI('DomainManage', 'course_unlock_rule_index', { family: 'Training', icon: 'unlock' }, EDIT_COURSE);
  ctx.i18n.load('zh', {
    course_unlock_rule_index: '课程解锁规则',
    course_unlock_rule_setting: '课程解锁设置',
    course_unlock_rule_status: '课程解锁状态',
    'Course Unlock Rule': '课程解锁规则',
  });
  ctx.i18n.load('en', {
    course_unlock_rule_index: 'Course Unlock Rules',
    course_unlock_rule_setting: 'Course Unlock Rule',
    course_unlock_rule_status: 'Course Unlock Status',
  });
}

module.exports = { apply };
