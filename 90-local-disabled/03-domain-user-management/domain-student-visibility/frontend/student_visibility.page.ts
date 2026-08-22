import { $, addPage } from '@hydrooj/ui-default';

declare const UiContext: any;

interface VisibilityContext {
    studentMode?: boolean;
    allowProblemSet?: boolean;
    showProblemStats?: boolean;
    showProblemDifficultyTags?: boolean;
}

function config(): VisibilityContext {
    return UiContext?.domainStudentVisibility || {};
}

function isProblemListHref(raw: string) {
    if (!raw || raw.startsWith('#')) return false;
    try {
        const url = new URL(raw, window.location.origin);
        return /^\/(?:d\/[^/]+\/)?p\/?$/.test(url.pathname);
    } catch (e) {
        return false;
    }
}

function ensureStyle() {
    if (document.getElementById('domain-student-visibility-style')) return;
    const style = document.createElement('style');
    style.id = 'domain-student-visibility-style';
    style.textContent = `
      body.dsv-hide-stats .col--ac-tried,
      body.dsv-hide-stats .col--tried,
      body.dsv-hide-stats .col--accepted,
      body.dsv-hide-difficulty-tags .col--difficulty,
      body.dsv-hide-difficulty-tags .col--problem-name .problem__tags,
      body.dsv-hide-difficulty-tags [name="show_tags"],
      body.dsv-hide-difficulty-tags .problem__tag,
      body.dsv-hide-difficulty-tags .problem__tag-link,
      body.dsv-hide-difficulty-tags .problem__tag-item.tags {
        display: none !important;
      }
    `;
    document.head.appendChild(style);
}

function hideProblemNav() {
    $('a[href]').each((_i, element) => {
        const href = element.getAttribute('href') || '';
        if (!isProblemListHref(href)) return;
        const $target = $(element).closest('.nav__list-item, .nav__item, .menu__item, li');
        ($target.length ? $target : $(element)).hide();
    });
}

function hideProblemStats() {
    $('.col--ac-tried, .col--tried, .col--accepted').hide();
    $('.problem__tags a[href*="/record"], .problem__tags a[href*="record_main"]').each((_i, element) => {
        const text = $(element).text();
        if (/Tried|Accepted|尝试|已通过|提交|通过/i.test(text)) $(element).hide();
    });
    $('.problem__tag-item').each((_i, element) => {
        const text = $(element).text();
        if (/Tried|Accepted|尝试|已通过/i.test(text)) $(element).hide();
    });
}

function hideDifficultyAndTags() {
    $('.col--difficulty, .col--problem-name .problem__tags, [name="show_tags"], .problem__tag, .problem__tag-link, .problem__tag-item.tags').hide();
    $('.problem__tag-item').each((_i, element) => {
        const text = $(element).text().trim();
        if (/Difficulty|Tags|难度|标签/i.test(text)) $(element).hide();
    });

    $('.section--problem-sidebar dl dt').each((_i, element) => {
        const text = $(element).text().trim();
        if (!/Difficulty|Tags|难度|标签/i.test(text)) return;
        const $dt = $(element);
        const $dd = $dt.next('dd');
        $dt.hide();
        $dd.hide();
    });
}

function applyVisibility() {
    const ctx = config();
    if (!ctx.studentMode) return;
    ensureStyle();

    document.body.classList.toggle('dsv-hide-stats', ctx.showProblemStats === false);
    document.body.classList.toggle('dsv-hide-difficulty-tags', ctx.showProblemDifficultyTags === false);

    if (ctx.allowProblemSet === false) hideProblemNav();
    if (ctx.showProblemStats === false) hideProblemStats();
    if (ctx.showProblemDifficultyTags === false) hideDifficultyAndTags();
}

addPage(() => {
    applyVisibility();
    $(document).off('vjContentNew.domainStudentVisibility').on('vjContentNew.domainStudentVisibility', () => applyVisibility());
});
