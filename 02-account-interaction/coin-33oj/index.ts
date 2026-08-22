import {
    Context, UserModel, DomainModel, SettingModel, RecordModel, TokenModel, SystemModel, Handler, UserNotFoundError, UserAlreadyExistError, NotFoundError, ValidationError, param, PRIV, Types, query, STATUS, Logger
} from 'hydrooj';
import { CoinModel, GoodsModel } from './model';

const logger = new Logger('score-reward');

//展示所有
class CoinShowHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    @query('groupName', Types.string, true)
    async get(domainId: string, page = 1, groupName?: string) {
        const filter = { coin_now: { $exists: true } };

        const groups = await UserModel.listGroup(domainId);
        if (groupName) {
            const groupInfo = groups.find((g) => g.name === groupName);
            if (groupInfo) {
                filter._id = { $in: groupInfo.uids };
            }
        }

        const [dudocs, upcount] = await this.paginate(
            UserModel.getMulti(filter).sort({ coin_now: -1 }),
            page,
            'ranking'
        );
        const udict = await UserModel.getList(domainId, dudocs.map((x) => x._id));
        const udocs = dudocs.map((x) => udict[x._id]);

        this.response.template = 'coin_show.html';
        this.response.body = { udocs, upcount, page, groupName, groups };
    }
}

//发放硬币
class CoinIncHandler extends Handler {
    @query('uidOrName', Types.UidOrName, true)
    async get(domainId: string, uidOrName: string) {
        this.response.template = 'coin_inc.html';
        this.response.body = { uidOrName };
    }

    @param('uidOrName', Types.UidOrName)
    @param('amount', Types.Int)
    @param('text', Types.String)
    async post(domainId: string, uidOrName: string, amount: number, text: string) {
        amount = parseInt(amount, 10);
        const udoc = await UserModel.getById(domainId, +uidOrName)
            || await UserModel.getByUname(domainId, uidOrName)
            || await UserModel.getByEmail(domainId, uidOrName);
        if (!udoc) {
            throw new UserNotFoundError(uidOrName);
        }
        if (udoc._id === 0) {
            throw new ValidationError(udoc.uname, '', '不能向 Guest 用户发放硬币');
        }  
        await CoinModel.inc(udoc._id, this.user._id, amount, text, 1);
        this.response.redirect = this.url('coin_inc');
    }
}

//账单
class CoinBillHandler extends Handler {
    @query('uid', Types.Int, true)
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, uid = this.user._id, page = 1) {
        const udoc = await UserModel.getById(domainId, uid);
        const [bills, upcount] = await this.paginate(
            await CoinModel.getUserBill(uid),
            page,
            'ranking'
        );

        const uids = new Set<number>([
            ...bills.map((x) => x.userId),
            ...bills.map((x) => x.rootId),
        ]);
        const udict = await UserModel.getList(domainId, Array.from(uids));

        this.response.template = 'coin_bill.html';
        this.response.body = { udoc, bills, upcount, page, udict };
    }
}

//批量导入硬币
class CoinImportHandler extends Handler {
    async get() {
        this.response.body.coins = [];
        this.response.template = 'coin_import.html';
    }

    @param('coins', Types.Content)
    @param('draft', Types.Boolean)
    async post(domainId: string, _coins: string, draft: boolean) {
        const coins = _coins.split('\n');
        const udocs: { username: string, amount: number, text: string }[] = [];
        const messages = [];

        for (const i in coins) {
            const u = coins[i];
            if (!u.trim()) continue;
            let [username, amount, text] = u.split('\t').map((t) => t.trim());
            if (username && !amount && !text) {
                const data = u.split(',').map((t) => t.trim());
                [username, amount, text] = data;
            }

            if (!username) continue;
            amount = parseInt(amount, 10);
            if (isNaN(amount)) {
                messages.push(`Line ${+i + 1}:  Invalid amount.`);
                continue;
            }

            const user = await UserModel.getByUname(domainId, username);
            if (!user) {
                messages.push(`Line ${+i + 1}: User ${username} not found.`);
                continue;
            }

            udocs.push({
                username, amount, text
            });
        }

        messages.push(`${udocs.length} coin records found.`);

        if (!draft) {
            for (const udoc of udocs) {
                try {
                    const user = await UserModel.getByUname(domainId, udoc.username);
                    if (!user || !udoc.amount || udoc.amount === 0) continue;  
                    await CoinModel.inc(user._id, this.user._id, udoc.amount, udoc.text, 1);
                } catch (e) {
                    messages.push(e.message);
                }
            }
        }
        this.response.body.coins = udocs;
        this.response.body.messages = messages;
    }
}

