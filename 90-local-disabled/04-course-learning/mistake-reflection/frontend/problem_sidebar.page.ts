import { $, addPage } from '@hydrooj/ui-default';

declare const UiContext: any;

function domainBase() {
    const domainId = UiContext?.domain?._id || UiContext?.domainId;
    return domainId ? `/d/${domainId}` : '';
}

function escapeHtml(value: string) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function problemId() {
    const fromContext = Number(UiContext?.pdoc?.docId || UiContext?.pdoc?._id || 0);
    if (fromContext) return fromContext;
    const match = window.location.pathname.match(/\/p\/(\d+)/);
    return match ? Number(match[1]) : 0;
}

function insertReflectionMenuItem(li: HTMLLIElement) {
    const $menu = $('.section--problem-sidebar ol.menu').first();
    if (!$menu.length) return;
    const $discussion = $menu.find('a[href*="/discuss/"]').closest('li').first();
    if ($discussion.length) $discussion.after(li);
    else {
        const $files = $menu.find('a[href*="/file"], a[href*="problem_files"]').closest('li').first();
        if ($files.length) $files.before(li);
        else $menu.append(li);
    }
}

function mountProblemReflectionEntry() {
    const pid = problemId();
    if (!pid) return;
    if (document.getElementById('mistake-reflection-problem-entry')) return;
    if (!$('.section--problem-sidebar ol.menu').length) return;

    $.getJSON(`${domainBase()}/reflection/card/${pid}`).then((data: any) => {
        if (!data?.accepted || document.getElementById('mistake-reflection-problem-entry')) return;
        const li = document.createElement('li');
        li.className = 'menu__item';
        li.id = 'mistake-reflection-problem-entry';
        const hasReflection = !!data.hasReflection;
        const url = hasReflection ? data.editUrl : data.createUrl;
        li.innerHTML = `
          <a class="menu__link${hasReflection ? '' : ' highlight'}" href="${escapeHtml(url)}">
            <span class="icon icon-edit"></span>
            ${hasReflection ? '错因总结（已完成）' : '填写错因总结（AC 必填）'}
          </a>
        `;
        insertReflectionMenuItem(li);
    }).catch(() => {});
}

addPage(mountProblemReflectionEntry);
