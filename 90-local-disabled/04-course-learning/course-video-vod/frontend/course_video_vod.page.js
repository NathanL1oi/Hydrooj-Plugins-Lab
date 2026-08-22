import { addPage, NamedPage } from '@hydrooj/ui-default';

let tcPlayerPromise;
let vodUploadSdkPromise;
const VOD_UPLOAD_SDK = 'https://cdn-go.cn/cdn/vod-js-sdk-v6/latest/vod-js-sdk-v6.js';

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[ch]));
}

function fmtDuration(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    if (!value) return '-';
    const h = Math.floor(value / 3600);
    const m = Math.floor((value % 3600) / 60);
    const s = Math.floor(value % 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtSize(bytes) {
    const value = Number(bytes) || 0;
    if (!value) return '-';
    if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
    return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function ensureStyle() {
    if (document.getElementById('course-video-vod-style')) return;
    const style = document.createElement('style');
    style.id = 'course-video-vod-style';
    style.textContent = `
      .cvv-section .cvv-head {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 10px;
        align-items: center;
      }
      .cvv-section .cvv-title {
        display: flex;
        gap: 8px;
        align-items: center;
        font-weight: 700;
      }
      .cvv-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }
      .cvv-section.is-collapsed .section__body {
        display: none;
      }
      .cvv-player {
        position: relative;
        width: 100%;
        aspect-ratio: 16 / 9;
        max-height: 460px;
        background: #0f172a;
        color: #e2e8f0;
        display: grid;
        place-items: center;
        overflow: hidden;
      }
      .cvv-player video {
        width: 100%;
        height: 100%;
        background: #000;
      }
      .cvv-player-error {
        position: absolute;
        left: 12px;
        right: 12px;
        bottom: 12px;
        padding: 8px 10px;
        border-radius: 4px;
        background: rgba(15, 23, 42, .86);
        color: #fee2e2;
        font-size: 13px;
      }
      .cvv-placeholder {
        text-align: center;
        padding: 18px;
      }
      .cvv-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin: 10px 0 0;
        color: #64748b;
        font-size: 13px;
      }
      .cvv-bind {
        display: grid;
        grid-template-columns: minmax(220px, 1fr) auto auto auto;
        gap: 8px;
        align-items: center;
        margin-top: 12px;
      }
      .cvv-bind label {
        margin-bottom: 0;
      }
      .cvv-package-panel {
        position: relative;
        z-index: 25;
        margin: 0 0 16px;
        padding: 14px 16px;
        border: 1px solid var(--hub-border, #d8e4f2);
        border-radius: 8px;
        background: var(--hub-surface, rgba(255, 255, 255, .055));
        color: var(--hub-text, #26354d);
        box-shadow: var(--hub-shadow, none);
        backdrop-filter: blur(14px) saturate(150%);
        -webkit-backdrop-filter: blur(14px) saturate(150%);
      }
      .cvv-package-panel strong {
        display: flex;
        gap: 8px;
        align-items: center;
        color: var(--hub-text, #10233f);
        font-size: 15px;
      }
      .cvv-package-panel p {
        margin: 10px 0 0;
      }
      .cvv-package-panel label {
        margin-bottom: 0;
      }
      .cvv-package-panel .help-text,
      .cvv-package-panel .cvv-meta {
        color: var(--hub-muted, #64748b);
      }
      .cvv-package-panel .select {
        background: var(--hub-input-bg, rgba(255, 255, 255, .62));
        border-color: var(--hub-border, #cbd5e1);
        color: var(--hub-text, #26354d);
      }
      .theme--dark .cvv-placeholder {
        border-color: #334155;
        background: #1f2937;
        color: #e5e7eb;
      }
      .theme--dark .cvv-package-panel {
        border-color: var(--hub-border, #3a4656);
        background: var(--hub-surface, rgba(255, 255, 255, .045));
        color: var(--hub-text, #e2e8f0);
      }
      .theme--dark .cvv-package-panel strong {
        color: var(--hub-text, #e2e8f0);
      }
      .theme--dark .cvv-meta {
        color: #94a3b8;
      }
      .theme--dark .cvv-package-panel .select {
        background: var(--hub-input-bg, rgba(15, 23, 42, .52));
        border-color: var(--hub-border, #3a4656);
        color: var(--hub-text, #e2e8f0);
      }
      html.hydro-user-background-enabled .cvv-package-panel {
        border-color: var(--hub-border) !important;
        background: var(--hub-surface) !important;
        color: var(--hub-text);
        box-shadow: var(--hub-shadow) !important;
      }
      html.hydro-user-background-enabled .cvv-package-panel .select {
        background: var(--hub-input-bg) !important;
        border-color: var(--hub-border) !important;
        color: var(--hub-text);
      }
      html.hydro-user-background-enabled .cvv-package-panel .help-text,
      html.hydro-user-background-enabled .cvv-package-panel .cvv-meta {
        color: var(--hub-muted);
      }
      .theme--dark .cvv-player {
        background: #020617;
        color: #e5e7eb;
      }
      .theme--dark .cvv-player-error {
        background: rgba(127, 29, 29, .88);
        color: #fee2e2;
      }
      @media screen and (max-width: 900px) {
        .cvv-bind {
          grid-template-columns: 1fr;
        }
        .cvv-player {
          max-height: none;
        }
      }
    `;
    document.head.appendChild(style);
}

function assetLabel(item) {
    const kind = item.provider === 'local' ? 'Hydro' : `VOD ${item.fileId || ''}`.trim();
    return `${item.title || item.fileId || item.id} - ${kind}`;
}

function assetOptions(assets, selectedId) {
    const rows = ['<option value="">不绑定视频</option>'];
    const groups = new Map();
    for (const item of assets || []) {
        const name = item.categoryName || '未分类';
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(item);
    }
    for (const [name, items] of groups) {
        rows.push(`<optgroup label="${esc(name)}">`);
        for (const item of items) {
            rows.push(`<option value="${esc(item.id)}"${item.id === selectedId ? ' selected' : ''}>${esc(assetLabel(item))}</option>`);
        }
        rows.push('</optgroup>');
    }
    return rows.join('');
}

function assetOptionsByHierarchy(assets, selectedId) {
    const rows = ['<option value="">不绑定视频</option>'];
    const groups = new Map();
    for (const item of assets || []) {
        const name = item.hierarchyLabel || item.categoryName || '未归档课程';
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(item);
    }
    for (const [name, items] of groups) {
        rows.push(`<optgroup label="${esc(name)}">`);
        for (const item of items) {
            rows.push(`<option value="${esc(item.id)}"${item.id === selectedId ? ' selected' : ''}>${esc(assetLabel(item))}</option>`);
        }
        rows.push('</optgroup>');
    }
    return rows.join('');
}

function bindingMeta(binding) {
    const asset = binding?.asset;
    if (!asset) return '<span>未绑定视频</span>';
    const rows = [
        `<span>来源: ${asset.provider === 'local' ? 'Hydro' : 'VOD'}</span>`,
        asset.categoryName ? `<span>分类: ${esc(asset.categoryName)}</span>` : '',
        asset.provider === 'local'
            ? `<span>文件: ${esc(asset.filename || asset.title || '')}</span>`
            : `<span>FileId: <code>${esc(asset.fileId)}</code></span>`,
        `<span>时长: ${esc(fmtDuration(asset.duration))}</span>`,
        `<span>大小: ${esc(fmtSize(asset.size))}</span>`,
        `<span>状态: ${esc(asset.status)}</span>`,
    ];
    return rows.filter(Boolean).join('');
}

function bindingMetaRich(binding) {
    const asset = binding?.asset;
    if (!asset) return '<span>未绑定视频</span>';
    const rows = [
        `<span>来源: ${asset.provider === 'local' ? 'Hydro' : 'VOD'}</span>`,
        asset.hierarchyLabel ? `<span>位置: ${esc(asset.hierarchyLabel)}</span>` : '',
        asset.categoryName ? `<span>分类: ${esc(asset.categoryName)}</span>` : '',
        asset.provider === 'local'
            ? `<span>文件: ${esc(asset.filename || asset.title || '')}</span>`
            : `<span>FileId: <code>${esc(asset.fileId)}</code></span>`,
        `<span>时长: ${esc(fmtDuration(asset.duration))}</span>`,
        `<span>大小: ${esc(fmtSize(asset.size))}</span>`,
        `<span>状态: ${esc(asset.status)}</span>`,
    ];
    return rows.filter(Boolean).join('');
}

function loadCssOnce(url) {
    if (!url || [...document.querySelectorAll('link[data-cvv-tcplayer-css]')].some((item) => item.href === url || item.dataset.cvvTcplayerCss === url)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    link.dataset.cvvTcplayerCss = url;
    document.head.appendChild(link);
}

function loadScriptOnce(url) {
    if (window.TCPlayer) return Promise.resolve();
    if (tcPlayerPromise) return tcPlayerPromise;
    tcPlayerPromise = new Promise((resolve, reject) => {
        const existed = [...document.scripts].find((item) => item.src === url);
        if (existed) {
            existed.addEventListener('load', () => resolve(), { once: true });
            existed.addEventListener('error', () => reject(new Error('TCPlayer SDK 加载失败')), { once: true });
            return;
        }
        const script = document.createElement('script');
        script.src = url;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('TCPlayer SDK 加载失败'));
        document.head.appendChild(script);
    });
    return tcPlayerPromise;
}

function loadVodUploadSdk() {
    if (window.TcVod) return Promise.resolve();
    if (vodUploadSdkPromise) return vodUploadSdkPromise;
    vodUploadSdkPromise = new Promise((resolve, reject) => {
        const existed = [...document.scripts].find((item) => item.src === VOD_UPLOAD_SDK);
        if (existed) {
            existed.addEventListener('load', () => resolve(), { once: true });
            existed.addEventListener('error', () => reject(new Error('VOD 上传 SDK 加载失败')), { once: true });
            return;
        }
        const script = document.createElement('script');
        script.src = VOD_UPLOAD_SDK;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('VOD 上传 SDK 加载失败'));
        document.head.appendChild(script);
    });
    return vodUploadSdkPromise;
}

function uploadState(form, text) {
    const node = form.querySelector('[data-vod-upload-state]');
    if (node) node.textContent = text || '';
}

function uploadProgress(form, percent) {
    const wrap = form.querySelector('[data-vod-upload-progress]');
    const bar = wrap?.querySelector('span');
    if (!wrap || !bar) return;
    wrap.style.display = 'block';
    bar.style.width = `${Math.max(0, Math.min(100, Math.round((Number(percent) || 0) * 100)))}%`;
}

function initHierarchySelects(root = document) {
    root.querySelectorAll('[data-cvv-path-selects]').forEach((wrap) => {
        if (wrap.dataset.cvvPathBound === '1') return;
        wrap.dataset.cvvPathBound = '1';
        const course = wrap.querySelector('[data-cvv-course-select]');
        const chapter = wrap.querySelector('[data-cvv-chapter-select]') || wrap.querySelector('[data-cvv-section-select]');
        if (!course || !chapter) return;
        const sync = () => {
            const courseId = course.value || '';
            for (const option of chapter.options) {
                if (!option.value) {
                    option.hidden = false;
                    continue;
                }
                option.hidden = !!courseId && option.dataset.courseId !== courseId;
            }
            if (chapter.value && chapter.selectedOptions[0]?.hidden) chapter.value = '';
        };
        course.addEventListener('change', () => {
            chapter.value = '';
            sync();
        });
        sync();
    });
}

async function postUrlencoded(url, data) {
    const res = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body: new URLSearchParams(data),
    });
    const text = await res.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch (err) {
        if (/^\s*</.test(text)) throw new Error('接口返回了页面而不是 JSON，请确认插件已重启并且当前账号是主域超管。');
        throw new Error(text.slice(0, 160) || '接口返回异常');
    }
    if (!res.ok || json.ok === false || json.error) throw new Error(json.message || json.error?.message || '请求失败');
    return json;
}

