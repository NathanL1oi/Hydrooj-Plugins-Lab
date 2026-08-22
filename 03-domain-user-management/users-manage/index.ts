import {
    UserModel, SettingModel, DomainModel, TokenModel, BlackListModel, Handler, UserNotFoundError, UserAlreadyExistError, ValidationError, param, PERM, PRIV, Types, query, SystemModel, requireSudo
} from 'hydrooj';

export const inject = { geoip: { required: false } };

function set(s: Setting, key: string, value: any) {
    if (!s) return undefined;
    if (s.family === 'setting_storage') return undefined;
    if (s.flag & SettingModel.FLAG_DISABLED) return undefined;
    if ((s.flag & SettingModel.FLAG_SECRET) && !value) return undefined;
    if (s.validation && !s.validation(value)) throw new ValidationError(key);
    if (s.type === 'boolean') {
        if (value === 'on') return true;
        return false;
    }
    if (s.type === 'number') {
        if (!Number.isSafeInteger(+value)) throw new ValidationError(key);
        return +value;
    }
    if (s.type === 'float') {
        if (Number.isNaN(+value)) throw new ValidationError(key);
        return +value;
    }
    if (value) {
        if (['json', 'yaml', 'markdown', 'textarea'].includes(s.type)) {
            if (!Types.Content[1](value)) throw new ValidationError(key);
        }
        if (s.type === 'text') {
            if (!Types.ShortString[1](value)) throw new ValidationError(key);
        }
    }
    if (s.subType === 'yaml') {
        try {
            yaml.load(value);
        } catch (e) {
            throw new ValidationError(key);
        }
    }
    if (s.subType === 'json') {
        try {
            JSON.parse(value);
        } catch (e) {
            throw new ValidationError(key);
        }
    }
    return value;
}

//用户管理
class UsersManageHandler extends Handler {
    @requireSudo
    @query('page', Types.PositiveInt, true)
    @query('realname', Types.string, true)
    @query('groupName', Types.string, true)
    @query('banStatus', Types.string, true)
    @query('loginTime', Types.string, true)
    async get(domainId: string, page = 1, realname: string, groupName: string, banStatus: string, loginTime: string) {

        let filter = { _id: { $gte: 2 } };

        // 添加实名认证筛选逻辑
        if (realname === 'set') {
            filter.realname_name = { $exists: true };
        } else if (realname === 'notset') {
            filter.realname_name = { $exists: false };
        }

        const groups = await UserModel.listGroup(domainId);
        if (groupName) {
            if (groupName === 'ungrouped') {
                const allGroupUids = groups.reduce((acc, group) => {
                    return acc.concat(group.uids);
                }, []);
                filter._id = { $nin: allGroupUids, $gte: 2 };
            } else {
                const groupInfo = groups.find(g => g.name === groupName);
                if (groupInfo) {
                    filter._id = { $in: groupInfo.uids };
                }
            }
        }

        // 添加封禁状态筛选逻辑
        if (banStatus === 'banned') {
            filter.priv = PRIV.PRIV_NONE;  // 封禁用户权限为0
        } else if (banStatus === 'active') {
            filter.priv = { $ne: PRIV.PRIV_NONE };  // 未封禁用户权限不为0
        }

        // 添加登录时间筛选逻辑
        if (loginTime) {
            const now = new Date();
            let timeThreshold: Date;
            switch (loginTime) {
                case 'recent_day':
                    timeThreshold = new Date(now.getTime() - 24 * 60 * 60 * 1000);
                    filter.loginat = { $gte: timeThreshold };
                    break;
                case 'recent_week':
                    timeThreshold = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                    filter.loginat = { $gte: timeThreshold };
                    break;
                case 'recent_month':
                    timeThreshold = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                    filter.loginat = { $gte: timeThreshold };
                    break;
                case 'recent_half_year':
                    timeThreshold = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
                    filter.loginat = { $gte: timeThreshold };
                    break;
                case 'not_login_day':
                    timeThreshold = new Date(now.getTime() - 24 * 60 * 60 * 1000);
                    filter.loginat = { $lt: timeThreshold };
                    break;
                case 'not_login_week':
                    timeThreshold = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                    filter.loginat = { $lt: timeThreshold };
                    break;
                case 'not_login_month':
                    timeThreshold = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                    filter.loginat = { $lt: timeThreshold };
                    break;
                case 'not_login_half_year':
                    timeThreshold = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
                    filter.loginat = { $lt: timeThreshold };
                    break;
            }
        }

        const [dudocs, upcount] = await this.paginate(
            UserModel.getMulti(filter).sort({ _id: -1 }),
            page,
            'ranking'
        );
        const udict = await UserModel.getList(domainId, dudocs.map((x) => x._id));
        const udocs = dudocs.map((x) => udict[x._id]);
        this.response.template = 'users_manage.html';
        this.response.body = { udocs, upcount, page, realname, groupName, groups, banStatus, loginTime };
    }
}

