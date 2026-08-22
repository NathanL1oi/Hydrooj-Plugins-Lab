import {
    UserModel, SettingModel, DomainModel, Handler, ValidationError, MessageNotFoundError, PrivilegeError, param, PERM, PRIV, Types, query, MessageModel, requireSudo
} from 'hydrooj';

class DomainImportHandler extends Handler {
    async get() {
        this.response.body.users = [];
        this.response.template = 'domain_import.html';
    }

    @param('users', Types.Content)
    @param('draft', Types.Boolean)
    async post(domainId: string, _users: string, draft: boolean) {
        const users = _users.split('\n');
        const udocs: { username: string, role: string, group: string }[] = [];
        const messages = [];

        for (const i in users) {
            const u = users[i];
            if (!u.trim()) continue;
            let [username, role, group] = u.split('\t').map((t) => t.trim());
            if (username && !role && !group) {
                const data = u.split(',').map((t) => t.trim());
                [username, role, group] = data;
            }

            if (!username) continue;

            // 验证用户是否存在
            const user = await UserModel.getByUname(domainId, username);
            if (!user) {
                messages.push(`Line ${+i + 1}: User ${username} not found.`);
                continue;
            }

            // 获取域中所有可用角色
            const availableRoles = await DomainModel.getRoles(domainId);
            const roleNames = availableRoles.map(role => role._id);
            if (role && !roleNames.includes(role)) {
                messages.push(`Line ${+i + 1}: Role ${role} does not exist.`);
                continue;
            }

            udocs.push({
                username, role, group
            });
        }
        messages.push(`${udocs.length} user records found.`);

        if (!draft) {
            const existing = await UserModel.listGroup(domainId);
            const groups: Record<string, number[]> = Object.create(null);

            for (const udoc of udocs) {
                try {
                    const user = await UserModel.getByUname(domainId, udoc.username);
                    if (!user) continue;
                    if (udoc.role)
                        await DomainModel.setUserRole(domainId, user._id, udoc.role, true);
                    if (udoc.group) {
                        groups[udoc.group] ||= [];
                        groups[udoc.group].push(user._id);
                    }
                } catch (e) {
                    messages.push(e.message);
                }
            }
            for (const name in groups) {
                const uids = groups[name];
                const current = existing.find((i) => i.name === name)?.uids || [];
                if (uids.length) await UserModel.updateGroup(domainId, name, Array.from(new Set([...current, ...uids])));
            }
        }
        this.response.body.users = udocs;
        this.response.body.messages = messages;
    }
}

//批量发送消息
class BulkMessageHandler extends Handler {
    async get() {
        this.checkPriv(PRIV.PRIV_SEND_MESSAGE);
        this.response.template = 'domain_bulk_message.html';
    }

    @param('recipients', Types.CommaSeperatedArray)
    @param('content', Types.Content)
    async post(domainId: string, recipients: string[], content: string) {
        this.checkPriv(PRIV.PRIV_SEND_MESSAGE);

        const uids = new Set<number>();
        const groups = await UserModel.listGroup(domainId);

        for (const recipient of recipients) {
          const trimmed = recipient.trim();
          if (!trimmed) continue;

          const group = groups.find((g) => g.name === trimmed);
          if (group) {
              for (const uid of group.uids) uids.add(uid);
          } else {
              const uid = parseInt(trimmed, 10);
              if (!Number.isNaN(uid)){
                  const udoc = await UserModel.getById(domainId, uid);
                  if (udoc) uids.add(uid);
              }
          }
        }

        if (!uids.size)
            throw new ValidationError('recipients');

        await MessageModel.send(
            this.user._id,
            Array.from(uids),
            content,
            MessageModel.FLAG_UNREAD
        );
        this.back();
        this.response.body = { success: true };
    }
}

class ManageFilesHandler extends Handler {
    @requireSudo
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, page = 1) {

        const [dudocs, upcount] = await this.paginate(
            UserModel.getMulti({ '_files.0': { $exists: true } }),
            page,
            'ranking'
        );
        const udict = await UserModel.getList(domainId, dudocs.map((x) => x._id));
        const udocs = dudocs.map((x) => udict[x._id]);
        this.response.template = 'manage_files.html'; // 返回此页面
        this.response.body = { udocs, upcount, page };
    }
}

