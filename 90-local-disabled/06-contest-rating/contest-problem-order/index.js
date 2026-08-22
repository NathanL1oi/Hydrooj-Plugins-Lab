'use strict';

const {
  ContestModel, Handler, ObjectId, PERM, ProblemModel,
} = require('hydrooj');

function tidFrom(raw) {
  if (raw?.toHexString) return raw;
  if (ObjectId?.isValid?.(raw)) return new ObjectId(raw);
  return raw;
}

function canManageContest(handler, tdoc) {
  return handler.user?.own?.(tdoc)
    || handler.user?.hasPerm?.(PERM.PERM_EDIT_CONTEST)
    || handler.user?.hasPerm?.(PERM.PERM_EDIT_DOMAIN);
}

function parsePids(value) {
  const seen = new Set();
  return String(value || '')
    .replace(/\uFF0C/g, ',')
    .split(/[\s,]+/)
    .map((item) => Number(String(item).trim().replace(/^P/i, '')))
    .filter((pid) => {
      if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) return false;
      seen.add(pid);
      return true;
    })
    .slice(0, 200);
}

function displayPid(pdoc, fallbackPid) {
  const pid = String(pdoc?.pid || '').trim();
  if (pid) return pid;
  return `P${fallbackPid}`;
}

class ContestProblemOrderMetaHandler extends Handler {
  async prepare() {
    const domainId = this.args?.domainId || this.domain?._id || 'system';
    const tid = tidFrom(this.args?.tid || this.request.params?.tid);
    this.tdoc = await ContestModel.get(domainId, tid);
    if (!canManageContest(this, this.tdoc)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
  }

  async get() {
    const domainId = this.args?.domainId || this.domain?._id || 'system';
    await this.limitRate('contest_problem_order_meta', 60, 180);
    const pids = parsePids(this.request.query?.pids);
    const pdict = await ProblemModel.getList(
      domainId,
      pids,
      this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) || this.user._id,
      false,
      ProblemModel.PROJECTION_PUBLIC,
      true,
    );
    this.response.body = {
      items: pids.map((pid) => {
        const pdoc = pdict[pid] || pdict[String(pid)] || {};
        return {
          docId: pid,
          pid: displayPid(pdoc, pid),
          title: pdoc.title || '',
          hidden: !!pdoc.hidden,
        };
      }),
    };
  }
}

function apply(ctx) {
  ctx.Route(
    'contest_problem_order_meta',
    '/contest/:tid/problem-order/meta',
    ContestProblemOrderMetaHandler,
    PERM.PERM_VIEW_CONTEST,
  );
  ctx.i18n.load('zh', {
    contest_problem_order: '\u6bd4\u8d5b\u9898\u76ee\u6392\u5e8f',
    contest_problem_order_meta: '\u6bd4\u8d5b\u9898\u76ee\u6392\u5e8f\u5143\u4fe1\u606f',
  });
  ctx.i18n.load('en', {
    contest_problem_order: 'Contest Problem Order',
    contest_problem_order_meta: 'Contest Problem Order Metadata',
  });
}

module.exports = { apply };