function initVideoMain() {
    initHierarchySelects(document);
    const form = document.getElementById('course-video-vod-upload-form');
    if (!form || form.dataset.cvvBound === '1') return;
    form.dataset.cvvBound = '1';
    form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const input = form.querySelector('input[name="video"]');
        const file = input?.files?.[0];
        if (!file) {
            uploadState(form, '请选择要上传的视频文件。');
            return;
        }
        const button = form.querySelector('button[type="submit"]');
        const title = form.querySelector('[name="videoTitle"]')?.value?.trim() || '';
        const folderCourseId = form.querySelector('[name="folderCourseId"]')?.value || form.querySelector('[name="courseId"]')?.value || '';
        const folderChapterId = form.querySelector('[name="folderChapterId"]')?.value || form.querySelector('[name="chapterId"]')?.value || '';
        const duration = form.querySelector('[name="duration"]')?.value || '';
        if (!folderCourseId || !folderChapterId) {
            uploadState(form, '请先选择视频库课程和章。');
            return;
        }
        if (!title) {
            uploadState(form, '请填写视频名。');
            return;
        }
        try {
            if (button) button.disabled = true;
            uploadProgress(form, 0);
            uploadState(form, '正在加载 VOD 上传 SDK...');
            await loadVodUploadSdk();
            const TcVodCtor = window.TcVod?.default || window.TcVod;
            if (!TcVodCtor) throw new Error('VOD 上传 SDK 未初始化。');
            const tcVod = new TcVodCtor({
                getSignature: async () => {
                    uploadState(form, '正在向 Hydro 获取 VOD 上传签名...');
                    const data = await postUrlencoded(form.dataset.signUrl, {
                        videoTitle: title,
                        filename: file.name,
                        size: String(file.size || 0),
                    });
                    return data.signature;
                },
            });
            uploadState(form, '正在上传到腾讯 VOD...');
            const uploader = tcVod.upload({
                mediaFile: file,
                mediaName: title,
                enableResume: true,
            });
            uploader.on('media_progress', (info) => {
                uploadProgress(form, info?.percent || 0);
                uploadState(form, `正在上传到腾讯 VOD：${Math.round((Number(info?.percent) || 0) * 100)}%`);
            });
            const done = await uploader.done();
            const fileId = done?.fileId;
            if (!fileId) throw new Error('VOD 上传完成但没有返回 FileId。');
            uploadProgress(form, 1);
            uploadState(form, `VOD 上传完成，正在登记 FileId：${fileId}`);
            await postUrlencoded(form.dataset.completeUrl, {
                fileId,
                videoTitle: title,
                filename: file.name,
                folderCourseId,
                folderChapterId,
                size: String(file.size || 0),
                duration,
                coverUrl: done?.cover?.url || '',
                status: 'ready',
            });
            const params = new URLSearchParams();
            if (folderCourseId) params.set('courseId', folderCourseId);
            if (folderChapterId) params.set('chapterId', folderChapterId);
            const qs = params.toString();
            const target = `${form.dataset.returnUrl}${qs ? `?${qs}` : ''}`;
            uploadState(form, '登记完成，正在刷新视频库...');
            window.location.assign(target);
        } catch (err) {
            uploadState(form, `上传失败：${err?.message || err}`);
            if (button) button.disabled = false;
        }
    });
}

