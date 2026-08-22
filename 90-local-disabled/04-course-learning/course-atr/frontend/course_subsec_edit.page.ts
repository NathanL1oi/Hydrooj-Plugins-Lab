import {
    i18n, pjax, request, tpl, NamedPage, ConfirmDialog, Notification, ProblemSelectAutoComplete, $, addPage
} from '@hydrooj/ui-default';

interface ProblemSearchItem {
    docId: number;
    pid?: string;
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

function writePids($input: any, pids: number[], trigger = true) {
    $input.val(pids.join(', '));
    if (trigger) $input.trigger('change');
}

function displayPid(item: ProblemSearchItem) {
    return String(item.pid || item.docId).trim();
}

function problemAutocompleteText(item: any) {
    const pid = String(item?.pid || item?.docId || item || '').trim();
    const title = String(item?.title || '').trim();
    return title ? `${pid} ${title}` : pid;
}

function problemDisplayPid(pid: number, problemMeta: Map<number, ProblemSearchItem>) {
    const item = problemMeta.get(pid);
    return item ? displayPid(item) : String(pid);
}

function problemTitle(pid: number, problemMeta: Map<number, ProblemSearchItem>) {
    return String(problemMeta.get(pid)?.title || '').trim();
}

function compareByProblemPid(a: number, b: number, problemMeta: Map<number, ProblemSearchItem>) {
    const left = problemDisplayPid(a, problemMeta);
    const right = problemDisplayPid(b, problemMeta);
    return left.localeCompare(right, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }) || a - b;
}

function sortPidsByProblemPid(pids: number[], problemMeta: Map<number, ProblemSearchItem>) {
    return Array.from(new Set(pids))
        .filter((pid) => Number.isInteger(pid) && pid > 0)
        .sort((a, b) => compareByProblemPid(a, b, problemMeta));
}

function compareProblemPid(a: ProblemSearchItem, b: ProblemSearchItem) {
    const byPid = displayPid(a).localeCompare(displayPid(b), 'zh-Hans-CN', {
        numeric: true,
        sensitivity: 'base',
    });
    if (byPid) return byPid;
    return Number(a.docId) - Number(b.docId);
}

function samePids(a: number[], b: number[]) {
    return a.length === b.length && a.every((item, index) => item === b[index]);
}

async function ensureProblemMeta(searchUrl: string, problemMeta: Map<number, ProblemSearchItem>, pids: number[]) {
    const missing = pids.filter((pid) => !problemMeta.has(pid));
    if (!searchUrl || !missing.length) return;
    await Promise.all(missing.map(async (pid) => {
        try {
            const data = await request.get(`${searchUrl}?page=1&q=${encodeURIComponent(String(pid))}`) as ProblemSearchResponse;
            const item = (data.items || []).find((problem) => Number(problem.docId) === pid);
            if (item) problemMeta.set(Number(item.docId), item);
        } catch (error) {
            // Keep the editor usable even if one metadata lookup fails.
        }
    }));
}

function movePid(pids: number[], index: number, action: string) {
    if (index < 0) return pids;
    const next = pids.slice();
    const [item] = next.splice(index, 1);
    if (action === 'top') next.unshift(item);
    else if (action === 'up') next.splice(Math.max(0, index - 1), 0, item);
    else if (action === 'down') next.splice(Math.min(next.length, index + 1), 0, item);
    else if (action === 'bottom') next.push(item);
    else next.splice(index, 0, item);
    return next;
}

function peerPidFor(pids: number[], index: number, action: string) {
    if (action === 'top') return index > 0 ? pids[0] : null;
    if (action === 'up') return index > 0 ? pids[index - 1] : null;
    if (action === 'down') return index < pids.length - 1 ? pids[index + 1] : null;
    if (action === 'bottom') return index < pids.length - 1 ? pids[pids.length - 1] : null;
    return null;
}

