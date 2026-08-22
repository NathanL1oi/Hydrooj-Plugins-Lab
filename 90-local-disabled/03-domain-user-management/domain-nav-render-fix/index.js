'use strict';

const { db } = require('hydrooj');

const PLUGIN_ID = 'domain-nav-render-fix';
const VIRTUAL_NAV_STORE = '__domainNavManagerVirtualNav';
const collConfig = db.collection('domain.navManager');
const configCache = new Map();

const AREAS = new Set(['main', 'more', 'hidden']);
const DEFAULT_MAIN = [
  'homepage',
  'problem_main',
  'training_main',
  'course_main',
  'contest_main',
  'homework_main',
  'discussion_main',
  'record_main',
  'ranking',
  'course_package_main',
  'article_main',
];
const DEFAULT_MORE = [
  'problem_collection_main',
  'domain_learning_point_table',
  'domain_learning_center',
  'domain_dashboard',
  'manage_dashboard',
];
const PROMOTE_TO_MAIN = new Set(['course_main']);
const FORCE_TO_MORE = new Set(['manage_dashboard']);

function stringifyDomainId(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (typeof value.toHexString === 'function') return value.toHexString();
  if (value && typeof value === 'object' && value._id !== undefined) return stringifyDomainId(value._id);
  if (typeof value.toString === 'function') {
    const result = String(value.toString()).trim();
    return result === '[object Object]' ? '' : result;
  }
  return '';
}

