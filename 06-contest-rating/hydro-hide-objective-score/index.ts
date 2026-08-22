import {
  ContestModel, Context, Logger, ObjectId, PERM, ProblemModel, RecordModel, Schema, STATUS,
  STATUS_CODES, STATUS_SHORT_TEXTS, STATUS_TEXTS,
} from 'hydrooj';

const logger = new Logger('hide-objective-score');
const DEFAULT_SUBMITTED_STATUS = -10001;
const SEND_PATCHED = Symbol('hideObjectiveScoreSendPatched');

type AnyDoc = Record<string, any>;

const ExplicitContest = Schema.object({
  domainId: Schema.string().default('system').description('Domain ID'),
  contestId: Schema.string().required().description('Contest ObjectId / docId'),
  pids: Schema.array(Schema.number()).default([]).description('Extra problem docIds to hide'),
});

export const name = 'hide-objective-score';

export const Config = Schema.object({
  rules: Schema.array(Schema.string()).default(['ioi', 'strictioi']).description('Contest rules to affect'),
  enableMode: Schema.union(['contestFlag', 'explicit', 'always']).default('always')
    .description('When to enable this plugin: contestFlag, explicit, or always'),
  contestFlagFields: Schema.array(Schema.string()).default(['hideObjectiveScore'])
    .description('Contest document boolean fields that enable hidden objective results'),
  problemTypes: Schema.array(Schema.string()).default(['objective']).description('Problem config.type values to hide'),
  revealAfterContest: Schema.boolean().default(true).description('Reveal hidden objective scores after contest ends'),
  revealAfterUserContest: Schema.boolean().default(true)
    .description('Reveal hidden objective scores after the current user personal contest window ends'),
  hideStatus: Schema.boolean().default(true).description('Also hide AC/WA status for objective problems'),
  statusMode: Schema.union(['submitted', 'hidden', 'ignored']).default('submitted')
    .description('How to project final hidden statuses: submitted, hidden, or ignored'),
  submittedStatusCode: Schema.number().default(DEFAULT_SUBMITTED_STATUS).description('Custom status code used by submitted mode'),
  submittedStatusText: Schema.string().default('已递交').description('Text shown for hidden final objective submissions'),
  submittedStatusShortText: Schema.string().default('已递交').description('Short text shown for hidden final objective submissions'),
  submittedStatusClass: Schema.string().default('waiting').description('CSS status class used by submitted mode'),
  stripStatusFilter: Schema.boolean().default(true).description('Remove status filters in enabled contests to avoid AC/WA inference'),
  hideScoreboardProblemCells: Schema.boolean().default(true).description('Hide objective problem cells on scoreboard'),
  hideScoreboardTotal: Schema.boolean().default(true).description('Hide total score on scoreboard to avoid leaking objective scores'),
  maskText: Schema.string().default('Hidden').description('Text shown in hidden scoreboard cells'),
  enabledContests: Schema.array(ExplicitContest).role('table').default([])
    .description('Contests where hidden objective results are enabled; pids are optional extras'),
  explicit: Schema.array(ExplicitContest).role('table').default([])
    .description('Deprecated alias of enabledContests'),
  persistFormField: Schema.boolean().default(true).description('Persist a custom contest edit form field into the contest document'),
  formField: Schema.string().default('hideObjectiveScore').description('Custom contest edit form field to persist'),
  writeContestFlagField: Schema.string().default('hideObjectiveScore').description('Contest document field written from formField'),
}).description('Hide objective problem scores in IOI contests');

function contestKey(tdoc: AnyDoc) {
  const id = tdoc?.docId || tdoc?._id;
  return `${tdoc?.domainId}/${id?.toString?.() || id}`;
}

function explicitKey(domainId: string, contestId: any) {
  return `${domainId}/${contestId?.toString?.() || contestId}`;
}

function isContestAdmin(handler: any, tdoc: AnyDoc) {
  return handler?.user?.own?.(tdoc) || handler?.user?.hasPerm?.(PERM.PERM_EDIT_CONTEST);
}

