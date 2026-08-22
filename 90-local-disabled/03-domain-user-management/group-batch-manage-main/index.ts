import { Context, db, Handler, param, Types } from 'hydrooj';

const collGroup = db.collection('user.group');
const collDomainUser = db.collection('domain.user');

const RE_UNAME = /^.{3,254}$/i;

interface BatchRow {
    lineNum: number;
    group: string;
    uname: string;
}

interface BatchMessage {
    level: 'ok' | 'skip' | 'error' | 'info';
    text: string;
}

function splitUserTokens(raw: string) {
    return raw
        .split(/[\s,，]+/)
        .map((s) => s.trim())
        .filter(Boolean);
}

function parseRows(raw: string, defaultGroup: string, knownGroups: Set<string>) {
    const rows: BatchRow[] = [];
    const issues: BatchMessage[] = [];

    for (const [i, line] of raw.split('\n').entries()) {
        const lineNum = i + 1;
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        const cols = (trimmed.includes('\t') ? trimmed.split('\t') : trimmed.split(','))
            .map((c) => c.trim())
            .filter(Boolean);

        if (cols.length >= 2 && knownGroups.has(cols[0])) {
            for (const uname of cols.slice(1).flatMap(splitUserTokens)) {
                rows.push({ lineNum, group: cols[0], uname });
            }
            continue;
        }

        if (defaultGroup) {
            for (const uname of splitUserTokens(trimmed)) {
                rows.push({ lineNum, group: defaultGroup, uname });
            }
            continue;
        }

        if (cols.length >= 2) {
            rows.push({ lineNum, group: cols[0], uname: cols[1] });
        } else {
            issues.push({
                level: 'error',
                text: `第 ${lineNum} 行缺少小组：请选择默认小组，或写成“小组名, 用户名”。`,
            });
        }
    }

    return { rows, issues };
}

class GroupBatchHandler extends Handler {
    async prepare() {
        this.checkPerm(BigInt(1) << BigInt(3)); // PERM_EDIT_DOMAIN_DATA
    }

    async get() {
        const UserM = global.Hydro.model.user;
        const groups = await UserM.listGroup(this.domain._id);
        this.response.template = 'group_batch.html';
        this.response.body = {
            groups,
            messages: [],
            domainId: this.domain._id,
            domainName: this.domain.name || this.domain._id,
            selectedGroup: groups?.[0]?.name || '',
        };
    }

