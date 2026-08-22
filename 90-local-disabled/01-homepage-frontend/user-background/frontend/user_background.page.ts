import { addPage } from '@hydrooj/ui-default';

declare const UserContext: any;

interface BackgroundConfig {
    enabled?: boolean;
    opacity?: number;
    url?: string;
}

const LAYER_ID = 'hydro-user-background-layer';
const STYLE_ID = 'hydro-user-background-style';
const CONFIG_PATH = '/home/background/config';
const CONFIG_STORAGE_KEY = 'hydro-user-background-config-v1';
const CONFIG_STORAGE_MAX_AGE = 24 * 60 * 60 * 1000;
const IMAGE_CACHE_NAME = 'hydro-user-background-image-v1';
const IMAGE_DB_NAME = 'hydro-user-background';
const IMAGE_STORE_NAME = 'images';

let activeObjectUrl = '';
let backgroundLoadScheduled = false;

function clampOpacity(value: any) {
    const opacity = Number(value);
    if (!Number.isFinite(opacity)) return 0.3;
    return Math.max(0, Math.min(opacity, 1));
}

function cssUrl(url: string) {
    return String(url || '').replace(/["\\\n\r\f]/g, '\\$&');
}

function absoluteUrl(url: string) {
    return new URL(url, window.location.href).toString();
}

function currentUid() {
    return Number(UserContext?._id || 0);
}

function readStoredConfig(): BackgroundConfig | null {
    try {
        const data = JSON.parse(localStorage.getItem(CONFIG_STORAGE_KEY) || 'null');
        if (!data || data.uid !== currentUid()) return null;
        if (Date.now() - Number(data.savedAt || 0) > CONFIG_STORAGE_MAX_AGE) return null;
        return data.config || null;
    } catch {
        return null;
    }
}

function writeStoredConfig(config: BackgroundConfig) {
    try {
        localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify({
            uid: currentUid(),
            savedAt: Date.now(),
            config,
        }));
    } catch {
        // localStorage may be disabled or full; the network path still works.
    }
}

function clearStoredConfig() {
    try {
        localStorage.removeItem(CONFIG_STORAGE_KEY);
    } catch {
        // Ignore storage failures.
    }
}

function revokeActiveObjectUrl() {
    if (!activeObjectUrl) return;
    URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = '';
}

function markCacheStatus(status: string, error = '') {
    document.documentElement.dataset.userBackgroundCache = status;
    if (error) document.documentElement.dataset.userBackgroundCacheError = error.slice(0, 160);
    else delete document.documentElement.dataset.userBackgroundCacheError;
}

async function openImageDb(): Promise<IDBDatabase | null> {
    if (!('indexedDB' in window)) return null;
    return await new Promise((resolve) => {
        const request = indexedDB.open(IMAGE_DB_NAME, 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(IMAGE_STORE_NAME)) db.createObjectStore(IMAGE_STORE_NAME);
        };
        request.onerror = () => resolve(null);
        request.onsuccess = () => resolve(request.result);
    });
}

function objectStoreRequest<T>(request: IDBRequest<T>): Promise<T | null> {
    return new Promise((resolve) => {
        request.onerror = () => resolve(null);
        request.onsuccess = () => resolve(request.result ?? null);
    });
}

async function getIdbBlob(key: string) {
    const db = await openImageDb();
    if (!db) return null;
    try {
        return await objectStoreRequest<Blob>(db.transaction(IMAGE_STORE_NAME, 'readonly').objectStore(IMAGE_STORE_NAME).get(key));
    } finally {
        db.close();
    }
}

async function putIdbBlob(key: string, blob: Blob) {
    const db = await openImageDb();
    if (!db) return;
    try {
        await objectStoreRequest(db.transaction(IMAGE_STORE_NAME, 'readwrite').objectStore(IMAGE_STORE_NAME).put(blob, key));
    } finally {
        db.close();
    }
}

async function pruneIdbImages(activeKey: string) {
    const db = await openImageDb();
    if (!db) return;
    try {
        const keys = await objectStoreRequest<IDBValidKey[]>(
            db.transaction(IMAGE_STORE_NAME, 'readonly').objectStore(IMAGE_STORE_NAME).getAllKeys(),
        );
        const staleKeys = (keys || [])
            .map((key) => String(key))
            .filter((key) => key !== activeKey);
        if (!staleKeys.length) return;
        const store = db.transaction(IMAGE_STORE_NAME, 'readwrite').objectStore(IMAGE_STORE_NAME);
        await Promise.all(staleKeys.map((key) => objectStoreRequest(store.delete(key))));
    } finally {
        db.close();
    }
}

