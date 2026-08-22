import { AutoloadPage, $, addPage } from '@hydrooj/ui-default';

const HEARTBEAT_INTERVAL = (window as any).PRESENCE_HEARTBEAT_INTERVAL || 60 * 1000; // 60s
const LEADER_TTL = Math.max(HEARTBEAT_INTERVAL * 1.5, 90 * 1000);
const JITTER_MS = Math.min(HEARTBEAT_INTERVAL * 0.2, 15 * 1000);
const TAB_ID_KEY = 'presence_tab_id';
const HEARTBEAT_RETRY = 2;
const HEARTBEAT_RETRY_DELAY_MS = 200;

interface LeaderState { id: string, ts: number, sid?: string }

function now() { return Date.now(); }
function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }


let storageEnabled = true;
function safeGet(key: string) {
    if (!storageEnabled) return null;
    try { return localStorage.getItem(key); } catch (e) { storageEnabled = false; return null; }
}
function safeSet(key: string, value: string) {
    if (!storageEnabled) return false;
    try { localStorage.setItem(key, value); return true; } catch (e) { storageEnabled = false; return false; }
}

function getTabId() {
    try {
        const existing = sessionStorage.getItem(TAB_ID_KEY);
        if (existing) return existing;
        const id = Math.random().toString(36).slice(2);
        sessionStorage.setItem(TAB_ID_KEY, id);
        return id;
    } catch (e) {
        return Math.random().toString(36).slice(2);
    }
}

function getLeaderKey(sessionId?: string) {
    const uid = UserContext?._id;
    const key = uid || sessionId || 'anon';
    return `presence_leader_${key}`;
}

function readLeader(key: string): LeaderState | null {
    const raw = safeGet(key);
    if (!raw) return null;
    try { return JSON.parse(raw) as LeaderState; } catch (e) { return null; }
}

function writeLeader(key: string, state: LeaderState) {
    return safeSet(key, JSON.stringify(state));
}

function leaderValid(cur: LeaderState | null, sessionId?: string) {
    if (!cur || typeof cur.ts !== 'number') return false;
    if ((now() - cur.ts) > LEADER_TTL) return false;
    if (sessionId && cur.sid && cur.sid !== sessionId) return false;
    return true;
}

function ensureLeader(key: string, tabId: string, sessionId?: string) {
    if (!storageEnabled) return true;
    const cur = readLeader(key);
    if (!leaderValid(cur, sessionId)) {
        return writeLeader(key, { id: tabId, ts: now(), sid: sessionId });
    }
    if (cur && cur.id === tabId) {
        cur.ts = now();
        cur.sid = sessionId;
        writeLeader(key, cur);
        return true;
    }
    return false;
}

async function sendHeartbeat(sessionId?: string, useBeacon = false) {
    const body = sessionId ? JSON.stringify({ sessionId }) : '{}';
    if (useBeacon && navigator.sendBeacon) {
        try {
            const ok = navigator.sendBeacon('/presence/heartbeat', new Blob([body], { type: 'application/json' }));
            if (ok) return;
        } catch (e) {
            // fallback to fetch
        }
    }
    for (let attempt = 0; attempt <= HEARTBEAT_RETRY; attempt += 1) {
        try {
            await fetch('/presence/heartbeat', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body,
                keepalive: true,
            });
            return;
        } catch (e) {
            if (attempt >= HEARTBEAT_RETRY) break;
            const jitter = Math.floor(Math.random() * 100);
            await delay(HEARTBEAT_RETRY_DELAY_MS * (attempt + 1) + jitter);
        }
    }
}

function startPresenceHeartbeats(sessionId?: string) {
    const uid = UserContext?._id;
    if ((!uid || +uid < 1) && !sessionId) return () => null;

    const tabId = getTabId();
    const leaderKey = getLeaderKey(sessionId);
    let timer: number | null = null;

    const tick = async () => {
        const isLeader = ensureLeader(leaderKey, tabId, sessionId);
        if (isLeader) await sendHeartbeat(sessionId);
        const delay = HEARTBEAT_INTERVAL + (JITTER_MS ? Math.floor(Math.random() * JITTER_MS) : 0);
        timer = window.setTimeout(tick, delay);
    };

    const onVisibility = () => {
        if (document.visibilityState === 'visible') {
            const isLeader = ensureLeader(leaderKey, tabId, sessionId);
            if (isLeader) sendHeartbeat(sessionId);
        }
    };

    const onUnload = () => sendHeartbeat(sessionId, true);

    const isLeader = ensureLeader(leaderKey, tabId, sessionId);
    if (isLeader) sendHeartbeat(sessionId);
    timer = window.setTimeout(tick, HEARTBEAT_INTERVAL + Math.floor(Math.random() * JITTER_MS));
    window.addEventListener('beforeunload', onUnload);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
        if (timer) window.clearTimeout(timer);
        window.removeEventListener('beforeunload', onUnload);
        document.removeEventListener('visibilitychange', onVisibility);
    };
}

addPage(new AutoloadPage('presence_heartbeat', () => {
    if ((window as any).__presenceHeartbeatStarted) return null;
    (window as any).__presenceHeartbeatStarted = true;
    const stop = startPresenceHeartbeats();
    return () => {
        if (stop) stop();
        (window as any).__presenceHeartbeatStarted = false;
    };
}));
