import {
    db, UserModel, SettingModel, DomainModel, Handler, UserNotFoundError, param, PERM, PRIV, Types, paginate, query
} from 'hydrooj';

// 修复 `getListForRender` 函数，给前端传递更多内容
export const coll: Collection<Udoc> = db.collection('user');
export const collV: Collection<VUdoc> = db.collection('vuser');
export const collGroup: Collection<GDoc> = db.collection('user.group');
UserModel.getListForRender = async function (domainId: string, uids: number[], arg: string[] | boolean) {
    const fields = ['_id', 'uname', 'mail', 'avatar', 'school', 'studentId', 'realname_flag', 'realname_name'].concat(arg instanceof Array ? arg : []);
    const showDisplayName = arg instanceof Array ? fields.includes('displayName') : arg;
    const [udocs, vudocs, dudocs] = await Promise.all([
        UserModel.getMulti({ _id: { $in: uids } }, fields).toArray(),
        collV.find({ _id: { $in: uids } }).toArray(),
        DomainModel.getDomainUserMulti(domainId, uids).project({ uid: 1, ...(showDisplayName ? { displayName: 1 } : {}) }).toArray(),
    ]);
    const udict = {};
    for (const udoc of udocs) udict[udoc._id] = udoc;
    for (const udoc of vudocs) udict[udoc._id] = udoc;
    if (showDisplayName) for (const dudoc of dudocs) udict[dudoc.uid].displayName = dudoc.displayName;
    for (const uid of uids) udict[uid] ||= { ...UserModel.defaultUser };
    for (const key in udict) {
        udict[key].school ||= '';
        udict[key].studentId ||= '';
        udict[key].displayName ||= udict[key].uname;
        udict[key].avatar ||= `gravatar:${udict[key].mail}`;
    }
    return udict as BaseUserDict;
};

//实名设置
class RealnameSetHandler extends Handler {
    @query('uidOrName', Types.UidOrName, true)
    @query('name', Types.string, true)
    async get(domainId: string, uidOrName: string, name: string) {
        this.response.template = 'realname_set.html'; // 返回此页面
        this.response.body = {
            uidOrName, name,
        };
    }
    @param('uidOrName', Types.UidOrName)
    @param('flag', Types.number, true)
    @param('name', Types.string, true)
    async post(domainId: string, uidOrName: string, flag: number, name: string) {
        // 检查输入
        flag = parseInt(flag);
        const udoc = await UserModel.getById(domainId, +uidOrName)
            || await UserModel.getByUname(domainId, uidOrName)
            || await UserModel.getByEmail(domainId, uidOrName);
        if (!udoc)
            throw new UserNotFoundError(uidOrName);
        // 构建实名代码并更新
        if ([0, 1, 2].includes(flag)) await UserModel.setById(udoc._id, { realname_flag: flag });
        if (name) await UserModel.setById(udoc._id, { realname_name: name.trim() });

        // 将用户重定向到创建完成的url
        this.response.redirect = this.url('realname_show');
    }
}

//展示实名用户
class RealnameShowHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    @query('groupName', Types.string, true)
    async get(domainId: string, page = 1, groupName: string) {

        let filter = { realname_flag: { $exists: true, $ne: "" } };

        const groups = await UserModel.listGroup(domainId);
        if (groupName) {
            const groupInfo = groups.find(g => g.name === groupName);
            if (groupInfo) {
                filter._id = { $in: groupInfo.uids };
            }
        }

        const [dudocs, upcount, ucount] = await this.ctx.db.paginate(
            UserModel.getMulti(filter).sort({ realname_flag: -1, _id: -1 }),
            page,
            100,
        );
        const udict = await UserModel.getList(domainId, dudocs.map((x) => x._id));
        const udocs = dudocs.map((x) => udict[x._id]);
        this.response.template = 'realname_show.html'; // 返回此页面
        this.response.body = { udocs, upcount, ucount, page, groupName, groups, };
    }
}

