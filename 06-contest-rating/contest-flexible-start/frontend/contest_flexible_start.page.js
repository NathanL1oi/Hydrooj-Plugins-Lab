import { addPage, NamedPage } from '@hydrooj/ui-default';

function formatTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date).replace(/\//g, '-');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ensureStyle() {
  if (document.getElementById('contest-flexible-start-style')) return;
  const style = document.createElement('style');
  style.id = 'contest-flexible-start-style';
  style.textContent = `
    .contest-flexible-start-panel {
      border-top: 1px solid #e5e7eb;
      border-bottom: 1px solid #e5e7eb;
      background: #f8fafc;
    }
    .contest-flexible-start-panel h2 {
      margin: 0 0 8px;
      font-size: 16px;
      line-height: 1.35;
    }
    .contest-flexible-start-panel p {
      margin: 6px 0;
      color: #475569;
      line-height: 1.55;
    }
    .contest-flexible-start-panel .flexible-start-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      margin-bottom: 6px;
      color: #0f766e;
      font-size: 13px;
      font-weight: 700;
    }
    .contest-flexible-start-panel .flexible-start-meta {
      display: grid;
      gap: 5px;
      margin-top: 8px;
      font-size: 13px;
      color: #334155;
    }
    .contest-flexible-start-panel .button {
      width: 100%;
      margin-top: 10px;
      text-align: center;
    }
    .contest-flexible-start-panel .flexible-start-muted {
      color: #64748b;
    }
    .contest-flexible-start-unstarted {
      color: #64748b;
      font-weight: 700;
      white-space: nowrap;
    }
    .contest-flexible-start-started {
      color: #0f172a;
      white-space: nowrap;
    }
  `;
  document.head.appendChild(style);
}

function replaceAttendText() {
  const attendInput = document.querySelector('.section.side input[name="operation"][value="attend"]');
  const button = attendInput?.closest('form')?.querySelector('button');
  if (!button) return;
  button.innerHTML = '<span class="icon icon-add"></span> 登记参加';
}

function hideEarlyEndBeforeStart(config) {
  if (!config.canStart) return;
  const earlyEndInput = document.querySelector('.section.side input[name="operation"][value="early_end"]');
  const item = earlyEndInput?.closest('li');
  if (item) item.style.display = 'none';
}

function rewriteProblemLinks(config) {
  if (!config.canStart || !config.startUrl || !config.tid) return;
  const needle = `/contest/${config.tid}/problems`;
  for (const anchor of document.querySelectorAll(`a[href*="${needle}"]`)) {
    anchor.setAttribute('href', config.startUrl);
    anchor.innerHTML = '<span class="icon icon-play"></span> 开始个人计时';
  }
}

function panelBody(config) {
  if (!config.attended) {
    return `
      <span class="flexible-start-badge"><span class="icon icon-schedule"></span> 灵活时间比赛</span>
      <h2>先登记，之后再开始</h2>
      <p>登记不会开始个人计时。等你准备好并进入比赛时，再确认开始。</p>
      <div class="flexible-start-meta">
        <span>个人时长：${escapeHtml(config.durationHours)} 小时</span>
        <span>全局截止：${formatTime(config.contestEndAt)}</span>
      </div>
    `;
  }
  if (config.started) {
    return `
      <span class="flexible-start-badge"><span class="icon icon-check"></span> 个人计时中</span>
      <h2>已开始个人计时</h2>
      <div class="flexible-start-meta">
        <span>开始：${formatTime(config.startAt)}</span>
        <span>截止：${formatTime(config.endAt)}</span>
      </div>
      <a class="button rounded primary" href="${escapeHtml(config.problemUrl)}">
        <span class="icon icon-unordered_list"></span> 进入题目
      </a>
    `;
  }
  if (config.canStart) {
    return `
      <span class="flexible-start-badge"><span class="icon icon-schedule"></span> 已登记，未开始</span>
      <h2>开始前需要确认</h2>
      <p>确认后会立刻记录你的个人开始时间。</p>
      <div class="flexible-start-meta">
        <span>若现在开始：${formatTime(config.plannedStartAt)}</span>
        <span>预计截止：${formatTime(config.plannedEndAt)}</span>
      </div>
      <a class="button rounded primary" href="${escapeHtml(config.startUrl)}">
        <span class="icon icon-play"></span> 开始个人计时
      </a>
    `;
  }
  if (config.beforeGlobalStart) {
    return `
      <span class="flexible-start-badge"><span class="icon icon-schedule"></span> 已登记，未开放</span>
      <h2>比赛还没有开始</h2>
      <p>全局开始后，你可以自己选择开始个人计时。</p>
      <div class="flexible-start-meta">
        <span>全局开始：${formatTime(config.contestBeginAt)}</span>
        <span>个人时长：${escapeHtml(config.durationHours)} 小时</span>
      </div>
    `;
  }
  return `
    <span class="flexible-start-badge"><span class="icon icon-info"></span> 灵活时间比赛</span>
    <h2>个人计时未开始</h2>
    <p class="flexible-start-muted">当前不能开始新的个人计时。</p>
  `;
}

function injectSidebarPanel(config) {
  const side = document.querySelector('.section.side');
  if (!side || document.getElementById('contest-flexible-start-panel')) return;
  const detailBody = side.querySelector('.section__body.typo');
  const panel = document.createElement('div');
  panel.id = 'contest-flexible-start-panel';
  panel.className = 'section__body contest-flexible-start-panel';
  panel.innerHTML = panelBody(config);
  if (detailBody) side.insertBefore(panel, detailBody);
  else side.appendChild(panel);
}

function applyFlexibleStartUI() {
  const config = window.UiContext?.contestFlexibleStart;
  if (!config?.enabled) return;
  ensureStyle();
  replaceAttendText();
  hideEarlyEndBeforeStart(config);
  rewriteProblemLinks(config);
  injectSidebarPanel(config);
}

function applyFlexibleStartUserManageUI() {
  const config = window.UiContext?.contestFlexibleStartUserManage;
  if (!config?.enabled) return;
  ensureStyle();
  for (const row of document.querySelectorAll('tr[data-uid]')) {
    const uid = row.getAttribute('data-uid');
    const state = config.users?.[uid];
    if (!state) continue;
    const startCell = row.querySelector('.col--start-time');
    const endCell = row.querySelector('.col--end-time');
    if (!startCell || !endCell) continue;
    if (state.started) {
      startCell.innerHTML = `<span class="contest-flexible-start-started">${formatTime(state.startAt)}</span>`;
      endCell.innerHTML = `<span class="contest-flexible-start-started">${formatTime(state.endAt)}</span>`;
    } else {
      startCell.innerHTML = '<span class="contest-flexible-start-unstarted">未开始个人计时</span>';
      endCell.innerHTML = '<span class="contest-flexible-start-unstarted">未开始</span>';
    }
  }
}

addPage(new NamedPage(['contest_detail', 'contest_flexible_start'], applyFlexibleStartUI));
addPage(new NamedPage(['contest_user'], applyFlexibleStartUserManageUI));
