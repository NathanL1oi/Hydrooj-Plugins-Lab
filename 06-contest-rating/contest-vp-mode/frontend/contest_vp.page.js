import { addPage, NamedPage } from '@hydrooj/ui-default';

function formatRemaining(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    const h = Math.floor(value / 3600);
    const m = Math.floor((value % 3600) / 60);
    if (h) return `${h} 小时 ${m} 分钟`;
    return `${m} 分钟`;
}

function button(href, text, primary = false) {
    return `<a class="button rounded${primary ? ' primary' : ''}" href="${href}">${text}</a>`;
}

function disabledButton(text, title = '') {
    return `<span class="button rounded disabled" aria-disabled="true" title="${title}">${text}</span>`;
}

function ensureStyle() {
    if (document.getElementById('contest-vp-style')) return;
    const style = document.createElement('style');
    style.id = 'contest-vp-style';
    style.textContent = `
      #contest-vp-card .vp-card-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }
      #contest-vp-card p {
        margin: 0 0 10px;
      }
      .contest-vp-locked-link {
        opacity: .55;
        cursor: not-allowed;
      }
      .col--vp_type {
        width: 72px;
        min-width: 72px;
        text-align: center;
        white-space: nowrap;
      }
      td.col--vp_type > span,
      th.col--vp_type > span {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 42px;
        padding: 2px 9px;
        border: 1px solid #cbd5e1;
        border-radius: 999px;
        background: #f8fafc;
        color: #475569;
        font-size: 12px;
        font-weight: 700;
        line-height: 1.5;
      }
      td.col--vp_type[style*="1d4ed8"] > span {
        border-color: #93c5fd;
        background: #dbeafe;
        color: #1d4ed8;
      }
    `;
    document.head.appendChild(style);
}

function lockScoreboardLinks(config) {
    if (config?.canViewRanking || !config?.tid) return;
    const needle = `/contest/${config.tid}/scoreboard`;
    for (const anchor of document.querySelectorAll('a[href]')) {
        const href = anchor.getAttribute('href') || '';
        if (!href.includes(needle)) continue;
        anchor.classList.add('contest-vp-locked-link', 'disabled');
        anchor.setAttribute('aria-disabled', 'true');
        anchor.setAttribute('title', config.rankingLockedReason || '完成 VP 后可查看排名');
        anchor.setAttribute('href', config.pageUrl);
    }
}

addPage(new NamedPage(['contest_detail'], () => {
    const config = window.UiContext?.contestVP;
    if (!config?.enabled) return;
    ensureStyle();
    lockScoreboardLinks(config);
    if (document.getElementById('contest-vp-card')) return;

    const target = document.querySelector('.medium-9.columns .section:nth-of-type(2)')
        || document.querySelector('.medium-9.columns .section');
    if (!target?.parentNode) return;

    const locked = disabledButton(
        '<span class="icon icon-statistics"></span> VP 完成后看榜',
        config.rankingLockedReason || '完成 VP 后可查看排名',
    );
    let body = '';
    if (config.active) {
        body = `<p>VP 进行中，剩余 ${formatRemaining(config.remainingSeconds)}。</p>
          <div class="vp-card-actions">
            ${button(config.problemUrl, '<span class="icon icon-play"></span> 继续 VP', true)}
            ${locked}
          </div>`;
    } else if (config.ended) {
        body = `<p>VP 已结束，可以查看排名。</p>
          <div class="vp-card-actions">
            ${button(config.scoreboardUrl, '<span class="icon icon-statistics"></span> VP 排名', true)}
            ${button(config.officialScoreboardUrl, '<span class="icon icon-list"></span> 比赛排名')}
          </div>`;
    } else if (config.canStart) {
        body = `<p>这场比赛已开放虚拟参赛。</p>
          <div class="vp-card-actions">
            ${button(config.pageUrl, '<span class="icon icon-play"></span> 开始 VP', true)}
            ${locked}
          </div>`;
    } else if (config.reason) {
        const ranking = config.canViewRanking
            ? `${button(config.scoreboardUrl, '<span class="icon icon-statistics"></span> VP 排名')}
               ${button(config.officialScoreboardUrl, '<span class="icon icon-list"></span> 比赛排名')}`
            : locked;
        body = `<p>${config.reason}</p>
          <div class="vp-card-actions">${ranking}</div>`;
    } else {
        return;
    }

    const section = document.createElement('div');
    section.id = 'contest-vp-card';
    section.className = 'section';
    section.innerHTML = `
      <div class="section__header">
        <h1 class="section__title">VP 虚拟参赛</h1>
      </div>
      <div class="section__body">${body}</div>
    `;
    target.parentNode.insertBefore(section, target.nextSibling);
}));

addPage(new NamedPage(['contest_scoreboard'], ensureStyle));
