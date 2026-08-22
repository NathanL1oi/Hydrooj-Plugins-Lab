import { addPage, NamedPage } from '@hydrooj/ui-default';

function getCurrentDiscussionScope() {
  const match = window.location.pathname.match(/\/discuss\/([^/?#]+)\/([^/?#]+)/);
  return {
    type: match ? decodeURIComponent(match[1]) : '',
    node: match ? decodeURIComponent(match[2]) : '',
  };
}

function mountDiscussionSearch() {
  if (document.querySelector('.discussion-title-search')) return;

  const form = document.createElement('form');
  const scope = getCurrentDiscussionScope();
  form.className = 'discussion-title-search section';
  form.method = 'get';
  form.action = '/discussion-search';
  form.innerHTML = `
    <div class="discussion-title-search__inner">
      <input class="textbox discussion-title-search__input" name="q" type="search" placeholder="搜索讨论标题" autocomplete="off">
      <input name="type" type="hidden" value="${scope.type.replace(/"/g, '&quot;')}">
      <input name="node" type="hidden" value="${scope.node.replace(/"/g, '&quot;')}">
      <button class="rounded primary button" type="submit">搜索</button>
    </div>
  `;

  const style = document.createElement('style');
  style.textContent = `
    .discussion-title-search {
      margin-bottom: 1rem;
      padding: 0.75rem;
    }
    .discussion-title-search__inner {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      flex-wrap: wrap;
    }
    .discussion-title-search__input {
      flex: 1 1 220px;
      min-width: 0;
    }
  `;

  const main = document.querySelector('.main') || document.querySelector('main');
  const target = main?.querySelector('.section') || main?.firstElementChild || main;
  document.head.appendChild(style);
  target?.parentElement?.insertBefore(form, target);
}

addPage(new NamedPage(['discussion_main', 'discussion_node'], mountDiscussionSearch));