async function getCacheApiBlob(key: string) {
    const cacheStorage = (window as any).caches as CacheStorage | undefined;
    if (!cacheStorage) return null;
    const cache = await cacheStorage.open(IMAGE_CACHE_NAME);
    const response = await cache.match(key);
    if (!response) return null;
    return await response.blob();
}

async function putCacheApiResponse(key: string, response: Response) {
    const cacheStorage = (window as any).caches as CacheStorage | undefined;
    if (!cacheStorage) return;
    const cache = await cacheStorage.open(IMAGE_CACHE_NAME);
    await cache.put(key, response);
}

async function pruneCacheApiImages(activeKey: string) {
    const cacheStorage = (window as any).caches as CacheStorage | undefined;
    if (!cacheStorage) return;
    const cache = await cacheStorage.open(IMAGE_CACHE_NAME);
    const keys = await cache.keys();
    await Promise.all(keys.filter((request) => request.url !== activeKey).map((request) => cache.delete(request)));
}

async function fetchBackgroundBlob(key: string) {
    const response = await fetch(key, { credentials: 'same-origin', cache: 'force-cache' });
    if (!response.ok) throw new Error(`Failed to load user background: ${response.status}`);
    const blob = await response.clone().blob();
    await Promise.all([
        putCacheApiResponse(key, response.clone()).catch(() => null),
        putIdbBlob(key, blob).catch(() => null),
    ]);
    return blob;
}

async function cachedBackgroundUrl(url: string) {
    const key = absoluteUrl(url);
    try {
        let status = 'cache-api';
        let blob = await getCacheApiBlob(key).catch(() => null);
        if (!blob) {
            status = 'indexeddb';
            blob = await getIdbBlob(key).catch(() => null);
        }
        if (!blob) {
            status = 'network';
            blob = await fetchBackgroundBlob(key);
        }
        await Promise.all([
            pruneCacheApiImages(key).catch(() => null),
            pruneIdbImages(key).catch(() => null),
        ]);
        revokeActiveObjectUrl();
        activeObjectUrl = URL.createObjectURL(blob);
        markCacheStatus(status);
        return activeObjectUrl;
    } catch (error) {
        markCacheStatus('fallback', String(error?.message || error || 'unknown error'));
        return url;
    }
}

function runWhenIdle(callback: () => void, timeout = 1600) {
    if ('requestIdleCallback' in window) {
        requestIdleCallback(callback, { timeout });
    } else {
        setTimeout(callback, Math.min(timeout, 800));
    }
}

function setBackgroundImage(target: HTMLElement, url: string) {
    target.style.backgroundImage = url ? `url("${cssUrl(absoluteUrl(url))}")` : '';
    if (url) target.dataset.loaded = '1';
    else delete target.dataset.loaded;
}

function initLazyBackgroundImages(root: ParentNode = document) {
    const targets = Array.from(root.querySelectorAll<HTMLElement>('[data-user-bg-lazy]'))
        .filter((target) => target.dataset.lazyBound !== '1');
    if (!targets.length) return;

    const load = (target: HTMLElement) => {
        const url = target.dataset.userBgLazy || '';
        if (!url || target.dataset.loaded === '1') return;
        setBackgroundImage(target, url);
    };

    if (!('IntersectionObserver' in window)) {
        runWhenIdle(() => targets.forEach(load));
        return;
    }

    const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting && entry.intersectionRatio <= 0) continue;
            const target = entry.target as HTMLElement;
            observer.unobserve(target);
            load(target);
        }
    }, { rootMargin: '360px 0px' });

    for (const target of targets) {
        target.dataset.lazyBound = '1';
        observer.observe(target);
    }
}

