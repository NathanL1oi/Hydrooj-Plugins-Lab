import { addPage, NamedPage } from '@hydrooj/ui-default';

addPage(new NamedPage(['contest_user'], () => {
  // Extract tid from the current URL: /contest/<tid>/user
  const match = window.location.pathname.match(/\/contest\/([^/]+)\/user/);
  if (!match) return;
  const tid = match[1];

  const batchUrl = `/contest/${tid}/batch-add`;

  // Build the button element, styled to match Hydro's button conventions
  const btn = document.createElement('a');
  btn.href = batchUrl;
  btn.className = 'button primary rounded';
  btn.style.cssText = 'margin-left:8px;';
  btn.innerHTML = '<span class="icon icon-add"></span> 批量添加';
  btn.title = 'Batch Add Users';

  // "添加用户" lives inside <div class="section__tools"> — append right there.
  const tools = document.querySelector<HTMLElement>('.section__tools');
  if (tools) {
    tools.appendChild(btn);
    return;
  }

  // Fallback: floating button if the tools bar isn't found.
  btn.style.cssText += 'position:fixed;top:80px;right:24px;z-index:999;box-shadow:0 2px 8px rgba(0,0,0,.25);';
  document.body.appendChild(btn);
}));
