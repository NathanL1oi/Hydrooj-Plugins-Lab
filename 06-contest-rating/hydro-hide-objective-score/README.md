# hydro-hide-objective-score

Hide objective problem results during selected IOI-style contests.

The plugin only changes what normal contestants see. It does not modify judge
records, contest status documents, or real scores stored in MongoDB.

## Default Behavior

- Applies to `ioi` and `strictioi` contests.
- Does nothing unless the contest is explicitly enabled.
- Auto-detects problems whose `config.type` is `objective`.
- Hides objective problem results in:
  - contest problem detail page;
  - contest problem list;
  - submission list;
  - submission detail;
  - submission detail websocket updates after judging finishes;
  - default scoreboard cells.

Version `0.3.3` also masks the first `record-detail-conn` websocket frame.
Hydro sends this frame inside websocket `prepare()`, before the normal
`connection/active` event, so older versions could leak the real result after a
page refresh.
- Hides score, time, memory, progress, subtasks, cases, judge texts, compiler
  texts, and final AC/WA status. By default the final status is shown as
  `已递交`.
- Removes status filters from the contest submission list while hiding is active,
  to avoid inferring AC/WA from filtered result counts.
- Hides scoreboard total score by default, because otherwise contestants may
  infer objective scores from `total - programming_problem_scores`.
- Contest owner and users with `PERM_EDIT_CONTEST` can still see real results.
- Results are revealed after the contest ends by default.
- For contests with per-user duration windows, results are revealed to that user
  after Hydro's own `ContestModel.isDone(tdoc, tsdoc)` reports their personal
  contest window as done.

Important: the stock scoreboard row order/rank may still leak partial
information about hidden objective scores. For strict secrecy, also hide the
contest scoreboard during the contest or use a custom scoreboard that does not
rank by the hidden scores.

This plugin targets the stock contest pages and the default scoreboard view. It
does not rewrite exported HTML/CSV scoreboards or third-party scoreboard views.

## Enable A Contest

Default `enableMode` is `contestFlag`. A contest is affected only when one of
these is true:

- the contest document has `hideObjectiveScore: true`;
- the contest is listed in `enabledContests`;
- the contest is listed in deprecated `explicit`.

If you add a custom checkbox named `hideObjectiveScore` to the contest edit form,
the plugin can persist it automatically into the contest document. Without a UI
customization, use `enabledContests` in the plugin config.

When adding that checkbox, include a hidden input with the same name and value
`0` before the checkbox, because unchecked HTML checkboxes are not submitted.

## Config

```yaml
hydro-hide-objective-score:
  rules:
    - ioi
    - strictioi
  enableMode: contestFlag
  contestFlagFields:
    - hideObjectiveScore
  problemTypes:
    - objective
  revealAfterContest: true
  revealAfterUserContest: true
  hideStatus: true
  statusMode: submitted
  submittedStatusCode: -10001
  submittedStatusText: 已递交
  submittedStatusShortText: 已递交
  submittedStatusClass: waiting
  stripStatusFilter: true
  hideScoreboardProblemCells: true
  hideScoreboardTotal: true
  maskText: Hidden
  enabledContests:
    - domainId: system
      contestId: 000000000000000000000000
      pids: []
```

`enableMode`:

- `contestFlag`: use contest document flags and `enabledContests`.
- `explicit`: only use `enabledContests`.
- `always`: affect every matching `ioi` / `strictioi` contest.

`statusMode`:

- `submitted`: show final hidden submissions as `已递交`.
- `hidden`: delete final status, so AC/WA is not displayed.
- `ignored`: show final hidden submissions as Hydro `Ignored`.

`submittedStatusText`, `submittedStatusShortText`, and `submittedStatusClass`
can be changed if you want a different display text or CSS class. The default
class is `waiting`, so the icon does not look like Hydro `Ignored` / canceled.

`pids` in `enabledContests` are optional extra problem IDs. Objective problems
are still auto-detected from `config.type: objective`.

## Install

Put this directory on the Hydro server, then run:

```bash
hydrooj addon add /path/to/hydro-hide-objective-score
```

Then restart Hydro. The package entry point is `index.ts`, and the config scope
is the package name: `hydro-hide-objective-score`.