async function ensureTcPlayer(data) {
    loadCssOnce(data.tcPlayerCss);
    await loadScriptOnce(data.tcPlayerJs);
    if (!window.TCPlayer) throw new Error('TCPlayer SDK 未正确初始化');
}

async function loadPlayInfo(config, target) {
    target.innerHTML = '<div class="cvv-placeholder">正在获取播放参数...</div>';
    const res = await fetch(config.playUrl, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
    });
    const text = await res.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch (err) {
        if (/^\s*</.test(text)) {
            throw new Error('播放接口返回了页面而不是 JSON。通常是未登录、路由未生效，或服务器返回了 Hydro 错误页；请重启 Hydro 后再试。');
        }
        throw new Error(`播放接口返回异常：${text.slice(0, 120)}`);
    }
    if (!res.ok || data.ok === false || data.error || data.message && !data.type) {
        throw new Error(data.message || data.error?.message || '获取播放参数失败');
    }
    if (data.type === 'url' && data.url) {
        target.innerHTML = `<video controls preload="metadata" playsinline src="${esc(data.url)}"></video>`;
        return;
    }
    if (data.type === 'tcplayer') {
        await ensureTcPlayer(data);
        const id = `cvv-tcplayer-${Date.now()}`;
        target.innerHTML = `<video id="${id}" preload="auto" playsinline webkit-playsinline style="width:100%;height:100%"></video>`;
        const options = {
            appID: String(data.appId),
            fileID: String(data.fileId),
            psign: data.psign,
            poster: data.coverUrl || undefined,
            autoplay: false,
            controls: true,
        };
        const player = window.TCPlayer(id, options);
        if (player?.on) {
            player.on('error', (err) => {
                target.querySelector('.cvv-player-error')?.remove();
                const tip = document.createElement('div');
                tip.className = 'cvv-player-error';
                tip.textContent = `播放失败：${err?.message || err?.code || '请检查 AppId、FileId、PlayKey 和视频审核状态'}`;
                target.appendChild(tip);
            });
        }
        return;
    }
    target.innerHTML = `
      <div class="cvv-placeholder">
        <p>${esc(data.message || '播放接口已返回，但前端播放器尚未接入。')}</p>
        <p>${esc(data.fileId || config.binding?.fileId || '')}</p>
      </div>
    `;
}

