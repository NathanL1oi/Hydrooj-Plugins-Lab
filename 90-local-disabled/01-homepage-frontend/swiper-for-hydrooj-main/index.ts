import {
    Context, FileLimitExceededError, FileUploadError, Handler, NotFoundError, PERM, StorageModel,
    Types, ValidationError, db, param, post, randomstring,
} from 'hydrooj';

const coll = db.collection('swiper');
const MAX_IMAGE_SIZE = 8 * 1024 * 1024;
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

interface SwiperSlide {
    title: string;
    img: string;
    url: string;
}

interface SwiperSetting {
    loop: boolean;
    autoplay: boolean;
    interval: number;
}

function storagePrefix(domainId: string) {
    return `swiper/${domainId}`;
}

function storagePath(domainId: string, filename: string) {
    return `${storagePrefix(domainId)}/${filename}`;
}

function getExt(filename: string) {
    const match = String(filename || '').toLowerCase().match(/\.[a-z0-9]+$/);
    return match ? match[0] : '';
}

function normalizeFilename(name: string) {
    const ext = getExt(name);
    if (!IMAGE_EXTS.has(ext)) throw new ValidationError('file', null, '仅支持 jpg、png、gif、webp、bmp 图片。');
    const base = String(name || 'swiper')
        .replace(/\.[^.]+$/, '')
        .replace(/[^\w.-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'swiper';
    return `${Date.now()}-${base}-${randomstring(6)}${ext}`;
}

function isSafeUrl(value: string, allowEmpty = true) {
    const text = String(value || '').trim();
    if (!text) return allowEmpty;
    if (/[\u0000-\u001f\u007f]/.test(text)) return false;
    if (/^(?:javascript|data|vbscript):/i.test(text)) return false;
    return text.startsWith('/') || /^https?:\/\//i.test(text);
}

function normalizeSlides(raw: any): SwiperSlide[] {
    if (!raw) return [];
    if (!Array.isArray(raw)) throw new ValidationError('config', null, '轮播配置必须是数组。');
    const slides: SwiperSlide[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const title = String(item.title || '').trim().slice(0, 80);
        const img = String(item.img || '').trim();
        const url = String(item.url || '').trim();
        if (!img) continue;
        if (!isSafeUrl(img, false)) throw new ValidationError('img', null, `图片地址不安全：${img}`);
        if (!isSafeUrl(url, true)) throw new ValidationError('url', null, `跳转地址不安全：${url}`);
        slides.push({ title, img, url });
    }
    return slides.slice(0, 20);
}

function normalizeSetting(data: any): SwiperSetting {
    return {
        loop: !!data?.loop,
        autoplay: !!data?.autoplay,
        interval: Math.max(1000, Math.min(Number(data?.interval) || 5000, 60000)),
    };
}

async function getSwiper(domainId: string): Promise<[SwiperSlide[], SwiperSetting]> {
    const data = await coll.findOne({ domainId });
    if (!data) return [[], normalizeSetting({})];
    return [normalizeSlides(data.config || []), normalizeSetting(data)];
}

async function setSwiper(domainId: string, sdocs: SwiperSlide[], ssdict: SwiperSetting) {
    await coll.updateOne({ domainId }, {
        $set: {
            loop: ssdict.loop,
            autoplay: ssdict.autoplay,
            interval: ssdict.interval,
            config: normalizeSlides(sdocs),
        },
    }, { upsert: true });
}

async function listImages(domainId: string, handler: Handler) {
    const files = await StorageModel.list(storagePrefix(domainId)).catch(() => []);
    return files.map((file: any) => {
        const name = file.name || file._id || String(file.path || '').split('/').pop();
        return {
            name,
            size: file.size || 0,
            lastModified: file.lastModified,
            url: handler.url('domain_swiper_file', { domainId, filename: name, noDisposition: true }),
        };
    }).filter((file) => file.name);
}

class DomainSwiperHandler extends Handler {
    domain: string;

    async prepare({ domainId }) {
        this.checkPerm(PERM.PERM_EDIT_DOMAIN);
        this.domain = domainId;
    }

    async get() {
        const [sdocs, ssdict] = await getSwiper(this.domain);
        this.response.template = 'domain_swiper.html';
        this.response.body = {
            initialize: !sdocs.length,
            domainId: this.domain,
            sdocs,
            ssdict,
            value: JSON.stringify(sdocs, null, 2),
            files: await listImages(this.domain, this),
        };
    }

    @param('loop', Types.Boolean)
    @param('autoplay', Types.Boolean)
    @param('interval', Types.Int)
    @param('value', Types.Content)
    async post({ domainId }, loop: boolean, autoplay: boolean, interval: number, value: string) {
        let sdocs: SwiperSlide[] = [];
        try {
            sdocs = normalizeSlides(JSON.parse(value || '[]'));
        } catch (e) {
            if (e instanceof ValidationError) throw e;
            throw new ValidationError('config', null, e.message);
        }
        await setSwiper(domainId, sdocs, normalizeSetting({ loop, autoplay, interval }));
        this.response.redirect = this.url('domain_swiper', { domainId });
    }

    @post('filename', Types.Filename, true)
    async postUploadImage({ domainId }, filename = '') {
        this.checkPerm(PERM.PERM_EDIT_DOMAIN);
        const file = this.request.files?.file;
        if (!file) throw new ValidationError('file');
        if (file.size && file.size > MAX_IMAGE_SIZE) throw new FileLimitExceededError('size');
        const finalName = normalizeFilename(filename || file.originalFilename || 'swiper.png');
        await StorageModel.put(storagePath(domainId, finalName), file.filepath, this.user._id);
        const meta = await StorageModel.getMeta(storagePath(domainId, finalName));
        if (!meta) throw new FileUploadError();
        this.response.redirect = this.url('domain_swiper', { domainId });
    }

    @post('files', Types.ArrayOf(Types.Filename))
    async postDeleteImages({ domainId }, files: string[]) {
        this.checkPerm(PERM.PERM_EDIT_DOMAIN);
        if (!files?.length) throw new ValidationError('files');
        await StorageModel.del(files.map((filename) => storagePath(domainId, filename)), this.user._id);
        this.response.redirect = this.url('domain_swiper', { domainId });
    }
}

class DomainSwiperFileHandler extends Handler {
    @param('filename', Types.Filename)
    @param('noDisposition', Types.Boolean)
    async get({ domainId }, filename: string, noDisposition = true) {
        const target = storagePath(domainId, filename);
        const meta = await StorageModel.getMeta(target);
        if (!meta) throw new NotFoundError(filename);
        this.response.addHeader('Cache-Control', 'public, max-age=31536000');
        this.response.redirect = await StorageModel.signDownloadLink(
            target, noDisposition ? undefined : filename, false, 'user',
        );
    }
}

export async function apply(ctx: Context) {
    ctx.withHandlerClass('HomeHandler', (HomeHandler) => {
        HomeHandler.prototype.getSwiper = getSwiper;
    });
    ctx.injectUI('DomainManage', 'domain_swiper', { family: 'Properties', icon: 'image' }, PERM.PERM_EDIT_DOMAIN);
    ctx.Route('domain_swiper', '/domain/swiper', DomainSwiperHandler, PERM.PERM_EDIT_DOMAIN);
    ctx.Route('domain_swiper_file', '/domain/swiper/file/:filename', DomainSwiperFileHandler);
    ctx.i18n.load('zh', {
        swiper: '轮播图',
        initialize: '初始化',
        domain_swiper: '轮播图配置',
        swiper_loop: '循环播放',
        swiper_autoplay: '自动播放',
        swiper_interval: '播放间隔',
        swiper_config: '详细配置',
    });
    ctx.i18n.load('en', {
        swiper: 'Swiper',
        initialize: 'Initialize',
        domain_swiper: 'Swiper Configuration',
        swiper_loop: 'Loop',
        swiper_autoplay: 'Autoplay',
        swiper_interval: 'Interval',
        swiper_config: 'Swiper Config',
    });
}
