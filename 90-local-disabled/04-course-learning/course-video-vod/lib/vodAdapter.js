'use strict';

const crypto = require('crypto');
const https = require('https');

const TCPLAYER_CSS = 'https://web.sdk.qcloud.com/player/tcplayer/release/v4.6.0/tcplayer.min.css';
const TCPLAYER_JS = 'https://web.sdk.qcloud.com/player/tcplayer/release/v4.6.0/tcplayer.v4.6.0.min.js';

function clean(value) {
    return String(value || '').trim();
}

function numericId(value) {
    const text = clean(value);
    return /^\d+$/.test(text) ? Number(text) : 0;
}

function vodAppId(config) {
    return numericId(config?.subAppId) || numericId(config?.appId);
}

function ensureVodApp(config) {
    if (!vodAppId(config)) {
        throw new Error('请先在课程视频配置页填写 VOD AppId/SubAppId。');
    }
}

function ensureApiSecret(config) {
    if (!clean(config?.secretId) || !clean(config?.secretKey)) {
        throw new Error('请先在课程视频配置页填写腾讯云 API SecretId 和 SecretKey。');
    }
}

function hmacSha256(key, data, encoding) {
    return crypto.createHmac('sha256', key).update(data, 'utf8').digest(encoding);
}

function sha256Hex(data) {
    return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function base64Url(input) {
    return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signJwt(payload, key) {
    const header = { alg: 'HS256', typ: 'JWT' };
    const body = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
    const signature = hmacSha256(key, body, 'base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    return `${body}.${signature}`;
}

function httpsJson(host, headers, body) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            method: 'POST',
            hostname: host,
            path: '/',
            headers: {
                ...headers,
                'Content-Length': Buffer.byteLength(body),
            },
            timeout: 8000,
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let data;
                try {
                    data = JSON.parse(text || '{}');
                } catch (err) {
                    reject(new Error(`腾讯云 API 返回异常：${text.slice(0, 200)}`));
                    return;
                }
                const error = data?.Response?.Error;
                if (error) {
                    reject(new Error(`${error.Code || 'TencentCloudError'}: ${error.Message || '调用失败'}`));
                    return;
                }
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
                    return;
                }
                resolve(data.Response || data);
            });
        });
        req.on('timeout', () => req.destroy(new Error('腾讯云 API 请求超时')));
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

async function tencentCloudVodRequest(config, action, payload = {}) {
    ensureApiSecret(config);
    const service = 'vod';
    const host = 'vod.tencentcloudapi.com';
    const version = '2018-07-17';
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const body = JSON.stringify(payload);
    const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
    const signedHeaders = 'content-type;host;x-tc-action';
    const canonicalRequest = [
        'POST',
        '/',
        '',
        canonicalHeaders,
        signedHeaders,
        sha256Hex(body),
    ].join('\n');
    const credentialScope = `${date}/${service}/tc3_request`;
    const stringToSign = [
        'TC3-HMAC-SHA256',
        String(timestamp),
        credentialScope,
        sha256Hex(canonicalRequest),
    ].join('\n');
    const secretDate = hmacSha256(`TC3${config.secretKey}`, date);
    const secretService = hmacSha256(secretDate, service);
    const secretSigning = hmacSha256(secretService, 'tc3_request');
    const signature = hmacSha256(secretSigning, stringToSign, 'hex');
    const authorization = `TC3-HMAC-SHA256 Credential=${config.secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return await httpsJson(host, {
        Authorization: authorization,
        'Content-Type': 'application/json; charset=utf-8',
        Host: host,
        'X-TC-Action': action,
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Version': version,
    }, body);
}

async function resolvePlayKey(config) {
    if (clean(config?.playKey)) return clean(config.playKey);
    const appId = vodAppId(config);
    if (!clean(config?.secretId) || !clean(config?.secretKey)) {
        throw new Error('缺少播放密钥。请在 VOD 配置中填写播放密钥，或填写 API SecretId/SecretKey 让插件自动查询默认分发配置。');
    }
    const payload = {};
    if (appId) payload.SubAppId = appId;
    try {
        const response = await tencentCloudVodRequest(config, 'DescribeDefaultDistributionConfig', payload);
        if (response?.PlayKey) return response.PlayKey;
    } catch (err) {
        throw new Error(`自动查询 VOD 播放密钥失败：${err.message}`);
    }
    throw new Error('腾讯云默认分发配置未返回播放密钥，请在 VOD 配置中手动填写播放密钥。');
}

async function createUploadSignature(config, payload = {}) {
    ensureVodApp(config);
    ensureApiSecret(config);
    const now = Math.floor(Date.now() / 1000);
    const expire = now + Math.max(600, Math.min(Number(config.uploadExpireSeconds || 7200), 7776000));
    const params = [
        ['secretId', config.secretId],
        ['currentTimeStamp', now],
        ['expireTime', expire],
        ['random', crypto.randomInt(1, 0xffffffff)],
        ['vodSubAppId', vodAppId(config)],
    ];
    if (payload?.title || payload?.filename) {
        params.push(['sourceContext', JSON.stringify({
            title: payload.title || payload.filename,
            uid: String(payload.uid || ''),
            domainId: String(payload.domainId || ''),
        }).slice(0, 250)]);
    }
    const original = params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&');
    const signature = Buffer.concat([
        crypto.createHmac('sha1', config.secretKey).update(original, 'utf8').digest(),
        Buffer.from(original, 'utf8'),
    ]).toString('base64');
    return {
        ok: true,
        signature,
        appId: vodAppId(config),
        subAppId: vodAppId(config),
        expireTime: expire,
        mediaName: payload.title || payload.filename || '',
    };
}

async function createPlayInfo(config, asset, context) {
    ensureVodApp(config);
    const appId = vodAppId(config);
    const now = Math.floor(Date.now() / 1000);
    const expire = now + Math.max(300, Math.min(Number(config.playExpireSeconds || 1800), 86400));
    const playKey = await resolvePlayKey(config);
    const payload = {
        appId,
        fileId: asset.fileId,
        contentInfo: {
            audioVideoType: clean(config.audioVideoType) || 'Original',
        },
        currentTimeStamp: now,
        expireTimeStamp: expire,
        urlAccessInfo: {
            t: expire.toString(16),
            us: `hydro-${context?.uid || 'user'}-${now}`,
        },
    };
    return {
        ok: true,
        type: 'tcplayer',
        appId,
        fileId: asset.fileId,
        psign: signJwt(payload, playKey),
        title: asset.title,
        coverUrl: asset.coverUrl || '',
        expiresAt: expire,
        tcPlayerCss: clean(config.tcPlayerCss) || TCPLAYER_CSS,
        tcPlayerJs: clean(config.tcPlayerJs) || TCPLAYER_JS,
    };
}

async function deleteMedia(config, asset) {
    ensureVodApp(config);
    ensureApiSecret(config);
    const fileId = clean(asset?.fileId);
    if (!fileId || fileId.startsWith('local:')) throw new Error('缺少可删除的 VOD FileId。');
    const payload = {
        FileId: fileId,
        // Empty DeleteParts means delete the media and all generated processing files.
        DeleteParts: [],
    };
    const appId = vodAppId(config);
    if (appId) payload.SubAppId = appId;
    return await tencentCloudVodRequest(config, 'DeleteMedia', payload);
}

module.exports = {
    createUploadSignature,
    createPlayInfo,
    deleteMedia,
};
