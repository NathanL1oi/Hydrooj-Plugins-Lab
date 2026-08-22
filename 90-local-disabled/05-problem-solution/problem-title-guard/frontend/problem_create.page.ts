import {
  $, addPage, i18n, NamedPage, Notification, request,
} from '@hydrooj/ui-default';

function escapeHtml(value: any) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getDomainId() {
  return (window as any).UiContext?.domainId || location.pathname.match(/^\/d\/([^/]+)/)?.[1] || 'system';
}

addPage(new NamedPage('problem_create', () => {
  const $title = $('input[name="title"]');
  if (!$title.length || $('#problem-title-guard-create').length) return;
  const $panel = $(`
    <div id="problem-title-guard-create" class="typo supplementary" style="margin-top: 8px;"></div>
  `);
  $title.after($panel);
  let timer: any = null;
  let lastValue = '';

  async function checkTitle() {
    const title = String($title.val() || '').trim();
    if (!title || title === lastValue) return;
    lastValue = title;
    try {
      const res = await request.post(`/d/${getDomainId()}/problem-title-guard/check`, { title });
      if (!res.duplicate) {
        $panel.html('<span class="text-green">题名未重名</span>');
        return;
      }
      const matches = (res.matches || [])
        .map((item: any) => `<a href="/d/${getDomainId()}/p/${encodeURIComponent(item.pid || item.docId)}" target="_blank">${escapeHtml(item.pid)} ${escapeHtml(item.title)}</a>`)
        .join('，');
      $panel.html(`
        <span class="text-red">当前题库已有同名题：</span>${matches}
        <button type="button" class="rounded button" name="problem_title_guard_use" style="margin-left: 8px;">
          使用建议名：${escapeHtml(res.suggestedTitle)}
        </button>
      `);
      $panel.find('[name="problem_title_guard_use"]').on('click', () => {
        $title.val(res.suggestedTitle);
        lastValue = '';
        Notification.success(i18n('Title updated.'));
        checkTitle();
      });
    } catch (e: any) {
      $panel.text(e.message || '题名检查失败');
    }
  }

  $title.on('input', () => {
    clearTimeout(timer);
    timer = setTimeout(checkTitle, 400);
  });
  checkTitle();
}));
