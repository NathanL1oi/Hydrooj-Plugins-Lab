'use strict';

const {
  ContestModel,
  ContestNotAttendedError,
  ContestNotLiveError,
  DocumentModel,
  ForbiddenError,
  NotFoundError,
  ObjectId,
  PERM,
  UserModel,
  ValidationError,
} = require('hydrooj');
const {
  ContestDetailBaseHandler,
  ContestDetailHandler,
  ContestFileDownloadHandler,
  ContestProblemListHandler,
} = require('hydrooj/src/handler/contest');

const HOUR = 60 * 60 * 1000;
const PATCH_KEY = '__contestFlexibleStartPatched';

function domainIdOf(handler) {
  return String(handler.args?.domainId || handler.domain?._id || 'system');
}

function tidOf(handler) {
  const raw = handler.args?.tid || handler.request?.params?.tid;
  if (raw?.toHexString) return raw;
  if (ObjectId.isValid(String(raw))) return new ObjectId(String(raw));
  throw new ValidationError('tid');
}

function idText(value) {
  return value?.toHexString?.() || value?.toString?.() || String(value || '');
}

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function isFlexibleContest(tdoc) {
  const duration = Number(tdoc?.duration || 0);
  return !!tdoc && tdoc.rule !== 'homework' && Number.isFinite(duration) && duration > 0;
}

function durationMs(tdoc) {
  return Math.max(0, Math.floor(Number(tdoc?.duration || 0) * HOUR));
}

