import { addPage, NamedPage } from '@hydrooj/ui-default';

declare const UiContext: any;

addPage(new NamedPage(['contest_detail'], () => {
    const config = UiContext?.contestSummaryEntry;
    if (!config?.url || document.getElementById('contest-summary-entry-link')) return;

    const menu = document.querySelector('.medium-3.columns .section.side ol.menu');
    if (!menu) return;

    const item = document.createElement('li');
    item.className = 'menu__item';
    item.id = 'contest-summary-entry-link';

    const link = document.createElement('a');
    link.className = 'menu__link';
    link.href = config.url;
    link.setAttribute('data-no-instant', '');

    const icon = document.createElement('span');
    icon.className = 'icon icon-edit';
    link.append(icon, ` ${config.title || '赛后总结'}`);
    item.appendChild(link);

    const anchors = Array.from(menu.querySelectorAll('a.menu__link')) as HTMLAnchorElement[];
    const discussion = anchors.find((anchor) => /\/discussion\/contest\//.test(anchor.href || ''));
    const submissions = anchors.find((anchor) => /\/record(?:\?|\/|\b)/.test(anchor.href || ''));
    const help = anchors.find((anchor) => /\/wiki\/help/.test(anchor.href || ''));
    const reference = discussion || submissions || help;
    const referenceItem = reference?.closest('li.menu__item');
    if (referenceItem) menu.insertBefore(item, referenceItem);
    else menu.appendChild(item);
}));
