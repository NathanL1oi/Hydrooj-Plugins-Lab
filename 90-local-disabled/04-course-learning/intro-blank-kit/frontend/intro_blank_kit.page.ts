import { $, addPage } from '@hydrooj/ui-default';

declare const UiContext: any;

const CODE_TOKEN_PATTERN = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|^\s*#[^\n]*|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[uUlLfF]*\b|\b[_A-Za-z]\w*\b|[{}()[\];,.<>+\-*\/%=!&|^~?:]+)/gm;
const CPP_KEYWORDS = new Set([
  'alignas', 'alignof', 'and', 'and_eq', 'asm', 'auto', 'bitand', 'bitor', 'bool', 'break',
  'case', 'catch', 'char', 'char16_t', 'char32_t', 'class', 'compl', 'concept', 'const',
  'constexpr', 'const_cast', 'continue', 'decltype', 'default', 'delete', 'do', 'double',
  'dynamic_cast', 'else', 'enum', 'explicit', 'export', 'extern', 'false', 'float', 'for',
  'friend', 'goto', 'if', 'inline', 'int', 'long', 'mutable', 'namespace', 'new', 'noexcept',
  'not', 'not_eq', 'nullptr', 'operator', 'or', 'or_eq', 'private', 'protected', 'public',
  'register', 'reinterpret_cast', 'requires', 'return', 'short', 'signed', 'sizeof', 'static',
  'static_assert', 'static_cast', 'struct', 'switch', 'template', 'this', 'thread_local',
  'throw', 'true', 'try', 'typedef', 'typeid', 'typename', 'union', 'unsigned', 'using',
  'virtual', 'void', 'volatile', 'while', 'xor', 'xor_eq',
]);
const CPP_BUILTINS = new Set([
  'cin', 'cout', 'cerr', 'clog', 'endl', 'string', 'vector', 'array', 'queue', 'stack',
  'deque', 'set', 'map', 'unordered_map', 'unordered_set', 'pair', 'tuple', 'priority_queue',
  'sort', 'lower_bound', 'upper_bound', 'min', 'max', 'abs', 'swap', 'begin', 'end',
  'push_back', 'pop_back', 'size', 'length', 'main', 'std',
]);

function escapeHtml(value: string) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseBlankLabels(template: string) {
  const blanks: string[] = [];
  stripFenceMarkerLines(template).replace(/\[\[([\s\S]*?)\]\]/g, (_full, raw) => {
    blanks.push(String(raw || '').trim() || `填空 ${blanks.length + 1}`);
    return '';
  });
  return blanks;
}

function stripFenceMarkerLines(source: string) {
  return String(source || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !/^\s*(```|~~~)[A-Za-z0-9_+.#-]*\s*$/.test(line))
    .join('\n')
    .trim();
}

function classifyCodeToken(token: string) {
  if (token.startsWith('//') || token.startsWith('/*')) return 'comment';
  if (token.startsWith('"') || token.startsWith("'")) return 'string';
  if (/^\s*#/.test(token)) return 'meta';
  if (/^\d/.test(token)) return 'number';
  if (CPP_KEYWORDS.has(token)) return 'keyword';
  if (CPP_BUILTINS.has(token)) return 'builtin';
  if (/^[{}()[\];,.<>+\-*\/%=!&|^~?:]+$/.test(token)) return 'operator';
  return '';
}

function highlightCodeText(source: string) {
  let html = '';
  let last = 0;
  let match: RegExpExecArray | null;
  CODE_TOKEN_PATTERN.lastIndex = 0;
  while ((match = CODE_TOKEN_PATTERN.exec(source || ''))) {
    if (match.index > last) html += escapeHtml(source.slice(last, match.index));
    const token = match[0];
    const kind = classifyCodeToken(token);
    html += kind
      ? `<span class="ibk-hl-${kind}">${escapeHtml(token)}</span>`
      : escapeHtml(token);
    last = match.index + token.length;
  }
  if (last < (source || '').length) html += escapeHtml(source.slice(last));
  return html;
}

function renderCodePreview(template: string) {
  const code = stripFenceMarkerLines(template);
  let html = '';
  let last = 0;
  let count = 0;
  code.replace(/\[\[([\s\S]*?)\]\]/g, (full, raw, offset) => {
    if (offset > last) html += highlightCodeText(code.slice(last, offset));
    const label = String(raw || '').trim() || `填空 ${count + 1}`;
    html += `<input class="textbox ibk-preview-blank" placeholder="${escapeHtml(label)}" disabled>`;
    count++;
    last = offset + full.length;
    return '';
  });
  if (last < code.length) html += highlightCodeText(code.slice(last));
  return html;
}

function insertAtCursor(textarea: HTMLTextAreaElement, value: string) {
  const start = textarea.selectionStart || 0;
  const end = textarea.selectionEnd || 0;
  const old = textarea.value;
  textarea.value = `${old.slice(0, start)}${value}${old.slice(end)}`;
  textarea.selectionStart = textarea.selectionEnd = start + value.length;
  textarea.focus();
  $(textarea).trigger('input');
}

function ensureEntry() {
  const config = UiContext?.introBlankKit;
  if (!config || (!config.enabled && !config.canEdit)) return;
  if (document.getElementById('intro-blank-kit-entry')) return;

  const label = config.enabled ? '程序填空' : '配置程序填空';
  const href = config.enabled ? config.url : config.editUrl;
  const $item = $(`
    <li class="menu__item" id="intro-blank-kit-entry">
      <a class="menu__link" href="${href}">
        <span class="icon icon-edit"></span> ${label}
      </a>
    </li>
  `);

  const $menu = $('.medium-3 .section.side ol.menu').first();
  if ($menu.length) $menu.prepend($item);
  else $('.medium-3').first().prepend(`
    <div class="section side" id="intro-blank-kit-entry">
      <div class="section__body no-padding">
        <ol class="menu"><li class="menu__item"><a class="menu__link" href="${href}">
          <span class="icon icon-edit"></span> ${label}
        </a></li></ol>
      </div>
    </div>
  `);
}

function initEditor() {
  const editor = document.getElementById('intro-blank-editor');
  if (!editor || (editor as any).__introBlankReady) return;
  (editor as any).__introBlankReady = true;

  const render = () => {
    const template = String($('[name="code"]').val() || '');
    const lang = String($('[name="lang"]').val() || 'cpp').trim() || 'cpp';
    const blanks = parseBlankLabels(template);
    $('#ibk-blank-count').text(String(blanks.length));
    $('#ibk-blank-list').html(blanks.map((label, index) => (
      `<span class="ibk-blank-pill">${index + 1}. ${escapeHtml(label)}</span>`
    )).join(''));
    $('#ibk-preview-lang').text(lang.toLowerCase().startsWith('cc') ? 'cpp' : lang);
    $('#ibk-code-preview').html(renderCodePreview(template));
  };

  $('[data-ibk-insert]').on('click', function insertBlank() {
    const active = document.activeElement as HTMLTextAreaElement | null;
    const textarea = active?.tagName === 'TEXTAREA' && $(active).closest(editor).length
      ? active
      : $('[name="code"]')[0] as HTMLTextAreaElement;
    if (!textarea) return;
    insertAtCursor(textarea, '[[填空]]');
  });

  $('[name="code"], [name="lang"]').on('input change', render);
  render();
}

addPage(() => {
  ensureEntry();
  initEditor();
});
