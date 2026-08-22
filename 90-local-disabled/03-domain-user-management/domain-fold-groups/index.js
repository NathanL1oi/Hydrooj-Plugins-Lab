'use strict';

const { Handler, PRIV, db, DomainModel } = require('hydrooj');

const PLUGIN_ID = 'domain-fold-groups';
const collConfig = db.collection('home.domainFoldGroups');

function userKey(uid) {
  return String(uid || '');
}

function sanitizeTitle(value, fallback = '') {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  return (title || fallback).slice(0, 32);
}

function sanitizeDomainId(value) {
  return String(value || '')
    .trim()
    .replace(/[^\w.-]/g, '')
    .slice(0, 64);
}

function splitDomainIds(value) {
  const seen = new Set();
  const result = [];
  for (const part of String(value || '').split(/[\s,，;；、]+/)) {
    const id = sanitizeDomainId(part);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length >= 300) break;
  }
  return result;
}

function normalizeGroups(groups) {
  const result = [];
  for (const rawGroup of Array.isArray(groups) ? groups : []) {
    const title = sanitizeTitle(rawGroup?.title, '未命名分组');
    const children = [];
    const childSource = Array.isArray(rawGroup?.children) ? rawGroup.children : [];
    for (const rawChild of childSource) {
      const childTitle = sanitizeTitle(rawChild?.title, '默认');
      const domains = splitDomainIds(Array.isArray(rawChild?.domains) ? rawChild.domains.join(',') : rawChild?.domains);
      if (!domains.length) continue;
      children.push({ title: childTitle, domains });
      if (children.length >= 80) break;
    }
    if (!children.length) continue;
    result.push({ title, children });
    if (result.length >= 30) break;
  }
  return result;
}

function normalizeConfig(uid, raw) {
  return {
    _id: userKey(uid),
    uid,
    groups: normalizeGroups(raw?.groups),
    updatedAt: raw?.updatedAt,
    updatedBy: raw?.updatedBy,
  };
}

async function getConfig(uid) {
  const key = userKey(uid);
  if (!key) return normalizeConfig(uid, null);
  return normalizeConfig(uid, await collConfig.findOne({ _id: key }));
}

function groupsToAssignments(groups) {
  const assignments = new Map();
  for (const group of normalizeGroups(groups)) {
    for (const child of group.children) {
      for (const id of child.domains) {
        if (assignments.has(id)) continue;
        assignments.set(id, { group: group.title, child: child.title });
      }
    }
  }
  return assignments;
}

function assignmentsToGroups(assignments) {
  const groupMap = new Map();
  for (const item of assignments) {
    const id = sanitizeDomainId(item.id);
    const groupTitle = sanitizeTitle(item.group);
    const childTitle = sanitizeTitle(item.child, '默认');
    if (!id || !groupTitle) continue;

    if (!groupMap.has(groupTitle)) groupMap.set(groupTitle, { title: groupTitle, childMap: new Map() });
    const group = groupMap.get(groupTitle);
    if (!group.childMap.has(childTitle)) group.childMap.set(childTitle, { title: childTitle, domains: [] });
    const child = group.childMap.get(childTitle);
    if (!child.domains.includes(id)) child.domains.push(id);
  }

  const groups = [];
  for (const group of groupMap.values()) {
    const children = Array.from(group.childMap.values()).filter((child) => child.domains.length);
    if (children.length) groups.push({ title: group.title, children });
  }
  return normalizeGroups(groups);
}

function configToText(groups) {
  const lines = [];
  for (const group of normalizeGroups(groups)) {
    for (const child of group.children) {
      lines.push(`${group.title} / ${child.title}: ${child.domains.join(', ')}`);
    }
  }
  return lines.join('\n');
}

function parseConfigText(rawText) {
  const assignments = [];
  const lines = String(rawText || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const colonIndex = line.search(/[:：]/);
    if (colonIndex < 0) throw new Error(`第 ${i + 1} 行缺少冒号。`);
    const left = line.slice(0, colonIndex).trim();
    const right = line.slice(colonIndex + 1).trim();
    const parts = left.split(/[\/／>|｜]+/).map((item) => sanitizeTitle(item)).filter(Boolean);
    const group = parts[0];
    const child = parts[1] || '默认';
    if (!group) throw new Error(`第 ${i + 1} 行缺少一级分组名称。`);
    const ids = splitDomainIds(right);
    if (!ids.length) throw new Error(`第 ${i + 1} 行没有可识别的域 ID。`);
    ids.forEach((id) => assignments.push({ id, group, child }));
  }
  return assignmentsToGroups(assignments);
}

async function listMyDomains(uid) {
  const dudict = await DomainModel.getDictUserByDomainId(uid);
  const ids = Object.keys(dudict || {});
  if (!ids.length) return [];
  const docs = await DomainModel.getMulti({ _id: { $in: ids } }).sort({ _id: 1 }).toArray();
  return docs.map((ddoc) => ({
    id: ddoc._id,
    name: ddoc.name || ddoc._id,
  }));
}

