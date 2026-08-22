import { addPage, NamedPage } from '@hydrooj/ui-default';

function getConfig() {
  return window.UiContext && window.UiContext.sol2imageBatch;
}

function findProblemSidebar() {
  const sections = Array.from(document.querySelectorAll('.medium-3.columns .section, .large-3.columns .section, .section.side, aside .section'));
  const selectedSection = sections.find((section) => /selected|已选|已选择|题目/i.test(section.textContent || ''));
  return selectedSection || document.querySelector('.medium-3.columns') || document.querySelector('.large-3.columns') || document.querySelector('aside');
}

function insertBatchRenderButton() {
  const config = getConfig();
  if (!config || !config.canUse || !config.url || document.getElementById('sol2image-batch-render-entry')) return;
  const sidebar = findProblemSidebar();
  if (!sidebar) return;
  const wrapper = document.createElement('p');
  wrapper.id = 'sol2image-batch-render-entry';
  const link = document.createElement('a');
  link.className = 'expanded rounded button';
  link.href = String(config.url);
  const icon = document.createElement('span');
  icon.className = 'icon icon-image';
  link.append(icon, document.createTextNode(' 批量渲染题解'));
  wrapper.appendChild(link);
  const firstSectionBody = sidebar.querySelector('.section__body') || sidebar;
  firstSectionBody.insertBefore(wrapper, firstSectionBody.firstChild);
}

addPage(new NamedPage(['problem_main'], () => {
  insertBatchRenderButton();
  window.setTimeout(insertBatchRenderButton, 80);
  window.setTimeout(insertBatchRenderButton, 300);
}));
