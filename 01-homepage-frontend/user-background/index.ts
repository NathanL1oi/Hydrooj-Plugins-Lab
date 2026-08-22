import {
    Context, FileLimitExceededError, FileUploadError, Handler, NotFoundError, PRIV,
    StorageModel, Types, ValidationError, db, post, randomstring,
} from 'hydrooj';
import { createReadStream, readFileSync, statSync } from 'fs';
import { join } from 'path';

const configColl = db.collection('user.background');
const imageColl = db.collection('user.background.image');
const MAX_IMAGE_SIZE = 8 * 1024 * 1024;
const MIN_IMAGE_WIDTH = 1920;
const MIN_IMAGE_HEIGHT = 1080;
const MAX_IMAGE_EDGE = 4096;
const RECOMMENDED_IMAGE_SIZE = '2560×1440 或 3120×2080';
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const DEFAULT_OPACITY = 0.3;
const CONFIG_CACHE_TTL = 60 * 1000;
const BUILTIN_DEFAULT_IMAGE_ID = 'default';
const BUILTIN_DEFAULT_IMAGE_NAME = 'default';
const BUILTIN_DEFAULT_IMAGE_FILENAME = 'default-background.png';
const BUILTIN_DEFAULT_IMAGE_PATH = join(__dirname, 'assets', BUILTIN_DEFAULT_IMAGE_FILENAME);
let builtinDefaultImageInfoCache: ImageInfo | null | undefined;
const configResponseCache = new Map<number, {
    expiresAt: number;
    etag: string;
    lastModified: Date;
    body: ReturnType<typeof publicConfig>;
}>();

interface UserBackgroundDoc {
    uid: number;
    imageId?: string;
    filename?: string;
    enabled: boolean;
    opacity: number;
    updatedAt: Date;
}

interface BackgroundImageDoc {
    _id: string;
    name: string;
    filename: string;
    owner: number;
    size: number;
    width?: number;
    height?: number;
    mime?: string;
    createdAt: Date;
    updatedAt: Date;
    builtin?: boolean;
}

interface ImageInfo {
    ext: string;
    mime: string;
    width: number;
    height: number;
}

function getExt(filename: string) {
    const match = String(filename || '').toLowerCase().match(/\.[a-z0-9]+$/);
    return match ? match[0] : '';
}

function isPng(data: Buffer) {
    return data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

function readPngInfo(data: Buffer): ImageInfo | null {
    if (!isPng(data)) return null;
    return {
        ext: '.png',
        mime: 'image/png',
        width: data.readUInt32BE(16),
        height: data.readUInt32BE(20),
    };
}

function readJpegInfo(data: Buffer): ImageInfo | null {
    if (data.length < 12 || data[0] !== 0xff || data[1] !== 0xd8) return null;
    let offset = 2;
    while (offset + 4 < data.length) {
        if (data[offset] !== 0xff) {
            offset++;
            continue;
        }
        const marker = data[offset + 1];
        offset += 2;
        if (marker === 0xd9 || marker === 0xda) break;
        if (marker >= 0xd0 && marker <= 0xd7) continue;
        if (offset + 2 > data.length) break;
        const length = data.readUInt16BE(offset);
        if (length < 2 || offset + length > data.length) break;
        if (
            marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc3
            || marker === 0xc5 || marker === 0xc6 || marker === 0xc7
            || marker === 0xc9 || marker === 0xca || marker === 0xcb
            || marker === 0xcd || marker === 0xce || marker === 0xcf
        ) {
            return {
                ext: '.jpg',
                mime: 'image/jpeg',
                width: data.readUInt16BE(offset + 5),
                height: data.readUInt16BE(offset + 3),
            };
        }
        offset += length;
    }
    return null;
}

function readUInt24LE(data: Buffer, offset: number) {
    return data[offset] + (data[offset + 1] << 8) + (data[offset + 2] << 16);
}

function readWebpInfo(data: Buffer): ImageInfo | null {
    if (data.length < 30 || data.subarray(0, 4).toString('ascii') !== 'RIFF' || data.subarray(8, 12).toString('ascii') !== 'WEBP') {
        return null;
    }
    const chunk = data.subarray(12, 16).toString('ascii');
    if (chunk === 'VP8X' && data.length >= 30) {
        return {
            ext: '.webp',
            mime: 'image/webp',
            width: readUInt24LE(data, 24) + 1,
            height: readUInt24LE(data, 27) + 1,
        };
    }
    if (chunk === 'VP8 ' && data.length >= 30 && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
        return {
            ext: '.webp',
            mime: 'image/webp',
            width: data.readUInt16LE(26) & 0x3fff,
            height: data.readUInt16LE(28) & 0x3fff,
        };
    }
    if (chunk === 'VP8L' && data.length >= 25 && data[20] === 0x2f) {
        const b1 = data[21];
        const b2 = data[22];
        const b3 = data[23];
        const b4 = data[24];
        return {
            ext: '.webp',
            mime: 'image/webp',
            width: 1 + b1 + ((b2 & 0x3f) << 8),
            height: 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)),
        };
    }
    return null;
}

