import {
  ConnectionHandler, ContestModel, ContestNotFoundError, Context, Handler,
  Logger, ObjectId, PERM, PermissionError, ProblemModel, Schema, STATUS, Types, param,
} from 'hydrooj';
import { LiveBoardEventStore } from './event-store';

const logger = new Logger('live-board');

type AnyDoc = Record<string, any>;
type Client = LiveBoardConnectionHandler;

const BoardConfig = Schema.object({
  domainId: Schema.string().default('system').description('Domain ID'),
  contestId: Schema.string().required().description('Contest ObjectId / docId'),
  slug: Schema.string().default('').description('Short relay URL slug, e.g. /b/slug'),
  token: Schema.string().default('').description('External display token'),
  title: Schema.string().default('').description('Display title'),
  showDisplayName: Schema.boolean().default(false).description('Show private display names if available'),
  maskDisplayName: Schema.boolean().default(false).description('Mask the middle of display names'),
  allowIps: Schema.array(Schema.string()).default([]).description('Allowed IPs or prefix patterns ending with *'),
});

export const name = 'live-board';

export const Config = Schema.object({
  boards: Schema.array(BoardConfig).role('table').default([]).description('Contest display entries'),
  showDisplayName: Schema.boolean().default(false).description('Default display-name mode'),
  maskDisplayName: Schema.boolean().default(false).description('Default display-name masking mode'),
  refreshThrottleMs: Schema.number().min(50).max(5000).default(500).description('Server-side event merge window'),
  eventFocusMs: Schema.number().min(500).max(30000).default(5000).description('Frontend focus duration after an event'),
  displayMinIntervalMs: Schema.number().min(0).max(10000).default(1500).description('Minimum frontend interval between animated board updates'),
  displayMaxAnimatedRankDelta: Schema.number().min(1).max(200).default(20).description('Maximum rank distance animated before the viewport jumps closer'),
  followEventScroll: Schema.boolean().default(true).description('Scroll the display to the focused row when an event is shown'),
  idleScrollSpeed: Schema.number().min(0).max(300).default(24).description('Idle auto-scroll speed in px/s'),
  maxCellTextLength: Schema.number().min(8).max(200).default(32).description('Maximum score-cell text length'),
  storageEnabled: Schema.boolean().default(true).description('Write replay events and snapshots to local files'),
  storageDir: Schema.string().default('data/live-board').description('Replay event store directory'),
  snapshotEveryEvents: Schema.number().min(1).max(1000).default(20).description('Store a replay snapshot after this many finished submissions'),
  snapshotEveryMs: Schema.number().min(1000).max(3600000).default(30000).description('Store a replay snapshot after this time window'),
  replayRetentionDays: Schema.number().min(0).max(3650).default(30).description('Replay snapshot retention; 0 disables cleanup'),
  recordWhenNoClients: Schema.boolean().default(true).description('Keep recording replay data even if nobody is watching the Hydro page'),
}).description('External IOI live board');

interface RuntimeEvent {
  uid?: number;
  pid?: number;
  rid?: string;
  score?: number;
  status?: number;
}

interface BoardCache {
  key: string;
  domainId: string;
  tid: ObjectId;
  seq: number;
  state?: AnyDoc;
  clients: Set<Client>;
  events: RuntimeEvent[];
  timer?: NodeJS.Timeout;
}

let runtime: LiveBoardRuntime;

function idToString(id: any) {
  return id?.toHexString?.() || id?.toString?.() || `${id}`;
}

function boardKey(domainId: string, tid: any) {
  return `${domainId}/${idToString(tid)}`;
}

function parseContestId(tid: any) {
  if (tid?.toHexString) return tid;
  const value = idToString(tid);
  return /^[0-9a-f]{24}$/i.test(value) ? new ObjectId(value) : tid;
}

function contestIdCandidates(tdoc: AnyDoc) {
  return Array.from(new Set([
    tdoc.docId && idToString(tdoc.docId),
    tdoc._id && idToString(tdoc._id),
  ].filter(Boolean)));
}