function formatDurationHours(ms) {
  const hours = ms / HOUR;
  if (!Number.isFinite(hours)) return '0';
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function globalWindowOpen(tdoc) {
  return !ContestModel.isNotStarted(tdoc) && !ContestModel.isDone(tdoc);
}

function shouldConfirmStart(tdoc, tsdoc) {
  return isFlexibleContest(tdoc)
    && !!tsdoc?.attend
    && !tsdoc.startAt
    && globalWindowOpen(tdoc);
}

function personalEndAt(tdoc, startAt, tsdoc) {
  const start = asDate(startAt);
  const length = durationMs(tdoc);
  const candidates = [];
  if (start && length) candidates.push(new Date(start.getTime() + length));
  const contestEndAt = asDate(tdoc?.endAt);
  if (contestEndAt) candidates.push(contestEndAt);
  const statusEndAt = asDate(tsdoc?.endAt);
  if (statusEndAt) candidates.push(statusEndAt);
  if (!candidates.length) return null;
  return new Date(Math.min(...candidates.map((item) => item.getTime())));
}

function buildPublicState(handler, tdoc, tsdoc) {
  const now = new Date();
  const startAt = asDate(tsdoc?.startAt);
  const length = durationMs(tdoc);
  const enabled = isFlexibleContest(tdoc);
  const attended = !!tsdoc?.attend;
  const started = !!startAt;
  const canStart = shouldConfirmStart(tdoc, tsdoc);
  const beforeGlobalStart = enabled && ContestModel.isNotStarted(tdoc);
  const contestDone = enabled && ContestModel.isDone(tdoc, tsdoc);
  const plannedStartAt = now;
  const endAt = started ? personalEndAt(tdoc, startAt, tsdoc) : null;
  const plannedEndAt = canStart ? personalEndAt(tdoc, plannedStartAt, tsdoc) : null;
  const tid = idText(tdoc?.docId || tdoc?._id || handler.args?.tid);
  return {
    enabled,
    tid,
    attended,
    started,
    canStart,
    beforeGlobalStart,
    contestDone,
    startAt,
    endAt,
    plannedStartAt,
    plannedEndAt,
    contestBeginAt: asDate(tdoc?.beginAt),
    contestEndAt: asDate(tdoc?.endAt),
    durationHours: formatDurationHours(length),
    startUrl: enabled && tid ? handler.url('contest_flexible_start', { tid }) : '',
    problemUrl: enabled && tid ? handler.url('contest_problemlist', { tid }) : '',
  };
}

function redirectToStart(handler) {
  handler.response.redirect = handler.url('contest_flexible_start', { tid: tidOf(handler) });
}

function ensureHandlerPatch() {
  if (ContestProblemListHandler[PATCH_KEY]) return;

  const originalProblemListGet = ContestProblemListHandler.prototype.get;
  ContestProblemListHandler.prototype.get = async function patchedFlexibleProblemListGet(...args) {
    if (shouldConfirmStart(this.tdoc, this.tsdoc)) {
      redirectToStart(this);
      return;
    }
    return await originalProblemListGet.apply(this, args);
  };

  const originalEarlyEnd = ContestDetailHandler.prototype.postEarlyEnd;
  ContestDetailHandler.prototype.postEarlyEnd = async function patchedFlexibleEarlyEnd(...args) {
    if (shouldConfirmStart(this.tdoc, this.tsdoc)) {
      redirectToStart(this);
      return;
    }
    return await originalEarlyEnd.apply(this, args);
  };

  const originalFileDownloadGet = ContestFileDownloadHandler.prototype.get;
  ContestFileDownloadHandler.prototype.get = async function patchedFlexibleFileDownload(...args) {
    const type = args[4] || 'private';
    if (type === 'private' && shouldConfirmStart(this.tdoc, this.tsdoc)) {
      redirectToStart(this);
      return;
    }
    return await originalFileDownloadGet.apply(this, args);
  };

  ContestProblemListHandler[PATCH_KEY] = {
    originalProblemListGet,
    originalEarlyEnd,
    originalFileDownloadGet,
  };
}

class ContestFlexibleStartHandler extends ContestDetailBaseHandler {
  async get() {
    const domainId = domainIdOf(this);
    const tid = tidOf(this);
    if (!isFlexibleContest(this.tdoc)) throw new NotFoundError('contest');
    if (!this.tsdoc?.attend) throw new ContestNotAttendedError(domainId, tid);
    if (this.tsdoc.startAt) {
      this.response.redirect = this.url('contest_problemlist', { tid });
      return;
    }

    const owner = await UserModel.getById(domainId, this.tdoc.owner);
    const state = buildPublicState(this, this.tdoc, this.tsdoc);
    this.UiContext.contestFlexibleStart = state;
    this.response.template = 'contest_flexible_start.html';
    this.response.body = {
      page_name: 'contest_flexible_start',
      tdoc: this.tdoc,
      tsdoc: this.tsdoc,
      owner_udoc: owner,
      state,
    };
  }

  async postStart() {
    const domainId = domainIdOf(this);
    const tid = tidOf(this);
    if (!isFlexibleContest(this.tdoc)) throw new NotFoundError('contest');
    await this.limitRate('contest_flexible_start', 60, 30);

    const latestStatus = await ContestModel.getStatus(domainId, tid, this.user._id);
    if (!latestStatus?.attend) throw new ContestNotAttendedError(domainId, tid);
    if (latestStatus.startAt) {
      this.response.redirect = this.url('contest_problemlist', { tid });
      return;
    }
    if (!shouldConfirmStart(this.tdoc, latestStatus)) throw new ContestNotLiveError(domainId, tid);

    const startAt = new Date();
    const result = await DocumentModel.setStatusIfCondition(
      domainId,
      DocumentModel.TYPE_CONTEST,
      tid,
      this.user._id,
      { attend: 1, startAt: { $exists: false } },
      { startAt },
    );
    if (!result) {
      const after = await ContestModel.getStatus(domainId, tid, this.user._id);
      if (after?.startAt) {
        this.response.redirect = this.url('contest_problemlist', { tid });
        return;
      }
      throw new ForbiddenError('Start failed. Please refresh and try again.');
    }
    this.response.redirect = this.url('contest_problemlist', { tid });
  }
}

async function exposeFlexibleStartState(handler) {
  if (!handler.tdoc || !isFlexibleContest(handler.tdoc)) return;
  const state = buildPublicState(handler, handler.tdoc, handler.tsdoc);
  handler.UiContext ||= {};
  handler.UiContext.contestFlexibleStart = state;
  if (state.canStart && handler.response?.body) handler.response.body.files = [];
}

async function exposeFlexibleStartUserManage(handler) {
  if (!handler.tdoc || !isFlexibleContest(handler.tdoc)) return;
  const users = {};
  for (const tsdoc of handler.response?.body?.tsdocs || []) {
    const started = !!tsdoc.startAt;
    users[String(tsdoc.uid)] = {
      started,
      startAt: started ? asDate(tsdoc.startAt) : null,
      endAt: started ? personalEndAt(handler.tdoc, tsdoc.startAt, tsdoc) : null,
    };
  }
  handler.UiContext ||= {};
  handler.UiContext.contestFlexibleStartUserManage = {
    enabled: true,
    users,
  };
}

async function apply(ctx) {
  ensureHandlerPatch();

  ctx.Route('contest_flexible_start', '/contest/:tid/flexible-start', ContestFlexibleStartHandler, PERM.PERM_VIEW_CONTEST);

  ctx.on('handler/after/ContestDetail#get', exposeFlexibleStartState);
  ctx.on('handler/after/ContestUser#get', exposeFlexibleStartUserManage);

  ctx.i18n.load('zh', {
    contest_flexible_start: '开始个人计时',
  });
  ctx.i18n.load('en', {
    contest_flexible_start: 'Start Personal Timer',
  });
}

module.exports = { apply };