//修改用户
class UserEditHandler extends Handler {
    @requireSudo
    @param('uid', Types.Int)
    async get(domainId: string, uid: number) {
        const [current, sdoc] = await Promise.all([
            UserModel.getById(domainId, uid),
            TokenModel.getMostRecentSessionByUid(uid, ['createAt', 'updateAt', 'updateIp', 'createIp']),
        ]);
        if (!current) throw new UserNotFoundError(uid);

        if (sdoc) {
            sdoc.updateGeoip = this.ctx.geoip?.lookup?.(
                sdoc.updateIp || sdoc.createIp,
                this.translate('geoip_locale'),
            );
        }
        const settings = SettingModel.ACCOUNT_SETTINGS;
        this.response.template = 'user_edit.html';
        this.response.body = { current, sdoc, settings };
    }

    @requireSudo
    @param('uid', Types.Int)
    async postBan(domainId: string, uid: number) {
        await UserModel.ban(uid, 'Banned by '+ this.user.uname );
        this.response.body = { success: true };
    }

    @requireSudo
    @param('uid', Types.Int)
    async postUnban(domainId: string, uid: number) {
        await UserModel.setPriv(uid, SystemModel.get('default.priv'));
        this.response.body = { success: true };
    }

    @requireSudo
    @param('uid', Types.Int)
    async postLogout(domainId: string, uid: number) {
        await TokenModel.delByUid(uid);
        this.response.body = { success: true };
    }

    @requireSudo
    @param('uid', Types.Int)
    @param('phone', Types.String, true)
    @param('mail', Types.Email)
    async postSetInfo(domainId: string, uid: number, phone: string, mail: string) {
        if (mail) {
            const mailDomain = mail.split('@')[1];
            if (await BlackListModel.get(`mail::${mailDomain}`)) throw new BlacklistedError(mailDomain);

            const existingUser = await UserModel.getByEmail(domainId, mail);
            if (existingUser && existingUser._id !== uid) {
                throw new UserAlreadyExistError(mail);
            }
        }
        const current = await UserModel.getById(domainId, uid)

        if (mail !== current.mail) {
            await UserModel.setEmail(uid, mail);
        }

        phone = phone?.trim();
        if (phone) {
            await UserModel.setById(uid, { phone });
        }
        else {
            await UserModel.setById(uid, undefined, { phone: '' });
        }
        this.response.body = { success: true };
    }

    @requireSudo
    @param('uid', Types.Int)
    @param('displayName', Types.String, true)
    async postSetDisplayname(domainId: string, uid: number, displayName: string) {
        await DomainModel.setUserInDomain(domainId, uid, { displayName: displayName || '' });
        this.response.body = { success: true };
    }

    @requireSudo
    @param('uid', Types.Int)
    async post(args: any, uid: number) {
        const $set = {};
        const booleanKeys = args.booleanKeys || {};
        delete args.booleanKeys;
        const setter = (s) => UserModel.setById(uid, s);
        const settings = SettingModel.SETTINGS_BY_KEY;
        for (const key in args) {
            const val = set(settings[key], key, args[key]);
            if (val !== undefined) $set[key] = val;
        }
        for (const key in booleanKeys) if (!args[key]) $set[key] = false;
        if (Object.keys($set).length) await setter($set);
        if (args.viewLang && args.viewLang !== this.session.viewLang) this.session.viewLang = '';
        this.response.body = { success: true };
    }
}

