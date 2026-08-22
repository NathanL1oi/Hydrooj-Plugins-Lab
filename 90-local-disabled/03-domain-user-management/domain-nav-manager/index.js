'use strict';

const {
  Handler, PERM, db,
} = require('hydrooj');

const PLUGIN_ID = 'domain-nav-manager';
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
const PROMOTE_TO_MAIN = new Set([
  'course_main',
]);
const FORCE_TO_MORE = new Set([
  'manage_dashboard',
]);
const AREA_RANK = {
  main: 0,
  more: 1,
  hidden: 2,
};

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

function virtualNavStore() {
  global.Hydro ||= {};
  global.Hydro[VIRTUAL_NAV_STORE] ||= new Map();
  return global.Hydro[VIRTUAL_NAV_STORE];
}

function registerVirtualNav(node) {
  if (!node?.name) return;
  virtualNavStore().set(node.name, {
    ...node,
    virtual: true,
  });
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

function sanitizeTitle(value) {
  const title = String(value || '').trim();
  return title.slice(0, 32);
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

function forgetConfig(domainId) {
  configCache.delete(cacheKey(domainId));
}

function getCachedConfig(domainId) {
  return configCache.get(cacheKey(domainId));
}

async function getConfig(domainId) {
  const id = cacheKey(domainId);
  const raw = await collConfig.findOne({ _id: id });
  return rememberConfig(normalizeConfig(id, raw));
}

async function warmConfigCache() {
  const rows = await collConfig.find({}).toArray();
  for (const raw of rows || []) {
    rememberConfig(normalizeConfig(raw?.domainId || raw?._id, raw));
  }
}

function visibleNodes(nodes, handler) {
  return (nodes || []).filter((item) => {
    try {
      return item?.checker?.(handler);
    } catch (e) {
      return false;
    }
  });
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
  return {
    ...item,
    displayName: meta.title,
  };
}

function getNavConfig(handler) {
  const domainId = domainIdOf(handler);
  const contextConfig = handler?.UiContext?.domainNavManager;
  if (contextConfig && cacheKey(contextConfig.domainId || contextConfig._id) === domainId) return contextConfig;
  return getCachedConfig(domainId) || normalizeConfig(domainId, null);
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

function navQuery(args, handler) {
  try {
    const query = args?.query;
    if (typeof query === 'function') return query(handler) || {};
    return query || {};
  } catch (e) {
    return {};
  }
}

function appendQuery(url, query) {
  const entries = Object.entries(query || {}).filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (!entries.length) return url;
  const search = entries.map(([key, value]) => (
    Array.isArray(value)
      ? value.map((item) => `${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`).join('&')
      : `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`
  )).filter(Boolean).join('&');
  if (!search) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${search}`;
}

function navHref(item, handler) {
  try {
    const args = navArgs(item, handler);
    return appendQuery(handler.url(item.name, args), navQuery(args, handler));
  } catch (e) {
    return '';
  }
}

function clientNode(item, handler) {
  const args = navArgs(item, handler);
  const href = navHref(item, handler);
  if (!href) return null;
  return {
    name: item.name,
    displayName: item.displayName || item.name,
    href,
    prefix: args.prefix || item.name,
  };
}

function clientNavConfig(handler, config) {
  const nodes = collectNavNodes(global.Hydro?.ui?.getNodes?.('Nav') || []);
  handler.UiContext ||= {};
  handler.UiContext.domainNavManager = config;
  const main = splitNodes(nodes, handler, 'main').map((item) => clientNode(item, handler)).filter(Boolean);
  const more = splitNodes(nodes, handler, 'more').map((item) => clientNode(item, handler)).filter(Boolean);
  return {
    domainId: config.domainId,
    items: config.items,
    main,
    more,
  };
}

function activePrefix(item) {
  const args = item?.args || {};
  return args.prefix || item.name;
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

function isActivePage(item, pageName) {
  const page = String(pageName || '');
  return pagePrefixVariants(activePrefix(item)).some((prefix) => (
    page === prefix
    || page.startsWith(`${prefix}_`)
    || page.startsWith(`${prefix}-`)
    || page.startsWith(`${prefix}.`)
  ));
}

function hasActive(nodes, pageName) {
  return (nodes || []).some((item) => isActivePage(item, pageName));
}

function allNavRows(config) {
  const nodes = collectNavNodes(global.Hydro?.ui?.getNodes?.('Nav') || []);
  return nodes.map((item, index) => {
    const meta = nodeMeta(item, config, index);
    return {
      name: item.name,
      displayName: item.displayName || item.name,
      area: meta.area,
      order: meta.order,
      title: meta.title,
      defaultArea: defaultArea(item.name, item),
      defaultOrder: defaultOrder(item.name, index),
      sourceIndex: index,
    };
  }).sort((a, b) => (
    AREA_RANK[a.area] - AREA_RANK[b.area]
    || a.order - b.order
    || a.sourceIndex - b.sourceIndex
  ));
}

function parseRowsFromBody(body) {
  const count = Math.max(0, Math.min(500, Number(body.count) || 0));
  const rows = [];
  for (let i = 0; i < count; i++) {
    const name = String(body[`name_${i}`] || '').trim();
    if (!name) continue;
    rows.push({
      name,
      area: normalizeArea(body[`area_${i}`]),
      title: sanitizeTitle(body[`title_${i}`]),
    });
  }
  return rows;
}

function swapWithinArea(rows, index, direction) {
  const current = rows[index];
  if (!current) return rows;
  const next = [...rows];
  for (let i = index + direction; i >= 0 && i < rows.length; i += direction) {
    if (rows[i]?.area !== current.area) continue;
    [next[index], next[i]] = [next[i], next[index]];
    return next;
  }
  return rows;
}

function rowsToItems(rows) {
  const counters = { main: 0, more: 0, hidden: 0 };
  const items = {};
  for (const row of rows) {
    counters[row.area] += 1;
    items[row.name] = {
      area: row.area,
      order: counters[row.area] * 10,
      title: row.title,
    };
  }
  return items;
}

class DomainNavManagerHandler extends Handler {
  async prepare() {
    this.checkPerm(PERM.PERM_EDIT_DOMAIN);
  }

  async get() {
    const domainId = domainIdOf(this);
    const config = await getConfig(domainId);
    this.response.template = 'domain_nav_manager.html';
    this.response.body = {
      page_name: 'domain_nav_manager',
      domainId,
      rows: allNavRows(config),
      saved: this.request.query?.saved,
    };
  }

  async post() {
    const domainId = domainIdOf(this);
    const body = this.request.body || {};
    const action = String(body.navAction || 'save');
    if (action === 'reset') {
      await collConfig.deleteOne({ _id: domainId });
      forgetConfig(domainId);
      this.response.redirect = `${this.url('domain_nav_manager')}?saved=reset`;
      return;
    }

    let rows = parseRowsFromBody(body);
    if (action.startsWith('move_up:')) {
      rows = swapWithinArea(rows, Number(action.slice('move_up:'.length)), -1);
    } else if (action.startsWith('move_down:')) {
      rows = swapWithinArea(rows, Number(action.slice('move_down:'.length)), 1);
    }
    const items = rowsToItems(rows);
    const updatedAt = new Date();
    const updatedBy = this.user?._id;

    await collConfig.updateOne(
      { _id: domainId },
      {
        $set: {
          _id: domainId,
          domainId,
          items,
          updatedAt,
          updatedBy,
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
    rememberConfig(normalizeConfig(domainId, { items, updatedAt, updatedBy }));
    this.response.redirect = `${this.url('domain_nav_manager')}?saved=1`;
  }
}

async function attachNavConfig(handler) {
  const domainId = domainIdOf(handler);
  const contextConfig = handler?.UiContext?.domainNavManager;
  let config = contextConfig;
  if (!config || cacheKey(config.domainId || config._id) !== domainId) config = await getConfig(domainId);
  handler.UiContext ||= {};
  handler.UiContext.domainNavManager = config;
  handler.UiContext.domainNavManagerClient = clientNavConfig(handler, config);
}

async function apply(ctx) {
  await db.ensureIndexes(
    collConfig,
    { key: { domainId: 1 }, name: 'domain_nav_manager_domain', unique: true },
  );
  await warmConfigCache();

  ctx.Route('domain_nav_manager', '/domain/nav-manager', DomainNavManagerHandler, PERM.PERM_EDIT_DOMAIN);
  ctx.injectUI('DomainManage', 'domain_nav_manager', { family: 'Properties', icon: 'menu' }, PERM.PERM_EDIT_DOMAIN);

  ctx.on('handler/create/http', attachNavConfig);
  ctx.on('handler/before', attachNavConfig);

  global.Hydro ||= {};
  global.Hydro.model ||= {};
  global.Hydro.model.domainNavManager = {
    PLUGIN_ID,
    registerVirtualNav,
    splitNodes,
    isActive: isActivePage,
    hasActive,
    getConfig: getNavConfig,
  };

  ctx.i18n.load('zh', {
    domain_nav_manager: '导航管理',
  });
  ctx.i18n.load('en', {
    domain_nav_manager: 'Navigation Manager',
  });
}

module.exports = { apply };