function isTruthyFormValue(value: any) {
  if (value instanceof Array) return value.some((item) => isTruthyFormValue(item));
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return !!value;
  return !['', '0', 'false', 'off', 'no', 'null', 'undefined'].includes(value.toLowerCase());
}

function hasOwn(obj: AnyDoc, key: string) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function isContestFlagEnabled(tdoc: AnyDoc, config: ReturnType<typeof Config>) {
  return (config.contestFlagFields || []).some((field) => !!tdoc?.[field]);
}

function isContestManuallyEnabled(tdoc: AnyDoc, manualContests: Map<string, Set<number>>) {
  return manualContests.has(contestKey(tdoc));
}

function shouldApply(
  tdoc: AnyDoc,
  config: ReturnType<typeof Config>,
  manualContests: Map<string, Set<number>>,
  tsdoc?: AnyDoc,
) {
  if (!tdoc || !config.rules.includes(tdoc.rule)) return false;
  if (config.revealAfterContest && ContestModel.isDone(tdoc, tsdoc)) return false;
  if (config.enableMode === 'always') return true;
  if (isContestManuallyEnabled(tdoc, manualContests)) return true;
  if (config.enableMode === 'explicit') return false;
  if (!isContestFlagEnabled(tdoc, config)) return false;
  return true;
}

function isObjectivePdoc(pdoc: AnyDoc, config: ReturnType<typeof Config>) {
  const type = pdoc?.config?.type;
  return typeof type === 'string' && config.problemTypes.includes(type);
}

function installSubmittedStatus(config: ReturnType<typeof Config>) {
  const statusCode = +(config.submittedStatusCode || DEFAULT_SUBMITTED_STATUS);
  (STATUS_TEXTS as AnyDoc)[statusCode] = config.submittedStatusText;
  (STATUS_SHORT_TEXTS as AnyDoc)[statusCode] = config.submittedStatusShortText;
  (STATUS_CODES as AnyDoc)[statusCode] = config.submittedStatusClass;
}

function isRunningStatus(status: number) {
  return [
    STATUS.STATUS_WAITING,
    STATUS.STATUS_FETCHED,
    STATUS.STATUS_COMPILING,
    STATUS.STATUS_JUDGING,
  ].includes(status);
}

function maskRecord<T extends AnyDoc>(
  rdoc: T,
  config: ReturnType<typeof Config>,
  statusMode = config.statusMode,
): T {
  if (!rdoc) return rdoc;
  const masked = { ...rdoc };
  const running = isRunningStatus(masked.status);

  delete masked.score;
  delete masked.time;
  delete masked.memory;
  delete masked.progress;
  delete masked.subtasks;
  masked.testCases = [];
  masked.judgeTexts = [];

  // Compile errors are not expected for objective problems, but hiding them avoids
  // leaking parser errors such as "No answer" in the objective judge.
  masked.compilerTexts = [];

  if (config.hideStatus) {
    if (!running && statusMode === 'submitted') {
      masked.status = +(config.submittedStatusCode || DEFAULT_SUBMITTED_STATUS);
    } else if (!running && statusMode === 'ignored') masked.status = STATUS.STATUS_IGNORED;
    else if (!running) delete masked.status;
  }

  masked.objectiveScoreHidden = true;
  return masked;
}

function maskRecordStat<T extends AnyDoc>(stat: T): T {
  if (!stat) return stat;
  const masked = { ...stat };
  delete masked.score;
  delete masked.time;
  delete masked.memory;
  delete masked.status;
  delete masked.progress;
  delete masked.subtasks;
  delete masked.testCases;
  delete masked.judgeTexts;
  delete masked.compilerTexts;
  return masked;
}

