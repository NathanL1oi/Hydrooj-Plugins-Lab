import { $, addPage } from '@hydrooj/ui-default';

declare const UiContext: any;

interface WidgetData {
  ok: boolean;
  hasTask: boolean;
  canEdit: boolean;
  canSubmit: boolean;
  targetTitle: string;
  task?: {
    title: string;
    deadlineText: string;
    minWords: number;
    defaultPoints: number;
    dailyReminder: boolean;
    allowLate: boolean;
  } | null;
  submit?: {
    status: 'submitted' | 'late';
    wordCount: number;
    awardedPoints: number;
    excellent: boolean;
  } | null;
  pointTotal: number;
  pendingCount: number;
  editUrl: string;
  submitUrl: string;
  manageUrl: string;
}

function routeInfo() {
  const path = window.location.pathname.replace(/\/$/, '');
  const match = path.match(/(?:\/d\/[^/]+)?\/course\/([^/]+)\/s\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) return null;
  const [, cid, csid, ssid] = match;
  if (ssid && ['create', 'edit', 'scoreboard', 'file'].includes(ssid)) return null;
  return {
    cid,
    csid,
    ssid,
    targetType: ssid ? 'subsec' : 'section',
  };
}

function ensureStyle() {
  if (document.getElementById('course-summary-points-style')) return;
  const style = document.createElement('style');
  style.id = 'course-summary-points-style';
  style.textContent = `
    .csp-widget {
      display: grid;
      gap: 10px;
      margin: 0;
      padding: 13px 15px 14px;
      border: 0;
      border-radius: 0;
      background: transparent;
      box-shadow: none;
      overflow: visible;
    }
    .csp-widget-shell {
      overflow: visible !important;
      opacity: 1 !important;
      transform: none !important;
    }
    .csp-widget-shell > .section__body {
      padding: 0 !important;
    }
    .csp-widget .csp-widget-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
      color: #1d3557;
      font-size: 14px;
      font-weight: 700;
      line-height: 1.35;
    }
    .csp-widget .csp-widget-heading {
      display: inline-flex;
      min-width: 0;
      align-items: center;
      gap: 7px;
    }
    .csp-widget .csp-widget-heading .icon {
      flex: 0 0 auto;
      color: #315778;
    }
    .csp-widget .csp-status {
      display: inline-flex;
      flex: 0 0 auto;
      align-items: center;
      min-height: 22px;
      padding: 0 8px;
      border-radius: 999px;
      background: #eef2ff;
      color: #3730a3;
      font-size: 12px;
      line-height: 22px;
      white-space: nowrap;
    }
    .csp-widget .csp-status.is-done { background: #dcfce7; color: #166534; }
    .csp-widget .csp-status.is-empty { background: #f1f5f9; color: #64748b; }
    .csp-widget .csp-widget-body { display: grid; gap: 9px; }
    .csp-widget .csp-widget-meta { display: grid; gap: 4px; color: #64748b; font-size: 12.5px; line-height: 1.45; }
    .csp-widget .csp-widget-name { color: #24364f; font-size: 13.5px; font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
    .csp-widget .csp-widget-actions {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(104px, 1fr));
      gap: 7px;
      align-items: stretch;
    }
    .csp-widget .csp-widget-actions .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      min-height: 34px;
      margin: 0 !important;
      padding: 6px 10px;
      font-size: 12.5px;
      line-height: 1.25;
      white-space: normal;
      text-align: center;
    }
    .theme--dark .csp-widget {
      background: transparent;
      box-shadow: none;
    }
    .theme--dark .csp-widget .csp-widget-title,
    .theme--dark .csp-widget .csp-widget-name {
      color: #e2e8f0;
    }
    .theme--dark .csp-widget .csp-widget-heading .icon,
    .theme--dark .csp-widget .csp-widget-meta {
      color: #94a3b8;
    }
    .theme--dark .csp-widget .csp-status {
      background: rgba(37, 99, 235, .24);
      color: #93c5fd;
    }
    .theme--dark .csp-widget .csp-status.is-done {
      background: rgba(22, 101, 52, .32);
      color: #86efac;
    }
    .theme--dark .csp-widget .csp-status.is-empty {
      background: rgba(15, 23, 42, .42);
      color: #94a3b8;
    }
    html.hydro-user-background-enabled .csp-widget {
      border-color: var(--course-border, rgba(15, 23, 42, .10));
      border-left-color: var(--course-accent, #5aa6e8);
      background: var(--course-bg-card, rgba(255, 255, 255, .38)) !important;
      box-shadow: var(--course-shadow, none);
      backdrop-filter: blur(14px) saturate(150%);
      -webkit-backdrop-filter: blur(14px) saturate(150%);
    }
    html.hydro-user-background-enabled.theme--dark .csp-widget,
    html.hydro-user-background-enabled .theme--dark .csp-widget {
      border-color: var(--course-border, rgba(255, 255, 255, .12));
      border-left-color: var(--course-accent, #60a5fa);
      background: var(--course-bg-card, rgba(24, 28, 36, .52)) !important;
      box-shadow: var(--course-shadow, none);
    }
    html.hydro-user-background-enabled .csp-widget .csp-status {
      border: 1px solid var(--course-border-soft, rgba(15, 23, 42, .07));
      background: var(--course-bg-soft, rgba(255, 255, 255, .24)) !important;
      color: var(--course-link, #0969c8);
    }
    html.hydro-user-background-enabled.theme--dark .csp-widget .csp-status,
    html.hydro-user-background-enabled .theme--dark .csp-widget .csp-status {
      border-color: var(--course-border-soft, rgba(255, 255, 255, .08));
      background: var(--course-bg-soft, rgba(24, 28, 36, .34)) !important;
      color: #93c5fd;
    }
    html.hydro-user-background-enabled .csp-widget .csp-status.is-done {
      background: rgba(22, 163, 74, .18) !important;
      color: #15803d;
    }
    html.hydro-user-background-enabled.theme--dark .csp-widget .csp-status.is-done,
    html.hydro-user-background-enabled .theme--dark .csp-widget .csp-status.is-done {
      background: rgba(34, 197, 94, .18) !important;
      color: #86efac;
    }
    html.hydro-user-background-enabled .csp-widget .csp-status.is-empty {
      background: var(--course-bg-muted, rgba(255, 255, 255, .18)) !important;
      color: var(--course-muted, #64748b);
    }
    html.hydro-user-background-enabled.theme--dark .csp-widget .csp-status.is-empty,
    html.hydro-user-background-enabled .theme--dark .csp-widget .csp-status.is-empty {
      background: var(--course-bg-muted, rgba(15, 23, 42, .28)) !important;
      color: var(--course-muted, #94a3b8);
    }
    html.hydro-user-background-enabled .csp-widget .csp-widget-actions .button:not(.primary) {
      border-color: var(--course-border, rgba(15, 23, 42, .10)) !important;
      background: var(--course-bg-muted, rgba(255, 255, 255, .18)) !important;
    }
  `;
  document.head.appendChild(style);
}