function renderBindForm(config, kind, ids) {
    if (!(config.canBindVideo ?? config.canManage)) return '';
    const binding = config.binding || {};
    const selected = binding.assetId || '';
    const hidden = Object.entries(ids).map(([key, value]) => `<input type="hidden" name="${key}" value="${esc(value)}">`).join('');
    return `
      <form class="cvv-bind" method="post" action="${esc(config.bindUrl)}">
        <input type="hidden" name="kind" value="${esc(kind)}">
        ${hidden}
        <label>
          讲解视频
          <select class="select" name="assetId">${assetOptionsByHierarchy(config.assets || [], selected)}</select>
        </label>
        <button class="rounded primary button" type="submit">保存视频绑定</button>
      </form>
    `;
}

function initCourseSubsec() {
    const config = window.UiContext?.courseVideoVod;
    if (!config || config.page !== 'course_subsec_detail') return;
    ensureStyle();
    if (document.getElementById('course-video-vod-section')) return;

    const firstSection = document.querySelector('.medium-9.columns > .section');
    if (!firstSection?.parentNode) return;

    const binding = config.binding;
    const asset = binding?.asset;
    const player = asset && config.canView ? `
      <div class="cvv-player" data-cvv-player>
        <div class="cvv-placeholder">
          <button type="button" class="rounded primary button" data-cvv-load-play>
            <span class="icon icon-play"></span> 加载讲解视频
          </button>
        </div>
      </div>
    ` : `
      <div class="cvv-placeholder">
        ${asset ? '本节视频暂未对学生开放。' : '本节暂未绑定讲解视频。'}
      </div>
    `;

    const toggle = config.canToggleStudentVideo && asset ? `
      <form method="post" action="${esc(config.toggleCourseUrl)}">
        <input type="hidden" name="courseId" value="${esc(config.course.courseId)}">
        <button class="rounded button${config.course.studentVideoEnabled ? ' primary' : ''}" type="submit">
          ${config.course.studentVideoEnabled ? '关闭学生端显示视频' : '开启学生端显示视频'}
        </button>
      </form>
    ` : '';
    const fold = `
      <button type="button" class="rounded button" data-cvv-toggle-fold>
        折叠视频
      </button>
    `;

    const section = document.createElement('div');
    section.id = 'course-video-vod-section';
    section.className = 'section cvv-section';
    section.innerHTML = `
      <div class="section__header cvv-head">
        <div class="cvv-title"><span class="icon icon-play"></span> 本节讲解视频</div>
        <div class="cvv-actions">${fold}${toggle}</div>
      </div>
      <div class="section__body">
        ${player}
      </div>
    `;
    firstSection.parentNode.insertBefore(section, firstSection.nextSibling);

    const foldButton = section.querySelector('[data-cvv-toggle-fold]');
    if (foldButton) {
        foldButton.addEventListener('click', () => {
            const collapsed = section.classList.toggle('is-collapsed');
            foldButton.textContent = collapsed ? '展开视频' : '折叠视频';
        });
    }

    const load = section.querySelector('[data-cvv-load-play]');
    if (load) {
        load.addEventListener('click', () => loadPlayInfo(config, section.querySelector('[data-cvv-player]')).catch((err) => {
            section.querySelector('[data-cvv-player]').innerHTML = `<div class="cvv-placeholder">${esc(err.message || err)}</div>`;
        }));
    }
}