//增加商品
class GoodsAddHandler extends Handler {
    async get() {
        this.response.template = 'goods_add.html';
    }

    @param('name', Types.String)
    @param('price', Types.Int)
    @param('num', Types.Int)
    async post(domainId: string, name: string, price: number, num: number) {
        await GoodsModel.add(name, price, num);
        this.response.body = { success: true };
    }
}

//管理商品
class GoodsManageHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, page = 1) {
        const [ddocs, dpcount] = await this.paginate(
            await GoodsModel.getMulti(),
            page,
            'ranking'
        );
        this.response.template = 'goods_manage.html';
        this.response.body = { ddocs, dpcount, page };
    }
}

class GoodsEditHandler extends Handler {
    @param('id', Types.PositiveInt)
    async get(domainId: string, id: number) {
        const goods = await GoodsModel.get(id);
        if (!goods) throw new NotFoundError(`商品 ${id} 不存在！`);
        this.response.template = 'goods_edit.html';
        this.response.body = { goods };
    }
  
    @param('id', Types.PositiveInt)
    @param('name', Types.String)
    @param('price', Types.Int)
    @param('num', Types.Int)
    async postUpdate(domainId: string, id: number, name: string, price: number, num: number) {
        const goods = await GoodsModel.get(id);
        if (!goods) throw new NotFoundError(`商品 ${id} 不存在！`);
        await GoodsModel.edit(id, name, price, num);
        this.response.redirect = this.url('goods_manage');
    }

    @param('id', Types.PositiveInt)
    async postDelete(domainId: string, id: number) {
        await GoodsModel.delete(id);
        this.response.redirect = this.url('goods_manage');
    }
}

//兑换商城
class CoinMallHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, page = 1, uid = this.user._id) {
        const udoc = await UserModel.getById(domainId, uid);
        const [ddocs, dpcount] = await this.paginate(
            await GoodsModel.getMulti(),
            page,
            'ranking'
        );
        this.response.template = 'coin_mall.html';
        this.response.body = { udoc, ddocs, dpcount, page };
    }
}

//兑换商品
class CoinExchangeHandler extends Handler {
    @param('id', Types.PositiveInt)
    async get(domainId: string, id: string, uid = this.user._id) {
        const goods = await GoodsModel.get(id);
        const udoc = await UserModel.getById(domainId, uid);
        if (!goods) throw new NotFoundError(`商品 ${id} 不存在！`);
        this.response.template = 'coin_exchange.html';
        this.response.body = { udoc, goods };
    }

    @param('id', Types.PositiveInt)
    @param('num', Types.Int)
    async post(domainId: string, id: number, num: number) {
        const goods = await GoodsModel.get(id);
        const udoc = await UserModel.getById(domainId, this.user._id);
        if (num <= 0) {
            throw new ValidationError(num, '', '商品数量必须大于0');  
        }  
        if (goods.num < num) {
            throw new ValidationError(num, '', `商品 ${goods.name} 数量不够`);
        }
        const currentCoin = typeof udoc.coin_now === 'number' ? udoc.coin_now : 0;
        if (currentCoin < goods.price * num) {
            throw new ValidationError(currentCoin, '', '你的硬币不够');
        }
        const amount = 0 - goods.price * num;
        const text = `兑换：${goods.name}×${num}`;
        await CoinModel.inc(this.user._id, 1, amount, text, 0, id);
        await GoodsModel.updateStock(id, -num);
        this.response.redirect = this.url('coin_myrecord');
    }
}