function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
html.hydro-user-background-enabled,
html.hydro-user-background-enabled body {
  min-height: 100%;
  background: transparent !important;
}
html.hydro-user-background-enabled body {
  position: relative;
  z-index: 0;
}
html.hydro-user-background-enabled #panel,
html.hydro-user-background-enabled .main {
  background: transparent !important;
}
html.hydro-user-background-enabled {
  color-scheme: light;
  --hub-nav-bg: rgba(255, 255, 255, .075);
  --hub-nav-hover: rgba(255, 255, 255, .105);
  --hub-surface: rgba(255, 255, 255, .055);
  --hub-surface-soft: rgba(255, 255, 255, .035);
  --hub-surface-strong: rgba(255, 255, 255, .12);
  --hub-input-bg: rgba(255, 255, 255, .075);
  --hub-code-bg: rgba(255, 255, 255, .085);
  --hub-border: rgba(15, 23, 42, .10);
  --hub-border-soft: rgba(15, 23, 42, .06);
  --hub-shadow: none;
  --hub-text: #111827;
  --hub-muted: #475569;
  --hub-accent-soft: rgba(237, 95, 130, .14);
  --bg-color: transparent;
  --highlight-color: var(--hub-nav-hover);
}
html.hydro-user-background-enabled.theme--dark,
html.hydro-user-background-enabled .theme--dark {
  color-scheme: dark;
  --hub-nav-bg: rgba(255, 255, 255, .045);
  --hub-nav-hover: rgba(255, 255, 255, .085);
  --hub-surface: rgba(255, 255, 255, .045);
  --hub-surface-soft: rgba(255, 255, 255, .028);
  --hub-surface-strong: rgba(255, 255, 255, .10);
  --hub-input-bg: rgba(255, 255, 255, .055);
  --hub-code-bg: rgba(255, 255, 255, .07);
  --hub-border: rgba(255, 255, 255, .12);
  --hub-border-soft: rgba(255, 255, 255, .08);
  --hub-shadow: none;
  --hub-text: #f8fafc;
  --hub-muted: #cbd5e1;
  --hub-accent-soft: rgba(237, 95, 130, .18);
}
html.hydro-user-background-enabled .nav {
  background: var(--hub-nav-bg) !important;
  backdrop-filter: blur(14px) saturate(150%);
  -webkit-backdrop-filter: blur(14px) saturate(150%);
}
html.hydro-user-background-enabled .nav--shadow {
  box-shadow: 0 1px 14px var(--hub-border-soft) !important;
}
html.hydro-user-background-enabled .nav .nav__item:hover {
  background: var(--hub-nav-hover) !important;
}
html.hydro-user-background-enabled .nav .nav__item,
html.hydro-user-background-enabled .nav .nav__item:visited,
html.hydro-user-background-enabled .nav .nav__item:active,
html.hydro-user-background-enabled .nav .nav__item:hover,
html.hydro-user-background-enabled .nav .nav__item .icon,
html.hydro-user-background-enabled .nav .dropdown-target.menu .menu__link,
html.hydro-user-background-enabled .nav .dropdown-target.menu .menu__link:visited,
html.hydro-user-background-enabled .nav .dropdown-target.menu .menu__link:active,
html.hydro-user-background-enabled .nav .dropdown-target.menu .menu__link:hover,
html.hydro-user-background-enabled .nav .dropdown-target.menu .menu__link .icon,
html.hydro-user-background-enabled .nav__dropdown.dropdown-target.menu .menu__link,
html.hydro-user-background-enabled .nav__dropdown.dropdown-target.menu .menu__link:visited,
html.hydro-user-background-enabled .nav__dropdown.dropdown-target.menu .menu__link:active,
html.hydro-user-background-enabled .nav__dropdown.dropdown-target.menu .menu__link:hover,
html.hydro-user-background-enabled .nav__dropdown.dropdown-target.menu .menu__link .icon {
  color: var(--hub-text) !important;
  opacity: 1 !important;
}
html.hydro-user-background-enabled .footer {
  color: var(--hub-text) !important;
  background: var(--hub-nav-bg) !important;
  backdrop-filter: blur(14px) saturate(150%);
  -webkit-backdrop-filter: blur(14px) saturate(150%);
}
html.hydro-user-background-enabled .footer__category {
  border-color: var(--hub-border-soft) !important;
}
html.hydro-user-background-enabled .footer a,
html.hydro-user-background-enabled .footer a:visited,
html.hydro-user-background-enabled .footer a:active,
html.hydro-user-background-enabled .footer a:hover {
  color: inherit !important;
}
html.hydro-user-background-enabled .footer .dropdown-target.menu {
  background: var(--hub-surface-strong) !important;
  backdrop-filter: blur(14px) saturate(150%);
  -webkit-backdrop-filter: blur(14px) saturate(150%);
}
html.hydro-user-background-enabled .nav .dropdown-target.menu {
  background: var(--hub-surface-strong) !important;
  backdrop-filter: blur(14px) saturate(150%);
  -webkit-backdrop-filter: blur(14px) saturate(150%);
}
html.hydro-user-background-enabled .nav__dropdown.dropdown-target.menu {
  background: var(--hub-surface-strong) !important;
  backdrop-filter: blur(14px) saturate(150%);
  -webkit-backdrop-filter: blur(14px) saturate(150%);
}
html.hydro-user-background-enabled .section,
html.hydro-user-background-enabled .dialog.withBg .dialog__content {
  color: var(--hub-text);
  background: var(--hub-surface) !important;
  border-color: var(--hub-border) !important;
  box-shadow: var(--hub-shadow) !important;
  backdrop-filter: blur(14px) saturate(150%);
  -webkit-backdrop-filter: blur(14px) saturate(150%);
}
html.hydro-user-background-enabled .section__header,
html.hydro-user-background-enabled .section__body,
html.hydro-user-background-enabled .section__tab-content,
html.hydro-user-background-enabled .section__table-container {
  background: transparent !important;
}
html.hydro-user-background-enabled .section__footer,
html.hydro-user-background-enabled .section__list__item,
html.hydro-user-background-enabled .section__tab-item,
html.hydro-user-background-enabled .pager.pager-top,
html.hydro-user-background-enabled .pager.pager-bottom,
html.hydro-user-background-enabled .data-table tr,
html.hydro-user-background-enabled .data-table thead > tr,
html.hydro-user-background-enabled .typo table th,
html.hydro-user-background-enabled .typo table td {
  border-color: var(--hub-border) !important;
}
html.hydro-user-background-enabled .section__title,
html.hydro-user-background-enabled .section__tab-title,
html.hydro-user-background-enabled .section__tab-header-item,
html.hydro-user-background-enabled label:not(.quick-input-list-label),
html.hydro-user-background-enabled .menu__link:not(.active),
html.hydro-user-background-enabled .pager__item,
html.hydro-user-background-enabled .supplementary,
html.hydro-user-background-enabled .nothing-placeholder {
  color: var(--hub-text) !important;
}
html.hydro-user-background-enabled .help-text,
html.hydro-user-background-enabled .time,
html.hydro-user-background-enabled .data-table thead > tr,
html.hydro-user-background-enabled .typo table caption {
  color: var(--hub-muted) !important;
}
html.hydro-user-background-enabled .section__table-header {
  background: transparent !important;
  box-shadow: none !important;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}
