/**
 * @hydrooj/userimport-domain
 *
 * Copyright (c) 2024 Jinxin-s-Hydro-tools
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import { Context, Handler, param, PRIV, Types, db } from 'hydrooj';

const RE_MAIL = /^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/i;
const RE_UNAME = /^.{3,254}$/i;
const isEmail = (s: string) => RE_MAIL.test(s);
const isUname = (s: string) => RE_UNAME.test(s);
const isPassword = (s: string) => s && s.length >= 5;

const collDomain = db.collection('domain');

async function resolveDomain(input: string): Promise<any | null> {
    const DomainModel = global.Hydro.model.domain;
    const byId = await DomainModel.get(input);
    if (byId) return byId;
    return await collDomain.findOne({ name: input }) ?? null;
}

function parseLine(raw: string, lineNum: number) {
    let cols = raw.split(',').map((t) => t.trim());
    if (!cols[0] || !cols[1] || !cols[2]) cols = raw.split('\t').map((t) => t.trim());
    while (cols.length > 0 && !cols[cols.length - 1]) cols.pop();
    const [email, username, password] = cols;
    if (!email || !username || !password) return null;
    let displayName: string | undefined;
    let domainInput: string | undefined;
    let role: string | undefined;
    switch (cols.length) {
        case 3: break;
        case 4: domainInput = cols[3]; break;
        case 5: domainInput = cols[3]; role = cols[4]; break;
        default:
            displayName = cols[3] || undefined;
            domainInput = cols[4] || undefined;
            role = cols[5] || undefined;
    }
    return { lineNum, email, username, password, displayName, domainInput, role };
}

class UserImportDomainHandler extends Handler {
    async prepare() { this.checkPriv(PRIV.PRIV_EDIT_SYSTEM); }

    async get() {
        this.response.body.users = [];
        this.response.template = 'userimport_domain.html';
    }

    @param('users', Types.Content)
    @param('draft', Types.Boolean)
    async post(domainId: string, _users: string, draft: boolean) {
        const UserModel = global.Hydro.model.user;
        const DomainModel = global.Hydro.model.domain;
        const messages: string[] = [];
        const validRows: any[] = [];
        const domainCache = new Map<string, any>();
        const roleCache = new Map<string, Set<string>>();

        for (const [i, u] of _users.split('\n').entries()) {
            if (!u.trim()) continue;
            const row = parseLine(u, i + 1);
            if (!row) { messages.push(`Line ${i + 1}: Input invalid.`); continue; }
            if (!isEmail(row.email)) { messages.push(`Line ${row.lineNum}: Invalid email.`); continue; }
            if (!isUname(row.username)) { messages.push(`Line ${row.lineNum}: Invalid username.`); continue; }
            if (!isPassword(row.password)) { messages.push(`Line ${row.lineNum}: Invalid password.`); continue; }
            if (await UserModel.getByEmail('system', row.email)) { messages.push(`Line ${row.lineNum}: Email ${row.email} already exists.`); continue; }
            if (await UserModel.getByUname('system', row.username)) { messages.push(`Line ${row.lineNum}: Username ${row.username} already exists.`); continue; }

            let resolvedDomainId: string | undefined;
            if (row.domainInput) {
                if (!domainCache.has(row.domainInput)) {
                    domainCache.set(row.domainInput, await resolveDomain(row.domainInput));
                }
                const ddoc = domainCache.get(row.domainInput);
                if (!ddoc) { messages.push(`Line ${row.lineNum}: Domain "${row.domainInput}" not found.`); continue; }
                resolvedDomainId = ddoc._id;
                const desiredRole = row.role?.trim() || 'default';
                if (!roleCache.has(ddoc._id)) {
                    const list: any[] = await DomainModel.getRoles(ddoc);
                    roleCache.set(ddoc._id, new Set(list.map((r: any) => r._id)));
                }
                if (!roleCache.get(ddoc._id)!.has(desiredRole)) {
                    messages.push(`Line ${row.lineNum}: Role "${desiredRole}" not found. Available: ${[...roleCache.get(ddoc._id)!].join(', ')}`);
                    continue;
                }
            }
            messages.push(`Line ${row.lineNum}: OK ${row.email}/${row.username}${resolvedDomainId ? ` domain=${resolvedDomainId} role=${row.role?.trim() || 'default'}` : ''}`);
            validRows.push({ ...row, resolvedDomainId });
        }
        messages.push(`${validRows.length} users found.`);

        if (!draft) {
            for (const row of validRows) {
                try {
                    const uid = await UserModel.create(row.email, row.username, row.password);
                    if (row.resolvedDomainId) {
                        const role = row.role?.trim() || 'default';
                        await DomainModel.setUserRole(row.resolvedDomainId, uid, role);
                        messages.push(`${row.username}: created, enrolled in "${row.resolvedDomainId}" as "${role}".`);
                    } else {
                        messages.push(`${row.username}: created.`);
                    }
                } catch (e: any) {
                    messages.push(`${row.username}: ERROR — ${e.message}`);
                }
            }
        }
        this.response.body = { users: validRows, messages };
        this.response.template = 'userimport_domain.html';
    }
}

export async function apply(ctx: Context) {
    ctx.Route('userimport_domain', '/manage/userimport-domain', UserImportDomainHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.injectUI('ControlPanel', 'userimport_domain', { icon: 'import' }, PRIV.PRIV_EDIT_SYSTEM);
    ctx.i18n.load('zh', { userimport_domain: '导入用户（域+角色）' });
    ctx.i18n.load('en', { userimport_domain: 'Import User (Domain+Role)' });
}
