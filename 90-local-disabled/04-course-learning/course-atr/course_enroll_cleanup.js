'use strict';

const {
  DocumentModel,
  Handler,
  ObjectId,
  OplogModel,
  PERM,
  UserModel,
  UserNotFoundError,
  ValidationError,
} = require('hydrooj');

const COURSE_DOC_TYPE = 80;
const EDIT_COURSE = PERM.PERM_EDIT_TRAINING || PERM.PERM_EDIT_DOMAIN;
let activeCourseModel = null;

function getDomainId(handler) {
  return handler.args?.domainId || handler.domain?._id || 'system';
}

function toObjectId(value, field = 'cid') {
  if (value?.toHexString) return value;
  try {
    return new ObjectId(String(value));
  } catch (err) {
    throw new ValidationError(field);
  }
}

function bodyText(handler, key) {
  return String(handler.request.body?.[key] || '').trim();
}

function uniqUids(values) {
  return Array.from(new Set((values || []).map((uid) => +uid).filter((uid) => uid > 1)));
}

async function findUser(domainId, uidOrName) {
  return await UserModel.getById(domainId, +uidOrName)
    || await UserModel.getByUname(domainId, uidOrName)
    || await UserModel.getByEmail(domainId, uidOrName);
}

async function getGroupUids(domainId, groupName) {
  const name = String(groupName || '').trim();
  if (!name) throw new ValidationError('groupName', null, '请输入小组名');
  const group = (await UserModel.listGroup(domainId)).find((item) => item.name === name);
  if (!group) throw new ValidationError('groupName', name, '小组不存在');
  return uniqUids(group.uids);
}

async function removeCourseEnrollment(handler, courseModel, domainId, cid, candidateUids, source) {
  if (!courseModel) throw new Error('Course model is not ready.');
  await courseModel.get(domainId, cid);
  const requestedUids = uniqUids(candidateUids);
  if (!requestedUids.length) return 0;

  const enrolled = await courseModel.getMultiStatus(domainId, {
    docId: cid,
    uid: { $in: requestedUids },
    enroll: 1,
  }).project({ uid: 1 }).toArray();
  const removedUids = uniqUids(enrolled.map((item) => item.uid));
  if (!removedUids.length) return 0;

  await DocumentModel.deleteMultiStatus(domainId, COURSE_DOC_TYPE, {
    docId: cid,
    uid: { $in: removedUids },
  });
  await courseModel.inc(domainId, cid, 'attend', -removedUids.length);
  await OplogModel.log(handler, 'course.enroll.remove', {
    cid,
    source,
    uids: removedUids,
    count: removedUids.length,
  });
  return removedUids.length;
}

class CourseEnrollCleanupUserHandler extends Handler {
  async prepare() {
    this.checkPerm(EDIT_COURSE);
  }

  async post() {
    const domainId = getDomainId(this);
    const cid = toObjectId(this.args?.cid || this.request.params?.cid);
    const uidOrName = bodyText(this, 'uidOrName');
    if (!uidOrName) throw new ValidationError('uidOrName', null, '请输入 UID / 用户名 / 邮箱');
    const udoc = await findUser(domainId, uidOrName);
    if (!udoc) throw new UserNotFoundError(uidOrName);
    const count = await removeCourseEnrollment(this, activeCourseModel, domainId, cid, [udoc._id], 'user');
    this.response.redirect = `${this.url('course_detail', { cid })}?enrollCleanup=${count}`;
  }
}

class CourseEnrollCleanupGroupHandler extends Handler {
  async prepare() {
    this.checkPerm(EDIT_COURSE);
  }

  async post() {
    const domainId = getDomainId(this);
    const cid = toObjectId(this.args?.cid || this.request.params?.cid);
    const groupName = bodyText(this, 'groupName');
    const uids = await getGroupUids(domainId, groupName);
    const count = await removeCourseEnrollment(this, activeCourseModel, domainId, cid, uids, `group:${groupName}`);
    this.response.redirect = `${this.url('course_detail', { cid })}?enrollCleanup=${count}`;
  }
}

function apply(ctx, courseModel) {
  activeCourseModel = courseModel || global.Hydro?.model?.course;
  ctx.Route('course_enroll_cleanup_user', '/course/:cid/enroll-cleanup/user', CourseEnrollCleanupUserHandler, EDIT_COURSE);
  ctx.Route('course_enroll_cleanup_group', '/course/:cid/enroll-cleanup/group', CourseEnrollCleanupGroupHandler, EDIT_COURSE);
  ctx.i18n.load('zh', {
    course_enroll_cleanup_user: '移除课程参与',
    course_enroll_cleanup_group: '按小组移除课程参与',
  });
}

module.exports = { apply };
