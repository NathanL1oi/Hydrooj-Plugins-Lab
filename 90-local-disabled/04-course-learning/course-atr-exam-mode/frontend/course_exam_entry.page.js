import { addPage, NamedPage } from '@hydrooj/ui-default';

const IDS = [
  'course-subsec-exam-entry',
  'course-subsec-exam-scoreboard-entry',
  'course-subsec-exam-edit-entry',
  'course-subsec-exam-results-entry',
];

let backendReady = false;
let backendReadyPromise = null;

function cfg() {
  return window.UiContext && window.UiContext.courseSubsecExamMode;
}

function routePrefix() {
  const match = window.location.pathname.match(/^\/d\/[^/]+/);
  return match ? match[0] : '';
}

function ensureBackendReady() {
  if (cfg() || backendReady) return Promise.resolve(true);
  if (!backendReadyPromise) {
    backendReadyPromise = fetch(`${routePrefix()}/course-exam-mode/ping`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        backendReady = !!data?.ok;
        return backendReady;
      })
      .catch(() => false);
  }
  return backendReadyPromise;
}

function pathBase() {
  const match = window.location.pathname.match(/^(.*\/course\/[^/]+\/s\/[^/]+\/[^/]+)(?:\/)?$/);
  return match ? match[1] : '';
}

function canManageFromMenu(menu) {
  if (!menu) return false;
  return !!(
    menu.querySelector('a[href$="/edit"]')
    || menu.querySelector('a[href$="/scoreboard"]')
  );
}

function removeOldEntries() {
  for (const id of IDS) document.getElementById(id)?.remove();
}

function menuItem(id, href, icon, label) {
  const li = document.createElement('li');
  li.className = 'menu__item';
  li.id = id;
  const a = document.createElement('a');
  a.className = 'menu__link';
  a.href = href;
  const span = document.createElement('span');
  span.className = `icon ${icon}`;
  a.append(span, document.createTextNode(` ${label}`));
  li.appendChild(a);
  return li;
}

function findMenu() {
  const actionsMenu = document.querySelector('.course-side-actions-menu');
  if (actionsMenu) return actionsMenu;
  const menus = Array.from(document.querySelectorAll('.section.side ol.menu'))
    .filter((menu) => !menu.classList.contains('course-side-results-menu'));
  return menus.find((menu) => menu.querySelector('a[href*="/course/"][href*="/s/"]'))
    || menus[0]
    || null;
}

function findResultsMenu() {
  return document.querySelector('.course-side-results-menu');
}

function mountExamEntry() {
  removeOldEntries();

  const menu = findMenu();
  if (!menu) return;

  const data = cfg() || {};
  if (!data.baseUrl && !backendReady) {
    ensureBackendReady().then((ready) => {
      if (ready) mountExamEntry();
    });
    return;
  }

  const canEdit = !!data.canEdit || canManageFromMenu(menu);
  const enabled = !!data.enabled;
  if (!enabled && !canEdit) return;

  const base = String(data.baseUrl || pathBase()).replace(/\/+$/, '');
  if (!base) return;

  const entries = [];
  if (enabled || canEdit) {
    entries.push(menuItem('course-subsec-exam-entry', `${base}/exam`, 'icon-flag', '小节考试'));
  }
  if (canEdit) {
    entries.push(menuItem('course-subsec-exam-scoreboard-entry', `${base}/exam/scoreboard`, 'icon-statistics', '比赛排名'));
    entries.push(menuItem('course-subsec-exam-edit-entry', `${base}/exam/edit`, 'icon-edit', '考试设置'));
    entries.push(menuItem('course-subsec-exam-results-entry', `${base}/exam/results`, 'icon-statistics', '考试记录'));
  }

  const resultsMenu = findResultsMenu();
  if (resultsMenu) {
    const resultEntries = [];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (
        entries[i].id === 'course-subsec-exam-scoreboard-entry'
        || entries[i].id === 'course-subsec-exam-results-entry'
      ) {
        resultEntries.unshift(entries.splice(i, 1)[0]);
      }
    }
    for (const entry of resultEntries) resultsMenu.append(entry);
  }

  if (!entries.length) return;

  const fileLink = menu.querySelector(`a[href="${base}/file"], a[href$="/file"]`);
  const articleLink = menu.querySelector(`a[href*="/blog/create/course/"]`);
  const anchor = (fileLink || articleLink)?.closest('li');
  if (anchor) {
    let after = anchor;
    for (const entry of entries) {
      after.after(entry);
      after = entry;
    }
    return;
  }

  for (let i = entries.length - 1; i >= 0; i -= 1) menu.prepend(entries[i]);
}

addPage(new NamedPage('course_subsec_detail', () => {
  mountExamEntry();
  window.setTimeout(mountExamEntry, 80);
}));
