import { addPage, AutoloadPage } from '@hydrooj/ui-default';

declare const UiContext: any;
declare const UserContext: any;

interface GuideConfig {
  enabled?: boolean;
  domainId?: string;
  registerUrl?: string;
  loginUrl?: string;
  buttonText?: string;
  autoOpen?: boolean;
}

interface GuideStep {
  id: string;
  title: string;
  body: string;
  target: () => HTMLElement | null;
  primaryText?: string;
  onPrimary?: () => void;
}

const buttonId = 'domain-register-guide-button';
const rootId = 'domain-register-guide-root';
const styleId = 'domain-register-guide-style';
const storagePrefix = 'domain-register-guide';

let currentSteps: GuideStep[] = [];
let currentIndex = 0;
let activeConfig: GuideConfig | null = null;
let resizeBound = false;

function getConfig(): GuideConfig | null {
  if (typeof UiContext === 'undefined') return null;
  const config = UiContext.domainRegisterGuide;
  return config?.enabled ? config : null;
}

function getUserId() {
  if (typeof UserContext === 'undefined') return 0;
  return Number(UserContext?._id || 0);
}

function storageKey(config: GuideConfig, suffix: string) {
  return `${storagePrefix}.${config.domainId || 'default'}.${suffix}`;
}

function getSession(config: GuideConfig, suffix: string) {
  try {
    return window.sessionStorage.getItem(storageKey(config, suffix));
  } catch {
    return null;
  }
}

function setSession(config: GuideConfig, suffix: string, value: string) {
  try {
    window.sessionStorage.setItem(storageKey(config, suffix), value);
  } catch { }
}

function removeSession(config: GuideConfig, suffix: string) {
  try {
    window.sessionStorage.removeItem(storageKey(config, suffix));
  } catch { }
}

function getLocal(config: GuideConfig, suffix: string) {
  try {
    return window.localStorage.getItem(storageKey(config, suffix));
  } catch {
    return null;
  }
}

function setLocal(config: GuideConfig, suffix: string, value: string) {
  try {
    window.localStorage.setItem(storageKey(config, suffix), value);
  } catch { }
}

function isVisible(element: HTMLElement | null) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
}

function pagePath() {
  return window.location.pathname.replace(/\/+$/, '');
}

