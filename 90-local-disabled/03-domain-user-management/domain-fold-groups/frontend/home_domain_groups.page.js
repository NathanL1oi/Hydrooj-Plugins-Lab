import { addPage } from '@hydrooj/ui-default';

const BOUND_FLAG = '__domainFoldGroupsBound';

function installStyle() {
  if (document.getElementById('domain-fold-groups-style')) return;
  const style = document.createElement('style');
  style.id = 'domain-fold-groups-style';
  style.textContent = `
.dfg-config-button {
  background: var(--hub-surface, rgba(255, 255, 255, .78)) !important;
  border: 1px solid var(--hub-border, #d8e4f2) !important;
  color: var(--hub-text, #26354d) !important;
  margin-left: 8px;
  backdrop-filter: blur(12px) saturate(145%);
  -webkit-backdrop-filter: blur(12px) saturate(145%);
}
.dfg-table .dfg-group-row td,
.dfg-table .dfg-child-row td {
  background: var(--hub-surface, rgba(255, 255, 255, .78));
  border-color: var(--hub-border, #d8e4f2);
  color: var(--hub-text, #26354d);
  cursor: pointer;
  position: relative;
  user-select: none;
  backdrop-filter: blur(14px) saturate(150%);
  -webkit-backdrop-filter: blur(14px) saturate(150%);
}
.dfg-table .dfg-group-row td {
  background: var(--hub-surface-strong, rgba(255, 255, 255, .86));
  border-top: 1px solid var(--hub-border, #d8e4f2);
  box-shadow: inset 0 1px 0 var(--hub-border-soft, rgba(15, 23, 42, .06));
  color: var(--hub-text, #213a55);
  font-weight: 700;
  padding: 15px 18px 15px 22px;
}
.dfg-table .dfg-child-row td {
  background: var(--hub-surface-soft, rgba(248, 251, 255, .72));
  border-top: 1px solid var(--hub-border-soft, #e6edf5);
  color: var(--hub-muted, #48627c);
  font-weight: 600;
  padding: 11px 18px 11px 54px;
}
.dfg-table .dfg-group-row:hover td,
.dfg-table .dfg-child-row:hover td {
  background: var(--hub-nav-hover, rgba(255, 255, 255, .88));
}
.dfg-table .dfg-header-inner {
  align-items: center;
  display: flex;
  gap: 10px;
}
.dfg-table .dfg-toggle {
  align-items: center;
  background: var(--hub-input-bg, rgba(255, 255, 255, .62));
  border: 1px solid var(--hub-border, #cbd5e1);
  border-radius: 6px;
  color: var(--hub-text, #2d6fa8);
  display: inline-flex;
  font-size: 13px;
  height: 24px;
  justify-content: center;
  width: 24px;
}
.dfg-table .dfg-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dfg-table .dfg-group-row .dfg-title {
  font-size: 1.08rem;
  font-weight: 700;
}
.dfg-table .dfg-count {
  background: var(--hub-input-bg, rgba(255, 255, 255, .62));
  border: 1px solid var(--hub-border, #c8d8e8);
  border-radius: 999px;
  color: var(--hub-muted, #4f6f8e);
  font-size: 0.82rem;
  margin-left: auto;
  padding: 3px 9px;
}
.dfg-table .dfg-child-row .dfg-toggle {
  border-color: var(--hub-border, #b9c7d5);
  color: var(--hub-muted, #52708a);
  height: 22px;
  width: 22px;
}
.dfg-table .dfg-child-row .dfg-count {
  border-color: var(--hub-border-soft, #d7e1eb);
  color: var(--hub-muted, #6b7f92);
}
.dfg-table .dfg-child-row .dfg-title {
  font-size: 0.92rem;
  font-weight: 600;
}
.dfg-table .dfg-hidden {
  display: none !important;
}
.theme--dark .dfg-config-button {
  background: rgba(255, 255, 255, .045) !important;
  border-color: rgba(255, 255, 255, .12) !important;
  color: #e2e8f0 !important;
}
.theme--dark .dfg-table .dfg-group-row td {
  background: rgba(255, 255, 255, .07);
  border-color: rgba(255, 255, 255, .12);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .08);
  color: #f8fafc;
}
.theme--dark .dfg-table .dfg-child-row td {
  background: rgba(255, 255, 255, .045);
  border-color: rgba(255, 255, 255, .08);
  color: #cbd5e1;
}
.theme--dark .dfg-table .dfg-group-row:hover td,
.theme--dark .dfg-table .dfg-child-row:hover td {
  background: rgba(255, 255, 255, .085);
}
.theme--dark .dfg-table .dfg-toggle,
.theme--dark .dfg-table .dfg-count {
  background: rgba(255, 255, 255, .055);
  border-color: rgba(255, 255, 255, .12);
  color: #f8fafc;
}
.theme--dark .dfg-table .dfg-child-row .dfg-toggle,
.theme--dark .dfg-table .dfg-child-row .dfg-count {
  color: #cbd5e1;
}
html.hydro-user-background-enabled .dfg-config-button {
  background: var(--hub-surface-strong) !important;
  border-color: var(--hub-border) !important;
  color: var(--hub-text) !important;
  box-shadow: var(--hub-shadow) !important;
}
html.hydro-user-background-enabled .dfg-table .dfg-group-row td {
  background: var(--hub-surface-strong) !important;
  border-color: var(--hub-border) !important;
  color: var(--hub-text) !important;
  box-shadow: inset 0 1px 0 var(--hub-border-soft) !important;
}
html.hydro-user-background-enabled .dfg-table .dfg-child-row td {
  background: var(--hub-surface-soft) !important;
  border-color: var(--hub-border-soft) !important;
  color: var(--hub-muted) !important;
}
html.hydro-user-background-enabled .dfg-table .dfg-group-row:hover td,
html.hydro-user-background-enabled .dfg-table .dfg-child-row:hover td {
  background: var(--hub-nav-hover) !important;
}
html.hydro-user-background-enabled .dfg-table .dfg-toggle,
html.hydro-user-background-enabled .dfg-table .dfg-count {
  background: var(--hub-input-bg) !important;
  border-color: var(--hub-border) !important;
  color: var(--hub-text) !important;
}
html.hydro-user-background-enabled .dfg-table .dfg-child-row .dfg-toggle,
html.hydro-user-background-enabled .dfg-table .dfg-child-row .dfg-count {
  color: var(--hub-muted) !important;
}
@media screen and (max-width: 700px) {
  .dfg-table .dfg-child-row td {
    padding-left: 36px;
  }
  .dfg-config-button {
    margin-left: 0;
    margin-top: 8px;
  }
}
`;
  document.head.appendChild(style);
}

