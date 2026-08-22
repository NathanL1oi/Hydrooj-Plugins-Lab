import {
    $, NamedPage, addPage,
} from '@hydrooj/ui-default';

declare const UiContext: any;

function escapeHtml(value: any) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function ensureStyle() {
    if (document.getElementById('problem-zip-replace-style')) return;
    const style = document.createElement('style');
    style.id = 'problem-zip-replace-style';
    style.textContent = `
#problem-zip-replace-card {
  border-left: 3px solid #5aa6e8;
  overflow: hidden;
}
#problem-zip-replace-card .section__body {
  padding-top: 14px;
}
.pzr-headline {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pzr-mini {
  color: #789;
  font-size: 12px;
  line-height: 1.55;
  margin: 0 0 10px;
}
.pzr-file {
  align-items: center;
  background: linear-gradient(180deg, #fbfdff, #f3f8ff);
  border: 1px dashed #9cc8f1;
  border-radius: 8px;
  color: #1d67a8;
  cursor: pointer;
  display: flex;
  gap: 8px;
  justify-content: center;
  min-height: 38px;
  padding: 8px 10px;
  transition: border-color .15s ease, box-shadow .15s ease, transform .15s ease;
  word-break: break-all;
}
.pzr-file:hover {
  border-color: #5aa6e8;
  box-shadow: 0 4px 14px rgba(90, 166, 232, .15);
  transform: translateY(-1px);
}
.pzr-file input {
  display: none;
}
.pzr-options {
  align-items: center;
  color: #60758a;
  display: flex;
  font-size: 13px;
  gap: 8px;
  margin: 10px 0 12px;
}
.pzr-submit {
  align-items: center;
  display: inline-flex;
  gap: 6px;
  justify-content: center;
  width: 100%;
}
.pzr-status {
  align-items: flex-start;
  background: #eef9f2;
  border: 1px solid #bfe7c9;
  border-radius: 8px;
  color: #267343;
  display: flex;
  gap: 7px;
  line-height: 1.5;
  margin-bottom: 12px;
  padding: 8px 10px;
}
.theme--dark #problem-zip-replace-card .pzr-mini,
.theme--dark #problem-zip-replace-card .pzr-options {
  color: #94a3b8;
}
.theme--dark #problem-zip-replace-card .pzr-file {
  border-color: rgba(96, 165, 250, .44);
  background: rgba(15, 23, 42, .48);
  color: #bfdbfe;
}
.theme--dark #problem-zip-replace-card .pzr-status {
  border-color: rgba(34, 197, 94, .34);
  background: rgba(20, 83, 45, .24);
  color: #bbf7d0;
}
`;
    document.head.appendChild(style);
}

function successBlock() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('zipReplace') !== 'success') return '';
    const data = params.get('zipReplaceData') || '0';
    const sol = params.get('zipReplaceSol') || '0';
    const oldSol = params.get('zipReplaceOldSol') || '0';
    return `
      <div class="pzr-status">
        <span class="icon icon-check"></span>
        <span>已替换：数据 ${escapeHtml(data)}，题解 ${escapeHtml(sol)} / 清理 ${escapeHtml(oldSol)}</span>
      </div>
    `;
}

function mountProblemZipReplace() {
    const config = UiContext?.problemZipReplace;
    if (!config?.action || !config?.pid) return;
    if (document.getElementById('problem-zip-replace-card')) return;

    const sidebar = $('.section--problem-sidebar').first();
    if (!sidebar.length) return;
    ensureStyle();

    const card = document.createElement('div');
    card.className = 'section side';
    card.id = 'problem-zip-replace-card';
    card.innerHTML = `
      <div class="section__header">
        <h1 class="section__title pzr-headline">
          <span class="icon icon-upload"></span>
          <span>替换本题</span>
        </h1>
      </div>
      <div class="section__body">
        ${successBlock()}
        <p class="pzr-mini">上传单题 Hydro ZIP，保留当前 ID。</p>
        <form method="post" enctype="multipart/form-data" action="${escapeHtml(config.action)}">
          <input type="hidden" name="csrfToken" value="${escapeHtml(config.csrfToken)}">
          <input type="hidden" name="pid" value="${escapeHtml(config.pid)}">
          <label class="pzr-file">
            <span class="icon icon-file_upload"></span>
            <span data-pzr-file-name>选择 Hydro ZIP</span>
            <input type="file" name="file" accept=".zip" required>
          </label>
          <label class="pzr-options">
            <input type="checkbox" name="replaceSolutions" value="1" checked>
            <span>同步替换题解</span>
          </label>
          <button type="submit" class="rounded primary button pzr-submit">
            <span class="icon icon-refresh"></span>
            <span>上传替换</span>
          </button>
        </form>
      </div>
    `;
    sidebar.after(card);

    const fileInput = card.querySelector<HTMLInputElement>('input[type="file"]');
    const fileName = card.querySelector<HTMLElement>('[data-pzr-file-name]');
    fileInput?.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        if (fileName) fileName.textContent = file ? file.name : '选择 Hydro ZIP';
    });

    const form = card.querySelector<HTMLFormElement>('form');
    const submit = card.querySelector<HTMLButtonElement>('button[type="submit"]');
    form?.addEventListener('submit', (event) => {
        if (!fileInput?.files?.length) return;
        const ok = window.confirm('确认用这个 ZIP 替换当前题目？当前 ID 会保留。');
        if (!ok) {
            event.preventDefault();
            return;
        }
        if (submit) {
            submit.disabled = true;
            submit.innerHTML = '<span class="icon icon-refresh"></span><span>替换中...</span>';
        }
    });
}

addPage(new NamedPage('problem_detail', mountProblemZipReplace));
$(document).on('vjContentNew', mountProblemZipReplace);
