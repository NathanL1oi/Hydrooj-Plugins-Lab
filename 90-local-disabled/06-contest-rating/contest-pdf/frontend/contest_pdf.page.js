import { addPage, NamedPage } from '@hydrooj/ui-default';

function insertContestPdfLink() {
  const config = window.UiContext && window.UiContext.contestPdf;
  if (!config?.url || document.getElementById('contest-pdf-link')) return;

  const menu = document.querySelector('.medium-3.columns .section.side ol.menu');
  if (!menu) return;
  const targetPath = new URL(config.url, window.location.href).pathname;
  const hasLink = Array.from(menu.querySelectorAll('a[href]')).some((anchor) => {
    return new URL(anchor.href, window.location.href).pathname === targetPath;
  });
  if (hasLink) return;

  const item = document.createElement('li');
  item.className = 'menu__item';
  item.id = 'contest-pdf-link';

  const link = document.createElement('a');
  link.className = 'menu__link';
  link.href = config.url;
  link.setAttribute('data-no-instant', '');
  link.innerHTML = `<span class="icon icon-book"></span> ${config.title || '\u5bfc\u51fa\u9898\u9762'}`;

  item.appendChild(link);

  const anchors = Array.from(menu.querySelectorAll('a.menu__link'));
  const print = anchors.find((anchor) => /\/print(?:$|[?#])/.test(anchor.href || ''));
  const scoreboard = anchors.find((anchor) => /scoreboard/.test(anchor.href || ''));
  const reference = print || scoreboard;
  const referenceItem = reference && reference.closest('li.menu__item');
  if (referenceItem?.nextSibling) menu.insertBefore(item, referenceItem.nextSibling);
  else menu.appendChild(item);
}

addPage(new NamedPage(['contest_detail'], insertContestPdfLink));