//我的兑换记录
class CoinMyRecordHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, page = 1, uid = this.user._id) {
        const [bills, upcount] = await this.paginate(
            await CoinModel.getUserRecord(uid),
            page,
            'ranking'
        );

        const uids = new Set<number>([
            ...bills.map((x) => x.userId),
            ...bills.map((x) => x.rootId),
        ]);
        const udict = await UserModel.getList(domainId, Array.from(uids));

        this.response.template = 'coin_myrecord.html';
        this.response.body = { bills, upcount, page, udict };
    }

    @param('id', Types.ObjectId)
    async post(domainId: string, id: ObjectId) {
        const bill = await CoinModel.getBill(id);
        if (!bill) throw new NotFoundError(`订单 ${id} 不存在！`);
        if (bill.userId !== this.user._id) {
            throw new ValidationError(this.user._id, '', `您无权操作他人订单！`);
        }
        const gid = bill.status;
        if (typeof gid !== 'number' || gid === 0) {
            throw new ValidationError('订单', '', `订单 ${id} 已确认，无法取消`);
        }
        const amount = 0 - bill.amount;
        const num = parseInt(bill.text.split('×').pop(), 10);
        await CoinModel.deleteBill(id);
        await GoodsModel.updateStock(gid, num);
        await UserModel.inc(this.user._id, 'coin_now', amount);
        this.response.body = { success: true };
    }
}

//兑换中心
class CoinRecordHandler extends Handler {
    @query('uid', Types.Int, true)
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, uid = 0, page = 1) {
        const [bills, upcount] = await this.paginate(
            await CoinModel.getUserRecord(uid),
            page,
            'ranking'
        );

        const uids = new Set<number>([
            ...bills.map((x) => x.userId),
            ...bills.map((x) => x.rootId),
        ]);
        const udict = await UserModel.getList(domainId, Array.from(uids));

        this.response.template = 'coin_record.html';
        this.response.body = { uid, bills, upcount, page, udict };
    }

    @param('id', Types.ObjectId)
    async post(domainId: string, id: ObjectId) {
        const bill = await CoinModel.getBill(id);
        if (!bill) throw new NotFoundError(`订单 ${id} 不存在！`);
        const gid = bill.status;
        if (typeof gid !== 'number' || gid === 0) {
            throw new ValidationError('订单', '', `订单 ${id} 无法兑换`);
        }
        await CoinModel.updateBill(id, { rootId: this.user._id, text: bill.text, status: 0 });
        this.response.body = { success: true };
    }
}

//赠送硬币
class CoinGiftHandler extends Handler {
    @query('uidOrName', Types.UidOrName, true)
    async get(domainId: string, uidOrName: string) {
        this.response.template = 'coin_gift.html';
        this.response.body = { uidOrName };
    }

    @param('password', Types.Password)
    @param('uidOrName', Types.UidOrName)
    @param('amount', Types.Int)
    async post(domainId: string, password: string, uidOrName: string, amount: number) {
        amount = parseInt(amount, 10);
        if (amount <= 0) {
            throw new ValidationError(amount, '', '赠送的硬币必须大于0');
        }
        const currentCoin = typeof this.user.coin_now === 'number' ? this.user.coin_now : 0;
        if (amount > currentCoin) {
            throw new ValidationError(currentCoin, '', '你的硬币不够');  
        }
        const udoc = await UserModel.getById(domainId, +uidOrName)
            || await UserModel.getByUname(domainId, uidOrName)
            || await UserModel.getByEmail(domainId, uidOrName);
        if (!udoc) {
            throw new UserNotFoundError(uidOrName);
        }
        if (udoc._id === this.user._id) {
            throw new ValidationError(udoc.uname, '', '不能赠送给自己硬币');
        }
        if (udoc._id === 0) {
            throw new ValidationError(udoc.uname, '', '不能向 Guest 用户赠送硬币');
        }
        await this.user.checkPassword(password);
        const text1 = `赠送：送给（${udoc.uname}）。`;
        const text2 = `赠送：来自（${this.user.uname}）。`;
        await CoinModel.inc(this.user._id, udoc._id, 0 - amount, text1, 0);
        await CoinModel.inc(udoc._id, this.user._id, amount, text2, 0);
        this.response.body = { success: true };
    }
}