function maskRecordDetailBody(body: AnyDoc, config: ReturnType<typeof Config>) {
  if (!body) return;
  for (const key of ['rdoc', 'record']) {
    if (body[key]) body[key] = maskRecord(body[key], config);
  }
  for (const key of ['rstat', 'stat', 'rdocStat', 'recordStat']) {
    if (body[key]) body[key] = maskRecordStat(body[key]);
  }
  if (body.rdoc?.stat) body.rdoc.stat = maskRecordStat(body.rdoc.stat);
  if (body.record?.stat) body.record.stat = maskRecordStat(body.record.stat);
  if (body.pdoc?.stats) body.pdoc = { ...body.pdoc, stats: {} };
  delete body.score;
  delete body.time;
  delete body.memory;
  delete body.progress;
}

function escapeHtml(value: any) {
  return `${value ?? ''}`
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hiddenStatusValue(config: ReturnType<typeof Config>, status?: number) {
  if (typeof status !== 'number' || isRunningStatus(status) || !config.hideStatus) return status;
  if (config.statusMode === 'submitted') return +(config.submittedStatusCode || DEFAULT_SUBMITTED_STATUS);
  if (config.statusMode === 'ignored') return STATUS.STATUS_IGNORED;
  return undefined;
}

function renderHiddenStatusHtml(config: ReturnType<typeof Config>) {
  const statusCode = +(config.submittedStatusCode || DEFAULT_SUBMITTED_STATUS);
  const statusClass = escapeHtml((STATUS_CODES as AnyDoc)[statusCode] || config.submittedStatusClass || 'waiting');
  const text = escapeHtml(config.submittedStatusText);
  return `<div id="status"><span class="record-status--text ${statusClass}">${text}</span></div>`;
}

function renderHiddenSummaryHtml(config: ReturnType<typeof Config>) {
  const text = escapeHtml(config.submittedStatusText);
  return `<div id="summary"><p>${text}</p></div>`;
}

function maskRecordDetailSocketPayload(payload: any, config: ReturnType<typeof Config>) {
  let data = payload;
  const wasString = typeof payload === 'string';
  if (wasString) {
    try {
      data = JSON.parse(payload);
    } catch {
      return payload;
    }
  }
  if (!data || typeof data !== 'object') return payload;

  const masked = { ...data };
  let touched = false;
  if (typeof masked.status === 'number') {
    const status = hiddenStatusValue(config, masked.status);
    if (typeof status === 'number') masked.status = status;
    else delete masked.status;
    touched = true;
  }
  for (const key of ['score', 'time', 'memory', 'progress', 'subtasks', 'testCases', 'judgeTexts', 'compilerTexts']) {
    if (hasOwn(masked, key)) {
      if (key === 'testCases' || key === 'judgeTexts' || key === 'compilerTexts') masked[key] = [];
      else delete masked[key];
      touched = true;
    }
  }
  if (masked.rdoc) {
    masked.rdoc = maskRecord(masked.rdoc, config);
    touched = true;
  }
  if (masked.rstat || masked.stat) {
    if (masked.rstat) masked.rstat = maskRecordStat(masked.rstat);
    if (masked.stat) masked.stat = maskRecordStat(masked.stat);
    touched = true;
  }
  if (hasOwn(masked, 'status_html')) {
    masked.status_html = renderHiddenStatusHtml(config);
    touched = true;
  }
  if (hasOwn(masked, 'summary_html')) {
    masked.summary_html = renderHiddenSummaryHtml(config);
    touched = true;
  }
  if (!touched) return payload;
  return wasString ? JSON.stringify(masked) : masked;
}

function patchConnectionSend(handler: any, config: ReturnType<typeof Config>) {
  if (!handler?.send || handler[SEND_PATCHED]) return;
  const originalSend = handler.send.bind(handler);
  handler.send = (payload: any, ...args: any[]) => originalSend(maskRecordDetailSocketPayload(payload, config), ...args);
  handler[SEND_PATCHED] = true;
}

function maskMaybe<T extends AnyDoc>(
  rdoc: T,
  hiddenPids: Set<number>,
  config: ReturnType<typeof Config>,
  statusMode = config.statusMode,
): T {
  if (!rdoc || !hiddenPids.has(+rdoc.pid)) return rdoc;
  return maskRecord(rdoc, config, statusMode);
}

function maskDict(
  dict: Record<string, AnyDoc>,
  hiddenPids: Set<number>,
  config: ReturnType<typeof Config>,
  statusMode = config.statusMode,
) {
  if (!dict) return;
  for (const key of Object.keys(dict)) {
    const doc = dict[key];
    const pid = +(doc?.pid ?? key);
    if (hiddenPids.has(pid)) dict[key] = maskRecord({ ...doc, pid }, config, statusMode);
  }
}

function maskRows(
  rows: AnyDoc[][],
  hiddenPids: Set<number>,
  config: ReturnType<typeof Config>,
) {
  if (!rows?.length) return;
  const header = rows[0] || [];
  const objectiveIndexes = header
    .map((cell, index) => ({ cell, index }))
    .filter(({ cell }) => cell?.type === 'problem' && hiddenPids.has(+cell.raw))
    .map(({ index }) => index);

  for (const row of rows.slice(1)) {
    if (!row) continue;
    if (config.hideScoreboardTotal) {
      for (const cell of row) {
        if (cell?.type === 'total_score') {
          cell.value = config.maskText;
          delete cell.score;
        }
      }
    }
    if (!config.hideScoreboardProblemCells) continue;
    for (const index of objectiveIndexes) {
      const cell = row[index];
      if (!cell) continue;
      cell.type = 'string';
      cell.value = config.maskText;
      cell.raw = null;
      delete cell.score;
      delete cell.hover;
    }
  }
}

export async function apply(ctx: Context, config: ReturnType<typeof Config>) {
  installSubmittedStatus(config);

  const hiddenCache = new Map<string, Set<number>>();
  const manualContests = new Map<string, Set<number>>();

  for (const item of [...(config.enabledContests || []), ...(config.explicit || [])]) {
    manualContests.set(explicitKey(item.domainId, item.contestId), new Set(item.pids || []));
  }

  async function getHiddenPids(tdoc: AnyDoc, pdict?: Record<number, AnyDoc>) {
    const key = contestKey(tdoc);
    const cached = hiddenCache.get(key);
    if (cached) return cached;

    const result = new Set<number>(manualContests.get(key) || []);
    if (pdict) {
      for (const [pid, pdoc] of Object.entries(pdict)) {
        if (isObjectivePdoc(pdoc, config)) result.add(+pid);
      }
    } else if (tdoc?.pids?.length) {
      try {
        const loaded = await ProblemModel.getList(tdoc.domainId, tdoc.pids, true, true, ['docId', 'config'] as any);
        for (const [pid, pdoc] of Object.entries(loaded)) {
          if (isObjectivePdoc(pdoc, config)) result.add(+pid);
        }
      } catch (e: any) {
        logger.warn(`Failed to load objective problems for contest ${key}: ${e.message}`);
      }
    }

    hiddenCache.set(key, result);
    return result;
  }

  function getHiddenPidsSync(tdoc: AnyDoc) {
    const key = contestKey(tdoc);
    return hiddenCache.get(key) || manualContests.get(key) || new Set<number>();
  }

  function shouldMaskForHandler(handler: any, tdoc: AnyDoc) {
    return shouldApply(tdoc, config, manualContests, handler?.tsdoc) && !isContestAdmin(handler, tdoc);
  }

  function shouldMaskInProjection(tdoc: AnyDoc) {
    if (config.revealAfterUserContest && tdoc?.duration) return false;
    return shouldApply(tdoc, config, manualContests);
  }

  async function resolveRecord(handler: any, body?: AnyDoc) {
    const existing = body?.rdoc || body?.record || handler?.rdoc || handler?.record;
    if (existing) return existing;
    const rid = handler?.args?.rid || body?.rid;
    const domainId = handler?.args?.domainId || body?.domainId || handler?.domain?._id;
    if (!rid || !domainId || !ObjectId.isValid?.(rid)) return null;
    try {
      return await RecordModel.get(domainId, new ObjectId(rid));
    } catch (e: any) {
      logger.warn(`Failed to load record ${rid} for objective-score masking: ${e.message}`);
      return null;
    }
  }

  async function resolveContest(handler: any, body?: AnyDoc) {
    const tdoc = body?.tdoc || handler?.tdoc;
    if (tdoc) return tdoc;
    const rdoc = await resolveRecord(handler, body);
    const contest = rdoc?.contest || handler?.args?.tid || handler?.args?.contest;
    const domainId = rdoc?.domainId || body?.domainId || handler?.args?.domainId || handler?.domainId;
    if (!domainId || !contest || `${contest}` === '000000000000000000000000') return null;
    try {
      return await ContestModel.get(domainId, contest);
    } catch (e: any) {
      logger.warn(`Failed to resolve contest for record detail masking: ${e.message}`);
      return null;
    }
  }

  async function resolvePdoc(handler: any, body: AnyDoc, rdoc: AnyDoc) {
    const pdoc = body?.pdoc || handler?.pdoc;
    if (pdoc) return pdoc;
    if (!rdoc?.domainId || !rdoc?.pid) return null;
    try {
      return await ProblemModel.get(rdoc.domainId, rdoc.pid, ['docId', 'config'] as any);
    } catch (e: any) {
      logger.warn(`Failed to load problem ${rdoc.domainId}/${rdoc.pid} for objective-score masking: ${e.message}`);
      return null;
    }
  }

  function getPidFromDocs(...docs: AnyDoc[]) {
    for (const doc of docs) {
      const pid = +(doc?.pid ?? doc?.docId);
      if (Number.isFinite(pid)) return pid;
    }
    return NaN;
  }

  async function isHiddenRecord(handler: any, body?: AnyDoc) {
    const rdoc = await resolveRecord(handler, body);
    const tdoc = await resolveContest(handler, body);
    if (config.revealAfterUserContest && tdoc?.duration && !handler?.tsdoc && handler?.user?._id) {
      try {
        handler.tsdoc = await ContestModel.getStatus(tdoc.domainId, tdoc.docId, handler.user._id);
      } catch (e: any) {
        logger.warn(`Failed to load contest status for objective-score masking: ${e.message}`);
      }
    }
    if (!shouldMaskForHandler(handler, tdoc)) return { tdoc, hidden: false, hiddenPids: new Set<number>() };
    const hiddenPids = await getHiddenPids(tdoc, body?.pdict);
    const pdoc = await resolvePdoc(handler, body || {}, rdoc);
    if (isObjectivePdoc(pdoc, config)) {
      hiddenPids.add(+pdoc.docId);
    }
    const pid = getPidFromDocs(rdoc, body?.rdoc, body?.record, handler?.rdoc, handler?.record, pdoc, body?.pdoc, handler?.pdoc);
    return { tdoc, hidden: hiddenPids.has(pid), hiddenPids };
  }

  function isRecordDetailConnection(handler: any) {
    const name = handler?.constructor?.name;
    const path = handler?.request?.path || handler?.context?.path || '';
    return name === 'RecordDetailConnectionHandler'
      || name === 'RecordDetailConnection'
      || path.endsWith('/record-detail-conn')
      || path === '/record-detail-conn';
  }

  for (const ruleName of config.rules) {
    const rule = ContestModel.RULES[ruleName];
    if (!rule) continue;
    const originalApplyProjection = rule.applyProjection.bind(rule);
    rule.applyProjection = (tdoc: AnyDoc, rdoc: AnyDoc, user: AnyDoc) => {
      const projected = originalApplyProjection(tdoc, rdoc, user);
      if (!shouldMaskInProjection(tdoc)) return projected;
      return maskMaybe(projected, getHiddenPidsSync(tdoc), config);
    };
  }

  ctx.on('handler/before/RecordList#get', async (handler: any) => {
    const tdoc = handler.tdoc;
    if (!config.stripStatusFilter || !shouldMaskForHandler(handler, tdoc)) return;
    if (hasOwn(handler.args, 'status')) delete handler.args.status;
  });

  ctx.on('handler/after/ContestProblemList#get', async (handler: any) => {
    const body = handler.response.body;
    const tdoc = body?.tdoc || handler.tdoc;
    if (!shouldMaskForHandler(handler, tdoc)) return;
    const hiddenPids = await getHiddenPids(tdoc, body.pdict);

    body.rdocs = (body.rdocs || []).map((rdoc: AnyDoc) => maskMaybe(rdoc, hiddenPids, config));
    maskDict(body.rdict, hiddenPids, config);
    maskDict(body.psdict, hiddenPids, config);
    maskDict(body.correction, hiddenPids, config);
  });

  ctx.on('handler/after/RecordList#get', async (handler: any) => {
    const body = handler.response.body;
    const tdoc = body?.tdoc || handler.tdoc;
    if (!shouldMaskForHandler(handler, tdoc)) return;
    const hiddenPids = await getHiddenPids(tdoc, body.pdict);
    body.rdocs = (body.rdocs || []).map((rdoc: AnyDoc) => maskMaybe(rdoc, hiddenPids, config));
  });

  ctx.on('handler/after/RecordDetail#get', async (handler: any) => {
    const body = handler.response.body;
    const { hidden, hiddenPids } = await isHiddenRecord(handler, body);
    if (!hidden) return;
    maskRecordDetailBody(body, config);

    // Warm cache so websocket updates on the same page are also projected.
    if (body?.pdoc?.docId) hiddenPids.add(+body.pdoc.docId);
  });

  ctx.on('handler/after/ProblemDetail#get', async (handler: any) => {
    const body = handler.response.body;
    const tdoc = body?.tdoc || handler.tdoc;
    if (!shouldMaskForHandler(handler, tdoc)) return;
    const hiddenPids = await getHiddenPids(tdoc);

    // The problem-detail tab strip treats any non-AC status as a failed icon.
    // Keep that compact navigation neutral while record views show "submitted".
    maskDict(body?.tsdoc?.detail, hiddenPids, config, 'hidden');
    if (isObjectivePdoc(body?.pdoc, config)) body.rdoc = maskRecord(body.rdoc, config);
  });

  ctx.on('handler/after/ContestScoreboard#get', async (handler: any) => {
    const body = handler.response.body;
    const tdoc = body?.tdoc || handler.tdoc;
    if (!shouldMaskForHandler(handler, tdoc)) return;
    const hiddenPids = await getHiddenPids(tdoc, body.pdict);
    maskRows(body.rows, hiddenPids, config);
  });

  ctx.on('record/judge', async (rdoc: AnyDoc) => {
    if (!rdoc?.contest) return;
    try {
      const tdoc = await ContestModel.get(rdoc.domainId, rdoc.contest);
      if (shouldApply(tdoc, config, manualContests)) await getHiddenPids(tdoc);
    } catch (e: any) {
      logger.warn(`Failed to warm objective-score cache: ${e.message}`);
    }
  });

  ctx.on('handler/create/ws', async (handler: any) => {
    if (!isRecordDetailConnection(handler)) return;
    const { hidden, hiddenPids } = await isHiddenRecord(handler);
    if (!hidden) return;
    if (handler?.pdoc?.docId) hiddenPids.add(+handler.pdoc.docId);
    patchConnectionSend(handler, config);
  });

  ctx.on('connection/active', async (handler: any) => {
    const { hidden, hiddenPids } = await isHiddenRecord(handler);
    if (!hidden) return;
    if (handler?.pdoc?.docId) hiddenPids.add(+handler.pdoc.docId);
    patchConnectionSend(handler, config);
  });

  ctx.on('handler/after/ContestEdit#post', async (handler: any) => {
    if (!config.persistFormField) return;
    const body = handler.request?.body || {};
    if (!hasOwn(body, config.formField)) return;
    const tid = handler.response?.body?.tid || handler.tdoc?.docId;
    const domainId = handler.args?.domainId;
    if (!tid || !domainId) return;
    const value = isTruthyFormValue(body[config.formField]);
    await ContestModel.edit(domainId, tid, { [config.writeContestFlagField]: value } as any);
    hiddenCache.delete(explicitKey(domainId, tid));
  });
}