function initContestDetail() {
    const config = window.UiContext?.courseVideoVod;
    if (!config || config.page !== 'contest_detail') return;
    ensureStyle();
    if (document.getElementById('course-video-vod-contest-section')) return;

    const firstSection = document.querySelector('.medium-9.columns > .section') || document.querySelector('.section');
    if (!firstSection?.parentNode) return;

    const binding = config.binding || {};
    const asset = binding?.asset;
    const player = asset && config.canView && config.playUrl ? `
      <div class="cvv-player" data-cvv-player>
        <div class="cvv-placeholder">
          <button type="button" class="rounded primary button" data-cvv-load-play>
            <span class="icon icon-play"></span> 加载赛后讲解视频
          </button>
        </div>
      </div>
    ` : `
      <div class="cvv-placeholder">
        ${asset
        ? (config.attended ? '比赛完成后可查看赛后讲解视频，VP 未完成时不会开放。' : '参加并完成比赛后可查看赛后讲解视频。')
        : '本比赛暂未绑定赛后讲解视频。'}
      </div>
    `;
    const section = document.createElement('div');
    section.id = 'course-video-vod-contest-section';
    section.className = 'section cvv-section';
    section.innerHTML = `
      <div class="section__header cvv-head">
        <div class="cvv-title"><span class="icon icon-play"></span> 赛后讲解视频</div>
      </div>
      <div class="section__body">
        ${player}
      </div>
    `;
    firstSection.parentNode.insertBefore(section, firstSection.nextSibling);

    const load = section.querySelector('[data-cvv-load-play]');
    if (load) {
        load.addEventListener('click', () => loadPlayInfo(config, section.querySelector('[data-cvv-player]')).catch((err) => {
            section.querySelector('[data-cvv-player]').innerHTML = `<div class="cvv-placeholder">${esc(err.message || err)}</div>`;
        }));
    }
}