//实名设置
class RealnameSetHandler extends Handler {
    @query('uidOrName', Types.UidOrName, true)
    async get(domainId: string, uidOrName: string) {
        let flag = 0;
        let name = '';
        if(uidOrName){
            const udoc = await UserModel.getById(domainId, +uidOrName)
                || await UserModel.getByUname(domainId, uidOrName)
                || await UserModel.getByEmail(domainId, uidOrName);
            if(udoc){
                flag = udoc.realname_flag || 0;
                name = udoc.realname_name || udoc.displayName || '';
            }
        }
        this.response.template = 'realname_set.html';
        this.response.body = { uidOrName, flag, name };
    }

    @requireSudo
    @param('uidOrName', Types.UidOrName)
    @param('flag', Types.number, true)
    @param('name', Types.string, true)
    async post(domainId: string, uidOrName: string, flag: number, name: string) {
        // 检查输入
        flag = parseInt(flag, 10);
        const udoc = await UserModel.getById(domainId, +uidOrName)
            || await UserModel.getByUname(domainId, uidOrName)
            || await UserModel.getByEmail(domainId, uidOrName);
        if (!udoc)
            throw new UserNotFoundError(uidOrName);
        // 构建实名代码并更新
        if (flag === 0 && !name) {
            await UserModel.setById(udoc._id, undefined, { realname_flag: '', realname_name: '' });
        } else {
            if ([0, 1, 2].includes(flag)) {
                await UserModel.setById(udoc._id, { realname_flag: flag });
            }
            if (name) {
                await UserModel.setById(udoc._id, { realname_name: name.trim() });
            }
            else {
                await UserModel.setById(udoc._id, undefined, { realname_name: '' });
            }
        }
        this.response.redirect = this.url('realname_set');
    }
}

//导入实名用户
class RealnameImportHandler extends Handler {
    async get() {
        this.response.body.realnames = [];
        this.response.template = 'realname_import.html';
    }

    @param('realnames', Types.Content)
    @param('draft', Types.Boolean)
    async post(domainId: string, _realnames: string, draft: boolean) {
        const realnames = _realnames.split('\n');
        const udocs: { username: string, flag: number, name: string }[] = [];
        const messages = [];

        for (const i in realnames) {
            const u = realnames[i];
            if (!u.trim()) continue;
            let [username, flag, name] = u.split('\t').map((t) => t.trim());
            if (username && !flag && !name) {
                const data = u.split(',').map((t) => t.trim());
                [username, flag, name] = data;
            }

            if (!username) continue;
            flag = parseInt(flag, 10);

            // 验证用户是否存在
            const user = await UserModel.getByUname(domainId, username);
            if (!user) {
                messages.push(`Line ${+i + 1}: User ${username} not found.`);
                continue;
            }

            udocs.push({
                username, flag, name
            });
        }
        messages.push(`${udocs.length} realname records found.`);

        if (!draft) {
            for (const udoc of udocs) {
                try {
                    const user = await UserModel.getByUname(domainId, udoc.username);
                    if (!user) continue;

                    if (![0, 1, 2].includes(udoc.flag) && udoc.name === '') {
                        await UserModel.setById(user._id, undefined, { realname_flag: '', realname_name: '' });
                    } else {
                        if ([0, 1, 2].includes(udoc.flag)) {
                            await UserModel.setById(user._id, { realname_flag: udoc.flag });
                        }
                        if (udoc.name) {
                            await UserModel.setById(user._id, { realname_name: udoc.name });
                        }
                    }
                } catch (e) {
                    messages.push(e.message);
                }
            }
        }
        this.response.body.realnames = udocs;
        this.response.body.messages = messages;
    }
}

//用户名修改
class UsersUnameChangeHandler extends Handler {
    @requireSudo
    @query('uidOrName', Types.UidOrName, true)
    async get(domainId: string, uidOrName: string) {
        this.response.template = 'users_unamechange.html';
        this.response.body = { uidOrName };
    }