function domainGroupsConfig() {
  return window.UiContext?.domainFoldGroups || {
    groups: [],
    manageUrl: '/home/domain-groups',
  };
}

function isHomeDomainPath() {
  return /\/home\/domain\/?$/.test(window.location.pathname);
}

function addConfigButton(manageUrl) {
  const section = findDomainSection();
  const tools = section?.querySelector('.section__header .section__tools');
  if (!tools || tools.querySelector('.dfg-config-button')) return;
  const link = document.createElement('a');
  link.href = manageUrl;
  link.className = 'rounded button dfg-config-button';
  link.innerHTML = '<span class="icon icon-menu"></span> 域分组';
  const help = tools.querySelector('.tool-button');
  tools.insertBefore(link, help || null);
}

function sectionTitle(section) {
  return String(section?.querySelector('.section__title, h1')?.textContent || '').replace(/\s+/g, ' ').trim();
}

function findDomainSection() {
  const sections = Array.from(document.querySelectorAll('.section'));
  if (!sections.length) return null;
  const exact = sections.find((section) => {
    const title = sectionTitle(section);
    return /我的域|My Domains|Domains|群组/.test(title) && section.querySelector('table');
  });
  if (exact) return exact;
  if (!isHomeDomainPath()) return null;
  return sections.find((section) => section.querySelector('table')) || null;
}

