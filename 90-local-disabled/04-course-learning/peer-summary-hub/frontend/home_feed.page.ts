import { $, addPage } from '@hydrooj/ui-default';

declare const UiContext: any;

function domainBase() {
    const domainId = UiContext?.domain?._id || UiContext?.domainId;
    return domainId ? `/d/${domainId}` : '';
}

function isDomainHomepage() {
    const path = window.location.pathname;
    return path === '/' || /^\/d\/[^/]+\/?$/.test(path);
}

function escapeHtml(value: string) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function ensureStyle() {
    if (document.getElementById('peer-summary-home-style')) return;
    const style = document.createElement('style');
    style.id = 'peer-summary-home-style';
    style.textContent = `
      .psh-home-feed .psh-home-list { display: grid; gap: 10px; }
      .psh-home-feed .psh-home-item { border: 1px solid #e2e8f0; border-radius: 8px; background: #f8fafc; padding: 10px; }
      .psh-home-feed .psh-home-item h2 { font-size: .95rem; margin: 0 0 5px 0; line-height: 1.35; }
      .psh-home-feed .psh-home-meta { color: #64748b; font-size: .85rem; display: flex; gap: 8px; flex-wrap: wrap; }
      .psh-home-feed .psh-home-text { margin: 7px 0 8px 0; color: #334155; font-size: .92rem; }
      .theme--dark .psh-home-feed .psh-home-item {
        border-color: rgba(148, 163, 184, .28);
        background: rgba(31, 41, 55, .72);
        color: #e2e8f0;
      }
      .theme--dark .psh-home-feed .psh-home-meta { color: #94a3b8; }
      .theme--dark .psh-home-feed .psh-home-text { color: #cbd5e1; }
    `;
    document.head.appendChild(style);
}

function mountHomeFeed() {
    if (!isDomainHomepage()) return;
    if (document.getElementById('peer-summary-home-feed')) return;
    $.getJSON(`${domainBase()}/domain/summary-hub/feed`).then((data: any) => {
        const items = (data?.items || []).slice(0, 3);
        if (!items.length || document.getElementById('peer-summary-home-feed')) return;
        ensureStyle();
        const section = document.createElement('div');
        section.className = 'section side psh-home-feed';
        section.id = 'peer-summary-home-feed';
        section.innerHTML = `
          <div class="section__header">
            <h1 class="section__title">优秀总结互评</h1>
          </div>
          <div class="section__body">
            <div class="psh-home-list">
              ${items.map((item: any) => `
                <article class="psh-home-item">
                  <h2><a href="${escapeHtml(item.url)}">${escapeHtml(item.title)}</a></h2>
                  <div class="psh-home-meta">
                    <span>${escapeHtml(item.author)}</span>
                    <span>点赞 ${Number(item.votes || 0)}</span>
                  </div>
                  <p class="psh-home-text">${escapeHtml(item.content)}</p>
                  <a class="button rounded primary small" href="${escapeHtml(item.url)}">阅读与互动</a>
                </article>
              `).join('')}
            </div>
            <p style="margin-top:10px"><a class="button rounded small" href="${escapeHtml(data.hubUrl || `${domainBase()}/domain/summary-hub`)}">查看更多</a></p>
          </div>
        `;
        const $row = $('.main > .row').first();
        const $target = $row.find('> .columns').last();
        if ($target.length) $target.prepend(section);
        else $('.main').prepend(section);
    }).catch(() => {});
}

addPage(mountHomeFeed);
