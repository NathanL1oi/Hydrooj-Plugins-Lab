import { addPage, NamedPage, request } from '@hydrooj/ui-default';

const STYLE_ID = 'contest-problem-order-style';
const ROOT_ID = 'contest-problem-order-panel';

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
  .contest-edit-glass {
    border-color: var(--hub-border, rgba(15, 23, 42, .10)) !important;
    background: rgba(255, 255, 255, .04) !important;
    box-shadow: var(--hub-shadow, 0 18px 42px rgba(15, 23, 42, .08)) !important;
    backdrop-filter: blur(18px) saturate(155%) !important;
    -webkit-backdrop-filter: blur(18px) saturate(155%) !important;
  }
  .contest-edit-glass > form > .section__header,
  .contest-edit-glass > form > .section__body {
    border-color: var(--hub-border-soft, rgba(15, 23, 42, .06)) !important;
    background: transparent !important;
  }
  .theme--dark .contest-edit-glass {
    border-color: var(--hub-border, rgba(255, 255, 255, .12)) !important;
    background: rgba(255, 255, 255, .028) !important;
    box-shadow: var(--hub-shadow, 0 18px 42px rgba(0, 0, 0, .16)) !important;
  }
  html.page--contest_edit .contest-edit-glass,
  html.page--contest_edit.theme--dark .contest-edit-glass {
    background: rgba(255, 255, 255, .028) !important;
  }
  html.page--contest_edit .contest-edit-glass > form > .section__header,
  html.page--contest_edit .contest-edit-glass > form > .section__body {
    background: transparent !important;
  }
  .contest-problem-sort {
    --contest-order-border: var(--hub-border, rgba(15, 23, 42, .10));
    --contest-order-border-soft: var(--hub-border-soft, rgba(15, 23, 42, .06));
    --contest-order-surface: rgba(255, 255, 255, .07);
    --contest-order-surface-soft: rgba(255, 255, 255, .035);
    --contest-order-hover: rgba(255, 255, 255, .12);
    --contest-order-text: var(--hub-text, #172033);
    --contest-order-muted: var(--hub-muted, #64748b);
    --contest-order-shadow: var(--hub-shadow, 0 16px 36px rgba(15, 23, 42, .10));
    margin: -4px 0 18px;
    border: 1px solid var(--contest-order-border);
    border-radius: 8px;
    background: var(--contest-order-surface-soft) !important;
    color: var(--contest-order-text);
    overflow: hidden;
    box-shadow: var(--contest-order-shadow);
    backdrop-filter: blur(16px) saturate(150%);
    -webkit-backdrop-filter: blur(16px) saturate(150%);
  }
  .contest-problem-sort__head {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-bottom: 1px solid var(--contest-order-border-soft);
    background: transparent !important;
  }
  .contest-problem-sort__title {
    margin: 0;
    color: var(--contest-order-text);
    font-size: 15px;
    font-weight: 600;
    line-height: 1.35;
  }
  .contest-problem-sort__count {
    color: var(--contest-order-muted);
    font-size: 12px;
  }
  .contest-problem-sort__body { padding: 10px 12px; }
  .contest-problem-sort__list {
    display: grid;
    gap: 8px;
    margin: 0 0 1px;
    padding: 0;
    list-style: none;
  }
  .contest-problem-sort__row {
    display: grid;
    grid-template-columns: 36px minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    padding: 9px 10px;
    border: 1px solid var(--contest-order-border);
    border-left: 1px solid var(--contest-order-border) !important;
    border-radius: 8px;
    background: var(--contest-order-surface);
    box-shadow: 0 10px 24px rgba(15, 23, 42, .06);
    backdrop-filter: blur(12px) saturate(145%);
    -webkit-backdrop-filter: blur(12px) saturate(145%);
    transition: background .18s ease, border-color .18s ease, box-shadow .18s ease;
  }
  .contest-problem-sort__row:hover { background: var(--contest-order-hover); }
  .contest-problem-sort__row.is-swap-main {
    border-color: rgba(251, 146, 60, .70);
    background: rgba(251, 146, 60, .10);
    box-shadow: 0 0 0 3px rgba(249, 115, 22, .10);
  }
  .contest-problem-sort__row.is-swap-peer {
    border-color: rgba(148, 163, 184, .34);
    background: rgba(148, 163, 184, .08);
  }
  .contest-problem-sort__index {
    display: inline-flex;
    width: 28px;
    height: 28px;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--contest-order-border);
    border-radius: 50%;
    background: var(--contest-order-surface-soft);
    color: var(--contest-order-text);
    font-weight: 600;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .24);
  }
  .contest-problem-sort__pid {
    display: inline-flex;
    width: fit-content;
    max-width: 100%;
    align-items: center;
    margin-bottom: 2px;
    padding: 1px 7px;
    border: 1px solid var(--contest-order-border);
    border-radius: 999px;
    background: var(--contest-order-surface-soft);
    color: var(--contest-order-muted);
    font-size: 12px;
    line-height: 18px;
    font-weight: 700;
    overflow-wrap: anywhere;
  }
  .contest-problem-sort__problem {
    min-width: 0;
    color: var(--contest-order-text);
    overflow-wrap: anywhere;
  }
  .contest-problem-sort__name {
    min-width: 0;
    color: var(--contest-order-text);
    font-size: 14px;
    font-weight: 650;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }
  .contest-problem-sort__meta {
    color: var(--contest-order-muted);
    font-size: 12px;
  }
  .contest-problem-sort__actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
  }
  .contest-problem-sort__actions .button {
    height: 28px;
    margin: 0 !important;
    padding: 0 9px;
    border-color: var(--contest-order-border);
    background: var(--contest-order-surface-soft);
    color: var(--contest-order-text);
    line-height: 26px;
    font-size: 12px;
    font-weight: 600;
    box-shadow: none;
    backdrop-filter: blur(10px) saturate(140%);
    -webkit-backdrop-filter: blur(10px) saturate(140%);
  }
  .contest-problem-sort__actions .button:hover {
    border-color: rgba(37, 99, 235, .36);
    background: var(--contest-order-hover);
    color: #2563eb;
  }
  .contest-problem-sort__actions .button[disabled] {
    background: rgba(148, 163, 184, .12);
    color: var(--contest-order-muted);
  }
  .contest-problem-sort__empty { color: var(--contest-order-muted); }
  .theme--dark .contest-problem-sort {
    --contest-order-border: var(--hub-border, rgba(255, 255, 255, .12));
    --contest-order-border-soft: var(--hub-border-soft, rgba(255, 255, 255, .08));
    --contest-order-surface: rgba(255, 255, 255, .055);
    --contest-order-surface-soft: rgba(255, 255, 255, .028);
    --contest-order-hover: rgba(255, 255, 255, .095);
    --contest-order-text: var(--hub-text, #e5e7eb);
    --contest-order-muted: var(--hub-muted, #94a3b8);
    --contest-order-shadow: var(--hub-shadow, 0 18px 40px rgba(0, 0, 0, .24));
  }
  @media screen and (max-width: 720px) {
    .contest-problem-sort__row { grid-template-columns: 32px minmax(0, 1fr); }
    .contest-problem-sort__actions { grid-column: 2; justify-content: flex-start; }
  }
  `;
  document.head.appendChild(style);
}

function parsePids(value) {
  const seen = new Set();
  return String(value || '')
    .replace(/\uFF0C/g, ',')
    .split(/[\s,]+/)
    .map((item) => item.trim().replace(/^P/i, ''))
    .filter((item) => {
      if (!/^\d+$/.test(item) || seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function createButton(action, text) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'rounded button';
  button.dataset.sortAction = action;
  button.textContent = text;
  return button;
}

function metaUrl() {
  return `${window.location.pathname.replace(/\/edit\/?$/, '/problem-order/meta')}`;
}

function displayPid(pid, problemMeta) {
  const item = problemMeta.get(String(pid));
  return String(item?.pid || `P${pid}`).trim();
}

function problemTitle(pid, problemMeta) {
  return String(problemMeta.get(String(pid))?.title || '').trim();
}

function problemTitleText(pid, problemMeta) {
  const title = problemTitle(pid, problemMeta);
  if (title) return title;
  return problemMeta.has(String(pid))
    ? '\u9898\u76ee\u540d\u79f0\u4e0d\u53ef\u7528'
    : '\u6b63\u5728\u8bfb\u53d6\u9898\u76ee\u540d\u79f0...';
}

function rememberItems(problemMeta, items) {
  (items || []).forEach((item) => {
    const docId = Number(item?.docId);
    if (Number.isInteger(docId) && docId > 0) problemMeta.set(String(docId), item);
  });
}

function mountContestProblemOrder() {
  const path = window.location.pathname;
  if (!/(?:\/d\/[^/]+)?\/contest\/[^/]+\/edit\/?$/.test(path)) return;
  if (document.getElementById(ROOT_ID)) return;

  const input = document.querySelector('form [name="pids"]');
  if (!(input instanceof HTMLInputElement)) return;
  const form = input.closest('form');
  if (!form) return;

  ensureStyle();
  form.closest('.section')?.classList.add('contest-edit-glass');

  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.className = 'contest-problem-sort';
  root.innerHTML = `
    <div class="contest-problem-sort__head">
      <h3 class="contest-problem-sort__title">\u9898\u76ee\u987a\u5e8f</h3>
      <span class="contest-problem-sort__count" data-contest-problem-count></span>
    </div>
    <div class="contest-problem-sort__body">
      <ol class="contest-problem-sort__list" data-contest-problem-list></ol>
      <div class="contest-problem-sort__empty" data-contest-problem-empty>\u6682\u65e0\u9898\u76ee</div>
    </div>
  `;

  const fieldRow = input.closest('.row') || input.parentElement;
  if (fieldRow?.parentNode) fieldRow.parentNode.insertBefore(root, fieldRow.nextSibling);
  else input.insertAdjacentElement('afterend', root);

  const list = root.querySelector('[data-contest-problem-list]');
  const empty = root.querySelector('[data-contest-problem-empty]');
  const count = root.querySelector('[data-contest-problem-count]');
  if (!(list instanceof HTMLOListElement)) return;

  let highlightTimer = 0;
  let lastRendered = '';
  let metaTimer = 0;
  let metaSeq = 0;
  const problemMeta = new Map();

  function rows() {
    return Array.from(list.querySelectorAll('[data-contest-problem-item]'));
  }

  function writeInput() {
    input.value = rows().map((row) => row.getAttribute('data-pid')).filter(Boolean).join(',');
    input.setAttribute('value', input.value);
    lastRendered = input.value;
  }

  function refreshControls() {
    const items = rows();
    if (empty instanceof HTMLElement) empty.style.display = items.length ? 'none' : '';
    if (count) count.textContent = items.length ? `${items.length} \u9053\u9898\u76ee` : '';
    items.forEach((row, index) => {
      const indexNode = row.querySelector('[data-contest-problem-index]');
      if (indexNode) indexNode.textContent = String(index + 1);
      const top = row.querySelector('[data-sort-action="top"]');
      const up = row.querySelector('[data-sort-action="up"]');
      const down = row.querySelector('[data-sort-action="down"]');
      const bottom = row.querySelector('[data-sort-action="bottom"]');
      if (top instanceof HTMLButtonElement) top.disabled = index === 0;
      if (up instanceof HTMLButtonElement) up.disabled = index === 0;
      if (down instanceof HTMLButtonElement) down.disabled = index === items.length - 1;
      if (bottom instanceof HTMLButtonElement) bottom.disabled = index === items.length - 1;
    });
  }

  async function refreshProblemMeta() {
    const pids = parsePids(input.value);
    const missing = pids.filter((pid) => !problemMeta.has(String(pid)));
    if (!missing.length) return;
    const seq = ++metaSeq;
    try {
      const data = await request.get(`${metaUrl()}?pids=${encodeURIComponent(missing.join(','))}`);
      rememberItems(problemMeta, data?.items);
      if (seq === metaSeq) render(true);
    } catch (error) {
      // Keep sorting usable even when metadata lookup is temporarily unavailable.
    }
  }

  function scheduleProblemMetaRefresh() {
    window.clearTimeout(metaTimer);
    metaTimer = window.setTimeout(refreshProblemMeta, 180);
  }

  function render(force = false) {
    const next = parsePids(input.value).join(',');
    if (!force && next === lastRendered && list.childElementCount) {
      refreshControls();
      return;
    }
    lastRendered = next;
    list.innerHTML = '';
    parsePids(input.value).forEach((pid) => {
      const row = document.createElement('li');
      row.className = 'contest-problem-sort__row';
      row.dataset.contestProblemItem = '';
      row.dataset.pid = pid;

      const index = document.createElement('span');
      index.className = 'contest-problem-sort__index';
      index.dataset.contestProblemIndex = '';

      const label = document.createElement('div');
      label.className = 'contest-problem-sort__problem';

      const pidNode = document.createElement('div');
      pidNode.className = 'contest-problem-sort__pid';
      pidNode.textContent = displayPid(pid, problemMeta);

      const titleNode = document.createElement('div');
      titleNode.className = 'contest-problem-sort__name';
      titleNode.textContent = problemTitleText(pid, problemMeta);

      label.append(pidNode, titleNode);
      if (displayPid(pid, problemMeta) !== `P${pid}`) {
        const docId = document.createElement('div');
        docId.className = 'contest-problem-sort__meta';
        docId.textContent = `#${pid}`;
        label.appendChild(docId);
      }

      const actions = document.createElement('div');
      actions.className = 'contest-problem-sort__actions';
      actions.append(
        createButton('top', '\u7f6e\u9876'),
        createButton('up', '\u4e0a\u79fb'),
        createButton('down', '\u4e0b\u79fb'),
        createButton('bottom', '\u7f6e\u5e95'),
      );

      row.append(index, label, actions);
      list.appendChild(row);
    });
    refreshControls();
    scheduleProblemMetaRefresh();
  }

  function peer(row, action) {
    if (!row) return null;
    if (action === 'top') return list.firstElementChild === row ? null : list.firstElementChild;
    if (action === 'up') return row.previousElementSibling;
    if (action === 'down') return row.nextElementSibling;
    if (action === 'bottom') return list.lastElementChild === row ? null : list.lastElementChild;
    return null;
  }

  function move(row, action) {
    if (!row) return;
    if (action === 'top') list.insertBefore(row, list.firstElementChild);
    if (action === 'up' && row.previousElementSibling) list.insertBefore(row, row.previousElementSibling);
    if (action === 'down' && row.nextElementSibling) list.insertBefore(row.nextElementSibling, row);
    if (action === 'bottom') list.appendChild(row);
  }

  function showSwap(row, other) {
    window.clearTimeout(highlightTimer);
    rows().forEach((item) => item.classList.remove('is-swap-main', 'is-swap-peer'));
    row?.classList.add('is-swap-main');
    other?.classList.add('is-swap-peer');
    highlightTimer = window.setTimeout(() => {
      rows().forEach((item) => item.classList.remove('is-swap-main', 'is-swap-peer'));
    }, 1200);
  }

  root.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest('[data-sort-action]');
    if (!(button instanceof HTMLButtonElement) || !root.contains(button)) return;
    event.preventDefault();
    const row = button.closest('[data-contest-problem-item]');
    const action = button.dataset.sortAction || '';
    const other = peer(row, action);
    move(row, action);
    writeInput();
    refreshControls();
    showSwap(row, other);
  });

  input.addEventListener('change', () => render());
  input.addEventListener('keyup', () => render());
  form.addEventListener('submit', writeInput);
  render(true);
  refreshProblemMeta();
}

addPage(new NamedPage(['contest_edit'], mountContestProblemOrder));
addPage(mountContestProblemOrder);
