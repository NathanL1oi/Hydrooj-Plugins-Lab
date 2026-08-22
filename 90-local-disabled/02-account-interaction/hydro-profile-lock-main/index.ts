import { Context, Handler, Logger, PRIV, Schema } from 'hydrooj';

const logger = new Logger('profile-lock');

export const Config = Schema.object({
    enabled: Schema.boolean().default(true),
    log: Schema.boolean().default(true),
    fields: Schema.array(Schema.string()).default([
        'avatar',
        'bio',
        'qq',
        'gender',
        'school',
        'studentId',
        'phone',
        'backgroundImage',
        'displayName',
    ]),
    reset: Schema.object({
        backgroundImage: Schema.string().default('/components/profile/backgrounds/1.jpg'),
    }).default({}),
});

function hasOwn(obj: object, key: string) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

function isTruthy(v: any) {
    if (v === undefined || v === null) return false;
    if (typeof v === 'boolean') return v;
    const s = String(v).trim().toLowerCase();
    return !!s && !['0', 'false', 'off', 'no'].includes(s);
}

function isValidBackgroundImage(value: string): boolean {
    return /^\/[\w\-\/.]+$/.test(value) && !value.includes('..');
}

function maskIp(ip: string): string {
    if (ip.includes('.')) return ip.replace(/\.\d+$/, '.***');
    if (ip.includes(':')) return ip.replace(/:[^:]+$/, ':***');
    return '***';
}

class ManageProfileLockHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
    }

    async get() {
        const enabled = !!this.ctx.setting.get('profile-lock.enabled');
        const log = !!this.ctx.setting.get('profile-lock.log');
        const fields = this.ctx.setting.get('profile-lock.fields') as string[] || [];
        const backgroundImage = this.ctx.setting.get('profile-lock.reset.backgroundImage') as string;

        this.response.template = 'manage_profile_lock.html';
        this.response.body = {
            enabled,
            log,
            fields,
            backgroundImage,
            saved: this.args.saved === '1',
            reset: this.args.reset === '1',
            bgInvalid: this.args.bgInvalid === '1',
            matched: /^\d+$/.test(String(this.args.matched || '')) ? this.args.matched : undefined,
            modified: /^\d+$/.test(String(this.args.modified || '')) ? this.args.modified : undefined,
        };
    }

    async postSave() {
        const enabled = isTruthy(this.args.enabled);
        const log = isTruthy(this.args.log);
        await Promise.all([
            this.ctx.setting.setConfig('profile-lock.enabled', enabled),
            this.ctx.setting.setConfig('profile-lock.log', log),
        ]);
        this.response.redirect = this.url('manage_profile_lock', { query: { saved: '1' } });
    }

    async postReset() {
        const rawBg = this.args.backgroundImage ? String(this.args.backgroundImage).trim() : undefined;
        if (rawBg && !isValidBackgroundImage(rawBg)) {
            this.response.redirect = this.url('manage_profile_lock', { query: { bgInvalid: '1' } });
            return;
        }
        if (rawBg) {
            await this.ctx.setting.setConfig('profile-lock.reset.backgroundImage', rawBg);
        }

        const background = (this.ctx.setting.get('profile-lock.reset.backgroundImage') as string)
            || '/components/profile/backgrounds/1.jpg';

        const userColl = this.ctx.db.collection('user' as any);
        const domainUserColl = this.ctx.db.collection('domain.user' as any);
        const updatePipeline: any[] = [{
            $set: {
                avatar: { $concat: ['gravatar:', { $ifNull: ['$mail', 'unknown@hydro.local'] }] },
                bio: null,
                qq: null,
                gender: 2,
                school: '',
                studentId: '',
                phone: null,
                backgroundImage: background,
            },
        }];
        const [res, duRes] = await Promise.all([
            userColl.updateMany({ _id: { $gte: 1 } }, updatePipeline),
            domainUserColl.updateMany({}, { $set: { displayName: '' } }),
        ]);
        logger.info(
            'Reset user profiles via manage: user matched=%d modified=%d, domain.user matched=%d modified=%d',
            res.matchedCount, res.modifiedCount, duRes.matchedCount, duRes.modifiedCount,
        );
        this.response.redirect = this.url('manage_profile_lock', {
            query: {
                reset: '1',
                matched: String(res.matchedCount),
                modified: String(res.modifiedCount),
            },
        });
    }
}

export function apply(ctx: Context, config: ReturnType<typeof Config>) {
    ctx.injectUI('ControlPanel', 'manage_profile_lock', { before: 'manage_config' }, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('manage_profile_lock', '/manage/profile-lock', ManageProfileLockHandler, PRIV.PRIV_EDIT_SYSTEM);

    ctx.i18n.load('zh', {
        manage_profile_lock: '个人信息锁定',
        'Profile Lock': '个人信息锁定',
        'Block User Profile Updates': '禁止用户修改个人信息',
        'Enable Block': '启用禁止',
        'Enable Log': '记录日志',
        'Locked Fields': '锁定字段',
        'Reset User Profiles': '重置用户个人信息',
        'Reset All Users Profiles': '重置所有用户个人信息',
        'Background Image': '背景图片',
        Saved: '已保存',
        'Invalid background image path.': '背景图片路径无效，仅允许以 / 开头的字母数字路径。',
        'Reset done. matched={0} modified={1}': '已重置。匹配={0} 修改={1}',
    });
    ctx.i18n.load('en', {
        manage_profile_lock: 'Profile Lock',
    });

    if (!config.enabled) return;
    const locked = new Set(config.fields);

    // Block updates from /home/settings/account (HomeSettingsHandler.post).
    ctx.on('handler/before/HomeSettings#post', (that) => {
        if (that.args.category !== 'account') return;

        const touched: string[] = [];
        for (const key of locked) {
            if (!hasOwn(that.args, key)) continue;
            delete that.args[key];
            touched.push(key);
        }
        if (that.args.booleanKeys && typeof that.args.booleanKeys === 'object') {
            for (const key of locked) delete that.args.booleanKeys[key];
        }
        if (config.log && touched.length) {
            logger.info(
                'Blocked profile update: uid=%d ip=%s fields=%s',
                that.user._id,
                maskIp(that.request.ip),
                touched.join(','),
            );
        }
    });

    // Block avatar upload / direct set from /home/avatar (HomeAvatarHandler.post).
    ctx.on('handler/before/HomeAvatar#post', (that) => {
        if (!locked.has('avatar')) return;
        if (config.log) logger.info('Blocked avatar update: uid=%d ip=%s', that.user._id, maskIp(that.request.ip));
        that.back();
        return 'after';
    });
}

