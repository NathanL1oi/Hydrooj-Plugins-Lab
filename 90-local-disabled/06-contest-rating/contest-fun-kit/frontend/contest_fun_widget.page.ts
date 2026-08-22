import { $, addPage } from '@hydrooj/ui-default';

declare const UiContext: any;

function domainBase() {
    const domainId = UiContext?.domain?._id || UiContext?.domainId;
    return domainId ? `/d/${domainId}` : '';
}

function pluginEnabled() {
    return !(UiContext?.pluginSwitch?.disabled || []).includes('contest-fun-kit');
}

function contestIdFromPath() {
    const match = window.location.pathname.match(/(?:\/d\/[^/]+)?\/contest\/([^/?#]+)/);
    const tid = match?.[1] || '';
    return /^[0-9a-f]{24}$/i.test(tid) ? tid : '';
}

function ensureStyle() {
    if (document.getElementById('contest-fun-kit-style')) return;
    const style = document.createElement('style');
    style.id = 'contest-fun-kit-style';
    style.textContent = `
      #contest-fun-widget .cfk-side-body { display: grid; gap: 10px; }
      #contest-fun-widget .cfk-side-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      #contest-fun-widget .cfk-side-pill { display: inline-block; padding: 2px 7px; border-radius: 999px; background: #eef2ff; color: #3730a3; font-size: 12px; white-space: nowrap; }
      #contest-fun-widget .cfk-side-muted { color: #64748b; font-size: 13px; line-height: 1.45; }
      #contest-fun-widget .cfk-side-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
      #contest-fun-widget .cfk-side-list li { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; }
      #contest-fun-widget .cfk-side-actions { display: flex; flex-wrap: wrap; gap: 6px; }
      #contest-fun-widget .cfk-side-actions .button { margin: 0; }
      .theme--dark #contest-fun-widget .cfk-side-pill {
        background: #10233e;
        color: #93c5fd;
      }
      .theme--dark #contest-fun-widget .cfk-side-muted {
        color: #94a3b8;
      }
    `;
    document.head.appendChild(style);
}

function insertMenu(data: any) {
    $('#contest-fun-menu-goal, #contest-fun-menu-highlights, #contest-fun-menu-timeline, #contest-fun-menu-settings').remove();
    if (!data?.showMenu) return;
    const $menu = $('.section.side ol.menu').first();
    if (!$menu.length) return;
    const $sep = $menu.children('.menu__seperator').first();
    const insert = ($item: any) => {
        if ($sep.length) $item.insertBefore($sep);
        else $menu.append($item);
    };
    if (data.goalEnabled || data.groupModeEnabled) {
        const $li = $('<li class="menu__item" id="contest-fun-menu-goal">');
        $('<a class="menu__link">')
            .attr('href', data.urls.goal)
            .html('<span class="icon icon-edit"></span> 赛前目标 / 小组')
            .appendTo($li);
        insert($li);
    }
    if (data.highlightEnabled) {
        const $li = $('<li class="menu__item" id="contest-fun-menu-highlights">');
        $('<a class="menu__link">')
            .attr('href', data.urls.highlights)
            .html('<span class="icon icon-star"></span> 首杀高光')
            .appendTo($li);
        insert($li);
    }
    if (data.timelineEnabled) {
        const $li = $('<li class="menu__item" id="contest-fun-menu-timeline">');
        $('<a class="menu__link">')
            .attr('href', data.urls.timeline)
            .html('<span class="icon icon-flag"></span> 赛后复盘')
            .appendTo($li);
        insert($li);
    }
    if (data.canManage) {
        const $li = $('<li class="menu__item" id="contest-fun-menu-settings">');
        $('<a class="menu__link">')
            .attr('href', data.urls.settings)
            .html('<span class="icon icon-settings"></span> 互动设置')
            .appendTo($li);
        insert($li);
    }
}

function renderWidget(data: any) {
    $('#contest-fun-widget').remove();
    if (!data?.enabled) return;
    const $side = $('[data-sticky="large"]').first().length
        ? $('[data-sticky="large"]').first()
        : $('.row[data-sticky-parent] > .medium-3.columns').first();
    if (!$side.length) return;

    const $card = $('<div class="section side" id="contest-fun-widget">');
    const $header = $('<div class="section__header">').appendTo($card);
    const $title = $('<div class="section__title cfk-side-title">').appendTo($header);
    $('<span>').text('比赛互动').appendTo($title);
    if (data.task) $('<span class="cfk-side-pill">').text(`${data.task.done}/${data.task.count}`).appendTo($title);

    const $body = $('<div class="section__body cfk-side-body">').appendTo($card);
    if (data.groupModeEnabled) {
        $('<div class="cfk-side-muted">')
            .text(data.teamName ? `我的小组：${data.teamName}` : '小组模式已开启，尚未选择小组')
            .appendTo($body);
        if (data.groupProgress) {
            $('<div class="cfk-side-muted">')
                .text(`小组进度：${data.groupProgress.solved}/${data.groupProgress.total} 题，${data.groupProgress.members} 人`)
                .appendTo($body);
        }
    }
    if (data.goalEnabled) {
        $('<div class="cfk-side-muted">')
            .text(data.goal ? `赛前目标：AC ${data.goal.targetSolve} 题` : '还没有填写赛前目标')
            .appendTo($body);
    }
    if (data.taskEnabled && data.task?.items?.length) {
        const $list = $('<ul class="cfk-side-list">').appendTo($body);
        for (const item of data.task.items.slice(0, 5)) {
            const $li = $('<li>').appendTo($list);
            $('<span>').text(item.title).appendTo($li);
            $('<span>').text(item.done ? '已完成' : '待完成').appendTo($li);
        }
    }
    if (data.highlightEnabled && data.highlights?.length) {
        const $list = $('<ul class="cfk-side-list">').appendTo($body);
        for (const event of data.highlights) {
            const $li = $('<li>').appendTo($list);
            $('<span>').text(event.title).appendTo($li);
            $('<span>').text(event.teamName || event.uname || '').appendTo($li);
        }
    }
    const $actions = $('<div class="cfk-side-actions">').appendTo($body);
    if (data.goalEnabled || data.groupModeEnabled) {
        $('<a class="button rounded primary">').attr('href', data.urls.goal).text(data.goal ? '查看目标' : '填写目标').appendTo($actions);
    }
    if (data.highlightEnabled) {
        $('<a class="button rounded">').attr('href', data.urls.highlights).text('高光').appendTo($actions);
    }
    if (data.timelineEnabled) {
        $('<a class="button rounded">').attr('href', data.urls.timeline).text('复盘').appendTo($actions);
    }

    const $first = $side.children('.section.side').first();
    if ($first.length) $first.after($card);
    else $side.prepend($card);
}

function mountContestFun() {
    ensureStyle();
    const tid = contestIdFromPath();
    $('#contest-fun-widget, #contest-fun-menu-goal, #contest-fun-menu-highlights, #contest-fun-menu-timeline, #contest-fun-menu-settings').remove();
    if (!pluginEnabled()) return;
    if (!tid) return;
    $.getJSON(`${domainBase()}/contest/${tid}/fun/widget`)
        .then((data: any) => {
            if (!data?.ok) return;
            insertMenu(data);
            renderWidget(data);
        })
        .catch((e) => console.warn('[contest-fun-kit] widget load failed', e));
}

addPage(() => {
    mountContestFun();
    $(document).off('vjContentNew.contestFunKit').on('vjContentNew.contestFunKit', () => mountContestFun());
});
