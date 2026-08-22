import {
    $, addPage, i18n, load, NamedPage,
} from '@hydrooj/ui-default';

declare const UiContext: any;

interface RatingHistoryPoint {
    contestId: string;
    contestTitle: string;
    ratedAt?: string | Date;
    oldRating: number;
    newRating: number;
    delta: number;
    rank: number;
    title: string;
    color: string;
}

function domainBase() {
    const domainId = UiContext?.domain?._id || UiContext?.domainId;
    return domainId ? `/d/${domainId}` : '';
}

function pluginEnabled() {
    return !(UiContext?.pluginSwitch?.disabled || []).includes('contest-rating-arena');
}

function ensureStyle() {
    if (document.getElementById('contest-rating-arena-style')) return;
    const style = document.createElement('style');
    style.id = 'contest-rating-arena-style';
    style.textContent = `
      .cra-ranking-tabs { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px; border-bottom: 1px solid #e5e7eb; }
      .cra-ranking-tabs .button { margin: 0; }
      .cra-user-rating-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 0 0 16px; }
      .cra-user-rating-summary__item { min-width: 0; }
      .cra-user-rating-summary__item span { display: block; color: #64748b; font-size: 12.5px; line-height: 1.4; }
      .cra-user-rating-summary__item strong { display: block; margin-top: 3px; font-size: 20px; line-height: 1.25; }
      .cra-user-rating-chart { width: 100%; height: 380px; min-height: 340px; margin: 18px 0 18px; }
      .cra-user-rating-table { margin-top: 8px; }
      .cra-rating-old { color: #64748b; }
      .cra-rating-delta { font-weight: 700; }
      .cra-rating-delta--up { color: #15803d; }
      .cra-rating-delta--down { color: #b91c1c; }
      .theme--dark .cra-user-rating-summary__item span,
      .theme--dark .cra-rating-old { color: #94a3b8; }
      .page--user_detail .profile-content .section__tab-header-wrapper,
      .page--homepage .profile-content .section__tab-header-wrapper {
        overflow: visible;
      }
      .page--user_detail .profile-content .section__tab-header,
      .page--homepage .profile-content .section__tab-header {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-end;
        gap: 8px;
        overflow: visible;
        white-space: normal;
        padding-bottom: 0;
        margin-bottom: 0;
      }
      .page--user_detail .profile-content .section__tab-header-item,
      .page--homepage .profile-content .section__tab-header-item {
        flex: 0 0 auto;
        margin-right: 0;
        margin-bottom: 6px;
        max-width: 100%;
      }
      .page--user_detail .profile-content .section__tab-content,
      .page--homepage .profile-content .section__tab-content {
        clear: both;
      }
      @media screen and (max-width: 720px) {
        .cra-user-rating-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .cra-user-rating-chart { height: 320px; min-height: 300px; }
        .page--user_detail .profile-content .section__tab-header,
        .page--homepage .profile-content .section__tab-header {
          gap: 6px;
        }
      }
    `;
    document.head.appendChild(style);
}

function cssVar(name: string, fallback: string) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
}

function formatDate(value: string | Date | number, withYear = true) {
    const date = new Date(value);
    if (Number.isNaN(+date)) return '';
    return new Intl.DateTimeFormat('zh-CN', {
        ...(withYear ? { year: 'numeric' as const } : {}),
        month: '2-digit',
        day: '2-digit',
    }).format(date);
}

