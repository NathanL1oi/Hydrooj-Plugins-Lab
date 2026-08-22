import { $, addPage, Notification } from '@hydrooj/ui-default';

declare const UiContext: any;

function escapeHtml(value: string) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function ensureEntry() {
  const config = UiContext?.richObjectiveKit;
  if (!config || (!config.enabled && !config.canEdit)) return;
  if (!config.enabled && !config.configured && config.hydroType !== 'submit_answer') return;
  if (document.getElementById('rich-objective-kit-entry')) return;

  const items: string[] = [];
  if (config.enabled) {
    items.push(`
      <li class="menu__item" id="rich-objective-kit-entry">
        <a class="menu__link" href="${escapeHtml(config.url)}">
          <span class="icon icon-edit"></span> ${escapeHtml(config.title || '富交互客观题')}
        </a>
      </li>
    `);
  }
  if (config.canEdit && config.hydroType === 'submit_answer') {
    const enabledValue = config.enabled ? 'off' : 'on';
    const label = config.enabled ? '停用富交互题' : '启用富交互题';
    const marker = config.enabled ? '' : ' id="rich-objective-kit-entry"';
    items.push(`
      <li class="menu__item"${marker}>
        <form method="post" action="${escapeHtml(config.toggleUrl)}" style="margin:0">
          <input type="hidden" name="enabled" value="${enabledValue}">
          <button class="menu__link" type="submit" style="width:100%;border:0;background:transparent;text-align:left">
            <span class="icon icon-settings"></span> ${label}
          </button>
        </form>
      </li>
    `);
  }
  if (config.canEdit && (config.hydroType === 'submit_answer' || config.configured)) {
    items.push(`
      <li class="menu__item">
        <a class="menu__link" href="${escapeHtml(config.editUrl)}">
          <span class="icon icon-wrench"></span> 高级配置
        </a>
      </li>
    `);
  }
  if (!items.length) return;

  const $menu = $('.medium-3 .section.side ol.menu, .section--problem-sidebar ol.menu').first();
  if ($menu.length) $menu.prepend(items.join(''));
  else $('.medium-3').first().prepend(`
    <div class="section side">
      <div class="section__body no-padding"><ol class="menu">${items.join('')}</ol></div>
    </div>
  `);
}

function fieldValue(field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
  if (field instanceof HTMLInputElement && field.type === 'checkbox') return field.checked ? field.value : '';
  if (field instanceof HTMLInputElement && field.type === 'radio') return field.checked ? field.value : '';
  return field.value;
}

function collectAnswers(form: HTMLFormElement) {
  const answers: Record<string, string | string[]> = {};
  const fields = Array.from(form.querySelectorAll<HTMLElement>('[data-rok-answer]'));
  for (const element of fields) {
    const id = element.dataset.rokAnswer || '';
    if (!id) continue;
    const field = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (field instanceof HTMLInputElement && field.type === 'checkbox') {
      answers[id] ||= [];
      if (field.checked) (answers[id] as string[]).push(field.value);
      continue;
    }
    if (field instanceof HTMLInputElement && field.type === 'radio') {
      if (field.checked) answers[id] = field.value;
      else answers[id] ||= '';
      continue;
    }
    answers[id] = fieldValue(field);
  }
  for (const [id, value] of Object.entries(answers)) {
    if (Array.isArray(value)) answers[id] = [...new Set(value)].sort();
  }
  return answers;
}

function isFilledAnswer(value: string | string[]) {
  return Array.isArray(value) ? value.length > 0 : !!String(value || '').trim();
}

function questionAnswered(id: string, answers: Record<string, string | string[]>) {
  return Object.entries(answers).some(([key, value]) => (
    (key === id || key.startsWith(`${id}.`)) && isFilledAnswer(value)
  ));
}

function restoreAnswers(form: HTMLFormElement, answers: Record<string, any>) {
  const fields = Array.from(form.querySelectorAll<HTMLElement>('[data-rok-answer]'));
  for (const element of fields) {
    const id = element.dataset.rokAnswer || '';
    if (!id || !(id in answers)) continue;
    const value = answers[id];
    const field = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (field instanceof HTMLInputElement && field.type === 'checkbox') {
      field.checked = Array.isArray(value) && value.includes(field.value);
    } else if (field instanceof HTMLInputElement && field.type === 'radio') {
      field.checked = value === field.value;
    } else {
      field.value = Array.isArray(value) ? value.join(', ') : String(value ?? '');
    }
  }
}

let blankMeasure: HTMLSpanElement | null = null;