function initPackageLessonEdit() {
    const config = window.UiContext?.courseVideoVod;
    if (!config || config.page !== 'course_package_lesson_edit' || !(config.canBindVideo ?? config.canManage)) return;
    ensureStyle();
    if (document.getElementById('course-video-vod-package-panel')) return;

    const form = document.querySelector('.course-package-lesson-edit form');
    const desc = form?.querySelector('textarea[name="content"]')?.closest('label');
    if (!form || !desc) return;

    const panel = document.createElement('div');
    panel.id = 'course-video-vod-package-panel';
    panel.className = 'cvv-package-panel';
    if (!config.savedLesson) {
        panel.innerHTML = `
          <strong><span class="icon icon-play"></span> 讲解视频</strong>
          <p>新建节需要先保存一次，再回来绑定讲解视频。</p>
          <p><a class="rounded button" href="${esc(config.libraryUrl)}" target="_blank">打开视频库</a></p>
        `;
    } else {
        panel.innerHTML = `
          <strong><span class="icon icon-play"></span> 讲解视频</strong>
          <div class="cvv-meta">${bindingMetaRich(config.binding)}</div>
          ${renderBindForm(config, 'packageLesson', {
            packageId: config.packageLesson.packageId,
            versionId: config.packageLesson.versionId,
            chapterId: config.packageLesson.chapterId,
            lessonId: config.packageLesson.lessonId,
          })}
          <p class="help-text">课程包同步到子域课程时，只同步视频绑定，不复制视频文件。</p>
        `;
    }
    form.insertBefore(panel, desc);
}

addPage(new NamedPage(['course_subsec_detail'], initCourseSubsec));
addPage(new NamedPage(['contest_detail'], initContestDetail));
addPage(new NamedPage(['course_package_lesson_edit', 'course_package_lesson_create'], initPackageLessonEdit));
addPage(new NamedPage(['course_video_main', 'course_video_folder_create', 'course_video_manual_register'], initVideoMain));
