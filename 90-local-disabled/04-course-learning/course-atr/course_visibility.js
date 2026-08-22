'use strict';

const Hydro = require('hydrooj');
const {
  ForbiddenError,
  Handler,
  NotFoundError,
  ObjectId,
  OplogModel,
  PERM,
  ValidationError,
} = Hydro;

const EDIT_COURSE = PERM.PERM_EDIT_TRAINING || PERM.PERM_EDIT_DOMAIN;
let activeCourseModel = null;

function asId(value) {
  return String(value && typeof value.toString === 'function' ? value.toString() : value);
}

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function getDomainId(handler) {
  return handler.args?.domainId || handler.domain?._id || 'system';
}

function toObjectId(value, field) {
  if (value?.toHexString) return value;
  try {
    return new ObjectId(String(value));
  } catch (err) {
    throw new ValidationError(field, value, `${field} is invalid.`);
  }
}

function canManage(user, hydro = Hydro) {
  return !!(user?.hasPerm?.(hydro.PERM.PERM_EDIT_TRAINING) || user?.hasPerm?.(hydro.PERM.PERM_EDIT_DOMAIN));
}

function isHidden(doc) {
  return doc?.hidden === true || doc?.hidden === 1 || doc?.hidden === '1';
}

function visibleList(handler, rows) {
  if (canManage(handler.user)) return rows || [];
  return (rows || []).filter((row) => !isHidden(row));
}

function cloneWithVisibleDag(handler, csdoc) {
  if (!csdoc || !Array.isArray(csdoc.dag) || canManage(handler.user)) return csdoc;
  return { ...csdoc, dag: visibleList(handler, csdoc.dag) };
}

function assertVisible(handler, ...docs) {
  if (canManage(handler.user)) return;
  if (docs.some(isHidden)) throw new ForbiddenError('This course item is hidden.');
}

function parseHidden(body, current) {
  const value = String(first(body.hidden) || '').toLowerCase();
  if (['1', 'true', 'yes', 'on', 'hide', 'hidden'].includes(value)) return true;
  if (['0', 'false', 'no', 'off', 'show', 'open'].includes(value)) return false;
  return !isHidden(current);
}

async function requireCourse(domainId, cid) {
  if (!activeCourseModel) throw new Error('Course model is not ready.');
  const cdoc = await activeCourseModel.get(domainId, cid);
  if (!cdoc) throw new NotFoundError('Course not found.');
  return cdoc;
}

async function requireSection(domainId, cid, csid) {
  await requireCourse(domainId, cid);
  const csdoc = await activeCourseModel.getSection(domainId, csid);
  if (!csdoc || asId(csdoc.parentId) !== asId(cid)) throw new NotFoundError('Section not found.');
  return csdoc;
}

async function requireSubsection(domainId, cid, csid, ssid) {
  const csdoc = await requireSection(domainId, cid, csid);
  let result;
  try {
    result = await activeCourseModel.getSubSection(domainId, csid, ssid);
  } catch (err) {
    throw new NotFoundError('Subsection not found.');
  }
  const ssdoc = result?.[1];
  if (!ssdoc) throw new NotFoundError('Subsection not found.');
  return { csdoc, ssdoc };
}

function back(handler) {
  if (typeof handler.back === 'function') return handler.back();
  handler.response.redirect = handler.request.headers?.referer || handler.url('course_main');
}

class CourseVisibilityToggleHandler extends Handler {
  async prepare() {
    if (!canManage(this.user)) throw new ForbiddenError('You do not have permission to change course visibility.');
  }

  async post() {
    const domainId = getDomainId(this);
    const body = this.request.body || {};
    const kind = String(first(body.kind) || '');
    const cid = toObjectId(first(body.cid), 'cid');

    if (kind === 'course') {
      const cdoc = await requireCourse(domainId, cid);
      const hidden = parseHidden(body, cdoc);
      await activeCourseModel.edit(domainId, cid, { hidden });
      await OplogModel.log(this, 'course.visibility', { kind, cid, hidden });
      return back(this);
    }

    if (kind === 'section') {
      const csid = toObjectId(first(body.csid), 'csid');
      const csdoc = await requireSection(domainId, cid, csid);
      const hidden = parseHidden(body, csdoc);
      await activeCourseModel.editSection(domainId, csid, { hidden });
      await OplogModel.log(this, 'course.visibility', { kind, cid, csid, hidden });
      return back(this);
    }

    if (kind === 'subsec') {
      const csid = toObjectId(first(body.csid), 'csid');
      const ssid = toObjectId(first(body.ssid), 'ssid');
      const { ssdoc } = await requireSubsection(domainId, cid, csid, ssid);
      const hidden = parseHidden(body, ssdoc);
      await activeCourseModel.editSubSection(domainId, csid, ssid, { hidden });
      await OplogModel.log(this, 'course.visibility', { kind, cid, csid, ssid, hidden });
      return back(this);
    }

    throw new ValidationError('kind', kind, 'Invalid visibility target.');
  }
}