function readImageInfo(data: Buffer): ImageInfo | null {
    return readPngInfo(data) || readJpegInfo(data) || readWebpInfo(data);
}

function validateImageInfo(info: ImageInfo | null) {
    if (!info) {
        throw new ValidationError('file', null, '只支持 JPG、PNG、WebP 图片，且必须是真实图片文件。');
    }
    if (!Number.isFinite(info.width) || !Number.isFinite(info.height) || info.width <= 0 || info.height <= 0) {
        throw new ValidationError('file', null, '无法读取图片尺寸，请换一张图片。');
    }
    if (info.width < MIN_IMAGE_WIDTH || info.height < MIN_IMAGE_HEIGHT) {
        throw new ValidationError('file', null, `图片尺寸至少需要 ${MIN_IMAGE_WIDTH}×${MIN_IMAGE_HEIGHT}，推荐 ${RECOMMENDED_IMAGE_SIZE}。`);
    }
    if (Math.max(info.width, info.height) > MAX_IMAGE_EDGE) {
        throw new ValidationError('file', null, `图片长边不能超过 ${MAX_IMAGE_EDGE}px，请先压缩后上传。`);
    }
    return info;
}

function normalizeOpacity(value: any) {
    const opacity = Number(value);
    if (!Number.isFinite(opacity)) return DEFAULT_OPACITY;
    return Math.max(0, Math.min(opacity, 1));
}