function getBlankMeasure() {
  if (blankMeasure) return blankMeasure;
  blankMeasure = document.createElement('span');
  blankMeasure.style.cssText = [
    'position:absolute',
    'left:-99999px',
    'top:-99999px',
    'visibility:hidden',
    'white-space:pre',
    'pointer-events:none',
  ].join(';');
  document.body.appendChild(blankMeasure);
  return blankMeasure;
}

function resizeAutosizeField(field: HTMLTextAreaElement) {
  if (field.classList.contains('rok-inline-blank')) {
    const measure = getBlankMeasure();
    const style = window.getComputedStyle(field);
    const raw = field.value || field.placeholder || '';
    const longestLine = raw.split(/\r?\n/).reduce((best, line) => (line.length > best.length ? line : best), '');
    measure.style.font = style.font;
    measure.style.letterSpacing = style.letterSpacing;
    measure.textContent = longestLine.replace(/ /g, '\u00a0') || ' ';

    const question = field.closest<HTMLElement>('.rok-question');
    const parentWidth = question?.clientWidth || field.parentElement?.clientWidth || 620;
    const minWidth = 136;
    const maxWidth = Math.max(minWidth, Math.min(parentWidth - 48, 620));
    const width = Math.max(minWidth, Math.min(maxWidth, Math.ceil(measure.getBoundingClientRect().width + 48)));
    field.style.width = `${width}px`;
  }

  const minHeight = field.classList.contains('rok-inline-blank') ? 34 : 38;
  field.style.height = 'auto';
  const height = Math.max(minHeight, field.scrollHeight);
  field.style.height = `${height}px`;
  field.classList.toggle('is-expanded', height > minHeight + 8 || field.value.includes('\n'));
}

function resizeAutosizeFields(root: ParentNode) {
  const fields = Array.from(root.querySelectorAll<HTMLTextAreaElement>('textarea[data-rok-autosize]'));
  for (const field of fields) resizeAutosizeField(field);
}

function updateOptionState(form: HTMLFormElement) {
  const options = Array.from(form.querySelectorAll<HTMLElement>('.rok-option'));
  for (const option of options) {
    const input = option.querySelector<HTMLInputElement>('input');
    option.classList.toggle('is-selected', !!input?.checked);
  }
}

function updateNavigation(form: HTMLFormElement) {
  const answers = collectAnswers(form);
  const navItems = Array.from(form.querySelectorAll<HTMLElement>('[data-rok-nav-item]'));
  const questions = Array.from(form.querySelectorAll<HTMLElement>('[data-rok-question]'));
  let answeredCount = 0;

  for (const question of questions) {
    const id = question.dataset.rokQuestion || '';
    const answered = !!id && questionAnswered(id, answers);
    question.classList.toggle('is-answered', answered);
    if (answered) answeredCount += 1;
  }

  for (const item of navItems) {
    const id = item.dataset.rokNavItem || '';
    item.classList.toggle('answered', !!id && questionAnswered(id, answers));
  }

  const total = questions.length || navItems.length;
  const current = form.querySelector<HTMLElement>('[data-rok-progress-current]');
  const totalNode = form.querySelector<HTMLElement>('[data-rok-progress-total]');
  const fill = form.querySelector<HTMLElement>('[data-rok-progress-fill]');
  if (current) current.textContent = String(answeredCount);
  if (totalNode) totalNode.textContent = String(total);
  if (fill) fill.style.width = total ? `${Math.round((answeredCount / total) * 100)}%` : '0%';
  updateOptionState(form);
}

function initSchemaForm(form: HTMLFormElement) {
  const draftKey = form.dataset.rokDraftKey || '';
  if (draftKey) {
    try {
      const raw = localStorage.getItem(draftKey);
      if (raw) restoreAnswers(form, JSON.parse(raw));
    } catch { }
  }
  resizeAutosizeFields(form);
  updateNavigation(form);

  const saveDraft = () => {
    resizeAutosizeFields(form);
    if (draftKey) {
      localStorage.setItem(draftKey, JSON.stringify(collectAnswers(form)));
      $('[data-rok-status]').text('草稿已保存在本机，点击保存后才会提交评测。');
    }
    updateNavigation(form);
  };

  $(form).on('input', '[data-rok-autosize]', (event) => resizeAutosizeField(event.currentTarget as HTMLTextAreaElement));
  $(form).on('input change', '[data-rok-answer]', saveDraft);
  window.addEventListener('resize', () => resizeAutosizeFields(form), { passive: true });
}

function normalizeH5Answers(data: any) {
  if (!data || typeof data !== 'object') return null;
  if (data.type !== 'rich-objective:answers') return null;
  if (data.answers !== undefined) return data.answers;
  if (data.payload !== undefined) return data.payload;
  if (data.value !== undefined) return data.value;
  return null;
}