function tableColumnCount(table) {
  return Math.max(1, table.querySelectorAll('thead th').length || table.querySelector('tr')?.children.length || 4);
}

function extractDomainId(row) {
  const starCell = row.querySelector('[data-star-action]');
  const action = starCell?.getAttribute('data-star-action') || '';
  const actionId = action.match(/[?&]id=([^&]+)/)?.[1];
  if (actionId) return decodeURIComponent(actionId).trim();

  const nameCell = row.querySelector('.col--name') || row.children[1] || row;
  const text = nameCell.textContent || row.textContent || '';
  const matches = Array.from(text.matchAll(/\(([^()]+)\)/g));
  return matches.length ? matches[matches.length - 1][1].trim() : '';
}

function findDomainTable() {
  const section = findDomainSection();
  if (!section) return null;
  const tables = Array.from(section.querySelectorAll('table'));
  return tables.find((table) => Array.from(table.querySelectorAll('tbody tr')).some((row) => extractDomainId(row))) || null;
}

function createHeaderRow(kind, key, title, count, colSpan, parentKey = '') {
  const row = document.createElement('tr');
  row.className = kind === 'group' ? 'dfg-group-row' : 'dfg-child-row';
  row.dataset.dfgHeader = kind;
  row.dataset.dfgKey = key;
  if (parentKey) row.dataset.dfgParent = parentKey;

  const cell = document.createElement('td');
  cell.colSpan = colSpan;
  cell.innerHTML = `
    <div class="dfg-header-inner">
      <span class="dfg-toggle">v</span>
      <span class="dfg-title"></span>
      <span class="dfg-count">${count} 个域</span>
    </div>
  `;
  const titleEl = cell.querySelector('.dfg-title');
  if (titleEl) titleEl.textContent = title;
  row.appendChild(cell);
  return row;
}

function readState(storageKey) {
  try {
    return JSON.parse(localStorage.getItem(storageKey) || '{}') || {};
  } catch (error) {
    return {};
  }
}

function writeState(storageKey, state) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
  } catch (error) {
    // localStorage may be disabled.
  }
}

function applyVisibility(tbody, state) {
  const groupCollapsed = new Map();
  tbody.querySelectorAll('tr[data-dfg-header="group"]').forEach((row) => {
    const key = row.dataset.dfgKey || '';
    const collapsed = !!state[key];
    groupCollapsed.set(key, collapsed);
    const toggle = row.querySelector('.dfg-toggle');
    if (toggle) toggle.textContent = collapsed ? '>' : 'v';
  });

  tbody.querySelectorAll('tr[data-dfg-header="child"]').forEach((row) => {
    const key = row.dataset.dfgKey || '';
    const parent = row.dataset.dfgParent || '';
    const hiddenByGroup = !!groupCollapsed.get(parent);
    const collapsed = !!state[key];
    row.classList.toggle('dfg-hidden', hiddenByGroup);
    const toggle = row.querySelector('.dfg-toggle');
    if (toggle) toggle.textContent = collapsed ? '>' : 'v';
  });

  tbody.querySelectorAll('tr[data-dfg-domain-row="1"]').forEach((row) => {
    const parent = row.dataset.dfgParent || '';
    const group = row.dataset.dfgGroup || '';
    const hidden = !!groupCollapsed.get(group) || !!state[parent];
    row.classList.toggle('dfg-hidden', hidden);
  });
}