function normalizeFilename(name: string, detectedExt?: string) {
    const ext = detectedExt || getExt(name);
    if (!IMAGE_EXTS.has(ext)) {
        throw new ValidationError('file', null, '只支持 JPG、PNG、WebP 背景图片。');
    }
    const base = String(name || 'background')
        .replace(/\.[^.]+$/, '')
        .replace(/[^\w.-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'background';
    return `${Date.now()}-${base}-${randomstring(6)}${ext}`;
}

function normalizeImageName(name: any) {
    const value = String(name || '').trim().replace(/\s+/g, ' ');
    if (!value) throw new ValidationError('name');
    if (value.toLowerCase() === BUILTIN_DEFAULT_IMAGE_NAME) {
        throw new ValidationError('name', null, 'The name "default" is reserved for the built-in background.');
    }
    return value.slice(0, 60);
}

function normalizeImageId(value: any) {
    return String(value || '').trim();
}

function isSafeImageId(value: string) {
    return /^[A-Za-z0-9_-]{6,80}$/.test(value);
}

function newImageId() {
    return `${Date.now()}-${randomstring(8)}`;
}

function imageStoragePath(image: Pick<BackgroundImageDoc, '_id' | 'filename'>) {
    return `user-background/library/${image._id}/${image.filename}`;
}

function backgroundImageFileUrl(image: Pick<BackgroundImageDoc, '_id' | 'filename'>) {
    return `/home/background/file/${encodeURIComponent(image._id)}/${encodeURIComponent(image.filename)}`;
}

function imageVersion(image: BackgroundImageDoc) {
    const time = new Date(image.updatedAt || image.createdAt).getTime();
    return Number.isFinite(time) ? String(time) : '';
}

function imageLastModified(image: BackgroundImageDoc) {
    const date = new Date(image.updatedAt || image.createdAt);
    return Number.isFinite(date.getTime()) ? date : new Date(0);
}

function imageEtag(image: BackgroundImageDoc, size = image.size || 0) {
    return `"user-background-${image._id}-${imageVersion(image)}-${size}"`;
}

function requestHeader(handler: Handler, name: string) {
    const headers = handler.request.headers || {};
    return String(headers[name.toLowerCase()] || headers[name] || '');
}

function requestHasFreshCache(handler: Handler, etag: string, lastModified: Date) {
    const ifNoneMatch = requestHeader(handler, 'if-none-match');
    if (ifNoneMatch) {
        const tags = ifNoneMatch.split(',').map((item) => item.trim());
        if (tags.includes('*') || tags.includes(etag)) return true;
    }
    const ifModifiedSince = requestHeader(handler, 'if-modified-since');
    if (!ifModifiedSince) return false;
    const since = new Date(ifModifiedSince);
    return Number.isFinite(since.getTime()) && Math.floor(lastModified.getTime() / 1000) <= Math.floor(since.getTime() / 1000);
}

function setImageCacheHeaders(handler: Handler, image: BackgroundImageDoc, size = image.size || 0) {
    const etag = imageEtag(image, size);
    const lastModified = imageLastModified(image);
    handler.response.addHeader('Cache-Control', 'private, max-age=31536000, immutable');
    handler.response.addHeader('ETag', etag);
    handler.response.addHeader('Last-Modified', lastModified.toUTCString());
    return { etag, lastModified };
}

function versionedImageUrl(image: BackgroundImageDoc) {
    const url = backgroundImageFileUrl(image);
    const version = imageVersion(image);
    return version ? `${url}?v=${version}` : url;
}

function formatSize(size: any) {
    const value = Number(size || 0);
    if (!Number.isFinite(value) || value <= 0) return '-';
    if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatDimensions(width?: number, height?: number) {
    if (!width || !height) return '';
    return `${width}×${height}`;
}

function builtinDefaultImageInfo() {
    if (builtinDefaultImageInfoCache !== undefined) return builtinDefaultImageInfoCache;
    builtinDefaultImageInfoCache = readImageInfo(readFileSync(BUILTIN_DEFAULT_IMAGE_PATH));
    return builtinDefaultImageInfoCache;
}

function renderImage(image: BackgroundImageDoc) {
    const dimensionText = formatDimensions(image.width, image.height);
    return {
        id: image._id,
        name: image.name,
        filename: image.filename,
        owner: image.owner,
        size: image.size || 0,
        sizeText: image.builtin ? '内置默认' : formatSize(image.size),
        width: image.width || 0,
        height: image.height || 0,
        dimensionText,
        metaText: [image.builtin ? '内置默认' : formatSize(image.size), dimensionText].filter(Boolean).join(' · '),
        createdAt: image.createdAt,
        updatedAt: image.updatedAt,
        url: versionedImageUrl(image),
        builtin: !!image.builtin,
    };
}

function builtinDefaultImage(): BackgroundImageDoc {
    const stat = statSync(BUILTIN_DEFAULT_IMAGE_PATH);
    const info = builtinDefaultImageInfo();
    return {
        _id: BUILTIN_DEFAULT_IMAGE_ID,
        name: BUILTIN_DEFAULT_IMAGE_NAME,
        filename: BUILTIN_DEFAULT_IMAGE_FILENAME,
        owner: 0,
        size: stat.size,
        width: info?.width,
        height: info?.height,
        mime: info?.mime,
        createdAt: stat.mtime,
        updatedAt: stat.mtime,
        builtin: true,
    };
}

function isBuiltinDefaultImage(image: BackgroundImageDoc | null) {
    return !!image && (
        image.builtin
        || image._id === BUILTIN_DEFAULT_IMAGE_ID
        || image.name?.toLowerCase() === BUILTIN_DEFAULT_IMAGE_NAME
    );
}

async function getConfig(uid: number): Promise<UserBackgroundDoc | null> {
    return await configColl.findOne({ uid }) as UserBackgroundDoc | null;
}

async function setConfig(uid: number, patch: Partial<UserBackgroundDoc>) {
    const update: any = {
        $set: {
            uid,
            enabled: patch.enabled ?? true,
            opacity: normalizeOpacity(patch.opacity),
            updatedAt: new Date(),
        },
        $unset: { filename: '' },
    };
    if (patch.imageId !== undefined) {
        const imageId = normalizeImageId(patch.imageId);
        if (imageId) update.$set.imageId = imageId;
        else update.$unset.imageId = '';
    }
    await configColl.updateOne({ uid }, update, { upsert: true });
    clearConfigCache(uid);
}

async function getImage(imageId?: string): Promise<BackgroundImageDoc | null> {
    const id = normalizeImageId(imageId);
    if (id === BUILTIN_DEFAULT_IMAGE_ID) return builtinDefaultImage();
    if (!id || !isSafeImageId(id)) return null;
    return await imageColl.findOne({ _id: id }) as BackgroundImageDoc | null;
}

async function listImages(): Promise<BackgroundImageDoc[]> {
    const images = await imageColl.find({}).sort({ createdAt: -1, _id: -1 }).toArray() as BackgroundImageDoc[];
    return [
        builtinDefaultImage(),
        ...images.filter((image) => !isBuiltinDefaultImage(image)),
    ];
}

async function getSelectedImage(config: UserBackgroundDoc | null) {
    if (!config) return builtinDefaultImage();
    if (!config.imageId) return null;
    const image = await getImage(config.imageId);
    return isBuiltinDefaultImage(image) ? builtinDefaultImage() : image;
}

function publicConfig(doc: UserBackgroundDoc | null, image: BackgroundImageDoc | null) {
    const url = image ? versionedImageUrl(image) : '';
    return {
        enabled: doc ? !!(doc.enabled && image) : !!image,
        opacity: doc ? normalizeOpacity(doc.opacity) : DEFAULT_OPACITY,
        url,
    };
}

function clearConfigCache(uid?: number) {
    if (typeof uid === 'number') configResponseCache.delete(uid);
    else configResponseCache.clear();
}

function configResponseEtag(uid: number, config: UserBackgroundDoc | null, image: BackgroundImageDoc | null) {
    const configTime = config ? new Date(config.updatedAt).getTime() : 0;
    const imagePart = image ? `${image._id}-${imageVersion(image)}-${image.size || 0}` : 'none';
    return `"user-background-config-${uid}-${Number.isFinite(configTime) ? configTime : 0}-${imagePart}"`;
}

function configResponseLastModified(config: UserBackgroundDoc | null, image: BackgroundImageDoc | null) {
    const times = [
        config ? new Date(config.updatedAt).getTime() : 0,
        image ? imageLastModified(image).getTime() : 0,
    ].filter((time) => Number.isFinite(time) && time > 0);
    return times.length ? new Date(Math.max(...times)) : new Date(0);
}

async function getCachedPublicConfig(uid: number) {
    const now = Date.now();
    const cached = configResponseCache.get(uid);
    if (cached && cached.expiresAt > now) return cached;
    const config = await getConfig(uid);
    const image = await getSelectedImage(config);
    const entry = {
        expiresAt: now + CONFIG_CACHE_TTL,
        etag: configResponseEtag(uid, config, image),
        lastModified: configResponseLastModified(config, image),
        body: publicConfig(config, image),
    };
    configResponseCache.set(uid, entry);
    return entry;
}

function setConfigCacheHeaders(handler: Handler, entry: { etag: string; lastModified: Date }) {
    handler.response.addHeader('Cache-Control', 'private, no-cache');
    handler.response.addHeader('ETag', entry.etag);
    handler.response.addHeader('Last-Modified', entry.lastModified.toUTCString());
}

async function ensureIndexes() {
    await Promise.all([
        configColl.createIndex({ uid: 1 }).catch(() => null),
        configColl.createIndex({ imageId: 1 }).catch(() => null),
        imageColl.createIndex({ createdAt: -1, _id: -1 }).catch(() => null),
    ]);
}

async function deleteLibraryImage(image: BackgroundImageDoc, operator: number) {
    await StorageModel.del([imageStoragePath(image)], operator).catch(() => null);
}

class UserBackgroundHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }

    async get() {
        const config = await getConfig(this.user._id);
        const images = await listImages();
        const selectedImage = await getSelectedImage(config);
        this.response.template = 'user_background.html';
        this.response.body = {
            config: {
                enabled: config ? !!(config.enabled && selectedImage) : !!selectedImage,
                opacity: config ? normalizeOpacity(config.opacity) : DEFAULT_OPACITY,
                imageId: selectedImage?._id || '',
            },
            images: images.map(renderImage),
            imageUrl: selectedImage ? versionedImageUrl(selectedImage) : '',
            maxImageSizeMB: Math.floor(MAX_IMAGE_SIZE / 1024 / 1024),
            defaultOpacityPercent: Math.round(DEFAULT_OPACITY * 100),
        };
    }

    async post() {
        if (this.request.body?.operation) return;
        const imageId = normalizeImageId(this.request.body?.imageId);
        const selectedImage = imageId ? await getImage(imageId) : null;
        if (imageId && !selectedImage) throw new ValidationError('imageId');
        await setConfig(this.user._id, {
            enabled: !!(this.request.body?.enabled && selectedImage),
            opacity: this.request.body?.opacity,
            imageId: selectedImage?._id || '',
        });
        this.response.redirect = this.url('user_background');
    }
}

class UserBackgroundManageHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
    }

    async get() {
        const images = await listImages();
        this.response.template = 'user_background_manage.html';
        this.response.body = {
            images: images.map(renderImage),
            maxImageSizeMB: Math.floor(MAX_IMAGE_SIZE / 1024 / 1024),
            minImageWidth: MIN_IMAGE_WIDTH,
            minImageHeight: MIN_IMAGE_HEIGHT,
            maxImageEdge: MAX_IMAGE_EDGE,
            recommendedImageSize: RECOMMENDED_IMAGE_SIZE,
        };
    }

    async post() {
        if (this.request.body?.operation) return;
        this.response.redirect = this.url('user_background_manage');
    }

    @post('name', Types.String)
    async postUpload(domainId: string, name: string) {
        const file = this.request.files?.file;
        if (!file) throw new ValidationError('file');
        const uploadedSize = Number(file.size || 0);
        if (!file.filepath || uploadedSize <= 0) {
            throw new ValidationError('file', null, 'Uploaded image is empty.');
        }
        if (uploadedSize > MAX_IMAGE_SIZE) throw new FileLimitExceededError('size');
        const imageInfo = validateImageInfo(readImageInfo(readFileSync(file.filepath)));

        const now = new Date();
        const image: BackgroundImageDoc = {
            _id: newImageId(),
            name: normalizeImageName(name),
            filename: normalizeFilename(file.originalFilename || 'background.png', imageInfo.ext),
            owner: this.user._id,
            size: uploadedSize,
            width: imageInfo.width,
            height: imageInfo.height,
            mime: imageInfo.mime,
            createdAt: now,
            updatedAt: now,
        };
        await StorageModel.put(imageStoragePath(image), file.filepath, this.user._id);
        const meta = await StorageModel.getMeta(imageStoragePath(image));
        if (!meta?.size) {
            await deleteLibraryImage(image, this.user._id);
            throw new FileUploadError();
        }
        image.size = Number(meta.size || uploadedSize);
        await imageColl.insertOne(image);
        this.response.redirect = this.url('user_background_manage');
    }

    @post('imageId', Types.String)
    async postDelete(domainId: string, imageId: string) {
        const image = await getImage(imageId);
        if (!image) throw new NotFoundError(imageId);
        await deleteLibraryImage(image, this.user._id);
        await imageColl.deleteOne({ _id: image._id });
        await configColl.updateMany({ imageId: image._id }, {
            $set: { enabled: false, updatedAt: new Date() },
            $unset: { imageId: '' },
        });
        clearConfigCache();
        this.response.redirect = this.url('user_background_manage');
    }
}