function renderSelectedProblemSort(
    $pids: any,
    problemMeta: Map<number, ProblemSearchItem>,
    mainPid: number | null = null,
    peerPid: number | null = null,
) {
    const $panel = $('[data-selected-problem-sort]');
    const $list = $panel.find('[data-selected-problem-list]');
    if (!$panel.length || !$list.length) return;
    const pids = parsePids($pids.val());
    if (!pids.length) {
        $list.html(`<li class="course-atr-selected-sort__row"><span></span><span class="course-atr-selected-sort__name">${escapeHtml('暂无已选题目')}</span></li>`);
        return;
    }
    $list.html(pids.map((pid, index) => {
        const mainClass = pid === mainPid ? ' is-swap-main' : '';
        const peerClass = pid === peerPid ? ' is-swap-peer' : '';
        const displayPid = problemDisplayPid(pid, problemMeta);
        const title = problemTitle(pid, problemMeta);
        const docId = displayPid !== String(pid) ? `<span class="course-atr-selected-sort__docid">#${pid}</span>` : '';
        return `<li class="course-atr-selected-sort__row${mainClass}${peerClass}" data-selected-problem-item data-pid="${pid}">
            <span class="course-atr-selected-sort__index">${index + 1}</span>
            <span class="course-atr-selected-sort__name">
                <span class="course-atr-selected-sort__problem">
                    <span class="course-atr-selected-sort__pid">${escapeHtml(displayPid)}</span>
                    ${title ? `<span class="course-atr-selected-sort__title-text">${escapeHtml(title)}</span>` : ''}
                    ${docId}
                </span>
            </span>
            <span class="course-atr-selected-sort__actions">
                <button type="button" class="rounded button" data-selected-sort-action="top" ${index === 0 ? 'disabled' : ''}>置顶</button>
                <button type="button" class="rounded button" data-selected-sort-action="up" ${index === 0 ? 'disabled' : ''}>上移</button>
                <button type="button" class="rounded button" data-selected-sort-action="down" ${index === pids.length - 1 ? 'disabled' : ''}>下移</button>
                <button type="button" class="rounded button" data-selected-sort-action="bottom" ${index === pids.length - 1 ? 'disabled' : ''}>置底</button>
            </span>
        </li>`;
    }).join(''));
}

function buildQuery($picker: any, page: number) {
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
    return `<div>${tags.map((tag) => `<span class="course-atr-problem-picker__tag">${escapeHtml(tag)}</span>`).join('')}</div>`;
}

