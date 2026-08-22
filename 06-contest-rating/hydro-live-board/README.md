# hydro-live-board

External live board for IOI-style Hydro contests.

This addon registers an independent display page and websocket. It does not use
Hydro's default contest scoreboard handler and does not call contest record
projection, so it is suitable for a non-contestant display screen.

## Routes

```text
/contest/:tid/live-board?token=TOKEN
/contest/:tid/live-board/state?token=TOKEN
/live-board-conn?domainId=DOMAIN&tid=TID&token=TOKEN
```

Logged-in contest owners and users with `PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD`
can access the page without a token. External display machines should use a
token configured below.

## Config

```yaml
hydro-live-board:
  boards:
    - domainId: system
      contestId: 000000000000000000000000
      slug: live
      token: change-me
      title: Live Board
      showDisplayName: false
      maskDisplayName: false
      allowIps: []
  showDisplayName: false
  maskDisplayName: false
  refreshThrottleMs: 500
  maxCellTextLength: 32
  storageEnabled: true
  storageDir: data/live-board
  snapshotEveryEvents: 20
  snapshotEveryMs: 30000
  replayRetentionDays: 30
  recordWhenNoClients: true
```

`allowIps` is optional. Entries can be exact IPs or prefix patterns ending with
`*`, for example `192.168.1.*`.

Set `showDisplayName: true` to use Hydro display names instead of login names.
Set `maskDisplayName: true` to hide the middle of display names before they are
written to replay files and sent to relay viewers.

## Replay Store and Relay

This addon can write a local replay store so external viewers do not need to
connect to the Hydro process directly.

```text
Hydro record/change
  -> event-store.ts writes events.ndjson and snapshots/*.json.gz
  -> relay-server.js reads those files
  -> viewers connect to the relay service
```

The replay store is per contest:

```text
data/live-board/
  system-000000000000000000000000/
    board.json
    events.ndjson
    latest.json
    snapshots/
      1710000000000-000001-xxxxxxxxxx.json.gz
```

`events.ndjson` is the raw finished-submission event log. `latest.json` and
`snapshots/*.json.gz` contain rendered board states for fast live display and
timeline seeking. The relay uses the board token from `board.json` for access
checks but never returns that token in API responses.

Run the relay on the machine that can read `storageDir`:

```bash
LIVE_BOARD_STORE_DIR=/path/to/data/live-board LIVE_BOARD_RELAY_PORT=7007 npm run relay
```

Relay API:

```text
GET /health
GET /api/boards
GET /b/:slug?token=TOKEN
GET /board/:domainId/:contestId?token=TOKEN
GET /api/:domainId/:contestId/latest?token=TOKEN
GET /api/:domainId/:contestId/replay/meta?token=TOKEN
GET /api/:domainId/:contestId/replay/state?at=ELAPSED_MS&token=TOKEN
GET /api/:domainId/:contestId/stream?token=TOKEN
```

Open the relay display page with:

```text
http://127.0.0.1:7007/b/live?token=TOKEN
http://127.0.0.1:7007/board/system/000000000000000000000000?token=TOKEN
```

Relay display options such as follow-row scrolling, idle scroll speed, update
interval, and animated rank distance are H5-only settings. Use the Settings
button on the relay page; values are saved in that browser's localStorage and do
not affect other viewers.

`stream` is Server-Sent Events. It is intentionally hosted by the relay, not by
Hydro, so hundreds or thousands of public viewers do not hold websocket
connections on the main contest service. For each contest, the relay keeps one
file polling loop and broadcasts cached updates plus heartbeat events to all
connected viewers.

## Performance Model

- The websocket listens to Hydro `record/change`.
- Finished submissions are merged for `refreshThrottleMs` before refreshing the
  board.
- The server recalculates one contest scoreboard snapshot per merged batch.
- The frontend plays animated board updates no faster than
  `displayMinIntervalMs`; during bursts it keeps the latest states and skips
  stale intermediate frames.
- When several submissions are merged into one board update, the focused row is
  the changed team with the best new rank. Set `followEventScroll: false` to
  update the board without moving the scroll position.
- If the focused team moves more than `displayMaxAnimatedRankDelta` ranks, the
  viewport jumps closer first and only the final rank segment is animated.
- Replay events and snapshots are written to local files outside Hydro's main
  database.
- For large public audiences, use `relay-server.js` and expose the relay through
  Nginx/CDN instead of sending viewers to the Hydro websocket page.
- The frontend keeps stable row keys by UID and uses FLIP-style row movement,
  instead of rebuilding an overlay animation.
- When there is no event, the table container scrolls slowly. Event focus pauses
  the idle scroll, jumps to the team row, and then lets the row move upward with
  the reordered table.

This first version is intended for normal school-contest scale. If the contest
has several thousand teams and very high submit frequency, the next optimization
should be replacing full scoreboard recompute with per-UID incremental status
updates.

## Install

Put this directory on the Hydro server, then run:

```bash
hydrooj addon add /path/to/hydro-live-board
```

Restart Hydro after installing or updating.
