import { addPage, NamedPage } from '@hydrooj/ui-default';

const ENTRY_ID = 'problem-collection-entry';

function config() {
  return window.UiContext && window.UiContext.problemCollection;
}

function findSidebar() {
  return document.querySelector('.medium-3.columns .section .section__body')
    || document.querySelector('.large-3.columns .section .section__body')
    || document.querySelector('.section.side .section__body')
    || document.querySelector('.medium-3.columns')
    || document.querySelector('.large-3.columns')
    || document.querySelector('aside');
}

function mount() {
  const cfg = config();
  if (!cfg || !cfg.canUse || !cfg.addUrl || document.getElementById(ENTRY_ID)) return;
  const body = findSidebar();
  if (!body) return;
  const label = cfg.collected
    ? `已收藏 ${cfg.collectedCount || 1} 个题单`
    : '收藏到题单';
  const wrapper = document.createElement('p');
  wrapper.id = ENTRY_ID;
  const link = document.createElement('a');
  link.className = `expanded rounded ${cfg.collected ? 'primary' : ''} button`;
  link.href = String(cfg.addUrl);
  const icon = document.createElement('span');
  icon.className = 'icon icon-star';
  link.append(icon, document.createTextNode(` ${label}`));
  wrapper.appendChild(link);
  body.insertBefore(wrapper, body.firstChild);
}

addPage(new NamedPage(['problem_detail', 'contest_detail_problem', 'homework_detail_problem'], () => {
  mount();
  window.setTimeout(mount, 80);
  window.setTimeout(mount, 300);
}));
