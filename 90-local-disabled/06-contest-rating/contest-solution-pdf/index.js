'use strict';

const {
  ContestModel,
  ContestNotFoundError,
  Handler,
  ObjectId,
  PRIV,
  ProblemModel,
  SolutionModel,
  ValidationError,
} = require('hydrooj');

function parseObjectId(value, field = 'tid') {
  const text = String(value || '').trim();
  if (!text || !ObjectId.isValid(text)) throw new ValidationError(field);
  return new ObjectId(text);
}

function canExportContestSolutions(handler) {
  return !!handler?.user?.hasPriv?.(PRIV.PRIV_EDIT_SYSTEM);
}

function rewriteProblemFileLinks(content, pid, tid) {
  const withTid = (filename) => {
    const sep = filename.includes('?') ? '&' : '?';
    return `../../p/${pid}/file/${filename}${sep}tid=${tid}`;
  };
  return String(content || '')
    .replace(/\(file:\/\/(.+?)\)/g, (_, filename) => `(${withTid(filename)})`)
    .replace(/="file:\/\/(.+?)"/g, (_, filename) => `="${withTid(filename)}"`)
    .replace(/=\\"file:\/\/(.+?)\\"/g, (_, filename) => `=\\"${withTid(filename)}\\"`);
}

function problemLabel(index) {
  let n = index;
  let label = '';
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

function normalizeProblemConfig(config = {}) {
  return {
    type: config.type || 'default',
    subType: config.subType || '',
    timeMin: Number.isFinite(Number(config.timeMin)) ? Number(config.timeMin) : 1000,
    timeMax: Number.isFinite(Number(config.timeMax)) ? Number(config.timeMax) : 1000,
    memoryMin: Number.isFinite(Number(config.memoryMin)) ? Number(config.memoryMin) : 256,
    memoryMax: Number.isFinite(Number(config.memoryMax)) ? Number(config.memoryMax) : 256,
  };
}

class ContestSolutionPdfHandler extends Handler {
  async get() {
    this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
    const domainId = this.args.domainId || this.domain?._id;
    const tid = parseObjectId(this.args.tid);
    const tdoc = await ContestModel.get(domainId, tid);
    if (!tdoc) throw new ContestNotFoundError(domainId, tid);

    const pids = Array.isArray(tdoc.pids) ? tdoc.pids : [];
    const pdict = await ProblemModel.getList(domainId, pids, true, false, undefined, true);
    const items = [];
    for (let i = 0; i < pids.length; i += 1) {
      const pid = pids[i];
      const pdoc = pdict[pid] || { docId: pid, title: `P${pid}` };
      const psdocs = await SolutionModel.getMulti(domainId, pdoc.docId).toArray();
      items.push({
        label: problemLabel(i),
        pid: pdoc.docId,
        title: pdoc.title || `P${pdoc.docId}`,
        config: normalizeProblemConfig(pdoc.config),
        solutions: psdocs.map((psdoc, index) => ({
          ...psdoc,
          index: index + 1,
          content: rewriteProblemFileLinks(psdoc.content, pdoc.docId, tid),
        })),
      });
    }

    this.response.template = 'contest_solution_pdf.html';
    this.response.body = {
      page_name: 'contest_solution_pdf',
      tdoc,
      items,
    };
  }
}

async function apply(ctx) {
  ctx.Route('contest_solution_pdf', '/contest/:tid/solution-pdf', ContestSolutionPdfHandler, PRIV.PRIV_EDIT_SYSTEM);

  ctx.injectUI('ContestDetail', 'contest_solution_pdf', (handler) => ({
    icon: 'book',
    displayName: 'Export Solution PDF',
    args: { tid: handler.args?.tid || handler.tdoc?.docId || handler.tdoc?._id },
  }), canExportContestSolutions);

  ctx.on('handler/after/ContestDetail#get', async (handler) => {
    if (!canExportContestSolutions(handler)) return;
    handler.UiContext ||= {};
    handler.UiContext.contestSolutionPdf = {
      url: handler.url('contest_solution_pdf', { tid: handler.args?.tid || handler.tdoc?.docId }),
      title: '导出题解',
    };
  });

  ctx.i18n.load('zh', {
    contest_solution_pdf: '导出题解',
    'Contest Solution PDF': '比赛题解导出',
    'Export Solution PDF': '导出题解',
    'Solution Export': '题解导出',
  });
  ctx.i18n.load('en', {
    contest_solution_pdf: 'Export Solutions',
    'Contest Solution PDF': 'Contest Solution PDF',
    'Export Solution PDF': 'Export Solutions',
    'Solution Export': 'Solution Export',
  });
}

module.exports = { apply };