    @param('users', Types.Content)
    @param('action', Types.String)
    @param('group', Types.String)
    @param('draft', Types.Boolean)
    async post(domainId: string, users: string, action: string, group = '', draft = false) {
        const UserM = global.Hydro.model.user;
        const DomainM = global.Hydro.model.domain;
        const realDomainId = this.domain._id;
        const isDelete = action === 'delete';
        const selectedGroup = (group || '').trim();

        const messages: BatchMessage[] = [];
        const push = (level: BatchMessage['level'], text: string) => messages.push({ level, text });

        let ok = 0;
        let fail = 0;
        let skipped = 0;

        const groupDocs = await collGroup.find({ domainId: realDomainId }).toArray() as any[];
        const groupMap: Record<string, { name: string; uids: number[] }> = {};
        for (const g of groupDocs) {
            groupMap[g.name] = { name: g.name, uids: Array.isArray(g.uids) ? [...g.uids] : [] };
        }

        const knownGroups = new Set(Object.keys(groupMap));
        const { rows, issues } = parseRows(users, selectedGroup, knownGroups);
        messages.push(...issues);
        fail += issues.length;

        if (!rows.length && !issues.length) {
            push('error', '没有读到任何用户。请先选择小组，并在文本框里粘贴用户名。');
            fail++;
        }

        const seenInput = new Set<string>();
        const userCache = new Map<string, any | null>();

        const findUser = async (uname: string) => {
            const key = uname.toLowerCase();
            if (userCache.has(key)) return userCache.get(key);
            const user = await UserM.getByUname('system', uname)
                ?? await UserM.getByUname(realDomainId, uname);
            userCache.set(key, user || null);
            return user;
        };

        for (const { lineNum, group: groupName, uname } of rows) {
            if (!groupMap[groupName]) {
                push('error', `第 ${lineNum} 行：小组“${groupName}”不存在。`);
                fail++;
                continue;
            }

            if (!RE_UNAME.test(uname)) {
                push('error', `第 ${lineNum} 行：用户名“${uname}”格式不正确。`);
                fail++;
                continue;
            }

            const inputKey = `${groupName}\0${uname.toLowerCase()}`;
            if (seenInput.has(inputKey)) {
                push('skip', `第 ${lineNum} 行：“${uname}”在小组“${groupName}”中重复出现，已跳过。`);
                skipped++;
                continue;
            }
            seenInput.add(inputKey);

            const udoc = await findUser(uname);
            if (!udoc) {
                push('error', `第 ${lineNum} 行：找不到用户“${uname}”。`);
                fail++;
                continue;
            }

            const uid: number = udoc._id;
            const currentUids = groupMap[groupName].uids;
            const alreadyIn = currentUids.includes(uid);

            const dudoc = await collDomainUser.findOne({ domainId: realDomainId, uid });
            const enrolled = !!(dudoc?.role);

            if (draft) {
                if (isDelete) {
                    if (alreadyIn) {
                        push('ok', `预览：将从“${groupName}”移除“${uname}”。`);
                        ok++;
                    } else {
                        push('skip', `预览：“${uname}”不在“${groupName}”中，会跳过。`);
                        skipped++;
                    }
                } else if (alreadyIn) {
                    push('skip', `预览：“${uname}”已经在“${groupName}”中，会跳过。`);
                    skipped++;
                } else {
                    push('ok', enrolled
                        ? `预览：将把“${uname}”加入“${groupName}”。`
                        : `预览：将先把“${uname}”加入当前域，再加入“${groupName}”。`);
                    ok++;
                }
                continue;
            }

            try {
                if (isDelete) {
                    if (!alreadyIn) {
                        push('skip', `“${uname}”不在“${groupName}”中，已跳过。`);
                        skipped++;
                        continue;
                    }
                    const newUids = currentUids.filter((u) => u !== uid);
                    await collGroup.updateOne(
                        { domainId: realDomainId, name: groupName },
                        { $set: { uids: newUids } },
                        { upsert: true },
                    );
                    groupMap[groupName].uids = newUids;
                    push('ok', `已从“${groupName}”移除“${uname}”。`);
                    ok++;
                } else {
                    if (alreadyIn) {
                        push('skip', `“${uname}”已经在“${groupName}”中，已跳过。`);
                        skipped++;
                        continue;
                    }
                    if (!enrolled) await DomainM.setUserRole(realDomainId, uid, 'default');
                    const newUids = [...currentUids, uid];
                    await collGroup.updateOne(
                        { domainId: realDomainId, name: groupName },
                        { $set: { uids: newUids } },
                        { upsert: true },
                    );
                    groupMap[groupName].uids = newUids;
                    push('ok', enrolled
                        ? `已把“${uname}”加入“${groupName}”。`
                        : `已把“${uname}”加入当前域，并加入“${groupName}”。`);
                    ok++;
                }
            } catch (e: any) {
                push('error', `第 ${lineNum} 行处理失败：${e.message}`);
                fail++;
            }
        }

        const updatedGroups = await UserM.listGroup(realDomainId);
        this.response.template = 'group_batch.html';
        this.response.body = {
            groups: updatedGroups,
            messages,
            summary: {
                total: rows.length,
                ok,
                skipped,
                fail,
                preview: !!draft,
                action: isDelete ? 'delete' : 'add',
            },
            domainId: realDomainId,
            domainName: this.domain.name || realDomainId,
            users,
            action,
            selectedGroup,
        };
    }
}

export async function apply(ctx: Context) {
    ctx.Route('group_batch', '/domain/group-batch', GroupBatchHandler);

    ctx.i18n.load('zh', {
        group_batch: '批量管理小组成员',
    });
    ctx.i18n.load('en', {
        group_batch: 'Batch Manage Group Members',
    });
}