function rowsForTemplate(domains, groups) {
  const assignments = groupsToAssignments(groups);
  const seen = new Set();
  const rows = domains.map((domain) => {
    seen.add(domain.id);
    const assigned = assignments.get(domain.id) || {};
    return {
      id: domain.id,
      name: domain.name,
      group: assigned.group || '',
      child: assigned.child || '',
      missing: false,
    };
  });

  for (const group of normalizeGroups(groups)) {
    for (const child of group.children) {
      for (const id of child.domains) {
        if (seen.has(id)) continue;
        seen.add(id);
        rows.push({
          id,
          name: '',
          group: group.title,
          child: child.title,
          missing: true,
        });
      }
    }
  }
  return rows;
}

function parseAssignmentsFromBody(body) {
  const count = Math.max(0, Math.min(500, Number(body.domainCount) || 0));
  const assignments = [];
  for (let i = 0; i < count; i++) {
    const id = sanitizeDomainId(body[`domain_${i}`]);
    const group = sanitizeTitle(body[`group_${i}`]);
    const child = sanitizeTitle(body[`child_${i}`], '默认');
    if (!id || !group) continue;
    assignments.push({ id, group, child });
  }

  const extra = String(body.extraRules || '').trim();
  if (extra) {
    for (const group of parseConfigText(extra)) {
      for (const child of group.children) {
        child.domains.forEach((id) => assignments.push({ id, group: group.title, child: child.title }));
      }
    }
  }
  return assignments;
}

function uniqueTitles(groups, type) {
  const result = [];
  const seen = new Set();
  for (const group of normalizeGroups(groups)) {
    if (type === 'group' && !seen.has(group.title)) {
      seen.add(group.title);
      result.push(group.title);
    }
    for (const child of group.children) {
      if (type === 'child' && !seen.has(child.title)) {
        seen.add(child.title);
        result.push(child.title);
      }
    }
  }
  return result;
}

class HomeDomainGroupsHandler extends Handler {
  async prepare() {
    this.checkPriv(PRIV.PRIV_USER_PROFILE);
  }

  async showPage(body = {}) {
    const [config, domains] = await Promise.all([
      getConfig(this.user._id),
      listMyDomains(this.user._id),
    ]);
    this.response.template = 'home_domain_groups.html';
    this.response.body = {
      page_name: 'home_domain_groups',
      rows: rowsForTemplate(domains, config.groups),
      groups: config.groups,
      groupTitles: uniqueTitles(config.groups, 'group'),
      childTitles: uniqueTitles(config.groups, 'child'),
      saved: this.request.query?.saved,
      ...body,
    };
  }

  async get() {
    await this.showPage();
  }

  async post() {
    const action = String(this.request.body?.groupAction || 'save');
    const uid = this.user._id;
    if (action === 'reset') {
      await collConfig.deleteOne({ _id: userKey(uid) });
      this.response.redirect = `${this.url('home_domain_groups')}?saved=reset`;
      return;
    }

    let groups;
    try {
      groups = assignmentsToGroups(parseAssignmentsFromBody(this.request.body || {}));
    } catch (error) {
      await this.showPage({
        parseError: error?.message || '分组配置格式有误。',
      });
      return;
    }

    await collConfig.updateOne(
      { _id: userKey(uid) },
      {
        $set: {
          _id: userKey(uid),
          uid,
          groups,
          updatedAt: new Date(),
          updatedBy: uid,
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
    this.response.redirect = `${this.url('home_domain_groups')}?saved=1`;
  }
}

async function apply(ctx) {
  await db.ensureIndexes(
    collConfig,
    { key: { uid: 1 }, name: 'domain_fold_groups_uid' },
  );

  ctx.Route('home_domain_groups', '/home/domain-groups', HomeDomainGroupsHandler, PRIV.PRIV_USER_PROFILE);

  ctx.on('handler/create/http', async (handler) => {
    const uid = handler.user?._id;
    if (!uid || uid <= 1) return;
    const config = await getConfig(uid);
    handler.UiContext ||= {};
    handler.UiContext.domainFoldGroups = {
      groups: config.groups,
      manageUrl: handler.url?.('home_domain_groups') || '/home/domain-groups',
    };
  });

  ctx.i18n.load('zh', {
    home_domain_groups: '域分组',
  });
  ctx.i18n.load('en', {
    home_domain_groups: 'Domain Groups',
  });

  global.Hydro ||= {};
  global.Hydro.model ||= {};
  global.Hydro.model.domainFoldGroups = {
    PLUGIN_ID,
    getConfig,
    parseConfigText,
    configToText,
  };
}

module.exports = { apply };
