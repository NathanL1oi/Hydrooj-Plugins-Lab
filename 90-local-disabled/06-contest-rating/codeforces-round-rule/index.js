const {
  ContestModel, Handler, ObjectId, PERM, ProblemModel, STATUS, UserModel, ValidationError, db,
} = require('hydrooj');

const RULE_ID = 'codeforces';
const DEFAULT_MAX_SCORES = [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000];
const DEFAULT_WRONG_ATTEMPT_PENALTY = 50;

function isDone(tdoc) {
  return ContestModel.isDone ? ContestModel.isDone(tdoc) : tdoc.endAt <= new Date();
}

function isLocked(tdoc, time = new Date()) {
  return ContestModel.isLocked ? ContestModel.isLocked(tdoc, time) : !!(tdoc.lockAt && tdoc.lockAt < time && !tdoc.unlocked);
}

function problemIndex(tdoc, pid) {
  return (tdoc.pids || []).findIndex((item) => Number(item) === Number(pid));
}

function problemMaxScore(tdoc, pid) {
  const configured = Number(tdoc.score?.[pid]);
  if (Number.isFinite(configured) && configured > 0) return configured;
  const index = problemIndex(tdoc, pid);
  return DEFAULT_MAX_SCORES[index] || DEFAULT_MAX_SCORES[DEFAULT_MAX_SCORES.length - 1] + Math.max(0, index - DEFAULT_MAX_SCORES.length + 1) * 500;
}

function getAlphabeticId(index) {
  let n = index + 1;
  let result = '';
  while (n > 0) {
    n -= 1;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result || '?';
}

function formatSeconds(seconds, compact = true) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (h) return `${h}:${pad(m)}:${pad(s)}`;
  return compact ? `${m}:${pad(s)}` : `${m}:${pad(s)}`;
}

function contestDurationMinutes(tdoc) {
  const beginAt = tdoc?.beginAt instanceof Date ? tdoc.beginAt : new Date(tdoc?.beginAt);
  const endAt = tdoc?.endAt instanceof Date ? tdoc.endAt : new Date(tdoc?.endAt);
  const duration = Math.floor((endAt.getTime() - beginAt.getTime()) / 60000);
  return Number.isFinite(duration) && duration > 0 ? duration : 120;
}

function minuteLoss(maxScore, tdoc) {
  return (120 * maxScore) / (250 * contestDurationMinutes(tdoc));
}

function secondsFromStart(tdoc, tsdoc, rid) {
  const useRelativeTime = !!tdoc.duration;
  const startAt = useRelativeTime ? (tsdoc?.startAt || tdoc.beginAt) : tdoc.beginAt;
  return Math.max(0, Math.floor((rid.getTimestamp().getTime() - startAt.getTime()) / 1000));
}

function isPenaltyAttempt(status) {
  return ![
    STATUS.STATUS_ACCEPTED,
    STATUS.STATUS_WAITING,
    STATUS.STATUS_FETCHED,
    STATUS.STATUS_COMPILING,
    STATUS.STATUS_JUDGING,
    STATUS.STATUS_COMPILE_ERROR,
    STATUS.STATUS_FORMAT_ERROR,
    STATUS.STATUS_CANCELED,
    STATUS.STATUS_IGNORED,
  ].includes(status);
}

function codeforcesProblemScore(maxScore, acceptedSeconds, wrongAttempts, durationMinutes = 120) {
  const minutes = Math.floor(Math.max(0, acceptedSeconds) / 60);
  const minScore = Math.ceil(maxScore * 0.3);
  const contestMinutes = Number.isFinite(Number(durationMinutes)) && Number(durationMinutes) > 0
    ? Number(durationMinutes)
    : 120;
  const decay = Math.floor((120 * maxScore * minutes) / (250 * contestMinutes));
  const score = maxScore - decay - DEFAULT_WRONG_ATTEMPT_PENALTY * wrongAttempts;
  return Math.max(minScore, score);
}

function displayNumber(value) {
  if (!Number.isFinite(Number(value))) return '0';
  return Number.isInteger(value) ? String(value) : Number(value).toFixed(2);
}

function tidFrom(raw) {
  if (raw?.toHexString) return raw;
  if (ObjectId?.isValid?.(raw)) return new ObjectId(raw);
  return raw;
}

function idText(value) {
  return value?.toHexString?.() || value?.toString?.() || String(value);
}