function domainIdFromPath(path) {
  const match = String(path || '').match(/(?:^|\/)d\/([^/?#]+)/);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch (e) {
    return match[1];
  }
}

function cacheKey(domainId) {
  return stringifyDomainId(domainId) || 'system';
}

function domainIdOf(handler) {
  const candidates = [
    handler?.args?.domainId,
    handler?.domain?._id,
    handler?.UiContext?.domainId,
    handler?.UiContext?.domain?._id,
    handler?.request?.params?.domainId,
    handler?.request?.query?.domainId,
    handler?.domainId,
    handler?.ctx?.domain?._id,
    domainIdFromPath(handler?.request?.path),
    domainIdFromPath(handler?.request?.url),
  ];
  for (const candidate of candidates) {
    const domainId = cacheKey(candidate);
    if (domainId && domainId !== 'system') return domainId;
  }
  return 'system';
}

function normalizeArea(value) {
  return AREAS.has(value) ? value : 'main';
}

function sanitizeTitle(value) {
  return String(value || '').trim().slice(0, 32);
}

function normalizeConfig(domainId, raw) {
  const id = cacheKey(domainId);
  const items = {};
  for (const [name, item] of Object.entries(raw?.items || {})) {
    if (!name) continue;
    items[name] = {
      area: normalizeArea(item.area),
      order: Number.isFinite(Number(item.order)) ? Number(item.order) : 1000,
      title: sanitizeTitle(item.title),
    };
  }
  return {
    _id: id,
    domainId: id,
    items,
    updatedAt: raw?.updatedAt,
    updatedBy: raw?.updatedBy,
  };
}

function rememberConfig(config) {
  if (config?.domainId) configCache.set(config.domainId, config);
  return config;
}

async function getConfig(domainId) {
  const id = cacheKey(domainId);
  const raw = await collConfig.findOne({ _id: id });
  return rememberConfig(normalizeConfig(id, raw));
}

async function warmConfigCache() {
  const rows = await collConfig.find({}).toArray();
  for (const raw of rows || []) rememberConfig(normalizeConfig(raw?.domainId || raw?._id, raw));
}

function virtualNavStore() {
  global.Hydro ||= {};
  global.Hydro[VIRTUAL_NAV_STORE] ||= new Map();
  return global.Hydro[VIRTUAL_NAV_STORE];
}

function registerVirtualNav(node) {
  if (!node?.name) return;
  virtualNavStore().set(node.name, { ...node, virtual: true });
}

function collectNavNodes(nodes) {
  const dedup = new Map();
  for (const item of nodes || []) {
    if (item?.name) dedup.set(item.name, item);
  }
  for (const item of virtualNavStore().values()) {
    if (item?.name && !dedup.has(item.name)) dedup.set(item.name, item);
  }
  return Array.from(dedup.values());
}

function staticArgs(item) {
  return typeof item?.args === 'function' ? {} : item?.args || {};
}

function defaultArea(name, item) {
  const args = staticArgs(item);
  const preferredArea = item?.domainNavDefaultArea || args.domainNavDefaultArea;
  if (AREAS.has(preferredArea)) return preferredArea;
  if (DEFAULT_MORE.includes(name)) return 'more';
  return 'main';
}

function defaultOrder(name, index = 0) {
  const mainIndex = DEFAULT_MAIN.indexOf(name);
  if (mainIndex >= 0) return (mainIndex + 1) * 10;
  const moreIndex = DEFAULT_MORE.indexOf(name);
  if (moreIndex >= 0) return (moreIndex + 1) * 10;
  return 1000 + index * 10;
}

function nodeMeta(item, config, index) {
  const itemConfig = config?.items?.[item.name] || {};
  let area = normalizeArea(itemConfig.area || defaultArea(item.name, item));
  if (PROMOTE_TO_MAIN.has(item.name) && area !== 'hidden') area = 'main';
  if (FORCE_TO_MORE.has(item.name) && area !== 'hidden') area = 'more';
  return {
    area,
    order: Number.isFinite(Number(itemConfig.order)) ? Number(itemConfig.order) : defaultOrder(item.name, index),
    title: sanitizeTitle(itemConfig.title),
  };
}

function decorateNode(item, meta) {
  if (!meta.title) return item;
  return { ...item, displayName: meta.title };
}

function visibleNodes(nodes, handler) {
  return (nodes || []).filter((item) => {
    try {
      return !item?.checker || item.checker(handler);
    } catch (e) {
      return false;
    }
  });
}

function getNavConfig(handler) {
  const domainId = domainIdOf(handler);
  const contextConfig = handler?.UiContext?.domainNavManager;
  if (contextConfig && cacheKey(contextConfig.domainId || contextConfig._id) === domainId) return contextConfig;
  return configCache.get(domainId) || normalizeConfig(domainId, null);
}

function splitNodes(nodes, handler, targetArea) {
  const config = getNavConfig(handler);
  return visibleNodes(collectNavNodes(nodes), handler)
    .map((item, index) => {
      const meta = nodeMeta(item, config, index);
      return { item: decorateNode(item, meta), meta, index };
    })
    .filter(({ meta }) => meta.area === targetArea)
    .sort((a, b) => a.meta.order - b.meta.order || a.index - b.index)
    .map(({ item }) => item);
}

function navArgs(item, handler) {
  try {
    const args = typeof item?.args === 'function' ? item.args(handler) : item?.args;
    return args && typeof args === 'object' ? args : {};
  } catch (e) {
    return {};
  }
}

function activePrefix(item, handler) {
  const args = navArgs(item, handler);
  return args.prefix || item?.args?.prefix || item?.name;
}

function pagePrefixVariants(prefix) {
  const value = String(prefix || '').trim();
  if (!value) return [];
  return Array.from(new Set([
    value,
    value.replace(/-/g, '_'),
    value.replace(/_/g, '-'),
  ]));
}

function isActivePage(item, pageName, handler) {
  const page = String(pageName || '');
  return pagePrefixVariants(activePrefix(item, handler)).some((prefix) => (
    page === prefix
    || page.startsWith(`${prefix}_`)
    || page.startsWith(`${prefix}-`)
    || page.startsWith(`${prefix}.`)
  ));
}

function hasActive(nodes, pageName, handler) {
  return (nodes || []).some((item) => isActivePage(item, pageName, handler));
}

async function attachNavConfig(handler) {
  const domainId = domainIdOf(handler);
  const contextConfig = handler?.UiContext?.domainNavManager;
  let config = contextConfig;
  if (!config || cacheKey(config.domainId || config._id) !== domainId) config = await getConfig(domainId);
  handler.UiContext ||= {};
  handler.UiContext.domainNavManager = config;
}

async function apply(ctx) {
  await warmConfigCache();

  ctx.on('handler/create/http', attachNavConfig);
  ctx.on('handler/before', attachNavConfig);

  global.Hydro ||= {};
  global.Hydro.model ||= {};
  const previous = global.Hydro.model.domainNavManager || {};
  global.Hydro.model.domainNavManager = {
    ...previous,
    PLUGIN_ID,
    registerVirtualNav: previous.registerVirtualNav || registerVirtualNav,
    splitNodes,
    isActive: isActivePage,
    hasActive,
    getConfig: getNavConfig,
  };

  ctx.i18n.load('zh', {
    domain_nav_render_fix: '导航渲染修复',
  });
  ctx.i18n.load('en', {
    domain_nav_render_fix: 'Navigation Render Fix',
  });
}

module.exports = { apply };