function initH5Form(form: HTMLFormElement) {
  const iframe = form.querySelector<HTMLIFrameElement>('[data-rok-h5-frame]');
  const payload = form.querySelector<HTMLInputElement>('[data-rok-h5-payload]');
  if (!iframe || !payload) return;

  window.addEventListener('message', (event) => {
    const answers = normalizeH5Answers(event.data);
    if (answers === null) return;
    payload.value = JSON.stringify({ answers });
    $('[data-rok-status]').text('H5 答案已同步，点击保存后提交评测。');
  });

  iframe.addEventListener('load', () => {
    iframe.contentWindow?.postMessage({ type: 'rich-objective:init' }, '*');
  });

  $(form).on('submit', (event) => {
    if (payload.value.trim()) return;
    if ((form as any).__rokCollecting) return;
    event.preventDefault();
    (form as any).__rokCollecting = true;
    iframe.contentWindow?.postMessage({ type: 'rich-objective:collect' }, '*');
    window.setTimeout(() => {
      (form as any).__rokCollecting = false;
      if (payload.value.trim()) form.requestSubmit();
      else Notification.error('H5 页面还没有导出答案。');
    }, 700);
  });
}

function initDetail() {
  const form = document.querySelector<HTMLFormElement>('[data-rok-form]');
  if (!form || (form as any).__rokReady) return;
  (form as any).__rokReady = true;
  if (form.dataset.rokMode === 'h5') initH5Form(form);
  else initSchemaForm(form);
}

function initEdit() {
  const form = document.querySelector<HTMLFormElement>('[data-rok-edit-form]');
  if (!form || (form as any).__rokEditReady) return;
  (form as any).__rokEditReady = true;
  const modeInputs = Array.from(form.querySelectorAll<HTMLInputElement>('input[data-rok-mode]'));
  const modeSelect = form.querySelector<HTMLSelectElement>('select[data-rok-mode]');
  const panels = Array.from(form.querySelectorAll<HTMLElement>('[data-rok-panel]'));
  const modeLabel = form.querySelector<HTMLElement>('[data-rok-edit-mode-label]');
  const enabled = form.querySelector<HTMLInputElement>('[data-rok-enabled]');
  const enabledLabel = form.querySelector<HTMLElement>('[data-rok-enabled-label]');
  const editStatus = form.querySelector<HTMLElement>('[data-rok-edit-status]');
  const counters: Array<[HTMLTextAreaElement | null, HTMLElement | null]> = [
    [form.querySelector<HTMLTextAreaElement>('[data-rok-schema-text]'), form.querySelector<HTMLElement>('[data-rok-editor-count]')],
    [form.querySelector<HTMLTextAreaElement>('[data-rok-h5-text]'), form.querySelector<HTMLElement>('[data-rok-h5-count]')],
    [form.querySelector<HTMLTextAreaElement>('[data-rok-css-text]'), form.querySelector<HTMLElement>('[data-rok-css-count]')],
  ];

  const currentMode = () => (
    modeInputs.find((input) => input.checked)?.value
    || modeSelect?.value
    || 'schema'
  );

  const markDirty = () => {
    if (editStatus) editStatus.textContent = '已修改';
  };

  const updateCounters = () => {
    for (const [textarea, counter] of counters) {
      if (textarea && counter) counter.textContent = String(textarea.value.length);
    }
  };

  const updateEnabledLabel = () => {
    if (!enabledLabel || !enabled) return;
    enabledLabel.textContent = enabled.checked ? '已启用' : '未启用';
    enabledLabel.classList.toggle('rok-state--good', enabled.checked);
  };

  const render = () => {
    const current = currentMode();
    for (const panel of panels) panel.style.display = panel.dataset.rokPanel === current ? '' : 'none';
    if (modeLabel) modeLabel.textContent = current === 'h5' ? 'H5' : 'Markdown';
    updateCounters();
    updateEnabledLabel();
  };

  for (const input of modeInputs) input.addEventListener('change', () => { render(); markDirty(); });
  modeSelect?.addEventListener('change', () => { render(); markDirty(); });
  enabled?.addEventListener('change', () => { updateEnabledLabel(); markDirty(); });
  for (const [textarea] of counters) textarea?.addEventListener('input', () => { updateCounters(); markDirty(); });
  $(form).on('input change', 'input.textbox, textarea.textbox, select', markDirty);
  render();
}

addPage(() => {
  ensureEntry();
  initDetail();
  initEdit();
});
