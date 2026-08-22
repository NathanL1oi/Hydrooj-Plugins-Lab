import { addPage } from '@hydrooj/ui-default';
import './domain_manage_sidebar_lite.css';

const ENHANCED_ATTR = 'data-domain-manage-sidebar-lite';
const STORAGE_KEY = 'domain-manage-sidebar-lite:v1';
const BOUND_FLAG = '__domainManageSidebarLiteBound';

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function domainKey() {
  const ctx = window.UiContext || {};
  return ctx.domainId || ctx.domain?._id || window.location.pathname.split('/')[2] || 'default';
}

function readState() {
  try {
    const raw = window.localStorage.getItem(`${STORAGE_KEY}:${domainKey()}`);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function writeState(state) {
  try {
    window.localStorage.setItem(`${STORAGE_KEY}:${domainKey()}`, JSON.stringify(state || {}));
  } catch (e) {
    // localStorage may be disabled; the sidebar still works without persistence.
  }
}

function directMenu(section) {
  return section.querySelector(':scope > ol.menu');
}

function directMenuItems(menu) {
  return Array.from(menu?.children || []).filter((node) => (
    node instanceof HTMLElement && node.matches('li.menu__item')
  ));
}

function collectGroups(section) {
  const root = directMenu(section);
  if (!root) return [];
  return directMenuItems(root).map((item, index) => {
    const header = item.querySelector(':scope > .menu__link.expandable');
    const menu = item.querySelector(':scope > ol.menu');
    if (!(header instanceof HTMLElement) || !(menu instanceof HTMLOListElement)) return null;
    const children = directMenuItems(menu);
    if (!children.length) return null;
    const title = normalizeText(header.textContent) || `group-${index}`;
    const active = !!item.querySelector(':scope > ol.menu .menu__link.active');
    return { item, header, menu, children, title, active };
  }).filter(Boolean);
}

function findDomainManageSidebar() {
  const sections = Array.from(document.querySelectorAll('.medium-3.columns .section.side, [data-sticky] .section.side'));
  return sections.find((section) => {
    if (!(section instanceof HTMLElement)) return false;
    const groups = collectGroups(section);
    return groups.length >= 2 && groups.some((group) => group.children.length);
  });
}

function setCollapsed(group, collapsed) {
  group.item.classList.toggle('dm-sidebar-group--collapsed', collapsed);
  group.header.setAttribute('aria-expanded', String(!collapsed));
  const expander = group.header.querySelector('.dm-sidebar-expander');
  if (expander) expander.classList.toggle('is-collapsed', collapsed);
}

function createToolbar() {
  const toolbar = document.createElement('div');
  toolbar.className = 'dm-sidebar-toolbar';

  const search = document.createElement('div');
  search.className = 'dm-sidebar-search';

  const icon = document.createElement('span');
  icon.className = 'icon icon-search';
  icon.setAttribute('aria-hidden', 'true');

  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = '搜索管理入口';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', '搜索管理入口');

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'dm-sidebar-clear';
  clear.title = '清空筛选';
  clear.setAttribute('aria-label', '清空筛选');
  clear.hidden = true;
  clear.innerHTML = '<span class="icon icon-close"></span>';

  search.append(icon, input, clear);

  const meta = document.createElement('div');
  meta.className = 'dm-sidebar-meta';
  meta.innerHTML = '<span data-dm-sidebar-summary></span><span data-dm-sidebar-hit></span>';

  toolbar.append(search, meta);
  return toolbar;
}

function prepareGroup(group, state, groupsCount) {
  group.item.classList.add('dm-sidebar-group');
  group.menu.classList.remove('collapsed');
  group.header.classList.add('dm-sidebar-group-title');
  group.header.setAttribute('role', 'button');
  group.header.tabIndex = 0;

  if (!group.header.querySelector('.dm-sidebar-expander')) {
    const expander = document.createElement('span');
    expander.className = 'icon icon-expand_less dm-sidebar-expander';
    expander.setAttribute('aria-hidden', 'true');
    group.header.appendChild(expander);
  }

  group.children.forEach((child) => {
    child.classList.add('dm-sidebar-entry');
    child.dataset.dmSearchText = normalizeText(child.textContent);
  });

  if (group.active) group.item.classList.add('dm-sidebar-group--active');
  const saved = state[group.title];
  const collapsed = typeof saved === 'boolean' ? saved : (!group.active && groupsCount > 2);
  setCollapsed(group, collapsed);
}

function enhanceSidebar() {
  const section = findDomainManageSidebar();
  if (!section || !(section instanceof HTMLElement)) return;

  const groups = collectGroups(section);
  if (groups.length < 2) return;

  section.classList.add('dm-sidebar-lite');
  const state = readState();

  let toolbar = section.querySelector(':scope > .dm-sidebar-toolbar');
  if (!toolbar) {
    toolbar = createToolbar();
    section.insertBefore(toolbar, section.firstChild);
  }

  groups.forEach((group) => prepareGroup(group, state, groups.length));

  const input = toolbar.querySelector('input[type="search"]');
  const clear = toolbar.querySelector('.dm-sidebar-clear');
  const summary = toolbar.querySelector('[data-dm-sidebar-summary]');
  const hit = toolbar.querySelector('[data-dm-sidebar-hit]');
  const totalEntries = groups.reduce((sum, group) => sum + group.children.length, 0);
  if (summary) summary.textContent = `${groups.length} 组 / ${totalEntries} 项`;

  const applyFilter = () => {
    const query = normalizeText(input?.value);
    let matched = 0;
    groups.forEach((group) => {
      const groupMatches = group.title.includes(query);
      let groupVisible = false;
      group.children.forEach((child) => {
        const visible = !query || groupMatches || (child.dataset.dmSearchText || '').includes(query);
        child.hidden = !visible;
        if (visible) {
          groupVisible = true;
          matched += 1;
        }
      });
      group.item.hidden = !!query && !groupVisible;
      if (query && groupVisible) setCollapsed(group, false);
      if (!query) setCollapsed(group, state[group.title] ?? (!group.active && groups.length > 2));
    });
    if (clear) clear.hidden = !query;
    if (hit) hit.textContent = query ? `${matched} 项` : '';
  };

  if (input && input.dataset.dmSidebarBound !== '1') {
    input.dataset.dmSidebarBound = '1';
    input.addEventListener('input', applyFilter);
  }
  if (clear && clear.dataset.dmSidebarBound !== '1') {
    clear.dataset.dmSidebarBound = '1';
    clear.addEventListener('click', () => {
      if (!input) return;
      input.value = '';
      input.focus();
      applyFilter();
    });
  }

  groups.forEach((group) => {
    if (group.header.dataset.dmSidebarBound === '1') return;
    group.header.dataset.dmSidebarBound = '1';
    const toggle = (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const nextCollapsed = !group.item.classList.contains('dm-sidebar-group--collapsed');
      state[group.title] = nextCollapsed;
      writeState(state);
      setCollapsed(group, nextCollapsed);
    };
    group.header.addEventListener('click', toggle, true);
    group.header.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      toggle(event);
    }, true);
  });

  section.setAttribute(ENHANCED_ATTR, '1');
  applyFilter();
}

function scheduleEnhance() {
  window.requestAnimationFrame(enhanceSidebar);
  window.setTimeout(enhanceSidebar, 120);
  window.setTimeout(enhanceSidebar, 400);
}

addPage(() => {
  scheduleEnhance();
  if (window[BOUND_FLAG]) return;
  window[BOUND_FLAG] = true;
  document.addEventListener('vjContentNew', scheduleEnhance);
});