function appendLine($meta: any, label: string, value: string | number) {
  const $line = $('<div>');
  $('<span>').text(`${label}: ${value}`).appendTo($line);
  $meta.append($line);
}

function taskDisplayTitle(data: WidgetData) {
  const title = String(data.task?.title || '').trim();
  const readableTitle = title.replace(/[#>*_`~\-[\]()]/g, '').trim();
  if (readableTitle) return title;
  return data.targetTitle ? `${data.targetTitle}学习小结` : '课程学习小结';
}

function renderCard(data: WidgetData) {
  const $card = $('<div class="csp-widget course-side-module">');
  const $title = $('<div class="csp-widget-title">').appendTo($card);
  const $heading = $('<span class="csp-widget-heading">').appendTo($title);
  $('<span class="icon icon-edit">').appendTo($heading);
  $('<span>').text('学习小结').appendTo($heading);

  const statusText = !data.hasTask ? '未布置' : data.submit ? '已提交' : '待完成';
  $('<span>')
    .addClass(`csp-status ${data.submit ? 'is-done' : (!data.hasTask ? 'is-empty' : '')}`)
    .text(statusText)
    .appendTo($title);

  const $body = $('<div class="csp-widget-body">').appendTo($card);
  const $actions = $('<div class="csp-widget-actions">');

  if (!data.hasTask || !data.task) {
    $('<div class="csp-widget-meta">').text(data.canEdit ? '当前章/小节还没有小结任务。' : '当前章/小节暂无小结任务。').appendTo($body);
    if (data.canEdit) {
      $('<a class="button rounded primary">').attr('href', data.editUrl).text('布置小结').appendTo($actions);
      $body.append($actions);
    }
    return $card;
  }

  $('<div class="csp-widget-name">').text(taskDisplayTitle(data)).appendTo($body);
  const $meta = $('<div class="csp-widget-meta">').appendTo($body);
  appendLine($meta, '截止', data.task.deadlineText || '不限');
  if (data.task.minWords) appendLine($meta, '最低字数', data.task.minWords);
  if (data.task.defaultPoints) appendLine($meta, '默认积分', data.task.defaultPoints);
  if (data.submit) {
    appendLine($meta, '我的字数', data.submit.wordCount);
    appendLine($meta, '已获积分', data.submit.awardedPoints || 0);
  }
  if (data.canSubmit) {
    $('<a class="button rounded primary">')
      .attr('href', data.submitUrl)
      .text(data.submit ? '查看/修改' : '写小结')
      .appendTo($actions);
  }
  if (data.canEdit) {
    $('<a class="button rounded">').attr('href', data.manageUrl).text(`批改${data.pendingCount ? ` (${data.pendingCount}未交)` : ''}`).appendTo($actions);
    $('<a class="button rounded">').attr('href', data.editUrl).text('设置/删除').appendTo($actions);
  }
  $body.append($actions);
  return $card;
}

function refreshSidebarLayout($side: any) {
  if ($side?.length) $side.addClass('course-atr-sidebar-scroll');
  const side = $side?.get?.(0);
  if (side) side.scrollTop = 0;
  window.requestAnimationFrame(() => {
    window.dispatchEvent(new Event('courseAtrSidebarChanged'));
    $('body').trigger('sticky_kit:recalc');
    $(document).trigger('vjLayout');
  });
}

async function mountWidget() {
  ensureStyle();
  $('.csp-widget, .csp-widget-shell').remove();
  const info = routeInfo();
  if (!info) return;
  const domainId = UiContext?.domain?._id || UiContext?.domainId;
  if (!domainId) return;
  const query = new URLSearchParams({
    cid: info.cid,
    csid: info.csid,
    targetType: info.targetType,
  });
  if (info.ssid) query.set('ssid', info.ssid);
  try {
    const data = await $.getJSON(`/d/${domainId}/course-summary/widget?${query.toString()}`) as WidgetData;
    if (!data?.ok) return;
    let $side = $('.row[data-sticky-parent] > .medium-3.columns').first();
    if (!$side.length) $side = $('[data-sticky="large"]').first();
    if (!$side.length) return;

    const $card = renderCard(data);
    const $shell = $('<div class="section side csp-widget-shell visible">');
    $('<div class="section__body">').append($card).appendTo($shell);
    const $results = $side.children('.course-side-results').first();
    if ($results.length) $results.before($shell);
    else $side.prepend($shell);
    refreshSidebarLayout($side);
  } catch (e) {
    console.warn('[course-summary-points] widget load failed', e);
  }
}

addPage(() => {
  mountWidget();
  $(document).off('vjContentNew.courseSummaryPoints').on('vjContentNew.courseSummaryPoints', () => mountWidget());
});
