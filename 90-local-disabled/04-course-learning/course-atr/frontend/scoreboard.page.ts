import {
    addPage, i18n, NamedPage, tpl, $,
} from '@hydrooj/ui-default';

// addPage(new NamedPage(['training_detail'], () => {
//   const menu = $('div.section.side:first-child > div:first-child > ol');
//   $(tpl`<li class="menu__item"><a class="menu__link" href="${window.location.pathname}/scoreboard">
//       <span class="icon icon-statistics"></span> 总成绩表
//     </a></li>`).appendTo(menu);
// }));

addPage(new NamedPage(['course_section_scoreboard', 'course_subsec_scoreboard'], () => {
    $(document).ready(() => { $('html').addClass('page--homework_scoreboard') });
    async function update() {
        const val = $($('.select.filter')).val();
        if (val === 'all') {
            $('.data-table tbody tr').show();
        } else {
            $('.data-table tbody tr').hide();
            const uids = val.toString().split(',').map((i) => +i.trim()).filter((i) => i);
            if (!uids?.length) return;
            uids.forEach((uid) => $(`.user--${uid}`).closest('tr').show());
        }
    }
    $('.select.filter').on('change', update);
}));