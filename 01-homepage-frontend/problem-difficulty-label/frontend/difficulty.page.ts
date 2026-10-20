import { $, addPage, NamedPage } from '@hydrooj/ui-default';

const DIFFICULTY_OPTIONS = [
    { value: 0, text: '暂无评定', color: 'rgb(191, 191, 191)' },
    { value: 1, text: '入门', color: 'rgb(254, 76, 97)' },
    { value: 2, text: '普及-', color: 'rgb(243, 156, 17)' },
    { value: 3, text: '普及', color: 'rgb(255, 193, 22)' },
    { value: 4, text: '普及+/提高-', color: 'rgb(83, 196, 26)' },
    { value: 5, text: '提高', color: 'rgb(19, 194, 194)' },
    { value: 6, text: '提高+/省选-', color: 'rgb(52, 152, 219)' },
    { value: 7, text: '省选/NOI-', color: 'rgb(156, 61, 207)' },
    { value: 8, text: 'NOI/NOI+/CTS', color: 'rgb(14, 29, 105)' },
];

const DIFFICULTY_ALIASES = [
    ['普及/提高-', 3],
    ['普及+/提高', 4],
    ['NOI/NOI+', 8],
    ['NOI/NOI+/CTSC', 8],
] as const;
const OPTION_BY_VALUE = new Map(DIFFICULTY_OPTIONS.map((item) => [item.value, item]));
const VALUE_BY_TEXT = new Map<string, number>([
    ...DIFFICULTY_OPTIONS.map((item) => [item.text, item.value] as const),
    ...DIFFICULTY_ALIASES,
]);
const NO_DIFFICULTY_TEXTS = new Set(['', '(无)', '(None)', '暂无评定']);
const PRIMARY_PROBLEM_TAGS = new Set([
    '基础算法',
    '搜索',
    '动态规划',
    '数学',
    '数学基础',
    '数论',
    '组合数学',
    '线性代数',
    '数据结构',
    '字符串',
    '图论',
    '树与森林',
    '计算几何',
    '分块与离线算法',
    '综合技巧',
    '题型与评测方式',
    '竞赛来源',
    '本地来源',
    '时间',
    '区域',
    '初赛',
    '难度',
    '原创',
]);

function normalizeToken(text: string) {
    return (text || '')
        .replace(/\s+/g, ' ')
        .replace(/^难度\s*[:：]\s*/, '')
        .trim();
}

function difficultyValueFromText(text: string) {
    const token = normalizeToken(text);
    if (VALUE_BY_TEXT.has(token)) return VALUE_BY_TEXT.get(token) || 0;
    const value = Number(token);
    if (Number.isFinite(value) && value >= 0 && value <= 8) return value;
    return undefined;
}

function difficultySubmitValue(value: number) {
    // Hydro validates difficulty as PositiveInt, so no-rating must submit as the optional empty value.
    return value === 0 ? '' : String(value);
}

function difficultyValueFromSubmit(value: string) {
    const normalized = value.trim();
    if (!normalized || normalized === '0') return 0;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
}

function ensureDifficultyStyle() {
    if (document.getElementById('bpjudge-difficulty-style')) return;
    $('head').append(`
        <style id="bpjudge-difficulty-style">
        .col--difficulty { width: 6.375rem!important; }
        .bpjudge-difficulty-label { font-weight: 700; white-space: nowrap; }
        .bpjudge-primary-problem-tag-hidden { display: none!important; }
        select.bpjudge-difficulty-select {
            color: var(--bpjudge-difficulty-color, inherit) !important;
            font-weight: 700 !important;
        }
        select.bpjudge-difficulty-select option {
            font-weight: 700;
        }
        </style>
    `);
}

function renderDifficulty(element: Element, value: number) {
    const option = OPTION_BY_VALUE.get(value) || OPTION_BY_VALUE.get(0)!;
    element.innerHTML = `<span class="bpjudge-difficulty-label" style="color: ${option.color};">${option.text}</span>`;
}

function resolveCellDifficulty(element: Element) {
    const rawText = normalizeToken(element.textContent || '');
    if (NO_DIFFICULTY_TEXTS.has(rawText)) return 0;
    const directValue = difficultyValueFromText(rawText);
    return directValue ?? 0;
}

