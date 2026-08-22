import {
  $, addPage, i18n, NamedPage, Notification, ProblemSelectAutoComplete, request
} from '@hydrooj/ui-default';

interface ProblemSearchItem {
  docId: number;
  pid: string;
  title: string;
  difficulty: string;
  tag: string[];
  hidden: boolean;
  nSubmit: number;
  nAccept: number;
}

interface ProblemSearchResponse {
  page: number;
  pcount: number;
  count: number;
  items: ProblemSearchItem[];
}

function escapeHtml(value: any) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parsePids(value: any) {
  return Array.from(new Set(String(value || '')
    .split(/[,，\s]+/)
    .map((item) => Number(item.trim().replace(/^P/i, '')))
    .filter((item) => Number.isInteger(item) && item > 0)));
}

function sortPidsByProblemMeta(pids: number[], problemMeta = new Map<number, ProblemSearchItem>()) {
  return Array.from(new Set(pids))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .sort((a, b) => {
      const aMeta = problemMeta.get(a);
      const bMeta = problemMeta.get(b);
      const aText = aMeta ? displayPid(aMeta) : String(a);
      const bText = bMeta ? displayPid(bMeta) : String(b);
      const byPid = aText.localeCompare(bText, 'zh-Hans-CN', {
        numeric: true,
        sensitivity: 'base',
      });
      if (byPid) return byPid;
      return a - b;
    });
}

function writePids($input: JQuery, pids: number[], problemMeta = new Map<number, ProblemSearchItem>()) {
  const ordered = Array.from(new Set(pids))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  $input.val(ordered.join(', ')).trigger('change');
}

function buildQuery($picker: JQuery, page: number) {
  const params = new URLSearchParams();
  params.set('page', String(page));
  const q = String($picker.find('[data-problem-search-q]').val() || '').trim();
  const tags = String($picker.find('[data-problem-search-tags]').val() || '').trim();
  const difficulty = String($picker.find('[data-problem-search-difficulty]').val() || '').trim();
  if (q) params.set('q', q);
  if (tags) params.set('tags', tags);
  if (difficulty) params.set('difficulty', difficulty);
  return params.toString();
}

function renderTags(tags: string[]) {
  if (!tags?.length) return '';
  return `<div>${tags.map((tag) => `<span class="course-package-problem-picker__tag">${escapeHtml(tag)}</span>`).join('')}</div>`;
}

function displayPid(item: ProblemSearchItem) {
  return String(item.pid || item.docId);
}

function compareProblemPid(a: ProblemSearchItem, b: ProblemSearchItem) {
  const byPid = displayPid(a).localeCompare(displayPid(b), 'zh-Hans-CN', {
    numeric: true,
    sensitivity: 'base',
  });
  if (byPid) return byPid;
  return Number(a.docId) - Number(b.docId);
}

function renderResults($picker: JQuery, items: ProblemSearchItem[], selected: Set<number>) {
  const $results = $picker.find('[data-problem-search-results]');
  const problemUrlTemplate = String($picker.data('problemUrlTemplate') || 'p/__pid__');
  if (!items.length) {
    $results.html(`<tr><td colspan="5">${escapeHtml(i18n('No results'))}</td></tr>`);
    return;
  }
  $results.html(items.map((item) => {
    const docId = Number(item.docId);
    const checked = selected.has(docId) ? 'checked' : '';
    const title = `${escapeHtml(item.title)}${item.hidden ? ` <span class="course-package-problem-picker__tag">${escapeHtml(i18n('Hidden'))}</span>` : ''}`;
    const problemUrl = problemUrlTemplate.replace('__pid__', String(docId));
    return `<tr>
      <td><input type="checkbox" data-problem-search-check value="${docId}" ${checked}></td>
      <td>${escapeHtml(displayPid(item))}</td>
      <td><a href="${escapeHtml(problemUrl)}" target="_blank">${title}</a>${renderTags(item.tag)}</td>
      <td>${escapeHtml(item.difficulty || '-')}</td>
      <td>${escapeHtml(item.nAccept || 0)} / ${escapeHtml(item.nSubmit || 0)}</td>
    </tr>`;
  }).join(''));
  $picker.find('[data-problem-search-check-all]').prop(
    'checked',
    items.length > 0 && items.every((item) => selected.has(Number(item.docId))),
  );
}