//用户修改用户名
class UnameChangeHandler extends Handler {
    async get({ domainId }) {
        const udoc = await UserModel.getById(domainId, this.user._id);
        const coinCost = SystemModel.get('coin.uname_change_cost') || 20;
        const uidOrName = udoc.uname;
        this.response.template = 'uname_change.html';
        this.response.body = { uidOrName, coinCost };
    }

    @param('password', Types.Password)
    @param('newUname', Types.Username)
    async postFree(domainId: string, password: string, newUname: string) {
        if (/^[+-]?\d+$/.test(newUname.trim())) {
            throw new ValidationError(newUname, '', '用户名不能为纯数字');
        }
        if (this.user.olduname) {
            throw new ValidationError('修改次数', '', '修改次数已达上限');
        }
        const udoc = await UserModel.getById(domainId, +newUname)
            || await UserModel.getByUname(domainId, newUname)
            || await UserModel.getByEmail(domainId, newUname);
        if (udoc) {
            throw new UserAlreadyExistError(newUname);
        }
        await this.user.checkPassword(password);
        await UserModel.setById(this.user._id, { olduname: this.user.uname });
        await UserModel.setUname(this.user._id, newUname);
        await TokenModel.delByUid(this.user._id);
        this.response.redirect = this.url('user_login');
    }
  
    @param('password', Types.Password)
    @param('newUname', Types.Username)
    async postBycoin(domainId: string, password: string, newUname: string) {
        if (/^[+-]?\d+$/.test(newUname.trim())) {
            throw new ValidationError(newUname, '', '用户名不能为纯数字');
        }
        const udoc = await UserModel.getById(domainId, +newUname)
            || await UserModel.getByUname(domainId, newUname)
            || await UserModel.getByEmail(domainId, newUname);
        if (udoc) {
            throw new UserAlreadyExistError(newUname);
        }
        await this.user.checkPassword(password);

        const coinCost = SystemModel.get('coin.uname_change_cost') || 20;
        const currentCoin = typeof this.user.coin_now === 'number' ? this.user.coin_now : 0;
        if (currentCoin < coinCost) {
            throw new ValidationError('currentCoin', '', '你的硬币不够');
        }

        await CoinModel.inc(this.user._id, 1, 0 - coinCost, '修改用户名', 0);
        await UserModel.setUname(this.user._id, newUname);
        await TokenModel.delByUid(this.user._id);
        this.response.redirect = this.url('user_login');
    }
}

class CoinSettingHandler extends Handler {
    async get() {
        this.response.template = 'domain_coin_setting.html';
        this.response.body = {
            coin_enabled: this.domain.coin_enabled || false,
            coin_amount: this.domain.coin_amount || 2,
        };
    }

    @param('coin_enabled', Types.Boolean)
    @param('coin_amount', Types.Int)
    async post( domainId: string, coin_enabled: boolean, coin_amount: number ) {
        await DomainModel.edit(domainId, {
            coin_enabled,
            coin_amount,
        });
        this.back();
    }
}