class UserBackgroundConfigHandler extends Handler {
    async get() {
        if (!this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) {
            const entry = {
                etag: '"user-background-config-guest"',
                lastModified: new Date(0),
                body: { enabled: false, opacity: 0, url: '' },
            };
            setConfigCacheHeaders(this, entry);
            if (requestHasFreshCache(this, entry.etag, entry.lastModified)) {
                this.response.status = 304;
                return;
            }
            this.response.body = entry.body;
            return;
        }
        const entry = await getCachedPublicConfig(this.user._id);
        setConfigCacheHeaders(this, entry);
        if (requestHasFreshCache(this, entry.etag, entry.lastModified)) {
            this.response.status = 304;
            return;
        }
        this.response.body = entry.body;
    }
}

class UserBackgroundFileHandler extends Handler {
    async get() {
        const imageId = normalizeImageId(this.request.params?.imageId);
        const filename = String(this.request.params?.filename || '');
        if (!this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) throw new NotFoundError(filename);
        const image = await getImage(imageId);
        if (!image || image.filename !== filename) throw new NotFoundError(filename);
        if (image.builtin) {
            const stat = statSync(BUILTIN_DEFAULT_IMAGE_PATH);
            const cache = setImageCacheHeaders(this, image, stat.size);
            if (requestHasFreshCache(this, cache.etag, cache.lastModified)) {
                this.response.status = 304;
                return;
            }
            this.response.type = 'image/png';
            this.response.addHeader('Content-Length', String(stat.size));
            this.response.body = createReadStream(BUILTIN_DEFAULT_IMAGE_PATH);
            return;
        }
        const target = imageStoragePath(image);
        const meta = await StorageModel.getMeta(target);
        if (!meta) throw new NotFoundError(filename);
        const cache = setImageCacheHeaders(this, image, Number(meta.size || image.size || 0));
        if (requestHasFreshCache(this, cache.etag, cache.lastModified)) {
            this.response.status = 304;
            return;
        }
        if (meta['Content-Type']) this.response.type = meta['Content-Type'];
        if (meta.size) this.response.addHeader('Content-Length', String(meta.size));
        this.response.body = await StorageModel.get(target);
    }
}

export async function apply(ctx: Context) {
    await ensureIndexes();
    ctx.Route('user_background', '/home/background', UserBackgroundHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('user_background_manage', '/manage/user-background', UserBackgroundManageHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('user_background_config', '/home/background/config', UserBackgroundConfigHandler);
    ctx.Route('user_background_file', '/home/background/file/:imageId/:filename', UserBackgroundFileHandler, PRIV.PRIV_USER_PROFILE);
    ctx.injectUI('UserDropdown', 'user_background', { icon: 'insert--image', displayName: '背景设置' }, PRIV.PRIV_USER_PROFILE);
    ctx.injectUI('ControlPanel', 'user_background_manage', { icon: 'insert--image', displayName: '背景图库' }, PRIV.PRIV_EDIT_SYSTEM);
    ctx.i18n.load('zh', {
        user_background: '背景设置',
        user_background_manage: '背景图库',
    });
    ctx.i18n.load('en', {
        user_background: 'Background',
        user_background_manage: 'Background Library',
    });
}
