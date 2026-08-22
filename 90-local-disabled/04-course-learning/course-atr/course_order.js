'use strict';

function asId(value) {
  return String(value && typeof value.toString === 'function' ? value.toString() : value);
}

function parseOrder(value) {
  const seen = new Set();
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function parsePids(value) {
  const seen = new Set();
  const items = Array.isArray(value)
    ? value
    : String(value || '').split(/[,，\s]+/);
  return items
    .map((item) => Number(String(item).trim().replace(/^P/i, '')))
    .filter((item) => Number.isInteger(item) && item > 0)
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function pinFor(total, index) {
  return (total - index) * 1000;
}

function sortByPinDesc(a, b) {
  const ap = typeof a.pin === 'number' ? a.pin : Number.MIN_SAFE_INTEGER;
  const bp = typeof b.pin === 'number' ? b.pin : Number.MIN_SAFE_INTEGER;
  if (ap !== bp) return bp - ap;
  return asId(b._id || b.docId).localeCompare(asId(a._id || a.docId));
}

function getProblemFromDict(pdict, pid) {
  if (!pdict) return null;
  return pdict[pid] || pdict[String(pid)] || null;
}

function getProblemDisplayPid(pdoc, pid) {
  if (pdoc && pdoc.pid) return String(pdoc.pid);
  return String(pid);
}

function getProblemOrderItems(pids, pdict) {
  return pids.map((pid) => {
    const docId = Number(pid);
    const pdoc = getProblemFromDict(pdict, docId);
    return {
      docId,
      displayPid: getProblemDisplayPid(pdoc, docId),
      title: pdoc && pdoc.title ? pdoc.title : '',
      difficulty: pdoc && pdoc.difficulty ? pdoc.difficulty : '',
      hidden: !!(pdoc && pdoc.hidden),
      missing: !pdoc,
    };
  });
}

function decorateMethod(target, key, decorators) {
  let descriptor = Object.getOwnPropertyDescriptor(target, key);
  for (let i = decorators.length - 1; i >= 0; i--) {
    descriptor = decorators[i](target, key, descriptor) || descriptor;
  }
  Object.defineProperty(target, key, descriptor);
}

function orderedByIds(items, ids, getId, Hydro, field) {
  const map = new Map();
  for (const item of items) map.set(asId(getId(item)), item);

  const result = [];
  for (const id of ids) {
    const item = map.get(asId(id));
    if (!item) throw new Hydro.ValidationError(field || 'order', null, '排序数据包含不存在的项目。');
    result.push(item);
    map.delete(asId(id));
  }

  for (const item of map.values()) result.push(item);
  return result;
}

async function requireCourse(domainId, cid, CourseModel, Hydro) {
  const cdoc = await CourseModel.get(domainId, cid);
  if (!cdoc) throw new Hydro.NotFoundError('课程不存在。');
  return cdoc;
}

async function requireSection(domainId, cid, csid, CourseModel, Hydro) {
  const cdoc = await requireCourse(domainId, cid, CourseModel, Hydro);
  const csdoc = await CourseModel.getSection(domainId, csid);
  if (!csdoc || asId(csdoc.parentId) !== asId(cid)) throw new Hydro.NotFoundError('章节不存在。');
  return [cdoc, csdoc];
}

async function requireSubsection(domainId, cid, csid, ssid, CourseModel, Hydro) {
  const docs = await requireSection(domainId, cid, csid, CourseModel, Hydro);
  let ssdoc;
  try {
    ssdoc = (await CourseModel.getSubSection(domainId, csid, ssid))[1];
  } catch (e) {
    throw new Hydro.NotFoundError('小节不存在。');
  }
  if (!ssdoc) throw new Hydro.NotFoundError('小节不存在。');
  return [docs[0], docs[1], ssdoc];
}

exports.apply = function apply(ctx, CourseModel, Hydro) {
  if (!CourseModel || !Hydro) throw new Error('course_order requires CourseModel and Hydro API');

  class CourseOrderHandler extends Hydro.Handler {
    async get({ domainId }) {
      this.checkPerm(Hydro.PERM.PERM_EDIT_TRAINING);
      const cdocs = await CourseModel.getMulti(domainId, {}).toArray();
      this.response.template = 'course_order.html';
      this.response.body = { page_name: 'course_order', cdocs };
    }

    async post({ domainId }, order = '') {
      this.checkPerm(Hydro.PERM.PERM_EDIT_TRAINING);
      const cdocs = await CourseModel.getMulti(domainId, {}).toArray();
      const ordered = orderedByIds(cdocs, parseOrder(order), (item) => item.docId, Hydro, 'order');
      await Promise.all(ordered.map((item, index) => (
        CourseModel.edit(domainId, item.docId, { pin: pinFor(ordered.length, index) })
      )));
      this.response.redirect = this.url('course_order');
    }
  }

  decorateMethod(CourseOrderHandler.prototype, 'post', [
    Hydro.param('order', Hydro.Types.Content, true),
  ]);

  class SectionOrderHandler extends Hydro.Handler {
    async get({ domainId }, cid) {
      this.checkPerm(Hydro.PERM.PERM_EDIT_TRAINING);
      const cdoc = await requireCourse(domainId, cid, CourseModel, Hydro);
      const csdocs = await CourseModel.getMultiSection(domainId, cid).toArray();
      this.response.template = 'course_section_order.html';
      this.response.body = { page_name: 'course_section_order', cdoc, csdocs };
    }

    async post({ domainId }, cid, order = '') {
      this.checkPerm(Hydro.PERM.PERM_EDIT_TRAINING);
      await requireCourse(domainId, cid, CourseModel, Hydro);
      const csdocs = await CourseModel.getMultiSection(domainId, cid).toArray();
      const ordered = orderedByIds(csdocs, parseOrder(order), (item) => item.docId, Hydro, 'order');
      await Promise.all(ordered.map((item, index) => (
        CourseModel.editSection(domainId, item.docId, { pin: pinFor(ordered.length, index) })
      )));
      this.response.redirect = this.url('course_detail', { cid });
    }
  }

  decorateMethod(SectionOrderHandler.prototype, 'get', [
    Hydro.param('cid', Hydro.Types.ObjectId),
  ]);
  decorateMethod(SectionOrderHandler.prototype, 'post', [
    Hydro.param('cid', Hydro.Types.ObjectId),
    Hydro.param('order', Hydro.Types.Content, true),
  ]);

  class SubsectionOrderHandler extends Hydro.Handler {
    async get({ domainId }, cid, csid) {
      this.checkPerm(Hydro.PERM.PERM_EDIT_TRAINING);
      const docs = await requireSection(domainId, cid, csid, CourseModel, Hydro);
      const nodes = [...(docs[1].dag || [])].sort(sortByPinDesc);
      this.response.template = 'course_subsec_order.html';
      this.response.body = {
        page_name: 'course_subsec_order',
        cdoc: docs[0],
        csdoc: docs[1],
        nodes,
      };
    }

    async post({ domainId }, cid, csid, order = '') {
      this.checkPerm(Hydro.PERM.PERM_EDIT_TRAINING);
      const docs = await requireSection(domainId, cid, csid, CourseModel, Hydro);
      const nodes = [...(docs[1].dag || [])].sort(sortByPinDesc);
      const ordered = orderedByIds(nodes, parseOrder(order), (item) => item._id, Hydro, 'order');
      await Promise.all(ordered.map((item, index) => (
        CourseModel.editSubSection(domainId, csid, item._id, { pin: pinFor(ordered.length, index) })
      )));
      this.response.redirect = this.url('course_section_detail', { cid, csid });
    }
  }

  decorateMethod(SubsectionOrderHandler.prototype, 'get', [
    Hydro.param('cid', Hydro.Types.ObjectId),
    Hydro.param('csid', Hydro.Types.ObjectId),
  ]);
  decorateMethod(SubsectionOrderHandler.prototype, 'post', [
    Hydro.param('cid', Hydro.Types.ObjectId),
    Hydro.param('csid', Hydro.Types.ObjectId),
    Hydro.param('order', Hydro.Types.Content, true),
  ]);

  class ProblemOrderHandler extends Hydro.Handler {
    async get({ domainId }, cid, csid, ssid) {
      this.checkPerm(Hydro.PERM.PERM_EDIT_TRAINING);
      const docs = await requireSubsection(domainId, cid, csid, ssid, CourseModel, Hydro);
      const pids = Array.isArray(docs[2].pids) ? docs[2].pids : [];
      const canView = this.user.hasPerm(Hydro.PERM.PERM_VIEW_PROBLEM_HIDDEN) || this.user._id;
      const pdict = pids.length ? await Hydro.ProblemModel.getList(domainId, pids, canView, true) : {};
      this.response.template = 'course_problem_order.html';
      this.response.body = {
        page_name: 'course_problem_order',
        cdoc: docs[0],
        csdoc: docs[1],
        ssdoc: docs[2],
        problemItems: getProblemOrderItems(pids, pdict),
      };
    }

    async post({ domainId }, cid, csid, ssid, order = '') {
      this.checkPerm(Hydro.PERM.PERM_EDIT_TRAINING);
      const docs = await requireSubsection(domainId, cid, csid, ssid, CourseModel, Hydro);
      const oldPids = Array.isArray(docs[2].pids) ? docs[2].pids.map(Number).filter(Boolean) : [];
      const oldSet = new Set(oldPids);
      const newPids = parsePids(order);
      if (newPids.length !== oldPids.length) throw new Hydro.ValidationError('order', null, '排序数据需要包含本小节全部题目。');
      for (const pid of newPids) {
        if (!oldSet.has(pid)) throw new Hydro.ValidationError('order', null, '排序数据包含不存在的题目。');
      }
      await CourseModel.editSubSection(domainId, csid, ssid, { pids: newPids });
      this.response.redirect = this.url('course_subsec_detail', { cid, csid, ssid });
    }
  }

  decorateMethod(ProblemOrderHandler.prototype, 'get', [
    Hydro.param('cid', Hydro.Types.ObjectId),
    Hydro.param('csid', Hydro.Types.ObjectId),
    Hydro.param('ssid', Hydro.Types.ObjectId),
  ]);
  decorateMethod(ProblemOrderHandler.prototype, 'post', [
    Hydro.param('cid', Hydro.Types.ObjectId),
    Hydro.param('csid', Hydro.Types.ObjectId),
    Hydro.param('ssid', Hydro.Types.ObjectId),
    Hydro.param('order', Hydro.Types.Content, true),
  ]);

  ctx.Route('course_order', '/course/order', CourseOrderHandler, Hydro.PERM.PERM_EDIT_TRAINING);
  ctx.Route('course_section_order', '/course/:cid/order', SectionOrderHandler, Hydro.PERM.PERM_EDIT_TRAINING);
  ctx.Route('course_subsec_order', '/course/:cid/s/:csid/order', SubsectionOrderHandler, Hydro.PERM.PERM_EDIT_TRAINING);
  ctx.Route('course_problem_order', '/course/:cid/s/:csid/:ssid/problem-order', ProblemOrderHandler, Hydro.PERM.PERM_EDIT_TRAINING);
  ctx.i18n.load('zh', {
    course_order: '调整课程顺序',
    course_section_order: '调整章节顺序',
    course_subsec_order: '调整小节顺序',
    course_problem_order: '调整题目顺序',
  });
  ctx.i18n.load('en', {
    course_order: 'Adjust Course Order',
    course_section_order: 'Adjust Section Order',
    course_subsec_order: 'Adjust Subsection Order',
    course_problem_order: 'Adjust Problem Order',
  });
};