function bindAfter(ctx, names, method, fn) {
  for (const name of names) ctx.on(`handler/after/${name}#${method}`, fn);
}

function bindBefore(ctx, names, method, fn) {
  for (const name of names) ctx.on(`handler/before/${name}#${method}`, fn);
}

function routeParam(handler, name) {
  return handler.args?.[name] || handler.request.params?.[name];
}

async function guardSubsectionByRoute(handler) {
  const cidValue = routeParam(handler, 'cid');
  const csidValue = routeParam(handler, 'csid');
  const ssidValue = routeParam(handler, 'ssid');
  if (!cidValue || !csidValue || !ssidValue) return;
  const domainId = getDomainId(handler);
  const cid = toObjectId(cidValue, 'cid');
  const csid = toObjectId(csidValue, 'csid');
  const ssid = toObjectId(ssidValue, 'ssid');
  const cdoc = await requireCourse(domainId, cid);
  const { csdoc, ssdoc } = await requireSubsection(domainId, cid, csid, ssid);
  assertVisible(handler, cdoc, csdoc, ssdoc);
}

function bindVisibilityHooks(ctx) {
  bindAfter(ctx, ['X', 'CourseMain', 'CourseMainHandler'], 'get', async (handler) => {
    const body = handler.response.body;
    if (!body?.cdocs) return;
    body.cdocs = visibleList(handler, body.cdocs);
  });

  bindAfter(ctx, ['C', 'F', 'CourseDetail', 'CourseDetailHandler'], 'get', async (handler) => {
    const body = handler.response.body;
    if (!body?.cdoc) return;
    assertVisible(handler, body.cdoc);
    body.csdocs = visibleList(handler, body.csdocs);
  });

  bindAfter(ctx, ['x', 'CourseSectionDetail', 'CourseSectionDetailHandler'], 'get', async (handler) => {
    const body = handler.response.body;
    if (!body?.cdoc || !body?.csdoc) return;
    assertVisible(handler, body.cdoc, body.csdoc);
    body.csdoc = cloneWithVisibleDag(handler, body.csdoc);
  });

  bindAfter(ctx, ['W', 'CourseSubSectionDetail', 'CourseSubSectionDetailHandler'], 'get', async (handler) => {
    const body = handler.response.body;
    if (!body?.cdoc || !body?.csdoc || !body?.ssdoc) return;
    assertVisible(handler, body.cdoc, body.csdoc, body.ssdoc);
  });

  bindBefore(ctx, [
    'W',
    'Z',
    'tt',
    'CourseSubSectionDetail',
    'CourseSubSectionDetailHandler',
    'CourseSubSectionArticle',
    'CourseSubSectionArticleHandler',
    'CourseFileDownload',
    'CourseFileDownloadHandler',
  ], 'get', guardSubsectionByRoute);

  bindAfter(ctx, ['H', 'CourseSubSectionScoreboard', 'CourseSubSectionScoreboardHandler'], 'get', async (handler) => {
    const body = handler.response.body;
    if (!body?.cdoc || !body?.csdoc || !body?.ssid) return;
    const ssdoc = (body.csdoc.dag || []).find((node) => asId(node._id) === asId(body.ssid));
    assertVisible(handler, body.cdoc, body.csdoc, ssdoc);
  });
}

function apply(ctx, CourseModel) {
  activeCourseModel = CourseModel || global.Hydro?.model?.course;
  ctx.Route('course_visibility_toggle', '/course-atr/visibility', CourseVisibilityToggleHandler);
  bindVisibilityHooks(ctx);
  ctx.i18n.load('zh', { course_visibility_toggle: '课程显示控制' });
  ctx.i18n.load('en', { course_visibility_toggle: 'Course Visibility' });
}

module.exports = {
  apply,
  assertVisible,
  canManage,
  cloneWithVisibleDag,
  isHidden,
  visibleList,
};