function applyDifficultyList() {
    ensureDifficultyStyle();
    const difficultyElements = Array.from(document.getElementsByClassName('col--difficulty'));
    for (const element of difficultyElements) {
        if (element.tagName.toLowerCase() === 'th') continue;
        renderDifficulty(element, resolveCellDifficulty(element));
    }
}

function applySecondaryOnlyProblemTags() {
    ensureDifficultyStyle();
    const list = document.querySelector('[data-fragment-id="problem_list"]') || document;
    const tagElements = Array.from(list.querySelectorAll('.col--problem-name .problem__tag'));
    for (const element of tagElements) {
        const text = normalizeToken(element.textContent || '');
        element.classList.toggle('bpjudge-primary-problem-tag-hidden', PRIMARY_PROBLEM_TAGS.has(text));
        const value = difficultyValueFromText(text);
        if (value !== undefined) renderDifficulty(element, value);
    }
}

function applyProblemDetailTags() {
    ensureDifficultyStyle();
    const tagElements = Array.from(document.getElementsByClassName('problem__tag-item'));
    for (const element of tagElements) {
        const rawText = (element.textContent || '').trim();
        const text = normalizeToken(rawText);
        const value = difficultyValueFromText(text);
        if (value === undefined) continue;
        if (rawText.startsWith('难度') || VALUE_BY_TEXT.has(text)) renderDifficulty(element, value);
    }
}

function applyDifficultySelect() {
    const container = document.querySelector('div[name="form_item_difficulty"]');
    if (!container) return;

    let select = container.querySelector<HTMLSelectElement>('select[name="difficulty"]');
    const input = container.querySelector<HTMLInputElement>('input[name="difficulty"]');
    if (!select) {
        select = document.createElement('select');
        select.name = 'difficulty';
        for (const option of DIFFICULTY_OPTIONS) {
            const item = document.createElement('option');
            item.value = difficultySubmitValue(option.value);
            item.textContent = option.text;
            item.dataset.difficultyColor = option.color;
            item.style.setProperty('color', option.color, 'important');
            item.style.setProperty('font-weight', '700');
            select.appendChild(item);
        }
        if (input) select.value = difficultySubmitValue(difficultyValueFromSubmit(input.value));
        if (input) input.replaceWith(select);
        else container.appendChild(select);
        container.className = 'select-container';
    }
    select.classList.add('select', 'bpjudge-difficulty-select');
    for (const item of Array.from(select.options)) {
        const option = OPTION_BY_VALUE.get(difficultyValueFromSubmit(item.value));
        if (!option) continue;
        item.value = difficultySubmitValue(option.value);
        item.dataset.difficultyColor = option.color;
        item.style.setProperty('color', option.color, 'important');
        item.style.setProperty('font-weight', '700');
    }

    const updateSelectColor = () => {
        const option = OPTION_BY_VALUE.get(difficultyValueFromSubmit(select!.value)) || OPTION_BY_VALUE.get(0)!;
        select!.style.setProperty('--bpjudge-difficulty-color', option.color);
        select!.style.setProperty('color', option.color, 'important');
        select!.style.setProperty('font-weight', '700', 'important');
    };

    updateSelectColor();
    if (!select.dataset.bpjudgeDifficultyBound) {
        select.dataset.bpjudgeDifficultyBound = '1';
        select.addEventListener('change', updateSelectColor);
    }
}

addPage(new NamedPage(['problem_main', 'training_detail', 'course_detail', 'course_chapter', 'course_subsec_detail'], async () => {
    applyDifficultyList();
    $(document).on('vjContentNew', applyDifficultyList);
}));

addPage(new NamedPage(['problem_main'], async () => {
    applySecondaryOnlyProblemTags();
    $(document).on('vjContentNew', applySecondaryOnlyProblemTags);
}));

addPage(new NamedPage(['problem_detail'], async () => {
    applyDifficultyList();
    applyProblemDetailTags();
    $(document).on('vjContentNew', () => {
        applyDifficultyList();
        applyProblemDetailTags();
    });
}));

addPage(new NamedPage(['problem_edit', 'problem_create'], async () => {
    applyDifficultySelect();
    $(document).on('vjContentNew', applyDifficultySelect);
}));
