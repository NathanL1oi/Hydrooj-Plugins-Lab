import { addPage, NamedPage } from '@hydrooj/ui-default';

const ENTRY_ID = 'disable-sol-problem-entry';
const STYLE_ID = 'disable-sol-problem-style';

function getConfig() {
  return window.UiContext && window.UiContext.disableSolProblem;
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${ENTRY_ID} {
      box-sizing: border-box;
      margin: 10px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 12px;
      border: 1px solid #dbe8f7;
      border-left: 3px solid #5aa6e8;
      border-radius: 8px;
      background: linear-gradient(180deg, #fbfdff 0%, #f6faff 100%);
      box-shadow: 0 1px 2px rgba(31, 45, 61, .04);
    }
    #${ENTRY_ID} .disable-sol-problem-title {
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
      margin-bottom: 0;
      color: #1d3557;
      font-size: 14px;
      font-weight: 700;
    }
    #${ENTRY_ID} .disable-sol-problem-row {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      flex: 0 0 auto;
    }
    #${ENTRY_ID} .disable-sol-problem-state {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 104px;
      min-height: 34px;
      padding: 0 16px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 700;
      white-space: nowrap;
    }
    #${ENTRY_ID} .disable-sol-problem-state.is-open {
      color: #0b65c2;
      border: 1px solid #9ed0ff;
      background: #eff8ff;
    }
    #${ENTRY_ID} .disable-sol-problem-state.is-closed {
      color: #d34220;
      border: 1px solid #ffc8b8;
      background: #fff4ef;
    }
    #${ENTRY_ID} .disable-sol-problem-form {
      display: flex;
      margin: 0;
    }
    #${ENTRY_ID} .disable-sol-problem-state {
      cursor: pointer;
      transition: transform .15s ease, background .15s ease, border-color .15s ease, box-shadow .15s ease;
    }
    #${ENTRY_ID} .disable-sol-problem-state:hover {
      box-shadow: 0 3px 10px rgba(32, 64, 100, .12);
    }
    #${ENTRY_ID} .disable-sol-problem-state:active {
      transform: translateY(1px);
    }
    .theme--dark #${ENTRY_ID} {
      border-color: #3a4656;
      border-left-color: #60a5fa;
      background: #242b35;
      box-shadow: none;
    }
    .theme--dark #${ENTRY_ID} .disable-sol-problem-title {
      color: #e2e8f0;
    }
    .theme--dark #${ENTRY_ID} .disable-sol-problem-state.is-open {
      color: #93c5fd;
      border-color: #2563eb;
      background: #10233e;
    }
    .theme--dark #${ENTRY_ID} .disable-sol-problem-state.is-closed {
      color: #fca5a5;
      border-color: #7f1d1d;
      background: #351b1b;
    }
    .theme--dark #${ENTRY_ID} .disable-sol-problem-state:hover {
      box-shadow: 0 3px 10px rgba(0, 0, 0, .24);
    }
  `;
  document.head.appendChild(style);
}

function findProblemMenu() {
  return document.querySelector('.section--problem-sidebar ol.menu');
}

function findSolutionItem(menu) {
  return Array.from(menu.querySelectorAll('a.menu__link'))
    .find((link) => /\/solution(?:$|\?)/.test(link.getAttribute('href') || ''))
    ?.closest('li');
}

function createHiddenInput(name, value) {
  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = name;
  input.value = String(value);
  return input;
}

function mount() {
  const cfg = getConfig();
  if (!cfg || !cfg.canManage || !cfg.action) return;

  const existing = document.getElementById(ENTRY_ID);
  if (existing) {
    if (existing.dataset.singleButton === 'true') return;
    existing.remove();
  }

  const menu = findProblemMenu();
  if (!menu) return;
  ensureStyle();

  const closed = !!cfg.closed;
  const item = document.createElement('li');
  item.id = ENTRY_ID;
  item.className = 'menu__item';
  item.dataset.singleButton = 'true';

  const title = document.createElement('div');
  title.className = 'disable-sol-problem-title';
  const titleIcon = document.createElement('span');
  titleIcon.className = 'icon icon-edit';
  title.append(titleIcon, document.createTextNode(' 题解状态'));

  const row = document.createElement('div');
  row.className = 'disable-sol-problem-row';

  const form = document.createElement('form');
  form.method = 'post';
  form.action = String(cfg.action);
  form.className = 'disable-sol-problem-form';
  form.append(
    createHiddenInput('pid', cfg.docId || cfg.pid),
    createHiddenInput('disable_sol', closed ? 'false' : 'true'),
  );

  const button = document.createElement('button');
  button.type = 'submit';
  button.className = `disable-sol-problem-state ${closed ? 'is-closed' : 'is-open'}`;
  button.textContent = closed ? '当前关闭' : '当前开放';
  button.title = closed ? '点击后打开题解' : '点击后关闭题解';
  button.setAttribute('aria-label', button.title);
  form.appendChild(button);

  row.append(form);
  item.append(title, row);

  const before = findSolutionItem(menu);
  menu.insertBefore(item, before || null);
}

addPage(new NamedPage(['problem_detail'], () => {
  mount();
  window.setTimeout(mount, 80);
  window.setTimeout(mount, 300);
}));