function renderResults($picker: any, items: ProblemSearchItem[], selected: Set<number>) {
    const $results = $picker.find('[data-problem-search-results]');
    const problemUrlTemplate = String($picker.data('problemUrlTemplate') || 'p/__pid__');
    if (!items.length) {
        $results.html(`<tr><td colspan="5">${escapeHtml('没有搜索结果')}</td></tr>`);
        return;
    }
    $results.html(items.map((item) => {
        const docId = Number(item.docId);
        const checked = selected.has(docId) ? 'checked' : '';
        const title = `${escapeHtml(item.title)}${item.hidden ? ` <span class="course-atr-problem-picker__tag">${escapeHtml('隐藏')}</span>` : ''}`;
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

function updateSelectedCount($picker: any, $pids: any) {
    $picker.find('[data-problem-selected-count]').text(String(parsePids($pids.val()).length));
}

function initBatchProblemPicker($pids: any) {
    const $picker = $('.course-atr-problem-picker');
    if (!$pids.length || !$picker.length || $picker.data('courseAtrProblemPickerReady')) return;
    $picker.data('courseAtrProblemPickerReady', true);

    let page = 1;
    let pcount = 1;
    let currentItems: ProblemSearchItem[] = [];
    const problemMeta = new Map<number, ProblemSearchItem>();
    const checked = new Set<number>();
    const searchUrl = String($picker.data('searchUrl') || '');
    let selectedHighlightTimer: number | null = null;
    let selectedSortRefreshSeq = 0;
    let selectedSortInputTimer: number | null = null;

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
        $picker.find('[data-problem-search-results]').html(`<tr><td colspan="5">${escapeHtml('正在搜索...')}</td></tr>`);
        try {
            const data = await request.get(`${searchUrl}?${buildQuery($picker, page)}`) as ProblemSearchResponse;
            currentItems = (data.items || []).slice().sort(compareProblemPid);
            rememberItems(currentItems);
            page = data.page || page;
            pcount = data.pcount || 1;
            $picker.find('[data-problem-search-count]').text(data.count ? ` / 共 ${data.count} 个结果` : '');
            renderResults($picker, currentItems, checked);
            syncPager();
        } catch (error: any) {
            Notification.error(error.message || String(error));
            $picker.find('[data-problem-search-results]').html(`<tr><td colspan="5">${escapeHtml('搜索失败')}</td></tr>`);
        }
    };

    const refreshSelectedSort = async (sortByPid = false) => {
        const seq = ++selectedSortRefreshSeq;
        const pids = parsePids($pids.val());
        await ensureProblemMeta(searchUrl, problemMeta, pids);
        if (seq !== selectedSortRefreshSeq) return;
        if (sortByPid) {
            const sorted = sortPidsByProblemPid(pids, problemMeta);
            if (!samePids(pids, sorted)) writePids($pids, sorted, false);
        }
        updateSelectedCount($picker, $pids);
        renderSelectedProblemSort($pids, problemMeta);
    };

    const scheduleRefreshSelectedSort = () => {
        if (selectedSortInputTimer) window.clearTimeout(selectedSortInputTimer);
        selectedSortInputTimer = window.setTimeout(() => {
            refreshSelectedSort(false);
        }, 250);
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
            Notification.warn('请先选择至少一道题目。');
            return;
        }
        const pids = parsePids($pids.val());
        checked.forEach((pid) => {
            if (!pids.includes(pid)) pids.push(pid);
        });
        writePids($pids, pids, false);
        refreshSelectedSort(false);
        Notification.success('已加入选中题目。');
    });
    $('[data-selected-problem-sort]').on('click', '[data-selected-sort-by-pid]', () => {
        refreshSelectedSort(true);
    });
    $('[data-selected-problem-sort]').on('click', '[data-selected-sort-action]', (ev) => {
        const $button = $(ev.currentTarget);
        const action = String($button.data('selectedSortAction') || '');
        const pids = parsePids($pids.val());
        const pid = Number($button.closest('[data-selected-problem-item]').data('pid'));
        const index = pids.indexOf(pid);
        const peerPid = peerPidFor(pids, index, action);
        writePids($pids, movePid(pids, index, action), false);
        renderSelectedProblemSort($pids, problemMeta, pid, peerPid);
        if (selectedHighlightTimer) window.clearTimeout(selectedHighlightTimer);
        selectedHighlightTimer = window.setTimeout(() => {
            renderSelectedProblemSort($pids, problemMeta);
        }, 2200);
    });
    $pids.closest('form').on('submit', () => {
        writePids($pids, parsePids($pids.val()), false);
    });
    $pids.on('change keyup', () => {
        scheduleRefreshSelectedSort();
    });
    ProblemSelectAutoComplete.getOrConstruct($pids, {
        multi: true,
        clearDefaultValue: false,
        props: {
            multi: true,
            height: 'auto',
            itemText: problemAutocompleteText,
        },
    });
    updateSelectedCount($picker, $pids);
    renderSelectedProblemSort($pids, problemMeta);
    refreshSelectedSort(false);
    syncPager();
}

addPage(new NamedPage(['course_subsec_edit'], () => {
    let confirmed = false;
    $(document).on('click', '[name="operation"]', (ev) => {
        ev.preventDefault();
        if (confirmed) {
            return request.post('.', { operation: 'delete' }).then((res) => {
                window.location.href = res.url;
            });
        }
        const message = '确认要删除此小节吗？';
        return new ConfirmDialog({
            $body: tpl.typoMsg(i18n(message)),
        }).open().then((action) => {
            if (action !== 'yes') return;
            confirmed = true;
            ev.target.click();
        });
    });
    initBatchProblemPicker($('[name="pids"]'));
}));
