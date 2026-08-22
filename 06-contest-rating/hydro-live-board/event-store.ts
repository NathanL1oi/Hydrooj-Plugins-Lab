import { createHash } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import {
  appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile,
} from 'fs/promises';
import { join } from 'path';
import { createGzip } from 'zlib';

type AnyDoc = Record<string, any>;

export interface LiveBoardStoreConfig {
  enabled: boolean;
  dir: string;
  snapshotEveryEvents: number;
  snapshotEveryMs: number;
  retentionDays: number;
}

interface BoardStoreState {
  eventCount: number;
  snapshotCount: number;
  lastSnapshotAt: number;
  writeChain: Promise<void>;
}

function idToString(id: any) {
  return id?.toHexString?.() || id?.toString?.() || `${id}`;
}

function boardKey(domainId: string, tid: any) {
  return `${domainId}/${idToString(tid)}`;
}

function safePart(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function boardDir(root: string, domainId: string, tid: any) {
  return join(root, `${safePart(domainId)}-${safePart(idToString(tid))}`);
}

async function gzipFile(source: string, target: string) {
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(source);
    const output = createWriteStream(target);
    input.on('error', reject);
    output.on('error', reject);
    output.on('finish', resolve);
    input.pipe(createGzip()).pipe(output);
  });
}

export class LiveBoardEventStore {
  private states = new Map<string, BoardStoreState>();

  constructor(private config: LiveBoardStoreConfig) { }

  private getState(domainId: string, tid: any) {
    const key = boardKey(domainId, tid);
    let state = this.states.get(key);
    if (!state) {
      state = {
        eventCount: 0,
        snapshotCount: 0,
        lastSnapshotAt: 0,
        writeChain: Promise.resolve(),
      };
      this.states.set(key, state);
    }
    return state;
  }

  private enqueue(domainId: string, tid: any, task: () => Promise<void>) {
    if (!this.config.enabled) return;
    const state = this.getState(domainId, tid);
    state.writeChain = state.writeChain
      .then(task)
      .catch(() => { });
  }

  async ensureBoard(domainId: string, tid: any, meta: AnyDoc = {}) {
    if (!this.config.enabled) return;
    const dir = boardDir(this.config.dir, domainId, tid);
    await mkdir(join(dir, 'snapshots'), { recursive: true });
    await writeFile(join(dir, 'board.json'), `${JSON.stringify({
      domainId,
      contestId: idToString(tid),
      ...meta,
      updatedAt: Date.now(),
    }, null, 2)}\n`);
  }

  appendEvent(domainId: string, tid: any, event: AnyDoc) {
    this.enqueue(domainId, tid, async () => {
      const dir = boardDir(this.config.dir, domainId, tid);
      await mkdir(join(dir, 'snapshots'), { recursive: true });
      const state = this.getState(domainId, tid);
      state.eventCount++;
      const id = `${Date.now()}-${String(state.eventCount).padStart(8, '0')}`;
      await appendFile(join(dir, 'events.ndjson'), `${JSON.stringify({
        id,
        domainId,
        contestId: idToString(tid),
        createdAt: Date.now(),
        ...event,
      })}\n`);
    });
  }

  appendSnapshot(domainId: string, tid: any, stateDoc: AnyDoc, force = false) {
    this.enqueue(domainId, tid, async () => {
      const state = this.getState(domainId, tid);
      const now = Date.now();
      const enoughEvents = state.eventCount > 0
        && state.eventCount % Math.max(1, this.config.snapshotEveryEvents) === 0;
      const enoughTime = now - state.lastSnapshotAt >= this.config.snapshotEveryMs;
      if (!force && !enoughEvents && !enoughTime) return;

      const dir = boardDir(this.config.dir, domainId, tid);
      const snapshotsDir = join(dir, 'snapshots');
      await mkdir(snapshotsDir, { recursive: true });
      state.snapshotCount++;
      state.lastSnapshotAt = now;
      const elapsedMs = Math.max(0, now - Number(stateDoc?.contest?.beginAt || now));
      const snapshot = {
        id: `${now}-${String(state.snapshotCount).padStart(6, '0')}`,
        domainId,
        contestId: idToString(tid),
        createdAt: now,
        elapsedMs,
        eventId: stateDoc?.event?.rid || '',
        state: stateDoc,
      };
      const hash = createHash('sha1').update(JSON.stringify(snapshot.state)).digest('hex').slice(0, 10);
      const baseName = `${snapshot.id}-${hash}.json`;
      const tempPath = join(snapshotsDir, `${baseName}.tmp`);
      const jsonPath = join(snapshotsDir, baseName);
      const gzipPath = `${jsonPath}.gz`;
      await writeFile(tempPath, `${JSON.stringify(snapshot)}\n`);
      await rename(tempPath, jsonPath);
      await gzipFile(jsonPath, gzipPath);
      await rm(jsonPath, { force: true });
      await writeFile(join(dir, 'latest.json'), `${JSON.stringify(snapshot)}\n`);
      await this.cleanupOldSnapshots(snapshotsDir, now);
    });
  }

  private async cleanupOldSnapshots(snapshotsDir: string, now: number) {
    if (!this.config.retentionDays) return;
    const maxAge = this.config.retentionDays * 86400_000;
    const files = await readdir(snapshotsDir).catch(() => []);
    await Promise.all(files.map(async (file) => {
      if (!file.endsWith('.json.gz')) return;
      const path = join(snapshotsDir, file);
      const info = await stat(path).catch(() => null);
      if (info && now - info.mtimeMs > maxAge) await rm(path, { force: true });
    }));
  }

  async readLatest(domainId: string, tid: any) {
    const data = await readFile(join(boardDir(this.config.dir, domainId, tid), 'latest.json'), 'utf8');
    return JSON.parse(data);
  }
}