function enhanceDomainTable() {
  if (!isHomeDomainPath() && !findDomainSection()) return;
  const config = domainGroupsConfig();
  installStyle();
  addConfigButton(config.manageUrl || '/home/domain-groups');

  const groups = Array.isArray(config.groups) ? config.groups : [];
  if (!groups.length) return;

  const table = findDomainTable();
  if (!table || table.dataset.dfgEnhanced === '1') return;
  const tbody = table.querySelector('tbody');
  if (!tbody) return;

  const rows = Array.from(tbody.querySelectorAll('tr'));
  const rowById = new Map();
  for (const row of rows) {
    const id = extractDomainId(row);
    if (id) rowById.set(id, row);
  }
  if (!rowById.size) return;

  const assigned = new Set();
  const claimed = new Set();
  const colSpan = tableColumnCount(table);
  const fragment = document.createDocumentFragment();
  let visibleGroupCount = 0;

  groups.forEach((group, groupIndex) => {
    const children = Array.isArray(group.children) ? group.children : [];
    const preparedChildren = children.map((child, childIndex) => {
      const domainRows = [];
      for (const id of Array.isArray(child.domains) ? child.domains : []) {
        if (claimed.has(id)) continue;
        const row = rowById.get(id);
        if (!row) continue;
        claimed.add(id);
        domainRows.push({ id, row });
      }
      return { child, childIndex, domainRows };
    }).filter((item) => item.domainRows.length);
    const total = preparedChildren.reduce((sum, item) => sum + item.domainRows.length, 0);
    if (!total) return;

    const groupKey = `g${groupIndex}`;
    fragment.appendChild(createHeaderRow('group', groupKey, group.title || '未命名分组', total, colSpan));
    visibleGroupCount += 1;

    preparedChildren.forEach(({ child, childIndex, domainRows }) => {
      const childKey = `${groupKey}s${childIndex}`;
      fragment.appendChild(createHeaderRow('child', childKey, child.title || '默认', domainRows.length, colSpan, groupKey));
      domainRows.forEach(({ id, row }) => {
        assigned.add(id);
        row.dataset.dfgDomainRow = '1';
        row.dataset.dfgGroup = groupKey;
        row.dataset.dfgParent = childKey;
        fragment.appendChild(row);
      });
    });
  });

  const ungroupedRows = Array.from(rowById.entries()).filter(([id]) => !assigned.has(id));
  if (ungroupedRows.length) {
    const groupKey = 'ungrouped';
    const childKey = 'ungrouped-default';
    fragment.appendChild(createHeaderRow('group', groupKey, '未分组', ungroupedRows.length, colSpan));
    fragment.appendChild(createHeaderRow('child', childKey, '暂未归类', ungroupedRows.length, colSpan, groupKey));
    ungroupedRows.forEach(([, row]) => {
      row.dataset.dfgDomainRow = '1';
      row.dataset.dfgGroup = groupKey;
      row.dataset.dfgParent = childKey;
      fragment.appendChild(row);
    });
  }

  if (!visibleGroupCount && !ungroupedRows.length) return;
  tbody.innerHTML = '';
  tbody.appendChild(fragment);
  table.classList.add('dfg-table');
  table.dataset.dfgEnhanced = '1';

  const stateKey = `domain-fold-groups:${location.pathname}`;
  const state = readState(stateKey);
  applyVisibility(tbody, state);

  tbody.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const header = target.closest('tr[data-dfg-header]');
    if (!header) return;
    const key = header.dataset.dfgKey || '';
    state[key] = !state[key];
    writeState(stateKey, state);
    applyVisibility(tbody, state);
  });
}

function enhanceConfigPage() {
  document.querySelectorAll('.dfg-clear-row').forEach((button) => {
    if (button.dataset.dfgBound === '1') return;
    button.dataset.dfgBound = '1';
    button.addEventListener('click', () => {
      const row = button.closest('tr');
      row?.querySelectorAll('input[type="text"]').forEach((input) => {
        input.value = '';
      });
    });
  });
}

function run() {
  enhanceDomainTable();
  enhanceConfigPage();
}

function scheduleRun() {
  window.requestAnimationFrame(run);
  window.setTimeout(run, 120);
  window.setTimeout(run, 450);
}

addPage(() => {
  scheduleRun();
  if (window[BOUND_FLAG]) return;
  window[BOUND_FLAG] = true;
  document.addEventListener('vjContentNew', scheduleRun);
});