function dateKey(value: string | Date | number) {
    const date = new Date(value);
    if (Number.isNaN(+date)) return '';
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

function deltaText(delta: number) {
    return delta > 0 ? `+${delta}` : `${delta || 0}`;
}

function visible(el: HTMLElement) {
    return !!(el.offsetWidth && el.offsetHeight);
}

async function mountUserRatingChart() {
    ensureStyle();
    const chartEl = document.getElementById('contest-rating-history-chart') as HTMLElement | null;
    if (!chartEl || chartEl.dataset.mounted === '1') return;
    const history = (Array.isArray(UiContext?.contestRatingHistory) ? UiContext.contestRatingHistory : []) as RatingHistoryPoint[];
    const data = history
        .filter((row) => row?.ratedAt
            && Number.isFinite(Number(row.newRating))
            && (Number(row.oldRating) !== Number(row.newRating) || Number(row.delta) !== 0))
        .map((row) => ({
            ...row,
            value: [new Date(row.ratedAt as any), Number(row.newRating)],
            itemStyle: { color: row.color || '#2563eb' },
        }));
    if (!data.length) return;

    const render = async () => {
        if (chartEl.dataset.mounted === '1' || chartEl.dataset.loading === '1') return;
        chartEl.dataset.loading = '1';
        try {
            const echarts = await load('echarts');
            const isDark = document.documentElement.classList.contains('theme--dark');
            const textColor = cssVar('--hub-text', isDark ? '#f8fafc' : '#111827');
            const mutedColor = cssVar('--hub-muted', isDark ? '#cbd5e1' : '#64748b');
            const borderColor = cssVar('--hub-border', isDark ? 'rgba(255,255,255,.12)' : 'rgba(15,23,42,.12)');
            const surfaceColor = cssVar('--hub-surface-strong', isDark ? 'rgba(24,28,36,.92)' : 'rgba(255,255,255,.94)');
            const lineColor = isDark ? '#7ab8ff' : '#2563eb';
            const values = data.map((item) => Number(item.newRating));
            const times = data.map((item) => +new Date(item.ratedAt as any)).filter((time) => Number.isFinite(time));
            const changeDateKeys = new Set(data.map((item) => dateKey(item.ratedAt as any)));
            const minRating = Math.max(0, Math.floor((Math.min(...values) - 80) / 100) * 100);
            const maxRating = Math.ceil((Math.max(...values) + 80) / 100) * 100;
            const singlePointTime = times.length === 1 ? times[0] : 0;
            const chart = echarts.init(chartEl);
            chart.setOption({
                animationDuration: 500,
                grid: {
                    left: 56,
                    right: 24,
                    top: 54,
                    bottom: 54,
                    containLabel: true,
                },
                tooltip: {
                    trigger: 'axis',
                    confine: true,
                    axisPointer: { type: 'line' },
                    backgroundColor: surfaceColor,
                    borderColor,
                    textStyle: { color: textColor },
                    formatter(params: any) {
                        const point = Array.isArray(params) ? params[0] : params;
                        const row = point?.data || {};
                        const delta = Number(row.delta) || 0;
                        const color = delta > 0 ? '#16a34a' : delta < 0 ? '#dc2626' : mutedColor;
                        return [
                            `<strong>${formatDate(row.ratedAt || point.value?.[0])}</strong>`,
                            `${row.contestTitle || i18n('Contest')}`,
                            `${i18n('Rank')}: ${row.rank ? `#${row.rank}` : '-'}`,
                            `${i18n('Rating')}: ${row.oldRating} -> <strong style="color:${row.color || lineColor}">${row.newRating}</strong>`,
                            `${i18n('Change')}: <strong style="color:${color}">${deltaText(delta)}</strong>`,
                        ].join('<br>');
                    },
                },
                xAxis: {
                    type: 'time',
                    boundaryGap: false,
                    ...(singlePointTime ? {
                        min: singlePointTime - 24 * 60 * 60 * 1000,
                        max: singlePointTime + 24 * 60 * 60 * 1000,
                    } : {}),
                    axisLabel: {
                        color: mutedColor,
                        hideOverlap: true,
                        formatter: (value: number) => (changeDateKeys.has(dateKey(value)) ? formatDate(value, false) : ''),
                    },
                    axisLine: { lineStyle: { color: borderColor } },
                    axisTick: { lineStyle: { color: borderColor } },
                    splitLine: { show: false },
                },
                yAxis: {
                    type: 'value',
                    name: 'Rating',
                    nameGap: 18,
                    min: minRating,
                    max: maxRating,
                    nameTextStyle: { color: mutedColor },
                    axisLabel: { color: mutedColor },
                    axisLine: { show: false },
                    axisTick: { show: false },
                    splitLine: { lineStyle: { color: borderColor } },
                },
                series: [{
                    name: 'Rating',
                    type: 'line',
                    data,
                    showSymbol: true,
                    symbol: 'circle',
                    symbolSize: 7,
                    label: {
                        show: true,
                        position: 'bottom',
                        distance: 10,
                        color: mutedColor,
                        fontSize: 11,
                        formatter: (params: any) => formatDate(params?.data?.ratedAt || params?.value?.[0], false),
                    },
                    labelLayout: { hideOverlap: true },
                    lineStyle: { width: 2.5, color: lineColor },
                    areaStyle: { color: isDark ? 'rgba(122, 184, 255, .10)' : 'rgba(37, 99, 235, .08)' },
                    emphasis: { focus: 'series' },
                }],
            });
            chartEl.dataset.mounted = '1';
            window.addEventListener('resize', () => chart.resize(), { passive: true });
        } finally {
            delete chartEl.dataset.loading;
        }
    };

    if (visible(chartEl)) {
        await render();
    } else {
        const $tab = $(chartEl).closest('.section__tab-main');
        ($tab.length ? $tab : $(chartEl).parent()).one('vjContentShow', () => {
            void render();
        });
    }
}

function mountRankingTabs() {
    ensureStyle();
    $('#contest-rating-arena-tabs').remove();
    if (!pluginEnabled()) return;
    if (!UiContext?.contestRating?.enabled || !UiContext?.contestRating?.showInNav) return;
    const path = window.location.pathname;
    if (!/(?:\/d\/[^/]+)?\/ranking\/?$/.test(path)) return;
    const target = document.querySelector<HTMLElement>('[data-fragment-id="ranking"]');
    if (!target) return;
    const tabs = document.createElement('div');
    tabs.id = 'contest-rating-arena-tabs';
    tabs.className = 'cra-ranking-tabs';
    tabs.innerHTML = `
      <a class="button rounded primary" href="${domainBase()}/ranking">RP榜</a>
      <a class="button rounded" href="${domainBase()}/ranking/contest-rating">Rating榜</a>
    `;
    target.prepend(tabs);
}

addPage(() => {
    mountRankingTabs();
    $(document).off('vjContentNew.contestRatingArena').on('vjContentNew.contestRatingArena', () => mountRankingTabs());
});

addPage(new NamedPage(['user_detail', 'homepage'], () => {
    void mountUserRatingChart();
}));
