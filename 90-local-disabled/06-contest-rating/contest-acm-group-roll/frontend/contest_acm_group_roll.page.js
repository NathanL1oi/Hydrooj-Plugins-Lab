import { $, addPage, NamedPage } from '@hydrooj/ui-default';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function parseRank(value) {
  const n = Number(String(value ?? '').replace(/[^\d]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function movement(item) {
  const from = parseRank(item.fromRank);
  const to = Number(item.toRank) || 0;
  if (!from || !to) return { text: '新上榜', cls: 'is-new' };
  const diff = from - to;
  if (diff > 0) return { text: `上升 ${diff} 名`, cls: 'is-up' };
  if (diff < 0) return { text: `下降 ${Math.abs(diff)} 名`, cls: 'is-down' };
  return { text: '名次保持', cls: '' };
}

function solvedDelta(item) {
  const delta = Number(item.deltaSolved) || 0;
  if (delta > 0) return `封榜后 +${delta} 题`;
  return '封榜后无新增通过';
}

function renderCurrent(item, index, total) {
  if (!item) {
    return `
      <div class="cagr-note">滚榜已完成</div>
      <h2>最终排名全部揭晓</h2>
      <div class="cagr-meta">
        <span class="cagr-pill is-up">已揭晓 ${total} 组</span>
      </div>
    `;
  }
  const move = movement(item);
  return `
    <div class="cagr-note">第 ${index + 1} / ${total} 组</div>
    <h2>${escapeHtml(item.teamName)}</h2>
    <div class="cagr-big-rank">#${escapeHtml(item.toRank)}</div>
    <div class="cagr-meta">
      <span class="cagr-pill">封榜名次 ${escapeHtml(item.fromRank)}</span>
      <span class="cagr-pill ${move.cls}">${escapeHtml(move.text)}</span>
      <span class="cagr-pill">通过 ${escapeHtml(item.solved)} 题</span>
      <span class="cagr-pill">罚时 ${escapeHtml(item.penalty)}</span>
      <span class="cagr-pill ${Number(item.deltaSolved) > 0 ? 'is-up' : ''}">${escapeHtml(solvedDelta(item))}</span>
    </div>
  `;
}

function renderFinalBoard(tbody, revealed) {
  const rows = [...revealed].sort((a, b) => (Number(a.toRank) || 999999) - (Number(b.toRank) || 999999));
  if (!rows.length) {
    tbody.innerHTML = '<tr data-cagr-empty-row><td colspan="6" class="cagr-empty">等待开始滚榜。</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((item) => {
    const move = movement(item);
    const delta = Number(item.deltaSolved) || 0;
    return `
      <tr data-final-team="${escapeHtml(item.teamName)}" class="is-new-row">
        <td><strong>#${escapeHtml(item.toRank)}</strong></td>
        <td>
          <div class="cagr-team">${escapeHtml(item.teamName)}</div>
          <div class="cagr-members" title="${escapeHtml(item.memberText || '')}">${escapeHtml(item.memberText || '')}</div>
        </td>
        <td>${escapeHtml(item.fromRank)}</td>
        <td>${escapeHtml(item.solved)}${delta > 0 ? ` <span class="cagr-pill is-up">+${delta}</span>` : ''}</td>
        <td>${escapeHtml(item.penalty)}</td>
        <td><span class="cagr-pill ${move.cls}">${escapeHtml(move.text)}</span></td>
      </tr>
    `;
  }).join('');
}

addPage(new NamedPage(['contest_acm_group_roll'], () => {
  const data = window.UiContext?.acmGroupRoll || {};
  const plan = data.revealPlan || [];
  const root = document.querySelector('[data-cagr-roll-root]');
  const stage = document.querySelector('[data-cagr-roll]');
  if (!root || !stage) return;

  const current = stage.querySelector('[data-cagr-current]');
  const progress = stage.querySelector('[data-cagr-progress]');
  const counter = root.querySelector('[data-cagr-counter]');
  const finalBoard = root.querySelector('[data-cagr-final-board]');
  const queueRows = Array.from(stage.querySelectorAll('[data-cagr-queue-row]'));
  let index = -1;
  let timer = null;

  const stop = () => {
    if (timer) window.clearInterval(timer);
    timer = null;
  };

  const update = (next) => {
    index = Math.max(-1, Math.min(plan.length, next));
    const done = index >= plan.length;
    const activeItem = done ? null : plan[index];
    const revealedCount = Math.max(0, Math.min(plan.length, done ? plan.length : index + 1));
    const revealed = plan.slice(0, revealedCount);

    queueRows.forEach((row, i) => {
      row.classList.toggle('is-current', !done && i === index);
      row.classList.toggle('is-revealed', i < revealedCount);
      const result = row.querySelector('[data-cagr-queue-result]');
      if (result) result.textContent = i < revealedCount ? `#${plan[i].toRank}` : '待揭晓';
    });

    if (current) {
      current.innerHTML = index < 0
        ? `
          <div class="cagr-note">等待开始</div>
          <h2>准备揭晓最终排名</h2>
          <div class="cagr-meta">
            <span class="cagr-pill">${plan.length} 组</span>
            <span class="cagr-pill">封榜后结果将在这里逐队展开</span>
          </div>
        `
        : renderCurrent(activeItem, Math.max(0, index), plan.length);
    }
    if (progress) progress.style.width = `${plan.length ? Math.round((revealedCount / plan.length) * 100) : 0}%`;
    if (counter) counter.textContent = `${revealedCount} / ${plan.length}`;
    if (finalBoard) renderFinalBoard(finalBoard, revealed);

    const row = queueRows[Math.max(0, Math.min(queueRows.length - 1, index))];
    if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  $('[data-cagr-next]').off('click.cagr').on('click.cagr', () => {
    stop();
    update(index + 1);
  });

  $('[data-cagr-reset]').off('click.cagr').on('click.cagr', () => {
    stop();
    update(-1);
  });

  $('[data-cagr-start]').off('click.cagr').on('click.cagr', () => {
    stop();
    if (index >= plan.length) update(-1);
    timer = window.setInterval(() => {
      if (index >= plan.length) return stop();
      update(index + 1);
    }, 3200);
    update(index + 1);
  });

  $('[data-cagr-theater]').off('click.cagr').on('click.cagr', () => {
    root.classList.toggle('is-theater');
  });

  $(document).off('keydown.cagr-roll').on('keydown.cagr-roll', (ev) => {
    if (!root.isConnected) return;
    if (ev.key === 'ArrowRight') {
      ev.preventDefault();
      stop();
      update(index + 1);
    } else if (ev.key === ' ') {
      ev.preventDefault();
      $('[data-cagr-start]').trigger('click');
    } else if (ev.key === 'Escape' && root.classList.contains('is-theater')) {
      root.classList.remove('is-theater');
    }
  });

  update(-1);
}));
