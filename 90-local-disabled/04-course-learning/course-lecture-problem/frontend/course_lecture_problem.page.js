import {
    $, addPage, NamedPage, ProblemSelectAutoComplete,
} from '@hydrooj/ui-default';

const EDIT_PAGES = [
    'course_subsec_edit',
    'course_subsec_create',
    'course_package_lesson_edit',
    'course_package_lesson_create',
];
const MARKER_RE = /<!--\s*hydro-course-lecture-problem\s+({[\s\S]*?})\s*-->\s*/g;

function getUiContext() {
    let context = null;
    try {
        if (typeof UiContext !== 'undefined') context = UiContext;
    } catch {
        context = null;
    }
    if (!context && typeof window !== 'undefined') context = window.UiContext;
    if (typeof context === 'string') {
        try {
            return JSON.parse(context);
        } catch {
            return {};
        }
    }
    return context || {};
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function normalizePid(value) {
    const match = String(value || '').trim().match(/P?\s*(\d+)/i);
    const pid = match ? Number(match[1]) : 0;
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

function parsePids(value) {
    const seen = new Set();
    const pids = [];
    for (const item of String(value || '').split(/[,\uFF0C\s]+/)) {
        const pid = normalizePid(item);
        if (!pid || seen.has(pid)) continue;
        seen.add(pid);
        pids.push(pid);
    }
    return pids;
}

function stripMarker(content) {
    MARKER_RE.lastIndex = 0;
    const clean = String(content || '').replace(MARKER_RE, '');
    MARKER_RE.lastIndex = 0;
    return clean.trimStart();
}

function readMarker(content) {
    let result = null;
    MARKER_RE.lastIndex = 0;
    let match;
    while ((match = MARKER_RE.exec(String(content || '')))) {
        try {
            result = JSON.parse(match[1]);
        } catch {
            result = null;
        }
    }
    MARKER_RE.lastIndex = 0;
    return result || {};
}

function markerLecturePids(meta, pids) {
    const directPids = parsePids(meta?.pids);
    const singlePid = normalizePid(meta?.pid);
    if (singlePid && !directPids.includes(singlePid)) directPids.push(singlePid);
    return directPids;
}

function withMarker(content, lecturePids) {
    const clean = stripMarker(content);
    const pids = parsePids(lecturePids);
    if (!pids.length) return clean;
    const meta = { pids };
    if (pids.length === 1) meta.pid = pids[0];
    return `<!-- hydro-course-lecture-problem ${JSON.stringify(meta)} -->\n${clean}`;
}

function ensureStyle() {
    if (document.getElementById('course-lecture-problem-style')) return;
    const style = document.createElement('style');
    style.id = 'course-lecture-problem-style';
    style.textContent = `
      .clp-edit-panel {
        position: relative;
        z-index: 30;
        overflow: visible;
        isolation: isolate;
        margin: 0 0 16px;
        padding: 14px 16px;
        border: 1px solid var(--hub-border, #d8e4f2);
        border-radius: 8px;
        background: var(--hub-surface, rgba(255, 255, 255, .055));
        box-shadow: var(--hub-shadow, none);
        backdrop-filter: blur(14px) saturate(150%);
        -webkit-backdrop-filter: blur(14px) saturate(150%);
      }
      .clp-edit-panel__title {
        display: flex;
        gap: 8px;
        align-items: center;
        margin: 0 0 10px;
        color: #10233f;
        font-size: 15px;
        font-weight: 700;
      }
      .clp-edit-panel label {
        margin-bottom: 0;
      }
      .clp-edit-panel .help-text {
        margin: 8px 0 0;
      }
      .clp-edit-panel .autocomplete-container {
        position: relative;
        z-index: 35;
        overflow: visible;
      }
      .clp-edit-panel .autocomplete-container .menu,
      .clp-edit-panel .menu.problem-select {
        z-index: 10020;
      }
      .clp-edit-panel + .course-atr-problem-picker,
      .clp-edit-panel + .course-package-problem-picker {
        position: relative;
        z-index: 1;
      }
      .clp-lecture-section .section__title {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .clp-lecture-list {
        display: grid;
        gap: 0;
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .clp-lecture-item + .clp-lecture-item {
        border-top: 1px solid #e5edf7;
      }
      .clp-lecture-link {
        display: flex;
        gap: 10px;
        align-items: center;
        min-height: 42px;
        padding: 10px 14px;
        color: #26354d;
        font-weight: 700;
        line-height: 1.45;
        text-decoration: none;
      }
      .clp-lecture-link:hover {
        background: #f8fbff;
        color: #165dbe;
        text-decoration: none;
      }
      .clp-lecture-link .icon {
        flex: none;
        color: #5aa3e6;
      }
      .clp-lecture-name {
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .clp-problem-image-card {
        display: block;
        width: 100%;
        box-sizing: border-box;
        background: #fff;
        color: #26354d;
        overflow: hidden;
        user-select: none;
        -webkit-user-select: none;
      }
      .clp-statement-image {
        display: block;
        width: 100%;
        height: auto;
        pointer-events: auto;
      }
      .theme--dark .clp-edit-panel {
        border-color: var(--hub-border, #3a4656);
        background: var(--hub-surface, rgba(255, 255, 255, .045));
      }
      .theme--dark .clp-edit-panel__title {
        color: #e2e8f0;
      }
      .theme--dark .clp-lecture-item + .clp-lecture-item {
        border-top-color: #3a4656;
      }
      .theme--dark .clp-lecture-link {
        color: #e2e8f0;
      }
      .theme--dark .clp-lecture-link:hover {
        background: #1f2a3a;
        color: #7ab8ff;
      }
      .theme--dark .clp-problem-image-card {
        background: #fff;
        color: #26354d;
      }
      @media screen and (max-width: 720px) {
        .clp-problem-image-card {
          overflow-x: auto;
        }
        .clp-statement-image {
          min-width: 760px;
        }
      }
    `;
    document.head.appendChild(style);
}

function renderLectureLink(item) {
    const title = String(item.problemTitle || '');
    return `
      <a class="clp-lecture-link" href="${escapeHtml(item.lectureUrl)}">
        <span class="icon icon-comment" aria-hidden="true"></span>
        <span class="clp-lecture-name">${escapeHtml(title || '\u8bb2\u4e49')}</span>
      </a>
    `;
}

function findInitialLecturePids(config, contentInput, pidsInput) {
    const fromConfig = parsePids(config.lecturePids);
    const legacyConfig = normalizePid(config.lecturePid);
    if (legacyConfig && !fromConfig.includes(legacyConfig)) fromConfig.push(legacyConfig);
    if (fromConfig.length) return fromConfig;
    const marker = readMarker(contentInput?.value);
    return markerLecturePids(marker, pidsInput?.value);
}

function buildLectureState(contentInput, pidsInput, lectureInput, forSubmit, initialLecturePids = []) {
    const lecturePids = parsePids(lectureInput.value);
    const lectureSet = new Set(lecturePids);
    const practicePids = [];
    const pushPracticePid = (pid) => {
        if (!pid || lectureSet.has(pid) || practicePids.includes(pid)) return;
        practicePids.push(pid);
    };
    // If an old marker made a normal problem look like a lecture, clearing it should restore it as a scored problem.
    for (const pid of parsePids(initialLecturePids)) pushPracticePid(pid);
    for (const pid of parsePids(pidsInput.value)) pushPracticePid(pid);
    const transportPids = forSubmit ? [...lecturePids, ...practicePids] : practicePids;
    return {
        lecturePids,
        practicePids,
        transportPids,
        content: withMarker(contentInput.value, lecturePids),
    };
}

function writeLectureState(contentInput, pidsInput, lectureInput, forSubmit = false, initialLecturePids = []) {
    const state = buildLectureState(contentInput, pidsInput, lectureInput, forSubmit, initialLecturePids);
    pidsInput.value = (forSubmit ? state.transportPids : state.practicePids).join(', ');
    contentInput.value = state.content;
    return state;
}

function renderLectureItems(items) {
    return items.map((item) => `
      <li class="clp-lecture-item" data-pid="${escapeHtml(item.lecturePid)}">
        ${renderLectureLink(item)}
      </li>
    `).join('');
}

function initEditPanel() {
    const config = getUiContext().courseLectureProblem;
    if (!config || !EDIT_PAGES.includes(config.page)) return;
    ensureStyle();
    if (document.getElementById('course-lecture-problem-edit-panel')) return;

    const form = document.querySelector('form');
    const pidsInput = form?.querySelector('input[name="pids"]');
    const contentInput = form?.querySelector('textarea[name="content"]');
    if (!form || !pidsInput || !contentInput) return;

    const initialLecturePids = findInitialLecturePids(config, contentInput, pidsInput);
    contentInput.value = stripMarker(contentInput.value);
    if (initialLecturePids.length) {
        const lectureSet = new Set(initialLecturePids);
        pidsInput.value = parsePids(pidsInput.value)
            .filter((pid) => !lectureSet.has(pid))
            .join(', ');
    }

    const panel = document.createElement('div');
    panel.id = 'course-lecture-problem-edit-panel';
    panel.className = 'clp-edit-panel';
    panel.innerHTML = `
      <div class="clp-edit-panel__title"><span class="icon icon-comment"></span> \u8bb2\u4e49</div>
      <label>
        \u9009\u62e9\u8bb2\u4e49\u9898
        <input class="textbox autocomplete-dummy" name="_courseLectureProblemPids" value="${escapeHtml(initialLecturePids.join(', '))}" placeholder="\u4f8b\u5982 P1000, P1001">
      </label>
      <p class="help-text">\u8bb2\u4e49\u4f5c\u4e3a\u672c\u8282\u5355\u72ec\u9605\u8bfb\u5185\u5bb9\u5c55\u793a\uff0c\u53ef\u4ee5\u9009\u591a\u9053\u9898\uff0c\u4e0d\u8ba1\u5165\u672c\u5c0f\u8282\u6210\u7ee9\uff0c\u4e5f\u4e0d\u9700\u8981\u653e\u5165\u4e0b\u65b9\u9898\u76ee\u5217\u8868\u3002</p>
    `;

    const pidsLabel = pidsInput.closest('label');
    if (pidsLabel?.parentElement) pidsLabel.parentElement.insertBefore(panel, pidsLabel);
    else form.insertBefore(panel, form.firstChild);

    const lectureInput = panel.querySelector('input[name="_courseLectureProblemPids"]');
    ProblemSelectAutoComplete.getOrConstruct($(lectureInput), {
        multi: true,
        clearDefaultValue: false,
        props: {
            multi: true,
            height: 'auto',
        },
    });

    const sync = () => writeLectureState(contentInput, pidsInput, lectureInput, false, initialLecturePids);
    const prepareSubmit = () => writeLectureState(contentInput, pidsInput, lectureInput, true, initialLecturePids);
    lectureInput.addEventListener('change', sync);
    lectureInput.addEventListener('keyup', sync);
    form.addEventListener('submit', prepareSubmit);
    form.addEventListener('formdata', (event) => {
        const state = buildLectureState(contentInput, pidsInput, lectureInput, true, initialLecturePids);
        event.formData.set('pids', state.transportPids.join(', '));
        event.formData.set('content', state.content);
    });
}

function initCourseSubsecLectureEntry() {
    const config = getUiContext().courseLectureProblem;
    if (!config || config.page !== 'course_subsec_detail') return;
    const items = Array.isArray(config.lectureItems) ? config.lectureItems : [];
    if (!items.length) return;
    ensureStyle();
    if (document.getElementById('course-lecture-problem-entry-section')) return;

    const problemsSection = document.querySelector('.training__problems')?.closest('.section');
    if (!problemsSection?.parentElement) return;

    const section = document.createElement('div');
    section.id = 'course-lecture-problem-entry-section';
    section.className = 'section clp-lecture-section';
    section.innerHTML = `
      <div class="section__header">
        <h1 class="section__title"><span class="icon icon-comment"></span> \u8bb2\u4e49</h1>
      </div>
      <div class="section__body no-padding">
        <ol class="clp-lecture-list">
          ${renderLectureItems(items)}
        </ol>
      </div>
    `;
    problemsSection.parentElement.insertBefore(section, problemsSection);
}

addPage(new NamedPage(EDIT_PAGES, initEditPanel));
addPage(new NamedPage(['course_subsec_detail'], initCourseSubsecLectureEntry));