//导入实名用户
class RealnameImportHandler extends Handler {
    async get() {
        this.response.template = 'realname_import.html'; // 返回此页面
    }
    @param('realnames', Types.Content)
    async post(domainId: string, _realnames: string) {
        const realnames = _realnames.split('\n');
        const udocs: { uidOrName: string, flag: number, name: string }[] = [];
        for (const i in realnames) {
            const u = realnames[i];
            if (!u.trim()) continue;
            let [uidOrName, flag, name] = u.split('\t').map((t) => t.trim());
            if (uidOrName && !flag && !name) {
                const data = u.split(',').map((t) => t.trim());
                [uidOrName, flag, name] = data;
            }

            if (!uidOrName) continue;
            flag = parseInt(flag);
            udocs.push({
                uidOrName, flag, name,
            });
        }
        for (const udoc of udocs) {
            let user = await UserModel.getByUname(domainId, udoc.uidOrName);
            if (!user) continue;
            // 构建实名代码并更新
            // await UserModel.setById(user._id, { realname_flag: udoc.flag, realname_name: udoc.name });
            if (![0, 1, 2].includes(udoc.flag) && udoc.name == '') {
                await UserModel.setById(user._id, { realname_flag: '', realname_name: '' });
            }
            else {
                if ([0, 1, 2].includes(udoc.flag)) await UserModel.setById(user._id, { realname_flag: udoc.flag });
                if (udoc.name) await UserModel.setById(user._id, { realname_name: udoc.name });
            }
        }
        this.response.redirect = this.url('realname_show');
    }
}

//修改密码
class ResetPwdHandler extends Handler {
    @query('uidOrName', Types.UidOrName, true)
    async get(domainId: string, uidOrName: string) {
        this.response.template = 'realname_resetpwd.html'; // 返回此页面
        this.response.body = {
            uidOrName,
        };
    }
    @param('uidOrName', Types.UidOrName)
    @param('resetpwd', Types.Password)
    async post(domainId: string, uidOrName: string, resetpwd: string) {
        // 检查输入
        const udoc = await UserModel.getById(domainId, +uidOrName)
            || await UserModel.getByUname(domainId, uidOrName)
            || await UserModel.getByEmail(domainId, uidOrName);
        if (!udoc)
            throw new UserNotFoundError(uidOrName);
        // 修改密码
        await UserModel.setPassword(udoc._id, resetpwd);
        // 将用户重定向到创建完成的url
        this.response.redirect = this.url('realname_show');
    }
}

//快速认证
class RealnameQuickHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, page = 1) {
        const [dudocs, upcount, ucount] = await this.ctx.db.paginate(
            UserModel.getMulti({ "_id": { $gte: 2 }, $or: [ { "realname_name": { $exists: false } }, { "realname_name": "" } ] }).sort({ realname_flag: 1, _id: -1 }),
            page,
            100,
        );
        const udict = await UserModel.getList(domainId, dudocs.map((x) => x._id));
        const udocs = dudocs.map((x) => udict[x._id]);

        this.response.template = 'realname_quick.html'; // 返回此页面
        this.response.body = { udocs, upcount, ucount, page, };
    }
}

// 配置项及路由
export async function apply(ctx: Context) {
    ctx.inject(['setting'], (c) => {
        c.setting.AccountSetting(
            SettingModel.Setting('setting_info', 'realname_flag', 0, 'number', '身份标记', '0是未添加身份，1是学生，2是老师', 2),
            SettingModel.Setting('setting_info', 'realname_name', '', 'text', '姓名', null, 2)
        );
    });
    ctx.Route('realname_show', '/realname/show', RealnameShowHandler, PRIV.PRIV_SET_PERM);
    ctx.Route('realname_import', '/realname/import', RealnameImportHandler, PRIV.PRIV_SET_PERM);
    ctx.Route('realname_set', '/realname/set', RealnameSetHandler, PRIV.PRIV_SET_PERM);
    ctx.Route('realname_resetpwd', '/realname/resetpwd', ResetPwdHandler, PRIV.PRIV_SET_PERM);
    ctx.Route('realname_quick', '/realname/quick', RealnameQuickHandler, PRIV.PRIV_SET_PERM);
    ctx.injectUI('UserDropdown', 'realname_show', { icon: 'feeling-lucky', displayName: '实名认证' }, PRIV.PRIV_SET_PERM);
}
