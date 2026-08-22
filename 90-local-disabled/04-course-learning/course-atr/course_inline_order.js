'use strict';

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function asId(value) {
  return String(value && typeof value.toString === 'function' ? value.toString() : value);
}

function toObjectId(Hydro, body, name) {
  const value = first(body[name]);
  if (!value) throw new Hydro.ValidationError(name, null, `${name} is required.`);
  try {
    return value instanceof Hydro.ObjectId ? value : new Hydro.ObjectId(String(value));
  } catch (e) {
    throw new Hydro.ValidationError(name, value, `${name} is invalid.`);
  }
}

function toPositiveInt(Hydro, body, name) {
  const value = Number(first(body[name]));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Hydro.ValidationError(name, first(body[name]), `${name} is invalid.`);
  }
  return value;
}

function directionOf(Hydro, body) {
  const direction = String(first(body.direction) || '');
  if (direction !== 'up' && direction !== 'down') {
    throw new Hydro.ValidationError('direction', direction, 'Invalid move direction.');
  }
  return direction;
}

function pinFor(total, index) {
  return (total - index) * 1000;
}

function sortByPin(left, right) {
  const lpin = typeof left.pin === 'number' ? left.pin : Number.MIN_SAFE_INTEGER;
  const rpin = typeof right.pin === 'number' ? right.pin : Number.MIN_SAFE_INTEGER;
  if (lpin !== rpin) return rpin - lpin;
  return asId(right._id || right.docId).localeCompare(asId(left._id || left.docId));
}

function swapOrdered(Hydro, items, target, direction, getId) {
  const wanted = asId(target);
  const current = items.findIndex((item) => asId(getId(item)) === wanted);
  if (current < 0) throw new Hydro.ValidationError('target', target, 'Target item not found.');
  const next = direction === 'up' ? current - 1 : current + 1;
  if (next < 0 || next >= items.length) return null;
  const ordered = items.slice();
  [ordered[current], ordered[next]] = [ordered[next], ordered[current]];
  return ordered;
}

async function requireCourse(Hydro, CourseModel, domainId, cid) {
  const cdoc = await CourseModel.get(domainId, cid);
  if (!cdoc) throw new Hydro.NotFoundError('Course not found.');
  return cdoc;
}

async function requireSection(Hydro, CourseModel, domainId, cid, csid) {
  await requireCourse(Hydro, CourseModel, domainId, cid);
  const csdoc = await CourseModel.getSection(domainId, csid);
  if (!csdoc || asId(csdoc.parentId) !== asId(cid)) {
    throw new Hydro.NotFoundError('Section not found.');
  }
  return csdoc;
}

async function requireSubsection(Hydro, CourseModel, domainId, cid, csid, ssid) {
  await requireSection(Hydro, CourseModel, domainId, cid, csid);
  let result;
  try {
    result = await CourseModel.getSubSection(domainId, csid, ssid);
  } catch (e) {
    throw new Hydro.NotFoundError('Subsection not found.');
  }
  const ssdoc = result && result[1];
  if (!ssdoc) throw new Hydro.NotFoundError('Subsection not found.');
  return ssdoc;
}

function back(handler) {
  if (typeof handler.back === 'function') return handler.back();
  handler.response.redirect = handler.request.headers.referer || '/';
}

function apply(ctx, CourseModel, Hydro) {
  class CourseInlineOrderActionHandler extends Hydro.Handler {
    async post({ domainId }) {
      this.checkPerm(Hydro.PERM.PERM_EDIT_DOMAIN);

      const body = this.request.body || {};
      const kind = String(first(body.kind) || '');
      const direction = directionOf(Hydro, body);

      if (kind === 'course') {
        const target = toObjectId(Hydro, body, 'target');
        const courses = await CourseModel.getMulti(domainId, {}).toArray();
        const ordered = swapOrdered(Hydro, courses, target, direction, (item) => item.docId);
        if (ordered) {
          await Promise.all(ordered.map((item, index) => (
            CourseModel.edit(domainId, item.docId, { pin: pinFor(ordered.length, index) })
          )));
        }
        return back(this);
      }

      if (kind === 'section') {
        const cid = toObjectId(Hydro, body, 'cid');
        const target = toObjectId(Hydro, body, 'target');
        await requireCourse(Hydro, CourseModel, domainId, cid);
        const sections = await CourseModel.getMultiSection(domainId, cid).toArray();
        const ordered = swapOrdered(Hydro, sections, target, direction, (item) => item.docId);
        if (ordered) {
          await Promise.all(ordered.map((item, index) => (
            CourseModel.editSection(domainId, item.docId, { pin: pinFor(ordered.length, index) })
          )));
        }
        return back(this);
      }

      if (kind === 'subsec') {
        const cid = toObjectId(Hydro, body, 'cid');
        const csid = toObjectId(Hydro, body, 'csid');
        const target = toObjectId(Hydro, body, 'target');
        const csdoc = await requireSection(Hydro, CourseModel, domainId, cid, csid);
        const nodes = [...(csdoc.dag || [])].sort(sortByPin);
        const ordered = swapOrdered(Hydro, nodes, target, direction, (item) => item._id);
        if (ordered) {
          await Promise.all(ordered.map((item, index) => (
            CourseModel.editSubSection(domainId, csid, item._id, { pin: pinFor(ordered.length, index) })
          )));
        }
        return back(this);
      }

      if (kind === 'problem') {
        const cid = toObjectId(Hydro, body, 'cid');
        const csid = toObjectId(Hydro, body, 'csid');
        const ssid = toObjectId(Hydro, body, 'ssid');
        const target = toPositiveInt(Hydro, body, 'target');
        const ssdoc = await requireSubsection(Hydro, CourseModel, domainId, cid, csid, ssid);
        const pids = Array.isArray(ssdoc.pids)
          ? ssdoc.pids.map((pid) => Number(pid)).filter((pid) => Number.isInteger(pid) && pid > 0)
          : [];
        const ordered = swapOrdered(Hydro, pids, target, direction, (item) => item);
        if (ordered) await CourseModel.editSubSection(domainId, csid, ssid, { pids: ordered });
        return back(this);
      }

      throw new Hydro.ValidationError('kind', kind, 'Invalid order target.');
    }
  }

  ctx.Route(
    'course_inline_order_action',
    '/course-atr/order-action',
    CourseInlineOrderActionHandler,
    Hydro.PERM.PERM_EDIT_DOMAIN,
  );
  ctx.i18n.load('zh', { course_inline_order_action: '\u8bfe\u7a0b\u987a\u5e8f\u8c03\u6574' });
  ctx.i18n.load('en', { course_inline_order_action: 'Course Order Action' });
}

module.exports = { apply };