function updateSelectedCount($picker: JQuery, $pids: JQuery) {
  $picker.find('[data-problem-selected-count]').text(String(parsePids($pids.val()).length));
}

function initBatchProblemPicker($pids: JQuery) {
  const $picker = $('.course-package-problem-picker');
  if (!$picker.length || $picker.data('coursePackageProblemPickerReady')) return;
  $picker.data('coursePackageProblemPickerReady', true);

  let page = 1;
  let pcount = 1;
  let currentItems: ProblemSearchItem[] = [];
  const checked = new Set<number>();
  const problemMeta = new Map<number, ProblemSearchItem>();
  const searchUrl = String($picker.data('searchUrl') || '');

  const rememberItems = (items: ProblemSearchItem[]) => {
    items.forEach((item) => {
      const docId = Number(item.docId);
      if (Number.isInteger(docId) && docId > 0) problemMeta.set(docId, item);
    });
  };

  const syncPager = () => {
    $picker.find('[data-problem-search-page]').text(`${page} / ${pcount || 1}`);
    $picker.find('[data-problem-search-prev]').prop('disabled', page <= 1);
    $picker.find('[data-problem-search-next]').prop('disabled', page >= pcount);
  };

  const search = async (nextPage = 1) => {
    if (!searchUrl) return;
    page = nextPage;
    $picker.find('[data-problem-search-results]').html(`<tr><td colspan="5">${escapeHtml(i18n('Loading...'))}</td></tr>`);
    try {
      const data = await request.get(`${searchUrl}?${buildQuery($picker, page)}`) as ProblemSearchResponse;
      currentItems = (data.items || []).slice().sort(compareProblemPid);
      rememberItems(currentItems);
      page = data.page || page;
      pcount = data.pcount || 1;
      $picker.find('[data-problem-search-count]').text(data.count ? ` / ${data.count} ${i18n('results')}` : '');
      renderResults($picker, currentItems, checked);
      syncPager();
    } catch (error: any) {
      Notification.error(error.message || String(error));
      $picker.find('[data-problem-search-results]').html(`<tr><td colspan="5">${escapeHtml(i18n('Search failed'))}</td></tr>`);
    }
  };

  $picker.find('[data-problem-search-submit]').on('click', () => search(1));
  $picker.find('[data-problem-search-q], [data-problem-search-tags], [data-problem-search-difficulty]').on('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      search(1);
    }
  });
  $picker.find('[data-problem-search-prev]').on('click', () => {
    if (page > 1) search(page - 1);
  });
  $picker.find('[data-problem-search-next]').on('click', () => {
    if (page < pcount) search(page + 1);
  });
  $picker.find('[data-problem-search-check-all]').on('change', (ev) => {
    const select = Boolean((ev.currentTarget as HTMLInputElement).checked);
    currentItems.forEach((item) => {
      const docId = Number(item.docId);
      if (select) checked.add(docId);
      else checked.delete(docId);
    });
    renderResults($picker, currentItems, checked);
    $picker.find('[data-problem-search-check-all]').prop('checked', select);
  });
  $picker.on('change', '[data-problem-search-check]', (ev) => {
    const docId = Number((ev.currentTarget as HTMLInputElement).value);
    const item = currentItems.find((current) => Number(current.docId) === docId);
    if (item) problemMeta.set(docId, item);
    if ((ev.currentTarget as HTMLInputElement).checked) checked.add(docId);
    else checked.delete(docId);
  });
  $picker.find('[data-problem-search-add]').on('click', () => {
    if (!checked.size) {
      Notification.warn(i18n('Please select at least one problem.'));
      return;
    }
    const pids = parsePids($pids.val());
    checked.forEach((pid) => {
      if (!pids.includes(pid)) pids.push(pid);
    });
    writePids($pids, pids, problemMeta);
    updateSelectedCount($picker, $pids);
    Notification.success(i18n('Problems added.'));
  });
  $pids.closest('form').on('submit', () => {
    writePids($pids, parsePids($pids.val()), problemMeta);
  });
  $pids.on('change keyup', () => updateSelectedCount($picker, $pids));
  updateSelectedCount($picker, $pids);
  syncPager();
}

addPage(new NamedPage(['course_package_lesson_create', 'course_package_lesson_edit'], () => {
  const $pids = $('[name="pids"]');
  ProblemSelectAutoComplete.getOrConstruct($pids, {
    multi: true,
    clearDefaultValue: false,
  });
  initBatchProblemPicker($pids);
}));
