import {
    i18n, pjax, request, tpl, NamedPage, ConfirmDialog, $, addPage, slideDown, slideUp, JQuery
} from '@hydrooj/ui-default';

type SectionAction = 'expand' | 'collapse';
type SectionState = 'expanded' | 'collapsed';

function action2state(action: SectionAction): SectionState {
    return action === 'expand' ? 'expanded' : 'collapsed';
}

async function setSectionState($section: JQuery<HTMLElement>, state: SectionState) {
    if ($section.is(`.${state}, .animating`)) return;
    $section.addClass('animating');
    const $detail = $section.find('.training__section__detail');
    if (state === 'expanded') {
        await slideDown($detail, 300, { opacity: 0 }, { opacity: 1 });
    } else {
        await slideUp($detail, 300, { opacity: 1 }, { opacity: 0 });
    }
    $section.addClass(state);
    $section.removeClass(state === 'expanded' ? 'collapsed' : 'expanded');
    $section.removeClass('animating');
}

async function handleSection(ev: JQuery.ClickEvent<Document>, type: SectionAction) {
    const $section = $(ev.currentTarget).closest('.training__section');
    await setSectionState($section, action2state(type));
}

async function handleSidebarClick(ev: JQuery.ClickEvent<Document>) {
    const id = $(ev.currentTarget).attr('href');
    const $section = $(id).closest('.training__section');
    await setSectionState($section, 'expanded');
}

async function handleHashChange() {
    const id = window.location.hash;
    if (id.startsWith('#node-')) {
        const $section = $(id).closest('.training__section');
        await setSectionState($section, 'expanded');
    }
}

addPage(new NamedPage(['course_detail'], () => {
    const style = document.createElement('style');
    document.head.appendChild(style);

    style.sheet.insertRule(`.training__section.invalid .training__problems { opacity: 0.6; }`, style.sheet.cssRules.length);
    style.sheet.insertRule(`.training__section.collapsed .collapsed--hidden, .training__section.expanded .expanded--hidden { display: none; }`, style.sheet.cssRules.length);
    style.sheet.insertRule(`.training__section.collapsed .training__section__detail { display: none; }`, style.sheet.cssRules.length);
    style.sheet.insertRule(`#menu-item-course_detail ul { max-height: max(260px, calc(100vh - 220px)); overflow-y: auto; overflow-x: hidden; }`, style.sheet.cssRules.length);


    $(document).on('click', '[name="training__section__expand"]', (ev) => handleSection(ev, 'expand'));
    $(document).on('click', '[name="training__section__collapse"]', (ev) => handleSection(ev, 'collapse'));
    $(document).on('click', '#menu-item-course_detail > ul > li > a', (ev) => handleSidebarClick(ev));
    $(document).on('click', '#menu-item-course_section_detail > ul > li > a', (ev) => handleSidebarClick(ev));
    window.addEventListener('hashchange', handleHashChange);
    $(handleHashChange);
}));