function text(value: any) {
  if (value === null || value === undefined) return '';
  return `${value}`;
}

function stripHtml(value: any) {
  return text(value).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function pickUserDisplayName(udoc: AnyDoc = {}) {
  return stripHtml(
    udoc.displayName
      || udoc.realName
      || udoc.realname
      || udoc.name
      || '',
  );
}

function getUserModel() {
  return (global as any).Hydro?.model?.user;
}

function maskName(name: string) {
  const chars = Array.from(name);
  const chineseIndexes = chars
    .map((char, index) => (/[\u3400-\u9fff]/u.test(char) ? index : -1))
    .filter((index) => index >= 0);
  if (chineseIndexes.length < 2) return name;
  chars[chineseIndexes[chineseIndexes.length - 2]] = '*';
  return chars.join('');
}

function serializeRaw(raw: any): any {
  if (raw === null || raw === undefined) return null;
  if (raw?.toHexString) return raw.toHexString();
  if (raw instanceof Array) return raw.map(serializeRaw);
  if (typeof raw === 'object') return JSON.parse(JSON.stringify(raw, (_, value) => {
    if (value?.toHexString) return value.toHexString();
    return value;
  }));
  return raw;
}

function isRunning(status: number) {
  return [
    STATUS.STATUS_WAITING,
    STATUS.STATUS_FETCHED,
    STATUS.STATUS_COMPILING,
    STATUS.STATUS_JUDGING,
  ].includes(status);
}

function ipAllowed(ip: string, patterns: string[]) {
  if (!patterns?.length) return true;
  return patterns.some((pattern) => {
    if (!pattern) return false;
    if (pattern.endsWith('*')) return ip.startsWith(pattern.slice(0, -1));
    return ip === pattern;
  });
}

class LiveBoardRuntime {
  caches = new Map<string, BoardCache>();
  store: LiveBoardEventStore;

  constructor(public ctx: Context, public config: ReturnType<typeof Config>) {
    this.store = new LiveBoardEventStore({
      enabled: config.storageEnabled,
      dir: config.storageDir,
      snapshotEveryEvents: config.snapshotEveryEvents,
      snapshotEveryMs: config.snapshotEveryMs,
      retentionDays: config.replayRetentionDays,
    });
  }

  getCache(domainId: string, tid: ObjectId) {
    const key = boardKey(domainId, tid);
    let cache = this.caches.get(key);
    if (!cache) {
      cache = {
        key,
        domainId,
        tid,
        seq: 0,
        clients: new Set(),
        events: [],
      };
      this.caches.set(key, cache);
    }
    return cache;
  }

  getBoardConfig(tdoc: AnyDoc) {
    const ids = contestIdCandidates(tdoc);
    const board = (this.config.boards || []).find((item) => (
      item.domainId === tdoc.domainId && ids.includes(idToString(item.contestId))
    ));
    if (!board) {
      logger.warn(`Live board config not found for ${tdoc.domainId}/${ids.join('|') || '<unknown>'}`);
    }
    return board;
  }

  isConfiguredBoard(domainId: string, tid: any) {
    const key = boardKey(domainId, tid);
    return (this.config.boards || []).some((item) => boardKey(item.domainId, item.contestId) === key);
  }

  isAdmin(handler: any, tdoc: AnyDoc) {
    return handler.user?.own?.(tdoc)
      || handler.user?.hasPerm?.(PERM.PERM_EDIT_CONTEST)
      || handler.user?.hasPerm?.(PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD);
  }

  async checkAccess(handler: any, tdoc: AnyDoc, token = '') {
    if (!tdoc) throw new ContestNotFoundError(handler.args?.domainId, handler.args?.tid);
    const board = this.getBoardConfig(tdoc);
    const tokenOk = !!board?.token && board.token === token;
    if (tokenOk && ipAllowed(handler.request?.ip || '', board.allowIps || [])) return board;
    if (this.isAdmin(handler, tdoc)) return board;
    throw new PermissionError(PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD);
  }

  async buildState(domainId: string, tid: ObjectId, translate: (s: string) => string, event?: AnyDoc, store = true) {
    const tdoc = await ContestModel.get(domainId, tid);
    if (!tdoc) throw new ContestNotFoundError(domainId, tid);
    const board = this.getBoardConfig(tdoc);
    const rule = ContestModel.RULES[tdoc.rule];
    if (!rule) throw new Error(`Unsupported contest rule: ${tdoc.rule}`);

    const title = board?.title || tdoc.title;
    const showDisplayName = board?.showDisplayName ?? this.config.showDisplayName;
    const maskDisplayName = board?.maskDisplayName ?? this.config.maskDisplayName;
    const pdict = await ProblemModel.getList(
      domainId,
      tdoc.pids,
      true,
      true,
      ProblemModel.PROJECTION_CONTEST_DETAIL,
    );
    const cursor = ContestModel.getMultiStatus(domainId, { docId: tdoc.docId })
      .sort(rule.statusSort);
    const [rawRows, udict] = await rule.scoreboard(
      { isExport: false, showDisplayName },
      translate,
      tdoc,
      pdict,
      cursor,
    );
    const displayUdict = await this.loadDisplayUsers(domainId, rawRows, showDisplayName, udict);

    const cache = this.getCache(domainId, tid);
    cache.seq++;
    const state = this.normalizeState(tdoc, pdict, rawRows, cache.seq, title, event, displayUdict, showDisplayName, maskDisplayName);
    await this.persistBoardMeta(tdoc, board);
    if (store) {
      cache.state = state;
      this.store.appendSnapshot(domainId, tid, state);
    }
    return state;
  }

  async syncConfiguredBoards() {
    for (const board of this.config.boards || []) {
      try {
        await this.buildState(board.domainId, parseContestId(board.contestId), (s) => s);
      } catch (e: any) {
        logger.warn(`Failed to sync live board ${board.domainId}/${board.contestId}: ${e.message}`);
      }
    }
  }

  async loadDisplayUsers(domainId: string, rawRows: AnyDoc[][], showDisplayName: boolean, fallback: Record<number, AnyDoc> = {}) {
    if (!showDisplayName) return fallback;
    const header = rawRows[0] || [];
    const userIndex = header.findIndex((cell) => cell?.type === 'user');
    const uids = Array.from(new Set(rawRows.slice(1)
      .map((row) => +(row[userIndex]?.raw || 0))
      .filter(Boolean)));
    if (!uids.length) return fallback;
    try {
      return await getUserModel().getListForRender(domainId, uids, ['displayName']);
    } catch (e: any) {
      logger.warn(`Failed to load live board display names: ${e.message}`);
      return fallback;
    }
  }

  async persistBoardMeta(tdoc: AnyDoc, board: AnyDoc = {}) {
    await this.store.ensureBoard(tdoc.domainId, tdoc.docId || tdoc._id, {
      title: board?.title || tdoc.title,
      slug: board?.slug || '',
      token: board?.token || '',
      beginAt: tdoc.beginAt,
      endAt: tdoc.endAt,
      rule: tdoc.rule,
    }).catch((e: any) => logger.warn(`Failed to write live board meta: ${e.message}`));
  }

  normalizeState(
    tdoc: AnyDoc,
    pdict: Record<number, AnyDoc>,
    rawRows: AnyDoc[][],
    seq: number,
    title: string,
    event?: AnyDoc,
    udict: Record<number, AnyDoc> = {},
    showDisplayName = false,
    maskDisplayName = false,
  ) {
    const header = rawRows[0] || [];
    const rankIndex = header.findIndex((cell) => cell?.type === 'rank');
    const userIndex = header.findIndex((cell) => cell?.type === 'user');
    const totalIndex = header.findIndex((cell) => cell?.type === 'total_score');
    const problemColumns = header
      .map((cell, index) => ({ cell, index }))
      .filter(({ cell }) => cell?.type === 'problem')
      .map(({ cell, index }) => {
        const pid = +cell.raw;
        return {
          index,
          pid,
          label: text(cell.value),
          title: text(pdict[pid]?.title || pid),
          maxScore: tdoc.score?.[pid] || 100,
        };
      });

    const firstByPid: Record<string, number> = {};
    const rows = rawRows.slice(1).map((row, order) => {
      const userCell = row[userIndex] || {};
      const uid = +userCell.raw;
      const udoc = udict?.[uid] || {};
      const preferredName = pickUserDisplayName(udoc);
      const displayName = showDisplayName && preferredName
        ? (maskDisplayName ? maskName(preferredName) : preferredName)
        : userCell.value || uid;
      const cells = problemColumns.map((problem) => {
        const cell = row[problem.index] || {};
        const value = text(cell.value).slice(0, this.config.maxCellTextLength);
        const firstAccepted = text(cell.style).includes('217, 240, 199');
        if (firstAccepted && uid) firstByPid[problem.pid] = uid;
        return {
          pid: problem.pid,
          value,
          score: typeof cell.score === 'number' ? cell.score : null,
          raw: serializeRaw(cell.raw),
          firstAccepted,
        };
      });
      return {
        uid,
        rank: text(row[rankIndex]?.value || order + 1),
        name: stripHtml(displayName),
        total: stripHtml(row[totalIndex]?.value || 0),
        cells,
      };
    });

    return {
      seq,
      generatedAt: Date.now(),
      contest: {
        domainId: tdoc.domainId,
        tid: idToString(tdoc.docId || tdoc._id),
        title,
        rule: tdoc.rule,
        beginAt: tdoc.beginAt,
        endAt: tdoc.endAt,
      },
      problems: problemColumns.map(({ index: _index, ...problem }) => problem),
      rows,
      firstByPid,
      event,
    };
  }

  summarizeEvent(previousState: AnyDoc, events: RuntimeEvent[], nextState: AnyDoc) {
    const previousFirst = previousState?.firstByPid || {};
    const firstPids = Object.keys(nextState.firstByPid || {})
      .filter((pid) => previousFirst[pid] !== nextState.firstByPid[pid])
      .map((pid) => +pid);
    const eventByUid = new Map<number, RuntimeEvent>();
    for (const item of events) {
      if (item.uid) eventByUid.set(item.uid, item);
    }
    const focusedUid = nextState.rows
      .map((row: AnyDoc) => +row.uid)
      .find((uid: number) => eventByUid.has(uid));
    const last = focusedUid ? eventByUid.get(focusedUid) || {} : [...events].reverse().find((item) => item.uid) || {};
    return {
      uid: last.uid,
      pid: last.pid,
      rid: last.rid,
      score: last.score,
      status: last.status,
      firstPids,
      batchSize: events.length,
      kind: last.pid !== undefined && firstPids.includes(last.pid) ? 'firstAccepted'
        : last.status === STATUS.STATUS_ACCEPTED ? 'accepted'
          : 'updated',
    };
  }

  async flush(cache: BoardCache) {
    cache.timer = null;
    const events = cache.events.splice(0);
    try {
      const previousState = cache.state;
      const state = await this.buildState(cache.domainId, cache.tid, (s) => s, undefined, false);
      state.event = this.summarizeEvent(previousState, events, state);
      cache.state = state;
      this.store.appendSnapshot(cache.domainId, cache.tid, state, true);
      for (const client of cache.clients) client.send({ type: 'state', state });
    } catch (e: any) {
      logger.warn(`Failed to flush live board ${cache.key}: ${e.message}`);
      for (const client of cache.clients) client.send({ type: 'error', message: e.message });
    }
  }

  schedule(domainId: string, tid: ObjectId, event: RuntimeEvent) {
    const cache = this.getCache(domainId, tid);
    if (!cache.clients.size && !this.config.recordWhenNoClients) return;
    cache.events.push(event);
    if (cache.timer) return;
    cache.timer = setTimeout(() => this.flush(cache), this.config.refreshThrottleMs);
  }

  onRecordChange(rdoc: AnyDoc) {
    if (!rdoc?.contest || rdoc.contest.toString() === '0'.repeat(24)) return;
    if (isRunning(rdoc.status)) return;
    if (!this.isConfiguredBoard(rdoc.domainId, rdoc.contest)) return;
    const event = {
      uid: rdoc.uid,
      pid: rdoc.pid,
      rid: idToString(rdoc._id),
      score: rdoc.score,
      status: rdoc.status,
    };
    this.store.appendEvent(rdoc.domainId, rdoc.contest, event);
    this.schedule(rdoc.domainId, rdoc.contest, event);
  }

  addClient(cache: BoardCache, client: Client) {
    cache.clients.add(client);
  }

  removeClient(cacheKey: string, client: Client) {
    const cache = this.caches.get(cacheKey);
    if (!cache) return;
    cache.clients.delete(client);
  }
}

class LiveBoardPageHandler extends Handler {
  noCheckPermView = true;

  @param('tid', Types.ObjectId)
  @param('token', Types.String, true)
  async get(domainId: string, tid: ObjectId, token = '') {
    const tdoc = await ContestModel.get(domainId, tid);
    await runtime.checkAccess(this, tdoc, token);
    const state = await runtime.buildState(domainId, tid, this.translate.bind(this));
    this.response.template = 'live_board.html';
    this.response.body = {
      state,
      token,
      options: {
        eventFocusMs: runtime.config.eventFocusMs,
        displayMinIntervalMs: runtime.config.displayMinIntervalMs,
        displayMaxAnimatedRankDelta: runtime.config.displayMaxAnimatedRankDelta,
        followEventScroll: runtime.config.followEventScroll,
        idleScrollSpeed: runtime.config.idleScrollSpeed,
      },
      stateUrl: this.url('live_board_state', { tid, query: { token } }),
      socketUrl: `/live-board-conn?domainId=${encodeURIComponent(domainId)}&tid=${idToString(tid)}&token=${encodeURIComponent(token)}`,
    };
  }
}

class LiveBoardStateHandler extends Handler {
  noCheckPermView = true;

  @param('tid', Types.ObjectId)
  @param('token', Types.String, true)
  async get(domainId: string, tid: ObjectId, token = '') {
    const tdoc = await ContestModel.get(domainId, tid);
    await runtime.checkAccess(this, tdoc, token);
    this.response.body = await runtime.buildState(domainId, tid, this.translate.bind(this));
  }
}

class LiveBoardConnectionHandler extends ConnectionHandler {
  noCheckPermView = true;
  cacheKey = '';

  @param('tid', Types.ObjectId)
  @param('token', Types.String, true)
  async prepare(domainId: string, tid: ObjectId, token = '') {
    const tdoc = await ContestModel.get(domainId, tid);
    await runtime.checkAccess(this, tdoc, token);
    const cache = runtime.getCache(domainId, tid);
    this.cacheKey = cache.key;
    runtime.addClient(cache, this);
    const state = cache.state || await runtime.buildState(domainId, tid, this.translate.bind(this));
    this.send({ type: 'state', state });
  }

  async cleanup() {
    if (this.cacheKey) runtime.removeClient(this.cacheKey, this);
  }
}

export async function apply(ctx: Context, config: ReturnType<typeof Config>) {
  runtime = new LiveBoardRuntime(ctx, config);
  ctx.Route('live_board', '/contest/:tid/live-board', LiveBoardPageHandler);
  ctx.Route('live_board_state', '/contest/:tid/live-board/state', LiveBoardStateHandler);
  ctx.Connection('live_board_conn', '/live-board-conn', LiveBoardConnectionHandler);
  ctx.on('record/change', (rdoc: AnyDoc) => runtime.onRecordChange(rdoc));
  void runtime.syncConfiguredBoards();
}
