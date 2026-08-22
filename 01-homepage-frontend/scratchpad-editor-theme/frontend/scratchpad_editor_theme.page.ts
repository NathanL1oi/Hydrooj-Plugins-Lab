import { addPage, AutoloadPage } from '@hydrooj/ui-default';

declare const UserContext: any;

type MonacoWindow = Window & {
  editor?: {
    updateOptions?: (options: Record<string, any>) => void;
  };
  monaco?: {
    editor?: {
      setTheme?: (theme: string) => void;
    };
  };
};

const pollMs = 120;
const maxPollCount = 30;
let scheduled = 0;
let lastApplied = '';
let observer: MutationObserver | null = null;

function readEditorConfigTheme() {
  try {
    const config = JSON.parse(window.localStorage.getItem('editor.config') || '{}');
    return typeof config.theme === 'string' && config.theme ? config.theme : '';
  } catch {
    return '';
  }
}

function getSiteTheme() {
  if (typeof UserContext !== 'undefined' && UserContext.theme === 'dark') return 'dark';
  if (document.documentElement.classList.contains('theme--dark')) return 'dark';
  if (document.documentElement.dataset.mantineColorScheme === 'dark') return 'dark';
  return 'light';
}

function getTargetTheme() {
  const configuredTheme = readEditorConfigTheme();
  if (configuredTheme) return configuredTheme;
  return getSiteTheme() === 'dark' ? 'vs-dark' : 'vs-light';
}

function isScratchpadActive() {
  return document.body.classList.contains('mode--scratchpad')
    || !!document.querySelector('.ScratchpadMonacoEditor .monaco-editor');
}

function applyThemeOnce() {
  if (!isScratchpadActive()) return false;
  const win = window as MonacoWindow;
  const editor = win.editor;
  const monaco = win.monaco;
  if (!editor?.updateOptions || !monaco?.editor?.setTheme) return false;

  const targetTheme = getTargetTheme();
  if (lastApplied === targetTheme) return true;
  monaco.editor.setTheme(targetTheme);
  editor.updateOptions({ theme: targetTheme });
  lastApplied = targetTheme;
  document.querySelector('.ScratchpadMonacoEditor')?.setAttribute('data-scratchpad-theme', targetTheme);
  return true;
}

function scheduleApply() {
  window.clearTimeout(scheduled);
  scheduled = window.setTimeout(() => {
    let count = 0;
    const timer = window.setInterval(() => {
      count++;
      if (applyThemeOnce() || count >= maxPollCount) window.clearInterval(timer);
    }, pollMs);
  }, 30);
}

function mountScratchpadThemeSync() {
  lastApplied = '';
  scheduleApply();
  if (observer) observer.disconnect();
  observer = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => mutation.type === 'childList' || mutation.attributeName === 'class')) scheduleApply();
  });
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
    childList: true,
    subtree: true,
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-mantine-color-scheme'],
  });
}

addPage(new AutoloadPage('scratchpadEditorTheme', mountScratchpadThemeSync));
