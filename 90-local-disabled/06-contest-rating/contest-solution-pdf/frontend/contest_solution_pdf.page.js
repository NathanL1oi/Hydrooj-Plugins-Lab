import { addPage, NamedPage } from '@hydrooj/ui-default';

addPage(new NamedPage(['contest_detail'], () => {
  const config = window.UiContext && window.UiContext.contestSolutionPdf;
  if (!config?.url || document.getElementById('contest-solution-pdf-link')) return;

  const menu = document.querySelector('.medium-3.columns .section.side ol.menu');
  if (!menu) return;

  const item = document.createElement('li');
  item.className = 'menu__item';
  item.id = 'contest-solution-pdf-link';

  const link = document.createElement('a');
  link.className = 'menu__link';
  link.href = config.url;
  link.setAttribute('data-no-instant', '');
  link.innerHTML = '<span class="icon icon-book"></span> 导出题解';

  item.appendChild(link);

  const anchors = Array.from(menu.querySelectorAll('a.menu__link'));
  const scoreboard = anchors.find((anchor) => /scoreboard/.test(anchor.href || ''));
  const print = anchors.find((anchor) => /\/print(?:$|[?#])/.test(anchor.href || ''));
  const reference = print || scoreboard;
  const referenceItem = reference && reference.closest('li.menu__item');
  if (referenceItem?.nextSibling) menu.insertBefore(item, referenceItem.nextSibling);
  else menu.appendChild(item);
}));