//展示所有消息
class ManageMessageHandler extends Handler {
    @requireSudo
    @query('uid', Types.Int, true)
    @query('page', Types.PositiveInt, true)
    async get(domainId: string,uid = 0, page = 1) {
        const udoc = await UserModel.getById(domainId, uid);
        const filter = uid === 0 ? MessageModel.coll.find().sort({ _id: -1 }) : MessageModel.getMulti(uid).sort({ _id: -1 });
        const [mdocs, upcount] = await this.paginate(filter,page,10);

        // 获取所有相关的用户信息
        const uids = new Set<number>([
            ...mdocs.map((mdoc) => mdoc.from),
            ...mdocs.flatMap((mdoc) => mdoc.to),  // flatMap 处理数组
        ]);

        const udict = await UserModel.getList(domainId, Array.from(uids));

        this.response.template = 'manage_messages.html'; // 返回此页面
        this.response.body = { uid, mdocs, upcount, page, udict };
    }

    //删除消息
    @requireSudo
    @param('id', Types.ObjectId)
    async postDelete(domainId: string, id: ObjectId) {
        const message = await MessageModel.get(id);
        if (!message) throw new MessageNotFoundError(id);
        await MessageModel.del(id);
        this.response.body = { success: true };
    }
}

// 配置项及路由
export async function apply(ctx: Context) {

    ctx.on('handler/before/DomainRank#get', async (h) => {
        const { domainId, groupName } = h.args;
        const page = parseInt(h.args.page, 10) || 1;
        let filter = { uid: { $gt: 1 }, rp: { $gt: 0 } };
        const groups = await UserModel.listGroup(domainId);
        if (groupName) {
            const groupInfo = groups.find(g => g.name === groupName);
            if (groupInfo) {
                filter.uid = { $in: groupInfo.uids };
            }
        }
        const [dudocs, upcount] = await h.paginate(
            DomainModel.getMultiUserInDomain(domainId, filter).sort({ rp: -1 }),
            page,
            'ranking'
        );
        const udict = await UserModel.getList(domainId, dudocs.map((dudoc) => dudoc.uid));
        const udocs = dudocs.map((i) => udict[i.uid]);
        h.response.template = 'ranking.html';
        h.response.body = { udocs, upcount, page, groupName, groups };
        return 'after';
    });

    ctx.on('handler/before/SwitchAccount#get', async (h) => {
        const { uid, domainId } = h.args;
        const targetUser = await UserModel.getById(domainId, uid);

        // 检查权限限制：如果当前用户没有PRIV_ALL，不能切换到有PRIV_ALL的用户
        if (!h.user.hasPriv(PRIV.PRIV_ALL) && targetUser.hasPriv(PRIV.PRIV_ALL)) {
            throw new PrivilegeError(PRIV.PRIV_ALL);
        }
    });

    const systemHandlers = ['SystemScriptHandler', 'SystemUserPrivHandler', 'SystemSettingHandler', 'SystemConfigHandler' ];
    systemHandlers.forEach(handlerName => {
        ctx.server.applyMixin(handlerName, {
            async prepare() {
                this.checkPriv(PRIV.PRIV_ALL);
            }
        });
    });

    ctx.Route('domain_import','/domain/import', DomainImportHandler,PERM.PERM_EDIT_DOMAIN);
    ctx.Route('domain_bulk_message', '/domain/bulk_message', BulkMessageHandler, PERM.PERM_EDIT_DOMAIN);
    ctx.Route('manage_files', '/manage/files', ManageFilesHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('manage_messages', '/manage/messages', ManageMessageHandler, PRIV.PRIV_ALL);
    ctx.injectUI('DomainManage', 'domain_import',{ family: 'Access Control', icon: 'user' });
    ctx.injectUI('DomainManage', 'domain_bulk_message',{ family: 'Access Control', icon: 'send' });
    ctx.injectUI('ControlPanel', 'manage_files');
    ctx.injectUI('ControlPanel', 'manage_messages', { icon: 'message', text: 'Manage Messages' }, PRIV.PRIV_ALL);

    //让普通管理员看不到菜单选项
    ctx.injectUI('ControlPanel', 'manage_script', { icon: 'code', before: 'manage_script' }, PRIV.PRIV_ALL);
    ctx.injectUI('ControlPanel', 'manage_user_priv', { icon: 'user-shield', before: 'manage_user_priv' }, PRIV.PRIV_ALL);
    ctx.injectUI('ControlPanel', 'manage_setting', { icon: 'settings', before: 'manage_setting' }, PRIV.PRIV_ALL);
    ctx.injectUI('ControlPanel', 'manage_config', { icon: 'config', before: 'manage_config' }, PRIV.PRIV_ALL);

    ctx.i18n.load('zh', {
        domain_import: '批量设置用户权限',
        domain_bulk_message: '批量发送消息',
        manage_files: '文件管理',
        manage_messages: '消息管理',
    });
}