    @requireSudo
    @param('uidOrName', Types.UidOrName)
    @param('newUname', Types.Username)
    async post(domainId: string, uidOrName: string, newUname: string) {
        // 检查输入
        if (/^[+-]?\d+$/.test(newUname.trim()))
            throw new ValidationError(newUname,'',`用户名不能为纯数字`);
        const udoc = await UserModel.getById(domainId, +uidOrName)
            || await UserModel.getByUname(domainId, uidOrName)
            || await UserModel.getByEmail(domainId, uidOrName);
        if (!udoc)
            throw new UserNotFoundError(uidOrName);
        const udoc2 = await UserModel.getById(domainId, +newUname)
            || await UserModel.getByUname(domainId, newUname)
            || await UserModel.getByEmail(domainId, newUname);
        if (udoc2)
            throw new UserAlreadyExistError(newUname);

        if ((udoc.hasPriv(PRIV.PRIV_SET_PERM) || udoc.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) && udoc._id !== this.user._id) {
            this.checkPriv(PRIV.PRIV_ALL);
        }

        // 修改用户名
        await UserModel.setUname(udoc._id, newUname);
        this.response.redirect = this.url('user_edit',{uid: udoc._id});
    }
}

//修改密码
class ResetPwdHandler extends Handler {
    @requireSudo
    @query('uidOrName', Types.UidOrName, true)
    async get(domainId: string, uidOrName: string) {
        this.response.template = 'users_resetpwd.html';
        this.response.body = { uidOrName };
    }

    @requireSudo
    @param('uidOrName', Types.UidOrName)
    @param('resetpwd', Types.Password)
    async post(domainId: string, uidOrName: string, resetpwd: string) {
        // 检查输入
        const udoc = await UserModel.getById(domainId, +uidOrName)
            || await UserModel.getByUname(domainId, uidOrName)
            || await UserModel.getByEmail(domainId, uidOrName);
        if (!udoc)
            throw new UserNotFoundError(uidOrName);

        if ((udoc.hasPriv(PRIV.PRIV_SET_PERM) && udoc._id !== this.user._id) || udoc.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) {
            this.checkPriv(PRIV.PRIV_ALL);
        }
        // 修改密码
        await UserModel.setPassword(udoc._id, resetpwd);
        this.response.redirect = this.url('users_resetpwd');
    }
}

// 配置项及路由
export async function apply(ctx: Context) {
    ctx.inject(['setting'], (c) => {
        c.setting.AccountSetting(
            SettingModel.Setting('setting_info', 'realname_flag', 0, 'number', '身份标记', '0是未添加身份，1是学生，2是老师', 2),
            SettingModel.Setting('setting_info', 'realname_name', '', 'text', '姓名', null, 2),
            SettingModel.Setting('setting_storage', 'olduname', '', 'text', '姓名', null, 3)
        );
    });

    //修改getListForRender 
    const originalGetListForRender = UserModel.getListForRender;
    UserModel.getListForRender = async function(domainId, uids, arg, extraFields) {
        //添加realname相关字段
        const _extraFields = Array.isArray(arg) ? arg : Array.isArray(extraFields) ? extraFields : [];
        const newExtraFields = [..._extraFields, 'realname_name', 'realname_flag']; 
        if (Array.isArray(arg)) {
            return originalGetListForRender.call(this, domainId, uids, newExtraFields);
        }
        return originalGetListForRender.call(this, domainId, uids, arg, newExtraFields);
    };

    ctx.Route('users_manage', '/users', UsersManageHandler, PRIV.PRIV_SET_PERM);
    ctx.Route('user_edit', '/user/:uid/edit', UserEditHandler, PRIV.PRIV_SET_PERM);
    ctx.Route('realname_set', '/users/realname_set', RealnameSetHandler, PRIV.PRIV_SET_PERM);
    ctx.Route('realname_import', '/users/realname_import', RealnameImportHandler, PRIV.PRIV_SET_PERM);
    ctx.Route('users_unamechange', '/users/unamechange', UsersUnameChangeHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('users_resetpwd', '/users/resetpwd', ResetPwdHandler, PRIV.PRIV_SET_PERM);
    ctx.injectUI('UserDropdown', 'users_manage', { icon: 'user--multiple', displayName: 'users_manage' }, PRIV.PRIV_SET_PERM);
    ctx.injectUI('ControlPanel', 'users_manage', { icon: 'user--multiple', displayName: 'users_manage' }, PRIV.PRIV_SET_PERM);
    ctx.i18n.load('zh', {
        users_manage: '用户管理',
        user_edit: '修改用户',
        realname_set: '添加实名认证',
        realname_import: '批量实名认证',
        users_unamechange: '修改用户名',
        users_resetpwd: '重置密码',
    });
}