function isRegisterPage() {
  return /(^|\/)register(?:\/[^/?#]+)?$/.test(pagePath());
}

function isRegisterWithCodePage() {
  return /(^|\/)register\/[^/?#]+$/.test(pagePath());
}

function safePath(url: string | undefined) {
  if (!url) return '';
  try {
    return new URL(url, window.location.href).pathname.replace(/\/+$/, '');
  } catch {
    return url.replace(/\/+$/, '');
  }
}

function findRegisterLink(config: GuideConfig) {
  const registerPath = safePath(config.registerUrl);
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
  return links.find((link) => {
    if (!isVisible(link)) return false;
    const hrefPath = safePath(link.href);
    if (registerPath && hrefPath === registerPath) return true;
    return /(^|\/)register$/.test(hrefPath) && !/login/.test(hrefPath);
  }) || null;
}

function findFormWithInput(name: string) {
  const input = document.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  return input?.closest('form') as HTMLFormElement | null;
}

function findRegisterForm() {
  return findFormWithInput('verifyPassword') || findFormWithInput('mail');
}

function findInput(name: string) {
  const form = findRegisterForm();
  return (form?.querySelector<HTMLInputElement>(`input[name="${name}"]`)
    || document.querySelector<HTMLInputElement>(`input[name="${name}"]`)) as HTMLElement | null;
}

function findSubmitButton() {
  const form = findRegisterForm();
  return (form?.querySelector<HTMLElement>('input[type="submit"], button[type="submit"]')
    || document.querySelector<HTMLElement>('input[type="submit"], button[type="submit"]')) as HTMLElement | null;
}

function ensureStyle() {
  if (document.getElementById(styleId)) return;
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    .domain-register-guide-button {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 9997;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 42px;
      padding: 0 16px;
      border: 0;
      border-radius: 999px;
      background: #2563eb;
      color: #fff;
      box-shadow: 0 10px 28px rgba(37, 99, 235, 0.28);
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
    }
    .domain-register-guide-button:hover {
      background: #1d4ed8;
    }
    .domain-register-guide-button__icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.2);
      font-weight: 700;
    }
    #domain-register-guide-root {
      pointer-events: none;
      position: fixed;
      inset: 0;
      z-index: 9998;
    }
    .domain-register-guide-highlight {
      position: fixed;
      z-index: 9998;
      border: 3px solid #2563eb;
      border-radius: 8px;
      box-shadow: 0 0 0 9999px rgba(15, 23, 42, 0.44), 0 8px 28px rgba(37, 99, 235, 0.22);
      pointer-events: none;
      transition: left 0.16s ease, top 0.16s ease, width 0.16s ease, height 0.16s ease;
    }
    .domain-register-guide-panel {
      position: fixed;
      z-index: 9999;
      width: min(340px, calc(100vw - 32px));
      padding: 16px;
      border: 1px solid #dbe3ef;
      border-radius: 8px;
      background: #fff;
      color: #172033;
      box-shadow: 0 18px 46px rgba(15, 23, 42, 0.2);
      pointer-events: auto;
    }
    .domain-register-guide-panel__head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
    }
    .domain-register-guide-panel__title {
      margin: 0;
      font-size: 18px;
      line-height: 1.35;
      font-weight: 700;
    }
    .domain-register-guide-panel__close {
      flex: 0 0 auto;
      width: 28px;
      height: 28px;
      border: 0;
      border-radius: 50%;
      background: #eef2f7;
      color: #334155;
      cursor: pointer;
      font-size: 18px;
      line-height: 28px;
      text-align: center;
    }
    .domain-register-guide-panel__body {
      margin: 0;
      color: #475569;
      font-size: 14px;
      line-height: 1.65;
    }
    .domain-register-guide-panel__meta {
      margin-top: 10px;
      color: #64748b;
      font-size: 12px;
    }
    .domain-register-guide-panel__actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 14px;
      flex-wrap: wrap;
    }
    .domain-register-guide-panel__actions button {
      min-height: 34px;
      padding: 0 13px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
    }
    .domain-register-guide-panel__secondary {
      border: 1px solid #cbd5e1;
      background: #fff;
      color: #334155;
    }
    .domain-register-guide-panel__primary {
      border: 1px solid #2563eb;
      background: #2563eb;
      color: #fff;
    }
    @media (max-width: 560px) {
      .domain-register-guide-button {
        right: 12px;
        bottom: 12px;
      }
      .domain-register-guide-panel {
        left: 16px !important;
        right: 16px;
        width: auto;
      }
    }
  `;
  document.head.appendChild(style);
}

function ensureButton(config: GuideConfig) {
  let button = document.getElementById(buttonId) as HTMLButtonElement | null;
  if (!button) {
    button = document.createElement('button');
    button.id = buttonId;
    button.type = 'button';
    button.className = 'domain-register-guide-button';
    document.body.appendChild(button);
  }
  button.innerHTML = `<span class="domain-register-guide-button__icon">?</span><span>${escapeHtml(config.buttonText || '注册引导')}</span>`;
  button.onclick = () => startGuide(config);
}

function removeButton() {
  document.getElementById(buttonId)?.remove();
}

function ensureRoot() {
  let root = document.getElementById(rootId);
  if (!root) {
    root = document.createElement('div');
    root.id = rootId;
    document.body.appendChild(root);
  }
  return root;
}

function closeGuide(clearActive: boolean) {
  if (activeConfig && clearActive) removeSession(activeConfig, 'active');
  document.getElementById(rootId)?.remove();
}

function escapeHtml(text: string) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch] || ch));
}

function gotoRegister(config: GuideConfig) {
  setSession(config, 'active', '1');
  window.location.href = config.registerUrl || '/register';
}

function buildSteps(config: GuideConfig): GuideStep[] {
  if (!isRegisterPage()) {
    return [{
      id: 'entry',
      title: '点击注册入口',
      body: '点击页面右上角的注册入口，或直接使用下面的按钮进入注册页。',
      target: () => findRegisterLink(config),
      primaryText: '前往注册',
      onPrimary: () => gotoRegister(config),
    }];
  }

  if (!isRegisterWithCodePage()) {
    return [
      {
        id: 'mail',
        title: '填写邮箱',
        body: '在这里填写自己的邮箱地址。这个站点点击发送后会直接进入下一步，不需要真的打开邮箱验证。',
        target: () => findInput('mail'),
      },
      {
        id: 'send-mail',
        title: '进入下一步',
        body: '填写邮箱后，点击页面里的“发送验证邮件”按钮。进入下一页后，引导会继续提示用户名和密码。',
        target: () => findSubmitButton(),
        primaryText: '我知道了',
        onPrimary: () => closeGuide(false),
      },
    ];
  }

  return [
    {
      id: 'uname',
      title: '填写用户名',
      body: '用户名会用于登录和提交记录展示，建议使用容易识别的名称。',
      target: () => findInput('uname'),
    },
    {
      id: 'password',
      title: '设置密码',
      body: '输入自己的登录密码。请使用自己能记住、但别人不容易猜到的密码。',
      target: () => findInput('password'),
    },
    {
      id: 'verify-password',
      title: '重复密码',
      body: '这里再输入一遍相同密码，用来确认前后两次没有输错。',
      target: () => findInput('verifyPassword'),
    },
    {
      id: 'submit-register',
      title: '完成注册',
      body: '确认邮箱、用户名和密码都填写正确后，点击页面上的注册按钮完成账号创建。',
      target: () => findSubmitButton(),
      primaryText: '完成引导',
      onPrimary: () => closeGuide(true),
    },
  ];
}

function positionPanel(panel: HTMLElement, target: HTMLElement | null) {
  const margin = 16;
  const panelRect = panel.getBoundingClientRect();

  if (!target || !isVisible(target)) {
    panel.style.left = `${Math.max(margin, (window.innerWidth - panelRect.width) / 2)}px`;
    panel.style.top = `${Math.max(margin, (window.innerHeight - panelRect.height) / 2)}px`;
    return;
  }

  const rect = target.getBoundingClientRect();
  let left = Math.min(Math.max(margin, rect.left), window.innerWidth - panelRect.width - margin);
  let top = rect.bottom + 12;
  if (top + panelRect.height > window.innerHeight - margin) top = rect.top - panelRect.height - 12;
  if (top < margin) top = margin;
  if (left < margin) left = margin;

  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

function drawStep(step: GuideStep, index: number) {
  const root = ensureRoot();
  root.innerHTML = '';

  const target = step.target();
  if (target && isVisible(target)) {
    const rect = target.getBoundingClientRect();
    const highlight = document.createElement('div');
    highlight.className = 'domain-register-guide-highlight';
    highlight.style.left = `${Math.max(4, rect.left - 6)}px`;
    highlight.style.top = `${Math.max(4, rect.top - 6)}px`;
    highlight.style.width = `${rect.width + 12}px`;
    highlight.style.height = `${rect.height + 12}px`;
    root.appendChild(highlight);
  }

  const panel = document.createElement('div');
  panel.className = 'domain-register-guide-panel';
  panel.innerHTML = `
    <div class="domain-register-guide-panel__head">
      <h2 class="domain-register-guide-panel__title">${escapeHtml(step.title)}</h2>
      <button class="domain-register-guide-panel__close" type="button" aria-label="结束引导">×</button>
    </div>
    <p class="domain-register-guide-panel__body">${escapeHtml(step.body)}</p>
    <div class="domain-register-guide-panel__meta">第 ${index + 1} / ${currentSteps.length} 步</div>
    <div class="domain-register-guide-panel__actions"></div>
  `;
  root.appendChild(panel);

  const actions = panel.querySelector('.domain-register-guide-panel__actions') as HTMLElement;
  const closeButton = panel.querySelector('.domain-register-guide-panel__close') as HTMLButtonElement;
  closeButton.onclick = () => closeGuide(true);

  if (index > 0) {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'domain-register-guide-panel__secondary';
    back.textContent = '上一步';
    back.onclick = () => renderStep(index - 1);
    actions.appendChild(back);
  }

  const end = document.createElement('button');
  end.type = 'button';
  end.className = 'domain-register-guide-panel__secondary';
  end.textContent = '结束';
  end.onclick = () => closeGuide(true);
  actions.appendChild(end);

  const primary = document.createElement('button');
  primary.type = 'button';
  primary.className = 'domain-register-guide-panel__primary';
  primary.textContent = step.primaryText || (index >= currentSteps.length - 1 ? '完成' : '下一步');
  primary.onclick = () => {
    if (step.onPrimary) {
      step.onPrimary();
      return;
    }
    if (index < currentSteps.length - 1) renderStep(index + 1);
    else closeGuide(true);
  };
  actions.appendChild(primary);

  window.requestAnimationFrame(() => positionPanel(panel, target));
}

function renderStep(index: number) {
  currentIndex = Math.min(Math.max(index, 0), currentSteps.length - 1);
  const step = currentSteps[currentIndex];
  if (!step) return;
  const target = step.target();
  if (target && isVisible(target)) target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
  window.setTimeout(() => drawStep(step, currentIndex), 120);
}

function showGuide(config: GuideConfig) {
  activeConfig = config;
  currentSteps = buildSteps(config);
  currentIndex = 0;
  if (!currentSteps.length) return;
  renderStep(currentIndex);
  if (!resizeBound) {
    resizeBound = true;
    window.addEventListener('resize', () => {
      if (document.getElementById(rootId) && currentSteps[currentIndex]) drawStep(currentSteps[currentIndex], currentIndex);
    });
  }
}

function startGuide(config: GuideConfig) {
  setSession(config, 'active', '1');
  showGuide(config);
}

function mountRegisterGuide() {
  const config = getConfig();
  if (!config) {
    removeButton();
    closeGuide(false);
    return;
  }
  if (getUserId()) {
    removeSession(config, 'active');
    removeButton();
    closeGuide(false);
    return;
  }

  ensureStyle();
  ensureButton(config);

  if (config.autoOpen && !getLocal(config, 'seen')) {
    setLocal(config, 'seen', '1');
    startGuide(config);
    return;
  }

  if (getSession(config, 'active') === '1') showGuide(config);
}

addPage(new AutoloadPage('domainRegisterGuide', mountRegisterGuide));