// 配置项及路由
export async function apply(ctx: Context) {
    ctx.inject(['setting'], (c) => {
        c.setting.AccountSetting(
            SettingModel.Setting('setting_storage', 'coin_now', 0, 'number', 'coin_now', null, 3),
            SettingModel.Setting('setting_storage', 'coin_all', 0, 'number', 'coin_all', null, 3)
        );
        c.setting.SystemSetting(
            SettingModel.Setting('domain_coin_setting', 'coin.uname_change_cost', 20, 'number', 'coin.uname_change_cost', '修改用户名所需硬币数量', 0)
        );
        c.setting.DomainSetting(
            SettingModel.Setting('setting_storage', 'coin_enabled', false, 'boolean', '自动发放硬币', '为该域启用首次AC硬币发放功能',3),  
            SettingModel.Setting('setting_storage', 'coin_amount', 2, 'number', '每题硬币数量', '每道题首次AC获得的硬币数量',3)  
        );
    });

    ctx.on('record/judge', async (rdoc, updated, pdoc) => {
        try {
            if (rdoc.status !== STATUS.STATUS_ACCEPTED) return;
            if (rdoc.contest) return;
            if (rdoc.rejudged) return;
            if (!updated) return;

            const ddoc = await DomainModel.get(rdoc.domainId);
            const coinEnabled = ddoc?.coin_enabled || false;
            if (!coinEnabled) return;

            const result = await RecordModel.collStat.updateOne(
                {
                    domainId: rdoc.domainId,
                    pid: rdoc.pid,
                    uid: rdoc.uid
                },
                {
                    $setOnInsert: {
                        _id: rdoc._id,
                        domainId: rdoc.domainId,
                        pid: rdoc.pid,
                        uid: rdoc.uid,
                        time: rdoc.time,
                        memory: rdoc.memory,
                        length: rdoc.code?.length || 0,
                        lang: rdoc.lang,
                    },
                },
                { upsert: true },
            );

            // 只有首次AC时才发放硬币
            if (result.upsertedCount > 0) {
                const coinAmount = +(ddoc?.coin_amount || 2);
                const domainName = ddoc?.name || rdoc.domainId;
                await CoinModel.inc( rdoc.uid, ddoc.owner, coinAmount, `答题：${domainName}（ID:${rdoc.pid}）`, 1);
                logger.info(`User ${rdoc.uid} earned ${coinAmount} coins for first AC on problem ${rdoc.pid} in domain ${domainName}`);
            }
        } catch (error) {
            logger.error('Error in coin reward plugin:', error);
        }
    });

    ctx.Route('coin_show', '/coin/show', CoinShowHandler);
    ctx.Route('coin_inc', '/coin/inc', CoinIncHandler, PRIV.PRIV_SET_PERM);
    ctx.Route('coin_import', '/coin/import', CoinImportHandler, PRIV.PRIV_SET_PERM);
    ctx.Route('coin_bill', '/coin/bill', CoinBillHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('coin_mall', '/coin/mall', CoinMallHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('coin_myrecord', '/coin/myrecord', CoinMyRecordHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('coin_exchange', '/coin/exchange/:id', CoinExchangeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('coin_record', '/coin/record', CoinRecordHandler, PRIV.PRIV_SET_PERM);
    ctx.Route('coin_gift', '/coin/gift', CoinGiftHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('goods_add', '/goods/add', GoodsAddHandler, PRIV.PRIV_SET_PERM);
    ctx.Route('goods_manage', '/goods/manage', GoodsManageHandler, PRIV.PRIV_SET_PERM);
    ctx.Route('goods_edit', '/goods/:id/edit', GoodsEditHandler, PRIV.PRIV_SET_PERM);
    ctx.Route('uname_change', '/uname/change', UnameChangeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('domain_coin_setting', '/domain/coin', CoinSettingHandler, PRIV.PRIV_SET_PERM);
    ctx.injectUI('DomainManage', 'domain_coin_setting',{family: 'Properties', icon: 'info' }, PRIV.PRIV_SET_PERM);
    ctx.injectUI('UserDropdown', 'coin_bill', { icon: 'bold', displayName: '我的硬币' });
    ctx.i18n.load('zh', {
        coin_show: '展示硬币',
        coin_inc: '发放硬币',
        coin_import: '批量发放硬币',
        coin_bill: '发放记录',
        coin_mall: '兑换商城',
        coin_myrecord: '我的兑换记录',
        coin_exchange: '兑换商品',
        coin_record: '兑换中心',
        coin_gift: '赠送硬币',
        goods_add: '添加商品',
        goods_manage: '管理商品',
        goods_edit: '编辑商品',
        uname_change: '修改用户名',
        domain_coin_setting: '硬币设置',
    });
}