function canManageContest(handler, tdoc = handler.tdoc) {
  return handler.user?.own?.(tdoc)
    || handler.user?.hasPerm?.(PERM.PERM_EDIT_CONTEST)
    || handler.user?.hasPerm?.(PERM.PERM_EDIT_DOMAIN);
}

function scoreFieldName(pid) {
  return `score_${pid}`;
}

function scoreRows(tdoc, pdict = {}) {
  return (tdoc.pids || []).map((pid, index) => {
    const custom = Number(tdoc.score?.[pid]);
    const defaultScore = DEFAULT_MAX_SCORES[index]
      || DEFAULT_MAX_SCORES[DEFAULT_MAX_SCORES.length - 1] + Math.max(0, index - DEFAULT_MAX_SCORES.length + 1) * 500;
    const current = problemMaxScore(tdoc, pid);
    const pdoc = pdict[pid] || pdict[String(pid)] || {};
    return {
      pid,
      label: getAlphabeticId(index),
      title: pdoc.title || `P${pid}`,
      defaultScore,
      customScore: Number.isFinite(custom) && custom > 0 ? custom : '',
      currentScore: current,
      minScore: Math.ceil(current * 0.3),
      minuteLoss: displayNumber(minuteLoss(current, tdoc)),
      field: scoreFieldName(pid),
    };
  });
}

async function problemDict(domainId, pids) {
  if (!pids?.length) return {};
  try {
    return await ProblemModel.getList(domainId, pids, true, true);
  } catch (e) {
    const rows = await ProblemModel.getMulti(domainId, { docId: { $in: pids } }).toArray();
    return Object.fromEntries(rows.map((pdoc) => [pdoc.docId, pdoc]));
  }
}

function bestScoreTie(a, b) {
  if (!a) return b;
  if (!b) return a;
  if ((b.cfScore || 0) > (a.cfScore || 0)) return b;
  if ((b.cfScore || 0) < (a.cfScore || 0)) return a;
  const at = a.rid?.getTimestamp?.()?.getTime?.() || 0;
  const bt = b.rid?.getTimestamp?.()?.getTime?.() || 0;
  return bt < at ? b : a;
}

