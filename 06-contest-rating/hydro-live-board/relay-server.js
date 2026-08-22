#!/usr/bin/env node
const { promises: fs } = require('fs');
const http = require('http');
const path = require('path');
const { gunzipSync } = require('zlib');

const storeDir = path.resolve(process.env.LIVE_BOARD_STORE_DIR || 'data/live-board');
const port = Number(process.env.LIVE_BOARD_RELAY_PORT || 7007);
const pollMs = Number(process.env.LIVE_BOARD_RELAY_POLL_MS || 1000);
const heartbeatMs = Number(process.env.LIVE_BOARD_RELAY_HEARTBEAT_MS || 25000);
const relayPageFile = path.join(__dirname, 'relay-board.html');

function sendJson(res, status, data) {
  const body = `${JSON.stringify(data)}\n`;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function notFound(res) {
  sendJson(res, 404, { error: 'not_found' });
}

function badRequest(res, message) {
  sendJson(res, 400, { error: message });
}

function safePart(value) {
  return `${value}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function boardPath(domainId, contestId) {
  return path.join(storeDir, `${safePart(domainId)}-${safePart(contestId)}`);
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function readGzipJson(file) {
  return JSON.parse(gunzipSync(await fs.readFile(file)).toString('utf8'));
}

async function readBoard(domainId, contestId) {
  return readJson(path.join(boardPath(domainId, contestId), 'board.json'));
}

function publicBoard(board) {
  const { token, ...rest } = board;
  return rest;
}

async function checkAccess(domainId, contestId, token) {
  const board = await readBoard(domainId, contestId);
  if (board.token && board.token !== token) {
    const error = new Error('forbidden');
    error.status = 403;
    throw error;
  }
  return board;
}

async function listBoards() {
  const entries = await fs.readdir(storeDir, { withFileTypes: true }).catch(() => []);
  const boards = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(storeDir, entry.name, 'board.json');
    try {
      const board = await readJson(file);
      boards.push(publicBoard(board));
    } catch { }
  }
  return boards;
}

async function findBoardBySlug(slug) {
  const entries = await fs.readdir(storeDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(storeDir, entry.name, 'board.json');
    try {
      const board = await readJson(file);
      if (board.slug === slug) return board;
    } catch { }
  }
  return null;
}

async function latestSnapshot(domainId, contestId) {
  return readJson(path.join(boardPath(domainId, contestId), 'latest.json'));
}

async function snapshotFiles(domainId, contestId) {
  const dir = path.join(boardPath(domainId, contestId), 'snapshots');
  const files = await fs.readdir(dir).catch(() => []);
  return files
    .filter((file) => file.endsWith('.json.gz'))
    .sort()
    .map((file) => path.join(dir, file));
}

async function snapshotMeta(domainId, contestId) {
  const files = await snapshotFiles(domainId, contestId);
  const snapshots = [];
  for (const file of files) {
    try {
      const snapshot = await readGzipJson(file);
      snapshots.push({
        id: snapshot.id,
        createdAt: snapshot.createdAt,
        elapsedMs: snapshot.elapsedMs,
        eventId: snapshot.eventId,
      });
    } catch { }
  }
  return snapshots;
}

async function snapshotAt(domainId, contestId, at) {
  const files = await snapshotFiles(domainId, contestId);
  let best = null;
  for (const file of files) {
    try {
      const snapshot = await readGzipJson(file);
      const elapsed = Number(snapshot.elapsedMs || 0);
      const createdAt = Number(snapshot.createdAt || 0);
      const point = at > 10_000_000_000 ? createdAt : elapsed;
      if (point <= at) best = snapshot;
      if (point > at) break;
    } catch { }
  }
  return best || latestSnapshot(domainId, contestId);
}

function parseBoardRoute(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api' || parts.length < 4) return null;
  return {
    domainId: decodeURIComponent(parts[1]),
    contestId: decodeURIComponent(parts[2]),
    action: parts.slice(3).join('/'),
  };
}

function parsePageRoute(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'b' && parts.length >= 2) {
    return { slug: decodeURIComponent(parts[1]) };
  }
  if (parts[0] !== 'board' || parts.length < 3) return null;
  return {
    domainId: decodeURIComponent(parts[1]),
    contestId: decodeURIComponent(parts[2]),
  };
}

async function renderBoardPage(reqUrl, board, token) {
  const domainId = board.domainId;
  const contestId = board.contestId;
  const page = await fs.readFile(relayPageFile, 'utf8');
  const latestUrl = `/api/${encodeURIComponent(domainId)}/${encodeURIComponent(contestId)}/latest?token=${encodeURIComponent(token)}`;
  const streamUrl = `/api/${encodeURIComponent(domainId)}/${encodeURIComponent(contestId)}/stream?token=${encodeURIComponent(token)}`;
  const replayMetaUrl = `/api/${encodeURIComponent(domainId)}/${encodeURIComponent(contestId)}/replay/meta?token=${encodeURIComponent(token)}`;
  const replayStateUrl = `/api/${encodeURIComponent(domainId)}/${encodeURIComponent(contestId)}/replay/state?token=${encodeURIComponent(token)}&at=`;
  const boot = {
    domainId,
    contestId,
    latestUrl,
    streamUrl,
    replayMetaUrl,
    replayStateUrl,
  };
  return page.replace('__LIVE_BOARD_RELAY_BOOTSTRAP__', JSON.stringify(boot).replace(/</g, '\\u003c'));
}

class LiveStreams {
  constructor() {
    this.items = new Map();
  }

  key(domainId, contestId) {
    return `${domainId}/${contestId}`;
  }

  add(domainId, contestId, res) {
    const key = this.key(domainId, contestId);
    let item = this.items.get(key);
    if (!item) {
      item = {
        domainId,
        contestId,
        clients: new Set(),
        timer: null,
        heartbeat: null,
        lastMtime: 0,
        latestPayload: '',
      };
      item.timer = setInterval(() => this.tick(item), pollMs);
      item.heartbeat = setInterval(() => this.heartbeat(item), heartbeatMs);
      this.items.set(key, item);
    }
    item.clients.add(res);
    if (item.latestPayload) this.write(res, 'state', item.latestPayload);
    else this.tick(item);
    res.on('close', () => {
      item.clients.delete(res);
      if (!item.clients.size) {
        clearInterval(item.timer);
        clearInterval(item.heartbeat);
        this.items.delete(key);
      }
    });
  }

  write(res, event, payload = '') {
    res.write(`event: ${event}\n`);
    if (payload) res.write(`data: ${payload}\n`);
    res.write('\n');
  }

  heartbeat(item) {
    for (const res of item.clients) this.write(res, 'ping', JSON.stringify({ now: Date.now() }));
  }

  async tick(item) {
    const file = path.join(boardPath(item.domainId, item.contestId), 'latest.json');
    const info = await fs.stat(file).catch(() => null);
    if (!info || info.mtimeMs <= item.lastMtime) return;
    item.lastMtime = info.mtimeMs;
    const snapshot = await latestSnapshot(item.domainId, item.contestId).catch(() => null);
    if (!snapshot) return;
    const payload = JSON.stringify({ type: 'state', snapshot });
    item.latestPayload = payload;
    for (const res of item.clients) {
      this.write(res, 'state', payload);
    }
  }
}

const streams = new LiveStreams();

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/health') return sendJson(res, 200, { ok: true });
  if (url.pathname === '/api/boards') return sendJson(res, 200, { boards: await listBoards() });

  const pageRoute = parsePageRoute(url);
  if (pageRoute) {
    const token = url.searchParams.get('token') || '';
    try {
      const board = pageRoute.slug
        ? await findBoardBySlug(pageRoute.slug)
        : await checkAccess(pageRoute.domainId, pageRoute.contestId, token);
      if (!board) return notFound(res);
      if (pageRoute.slug && board.token && board.token !== token) {
        const error = new Error('forbidden');
        error.status = 403;
        throw error;
      }
      return sendHtml(res, 200, await renderBoardPage(url, board, token));
    } catch (e) {
      return sendHtml(res, e.status || 500, `<pre>${e.message || 'internal_error'}</pre>`);
    }
  }

  const route = parseBoardRoute(url);
  if (!route) return notFound(res);
  const token = url.searchParams.get('token') || '';
  try {
    const board = await checkAccess(route.domainId, route.contestId, token);
    if (route.action === 'latest') {
      const snapshot = await latestSnapshot(route.domainId, route.contestId);
      return sendJson(res, 200, { board: publicBoard(board), snapshot });
    }
    if (route.action === 'replay/meta') {
      const snapshots = await snapshotMeta(route.domainId, route.contestId);
      return sendJson(res, 200, { board: publicBoard(board), snapshots });
    }
    if (route.action === 'replay/state') {
      const at = Number(url.searchParams.get('at'));
      if (!Number.isFinite(at)) return badRequest(res, 'invalid_at');
      const snapshot = await snapshotAt(route.domainId, route.contestId, at);
      return sendJson(res, 200, { board: publicBoard(board), snapshot });
    }
    if (route.action === 'stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write(`event: hello\n`);
      res.write(`data: ${JSON.stringify({ type: 'hello', board: publicBoard(board) })}\n\n`);
      streams.add(route.domainId, route.contestId, res);
      return undefined;
    }
  } catch (e) {
    return sendJson(res, e.status || 500, { error: e.message || 'internal_error' });
  }
  return notFound(res);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => sendJson(res, 500, { error: e.message || 'internal_error' }));
});

server.listen(port, () => {
  console.log(`hydro-live-board relay listening on http://127.0.0.1:${port}`);
  console.log(`store: ${storeDir}`);
});