html.hydro-user-background-enabled .section__table-header.is_stuck {
  box-shadow: 0 1px 12px var(--hub-border-soft) !important;
}
html.hydro-user-background-enabled .data-table > thead,
html.hydro-user-background-enabled .data-table > thead > tr,
html.hydro-user-background-enabled .data-table > thead > tr > th,
html.hydro-user-background-enabled .section__table-header .data-table > thead,
html.hydro-user-background-enabled .section__table-header .data-table > thead > tr,
html.hydro-user-background-enabled .section__table-header .data-table > thead > tr > th {
  background: transparent !important;
  border-color: var(--hub-border) !important;
}
html.hydro-user-background-enabled #searchForm {
  background: transparent !important;
}
html.hydro-user-background-enabled #searchForm .search {
  background: transparent !important;
}
html.hydro-user-background-enabled #searchForm .search > input,
html.hydro-user-background-enabled #searchForm .search-sort {
  color: var(--hub-text) !important;
  background: var(--hub-input-bg) !important;
  border-color: var(--hub-border) !important;
  box-shadow: none !important;
}
html.hydro-user-background-enabled #searchForm .search > input::placeholder {
  color: var(--hub-muted) !important;
  opacity: .82;
}
html.hydro-user-background-enabled #searchForm .search > button {
  color: var(--hub-text) !important;
  background: var(--hub-accent-soft) !important;
  border-color: var(--hub-border) !important;
}
html.hydro-user-background-enabled #searchForm .search > button:hover {
  background: var(--hub-nav-hover) !important;
}
html.hydro-user-background-enabled #searchForm [data-fragment-id="problem_stat"] {
  color: var(--hub-muted) !important;
}
html.hydro-user-background-enabled .problem__tag-link,
html.hydro-user-background-enabled .problem__tag-item,
html.hydro-user-background-enabled .search-tag__item,
html.hydro-user-background-enabled .widget--category-filter__tag,
html.hydro-user-background-enabled .category-filter__header .list .list__item {
  color: var(--hub-text) !important;
  background: var(--hub-surface-soft) !important;
  border: 1px solid var(--hub-border-soft) !important;
  box-shadow: none !important;
}
html.hydro-user-background-enabled .problem__tag-link:hover,
html.hydro-user-background-enabled .problem__tag-item.interactive:hover,
html.hydro-user-background-enabled .search-tag__item:hover,
html.hydro-user-background-enabled .search-tag__item.selected,
html.hydro-user-background-enabled .widget--category-filter__tag:hover,
html.hydro-user-background-enabled .widget--category-filter__tag.selected,
html.hydro-user-background-enabled .category-filter__header .list .list__item.selected {
  color: var(--hub-text) !important;
  background: var(--hub-accent-soft) !important;
  border-color: var(--hub-border) !important;
  text-decoration: none !important;
}
html.hydro-user-background-enabled .category-filter__body {
  background: transparent !important;
}
html.hydro-user-background-enabled .widget--category-filter__drop {
  color: var(--hub-text) !important;
  background: var(--hub-surface-strong) !important;
  border: 1px solid var(--hub-border) !important;
  box-shadow: var(--hub-shadow) !important;
  backdrop-filter: blur(14px) saturate(150%);
  -webkit-backdrop-filter: blur(14px) saturate(150%);
}
html.hydro-user-background-enabled .widget--category-filter__drop:before {
  border-top-color: var(--hub-surface-strong) !important;
  border-left-color: var(--hub-surface-strong) !important;
}
html.hydro-user-background-enabled .data-table tr:nth-child(even),
html.hydro-user-background-enabled .typo table th {
  background: var(--hub-surface-soft) !important;
}
html.hydro-user-background-enabled .data-table tr.highlight,
html.hydro-user-background-enabled .data-table.is--full-row tr:hover,
html.hydro-user-background-enabled .section__tab-container:not(.immersive) .section__tab-header-item:hover,
html.hydro-user-background-enabled a.menu__link:not(.disabled):hover,
html.hydro-user-background-enabled button.menu__link:not(.disabled):hover {
  background: var(--hub-nav-hover) !important;
}
html.hydro-user-background-enabled .section__tab-container:not(.immersive) .section__tab-header-item.selected,
html.hydro-user-background-enabled .section__tab-container:not(.immersive) .section__tab-header-item.tab--active,
html.hydro-user-background-enabled a.menu__link.active,
html.hydro-user-background-enabled button.menu__link.active,
html.hydro-user-background-enabled a.menu__link.active:hover,
html.hydro-user-background-enabled button.menu__link.active:hover {
  background: var(--hub-accent-soft) !important;
}
html.hydro-user-background-enabled .dropdown-target.menu,
html.hydro-user-background-enabled .autocomplete-container .menu,
html.hydro-user-background-enabled .menu.user-select,
html.hydro-user-background-enabled .menu.problem-select,
html.hydro-user-background-enabled .menu.domain-select {
  color: var(--hub-text) !important;
  background: var(--hub-surface-strong) !important;
  border-color: var(--hub-border) !important;
  box-shadow: var(--hub-shadow) !important;
  backdrop-filter: blur(14px) saturate(150%);
  -webkit-backdrop-filter: blur(14px) saturate(150%);
}
html.hydro-user-background-enabled .autocomplete-container {
  color: var(--hub-text) !important;
}
html.hydro-user-background-enabled .section .menu {
  background: transparent !important;
  box-shadow: none !important;
}
html.hydro-user-background-enabled .section .autocomplete-container .menu,
html.hydro-user-background-enabled .section .menu.user-select,
html.hydro-user-background-enabled .section .menu.problem-select,
html.hydro-user-background-enabled .section .menu.domain-select,
html.hydro-user-background-enabled .section .dropdown-target.menu {
  color: var(--hub-text) !important;
  background: var(--hub-surface-strong) !important;
  border-color: var(--hub-border) !important;
  box-shadow: var(--hub-shadow) !important;
  backdrop-filter: blur(14px) saturate(150%);
  -webkit-backdrop-filter: blur(14px) saturate(150%);
}
html.hydro-user-background-enabled .autocomplete-container .menu__item,
html.hydro-user-background-enabled .menu.problem-select .menu__item,
html.hydro-user-background-enabled .menu.user-select .menu__item,
html.hydro-user-background-enabled .menu.domain-select .menu__item,
html.hydro-user-background-enabled .autocomplete-container .menu__link,
html.hydro-user-background-enabled .menu.problem-select .menu__link,
html.hydro-user-background-enabled .menu.user-select .menu__link,
html.hydro-user-background-enabled .menu.domain-select .menu__link {
  color: var(--hub-text) !important;
  background: transparent !important;
}
html.hydro-user-background-enabled .autocomplete-container .menu__item:hover,
html.hydro-user-background-enabled .menu.problem-select .menu__item:hover,
html.hydro-user-background-enabled .menu.user-select .menu__item:hover,
html.hydro-user-background-enabled .menu.domain-select .menu__item:hover,
html.hydro-user-background-enabled .autocomplete-container .menu__link:hover,
html.hydro-user-background-enabled .menu.problem-select .menu__link:hover,
html.hydro-user-background-enabled .menu.user-select .menu__link:hover,
html.hydro-user-background-enabled .menu.domain-select .menu__link:hover {
  color: var(--hub-text) !important;
  background: var(--hub-nav-hover) !important;
}
html.hydro-user-background-enabled .problem-select__id {
  color: var(--hub-muted) !important;
}
html.hydro-user-background-enabled .menu__seperator {
  border-color: var(--hub-border) !important;
}
html.hydro-user-background-enabled input.textbox,
html.hydro-user-background-enabled textarea.textbox,
html.hydro-user-background-enabled span.textbox,
html.hydro-user-background-enabled div.textbox,
html.hydro-user-background-enabled .select {
  color: var(--hub-text) !important;
  background-color: var(--hub-input-bg) !important;
  border-color: var(--hub-border) !important;
  box-shadow: none !important;
}
html.hydro-user-background-enabled input.textbox:focus,
html.hydro-user-background-enabled textarea.textbox:focus,
html.hydro-user-background-enabled .select:focus {
  background-color: var(--hub-surface-strong) !important;
}
html.hydro-user-background-enabled label.textbox.material input {
  color: var(--hub-text) !important;
  border-color: var(--hub-border) !important;
}
html.hydro-user-background-enabled input.textbox[data-pick-date],
html.hydro-user-background-enabled input.textbox[data-pick-time],
html.hydro-user-background-enabled input.textbox[data-pick-datetime] {
  color-scheme: light;
}
html.hydro-user-background-enabled.theme--dark input.textbox[data-pick-date],
html.hydro-user-background-enabled.theme--dark input.textbox[data-pick-time],
html.hydro-user-background-enabled.theme--dark input.textbox[data-pick-datetime],
html.hydro-user-background-enabled .theme--dark input.textbox[data-pick-date],
html.hydro-user-background-enabled .theme--dark input.textbox[data-pick-time],
html.hydro-user-background-enabled .theme--dark input.textbox[data-pick-datetime] {
  color-scheme: dark;
}
html.hydro-user-background-enabled .time-picker-dropdown,
html.hydro-user-background-enabled .flatpickr-calendar {
  color: var(--hub-text) !important;
  background: var(--hub-surface-strong) !important;
  border-color: var(--hub-border) !important;
  box-shadow: var(--hub-shadow) !important;
  backdrop-filter: blur(14px) saturate(150%);
  -webkit-backdrop-filter: blur(14px) saturate(150%);
}
html.hydro-user-background-enabled .time-picker-dropdown > div {
  color: var(--hub-text) !important;
}
html.hydro-user-background-enabled .time-picker-dropdown > div:hover {
  background: var(--hub-nav-hover) !important;
}
html.hydro-user-background-enabled .flatpickr-calendar.arrowTop:before,
html.hydro-user-background-enabled .flatpickr-calendar.arrowTop:after,
html.hydro-user-background-enabled .flatpickr-calendar.arrowBottom:before,
html.hydro-user-background-enabled .flatpickr-calendar.arrowBottom:after {
  border-bottom-color: var(--hub-surface-strong) !important;
  border-top-color: var(--hub-surface-strong) !important;
}
html.hydro-user-background-enabled .flatpickr-months,
html.hydro-user-background-enabled .flatpickr-months .flatpickr-month,
html.hydro-user-background-enabled .flatpickr-months .flatpickr-prev-month,
html.hydro-user-background-enabled .flatpickr-months .flatpickr-next-month,
html.hydro-user-background-enabled .flatpickr-current-month,
html.hydro-user-background-enabled .flatpickr-current-month .cur-month,
html.hydro-user-background-enabled .flatpickr-weekdays,
html.hydro-user-background-enabled .flatpickr-time,
html.hydro-user-background-enabled .flatpickr-current-month .flatpickr-monthDropdown-months,
html.hydro-user-background-enabled .flatpickr-current-month .flatpickr-monthDropdown-month,
html.hydro-user-background-enabled .flatpickr-current-month input.cur-year,
html.hydro-user-background-enabled .flatpickr-time input,
html.hydro-user-background-enabled .flatpickr-time .flatpickr-am-pm {
  color: var(--hub-text) !important;
  background: transparent !important;
  border-color: var(--hub-border) !important;
}
html.hydro-user-background-enabled .flatpickr-months .flatpickr-prev-month svg,
html.hydro-user-background-enabled .flatpickr-months .flatpickr-next-month svg {
  fill: var(--hub-text) !important;
}
html.hydro-user-background-enabled .flatpickr-weekday,
html.hydro-user-background-enabled .flatpickr-day {
  color: var(--hub-text) !important;
}
html.hydro-user-background-enabled .flatpickr-day.prevMonthDay,
html.hydro-user-background-enabled .flatpickr-day.nextMonthDay,
html.hydro-user-background-enabled .flatpickr-day.disabled,
html.hydro-user-background-enabled .flatpickr-day.disabled:hover {
  color: var(--hub-muted) !important;
}
html.hydro-user-background-enabled .flatpickr-day:hover,
html.hydro-user-background-enabled .flatpickr-day:focus,
html.hydro-user-background-enabled .flatpickr-day.today:hover,
html.hydro-user-background-enabled .numInputWrapper:hover {
  color: var(--hub-text) !important;
  background: var(--hub-nav-hover) !important;
  border-color: var(--hub-border) !important;
}
html.hydro-user-background-enabled .flatpickr-day.today {
  border-color: var(--hub-border) !important;
}
html.hydro-user-background-enabled .flatpickr-day.selected,
html.hydro-user-background-enabled .flatpickr-day.startRange,
html.hydro-user-background-enabled .flatpickr-day.endRange {
  color: var(--hub-text) !important;
  background: var(--hub-accent-soft) !important;
  border-color: var(--hub-border) !important;
}
html.hydro-user-background-enabled blockquote,
html.hydro-user-background-enabled blockquote.note,
html.hydro-user-background-enabled blockquote.warn,
html.hydro-user-background-enabled blockquote.red,
html.hydro-user-background-enabled blockquote.yellow,
html.hydro-user-background-enabled blockquote.blue,
html.hydro-user-background-enabled pre,
html.hydro-user-background-enabled code,
html.hydro-user-background-enabled :not(pre) > code[class*="language-"],
html.hydro-user-background-enabled pre[class*="language-"] {
  background: var(--hub-code-bg) !important;
  border-color: var(--hub-border) !important;
}
html.hydro-user-background-enabled pre > code {
  background: transparent !important;
}
html.hydro-user-background-enabled .dialog {
  background: rgba(15, 23, 42, .32) !important;
}
html.hydro-user-background-enabled.theme--dark .nav,
html.hydro-user-background-enabled .theme--dark .nav {
  background: var(--hub-nav-bg) !important;
}
html.hydro-user-background-enabled.theme--dark .nav .nav__item:hover,
html.hydro-user-background-enabled .theme--dark .nav .nav__item:hover {
  background: var(--hub-nav-hover) !important;
}
html.hydro-user-background-enabled.theme--dark .footer,
html.hydro-user-background-enabled .theme--dark .footer {
  background: var(--hub-nav-bg) !important;
}
html.hydro-user-background-enabled.theme--dark .footer__category,
html.hydro-user-background-enabled .theme--dark .footer__category {
  border-color: var(--hub-border-soft) !important;
}
html.hydro-user-background-enabled.theme--dark .footer .dropdown-target.menu,
html.hydro-user-background-enabled .theme--dark .footer .dropdown-target.menu {
  background: var(--hub-surface-strong) !important;
}
html.hydro-user-background-enabled.theme--dark .nav .dropdown-target.menu,
html.hydro-user-background-enabled .theme--dark .nav .dropdown-target.menu {
  background: var(--hub-surface-strong) !important;
}
html.hydro-user-background-enabled.theme--dark .nav__dropdown.dropdown-target.menu,
html.hydro-user-background-enabled .theme--dark .nav__dropdown.dropdown-target.menu {
  background: var(--hub-surface-strong) !important;
}
#${LAYER_ID} {
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background-position: center;
  background-repeat: no-repeat;
  background-size: cover;
  transition: opacity .18s ease, background-image .18s ease;
}
`;
    document.head.appendChild(style);
}

function ensureLayer() {
    let layer = document.getElementById(LAYER_ID) as HTMLDivElement | null;
    if (!layer) {
        layer = document.createElement('div');
        layer.id = LAYER_ID;
        layer.setAttribute('aria-hidden', 'true');
        document.body.insertBefore(layer, document.body.firstChild);
    }
    return layer;
}

function clearBackground() {
    document.documentElement.classList.remove('hydro-user-background-enabled');
    markCacheStatus('disabled');
    const layer = document.getElementById(LAYER_ID);
    if (layer) layer.remove();
    revokeActiveObjectUrl();
}

async function applyBackground(config: BackgroundConfig) {
    if (!config?.enabled || !config.url) {
        clearBackground();
        return;
    }
    ensureStyle();
    const layer = ensureLayer();
    layer.style.opacity = String(clampOpacity(config.opacity));
    document.documentElement.classList.add('hydro-user-background-enabled');
    setBackgroundImage(layer, await cachedBackgroundUrl(config.url));
}

async function loadBackground() {
    if (!UserContext?._id) {
        clearStoredConfig();
        clearBackground();
        return;
    }
    const cached = readStoredConfig();
    if (cached) await applyBackground(cached);
    try {
        const res = await fetch(CONFIG_PATH, {
            credentials: 'same-origin',
            headers: { Accept: 'application/json' },
        });
        if (!res.ok) {
            if (!cached) clearBackground();
            return;
        }
        const config = await res.json();
        writeStoredConfig(config);
        await applyBackground(config);
    } catch (error) {
        if (!cached) clearBackground();
    }
}

function scheduleLoadBackground() {
    if (backgroundLoadScheduled) return;
    backgroundLoadScheduled = true;
    const run = () => runWhenIdle(() => loadBackground(), 2000);
    if (document.readyState === 'complete') run();
    else window.addEventListener('load', run, { once: true });
}

function initSettingsPage() {
    const root = document.querySelector<HTMLElement>('[data-user-bg-settings]');
    if (!root || root.dataset.bound === '1') return;
    root.dataset.bound = '1';

    const enabledInput = root.querySelector<HTMLInputElement>('[data-user-bg-enabled]');
    const opacity = root.querySelector<HTMLInputElement>('[data-user-bg-opacity]');
    const opacityText = root.querySelector<HTMLElement>('[data-user-bg-opacity-text]');
    const opacityBox = root.querySelector<HTMLInputElement>('[data-user-bg-opacity-box]');
    const preview = root.querySelector<HTMLElement>('[data-user-bg-preview]');
    const fileInput = root.querySelector<HTMLInputElement>('[data-user-bg-file]');
    const clearButton = root.querySelector<HTMLButtonElement>('[data-user-bg-clear]');
    const options = Array.from(root.querySelectorAll<HTMLInputElement>('[data-user-bg-option]'));
    const cards = Array.from(root.querySelectorAll<HTMLElement>('.user-bg-card'));

    const updateOpacity = () => {
        const value = clampOpacity(opacity?.value);
        const percent = `${Math.round(value * 100)}%`;
        if (preview) preview.style.opacity = String(value);
        if (opacityText) opacityText.textContent = String(Math.round(value * 100));
        if (opacityBox) opacityBox.value = percent;
    };

    const updateSelection = (syncEnabled = false) => {
        const selected = options.find((option) => option.checked);
        const selectedUrl = selected?.dataset.url || '';
        cards.forEach((card) => {
            const option = card.querySelector<HTMLInputElement>('[data-user-bg-option]');
            card.classList.toggle('is-selected', !!option?.checked);
        });
        if (preview) setBackgroundImage(preview, selectedUrl);
        if (syncEnabled && enabledInput) enabledInput.checked = !!selectedUrl;
    };

    opacity?.addEventListener('input', updateOpacity);
    options.forEach((option) => option.addEventListener('change', () => updateSelection(true)));
    fileInput?.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        if (!file || !preview) return;
        const url = URL.createObjectURL(file);
        preview.style.backgroundImage = `url("${cssUrl(url)}")`;
    });
    clearButton?.addEventListener('click', (event) => {
        if (!confirm('确认清除当前背景图片和透明度设置吗？')) event.preventDefault();
    });
    updateOpacity();
    updateSelection();
    initLazyBackgroundImages(root);
}

function initManagePage() {
    initLazyBackgroundImages(document);
    document.querySelectorAll<HTMLButtonElement>('[data-user-bg-delete]').forEach((button) => {
        if (button.dataset.bound === '1') return;
        button.dataset.bound = '1';
        button.addEventListener('click', (event) => {
            if (!confirm('确认删除这张背景图片吗？正在使用它的用户会被清空选择。')) event.preventDefault();
        });
    });
}

addPage(() => {
    initSettingsPage();
    initManagePage();
    scheduleLoadBackground();
});