class CodeforcesScoreSettingHandler extends Handler {
  async prepare() {
    const domainId = this.args?.domainId || this.domain?._id || 'system';
    const tid = tidFrom(this.args?.tid || this.request.params?.tid);
    this.tdoc = await ContestModel.get(domainId, tid);
    if (!this.tdoc) throw new ValidationError('tid');
    if (this.tdoc.rule !== RULE_ID) throw new ValidationError('rule');
    if (!canManageContest(this, this.tdoc)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
  }

  async get() {
    const domainId = this.args?.domainId || this.domain?._id || 'system';
    const pdict = await problemDict(domainId, this.tdoc.pids || []);
    this.response.template = 'codeforces_score_setting.html';
    this.response.body = {
      page_name: 'codeforces_score_setting',
      tdoc: this.tdoc,
      rows: scoreRows(this.tdoc, pdict),
      saved: this.request.query?.saved,
    };
  }

  async post() {
    const domainId = this.args?.domainId || this.domain?._id || 'system';
    const body = this.request.body || {};
    const nextScore = { ...(this.tdoc.score || {}) };

    if (body.operation === 'reset') {
      for (const pid of this.tdoc.pids || []) delete nextScore[pid];
    } else {
      for (const pid of this.tdoc.pids || []) {
        const raw = String(body[scoreFieldName(pid)] ?? '').trim();
        if (!raw) {
          delete nextScore[pid];
          continue;
        }
        const score = Number(raw);
        if (!Number.isInteger(score) || score <= 0 || score > 1000000) throw new ValidationError(scoreFieldName(pid));
        nextScore[pid] = score;
      }
    }

    const cleaned = Object.fromEntries(Object.entries(nextScore).filter(([, value]) => Number(value) > 0));
    await ContestModel.edit(domainId, this.tdoc.docId, { score: Object.keys(cleaned).length ? cleaned : {} });
    await ContestModel.recalcStatus(domainId, this.tdoc.docId);
    this.response.redirect = `${this.url('codeforces_score_setting', { tid: this.tdoc.docId })}?saved=1`;
  }
}

function buildCodeforcesRule() {
  const base = ContestModel.RULES?.oi || ContestModel.RULES?.acm;
  const buildContestRule = ContestModel.buildContestRule || ((def) => def);

  return buildContestRule({
    TEXT: 'Codeforces Round',
    check: () => {},
    submitAfterAccept: false,
    statusSort: { score: -1 },
    showScoreboard: (tdoc, now) => now > tdoc.beginAt,
    showSelfRecord: () => true,
    showRecord: (tdoc, now) => now > tdoc.endAt && !isLocked(tdoc),
    stat(tdoc, journal) {
      const wrong = {};
      const detail = {};
      const display = {};
      let score = 0;
      let accept = 0;
      const lockAt = isLocked(tdoc) ? tdoc.lockAt : null;
      const durationMinutes = contestDurationMinutes(tdoc);

      for (const raw of journal || []) {
        if (!(tdoc.pids || []).includes(raw.pid)) continue;
        if (display[raw.pid]?.status === STATUS.STATUS_ACCEPTED) continue;

        const j = { ...raw };
        const maxScore = problemMaxScore(tdoc, j.pid);
        const previousWrongAttempts = wrong[j.pid] || 0;
        const currentWrongAttempts = isPenaltyAttempt(j.status) ? previousWrongAttempts + 1 : previousWrongAttempts;
        const real = secondsFromStart(tdoc, null, j.rid);
        const cfScore = j.status === STATUS.STATUS_ACCEPTED
          ? codeforcesProblemScore(maxScore, real, previousWrongAttempts, durationMinutes)
          : 0;

        const item = {
          ...j,
          maxScore,
          wrongAttempts: j.status === STATUS.STATUS_ACCEPTED ? previousWrongAttempts : currentWrongAttempts,
          real,
          cfScore,
          minuteLoss: minuteLoss(maxScore, tdoc),
          minScore: Math.ceil(maxScore * 0.3),
        };

        detail[j.pid] = j.status === STATUS.STATUS_ACCEPTED
          ? bestScoreTie(detail[j.pid], item)
          : item;
        if (lockAt && j.rid.getTimestamp() > lockAt) {
          display[j.pid] ||= {};
          display[j.pid].npending = (display[j.pid].npending || 0) + 1;
        } else {
          display[j.pid] = j.status === STATUS.STATUS_ACCEPTED
            ? bestScoreTie(display[j.pid], item)
            : item;
        }

        if (j.status === STATUS.STATUS_ACCEPTED) continue;
        if (isPenaltyAttempt(j.status)) wrong[j.pid] = currentWrongAttempts;
      }

      for (const pid of tdoc.pids || []) {
        const item = display[pid];
        if (item?.status === STATUS.STATUS_ACCEPTED) {
          accept++;
          score += Number(item.cfScore) || 0;
        }
      }

      return {
        score, accept, detail, display,
      };
    },
    async scoreboardHeader(config, _, tdoc, pdict) {
      const columns = [
        { type: 'rank', value: '#' },
        { type: 'user', value: _('User') },
      ];
      if (config.isExport && config.showDisplayName) {
        columns.push({ type: 'email', value: _('Email') });
        columns.push({ type: 'string', value: _('School') });
        columns.push({ type: 'string', value: _('Name') });
        columns.push({ type: 'string', value: _('Student ID') });
      }
      columns.push({ type: 'total_score', value: _('Score') });
      for (let i = 1; i <= (tdoc.pids || []).length; i++) {
        const pid = tdoc.pids[i - 1];
        if (pdict[pid]) {
          pdict[pid].nAccept = 0;
          pdict[pid].nSubmit = 0;
        }
        const maxScore = problemMaxScore(tdoc, pid);
        columns.push(config.isExport ? {
          type: 'string',
          value: `#${i} ${pdict[pid]?.title || pid} (${maxScore})`,
        } : {
          type: 'problem',
          value: `${getAlphabeticId(i - 1)}\n${maxScore}`,
          raw: pid,
        });
      }
      return columns;
    },
    async scoreboardRow(config, _, tdoc, pdict, udoc, rank, tsdoc, meta) {
      const row = [
        { type: 'rank', value: rank.toString() },
        { type: 'user', value: udoc?.uname || `U${tsdoc.uid}`, raw: tsdoc.uid },
      ];
      if (config.isExport && config.showDisplayName) {
        row.push({ type: 'email', value: udoc?.mail || '' });
        row.push({ type: 'string', value: udoc?.school || '' });
        row.push({ type: 'string', value: udoc?.displayName || '' });
        row.push({ type: 'string', value: udoc?.studentId || '' });
      }
      row.push({ type: 'total_score', value: displayNumber(tsdoc.score || 0) });

      const accepted = {};
      for (const s of tsdoc.journal || []) {
        if (!pdict[s.pid]) continue;
        if (config.lockAt && s.rid.getTimestamp() > config.lockAt) continue;
        pdict[s.pid].nSubmit++;
        if (s.status === STATUS.STATUS_ACCEPTED && !accepted[s.pid]) {
          pdict[s.pid].nAccept++;
          accepted[s.pid] = true;
        }
      }

      const tsddict = ((config.lockAt && isLocked(tdoc, new Date())) ? tsdoc.display : tsdoc.detail) || {};
      for (const pid of tdoc.pids || []) {
        const doc = tsddict[pid] || {};
        const accept = doc.status === STATUS.STATUS_ACCEPTED;
        const wrongSuffix = accept && doc.wrongAttempts ? `\n-${doc.wrongAttempts}` : '';
        const value = accept
          ? `${displayNumber(doc.cfScore || 0)}${wrongSuffix}\n${formatSeconds(doc.real || 0, false)}`
          : (doc.rid ? `-${doc.wrongAttempts || 0}` : '');
        const pending = doc.npending ? `${value ? ' ' : ''}<span style="color:orange">+${doc.npending}</span>` : '';
        const first = accept && doc.rid?.getTimestamp?.()?.getTime?.() === meta?.first?.[pid];
        row.push({
          type: 'record',
          value: `${value}${pending}`,
          score: accept ? 100 : 0,
          raw: doc.rid || null,
          hover: accept
            ? `Max ${doc.maxScore}, wrong ${doc.wrongAttempts || 0}, time ${formatSeconds(doc.real || 0)}`
            : '',
          style: first ? 'background-color: rgb(217, 240, 199);' : undefined,
        });
      }
      return row;
    },
    async scoreboard(config, _, tdoc, pdict, cursor) {
      const rankedTsdocs = await db.ranked(cursor, (a, b) => (a.score || 0) === (b.score || 0));
      const uids = rankedTsdocs.map(([, tsdoc]) => tsdoc.uid);
      const udict = await UserModel.getListForRender(tdoc.domainId, uids, config.showDisplayName ? ['displayName'] : []);
      const first = {};
      for (const [, tsdoc] of rankedTsdocs) {
        for (const [pid, detail] of Object.entries(tsdoc.detail || {})) {
          if (detail.status !== STATUS.STATUS_ACCEPTED) continue;
          const time = detail.rid.getTimestamp().getTime();
          if (!first[pid] || first[pid] > time) first[pid] = time;
        }
      }
      const columns = await this.scoreboardHeader(config, _, tdoc, pdict);
      const rows = [
        columns,
        ...await Promise.all(rankedTsdocs.map(
          ([rank, tsdoc]) => this.scoreboardRow(config, _, tdoc, pdict, udict[tsdoc.uid], rank, tsdoc, { first }),
        )),
      ];
      return [rows, udict];
    },
    async ranked(tdoc, cursor) {
      return await db.ranked(cursor, (a, b) => (a.score || 0) === (b.score || 0));
    },
    applyProjection(tdoc, rdoc) {
      if (isDone(tdoc)) return rdoc;
      delete rdoc.time;
      delete rdoc.memory;
      rdoc.testCases = [];
      rdoc.judgeTexts = [];
      delete rdoc.progress;
      delete rdoc.subtasks;
      delete rdoc.score;
      return rdoc;
    },
  }, base);
}

async function apply(ctx) {
  if (!ContestModel.RULES) return;
  if (!ContestModel.RULES[RULE_ID]) ContestModel.RULES[RULE_ID] = buildCodeforcesRule();
  ctx.Route('codeforces_score_setting', '/contest/:tid/codeforces-score', CodeforcesScoreSettingHandler, PERM.PERM_VIEW_CONTEST);
  ctx.injectUI('ContestDetail', 'codeforces_score_setting', (handler) => ({
    icon: 'settings',
    displayName: 'CF 分数设置',
    args: { tid: idText(handler.args?.tid || handler.tdoc?.docId || '') },
  }), (handler) => handler.tdoc?.rule === RULE_ID && canManageContest(handler));
  global.Hydro ||= {};
  global.Hydro.model ||= {};
  global.Hydro.model.codeforcesRoundRule = {
    RULE_ID,
    DEFAULT_MAX_SCORES,
    DEFAULT_WRONG_ATTEMPT_PENALTY,
    contestDurationMinutes,
    problemMaxScore,
    codeforcesProblemScore,
  };
  ctx.i18n.load('zh', {
    'Codeforces Round': 'Codeforces Round',
    codeforces_score_setting: 'CF 分数设置',
  });
}

module.exports = { apply };
