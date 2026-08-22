/**
 * @hydrooj/contest-userimport
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

import {
    Context, Handler, param, PRIV, Types, db,
    ContestModel, UserModel, DomainModel,
} from 'hydrooj';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Split a raw textarea line into trimmed columns (comma or tab). */
function splitLine(raw: string): string[] {
    let cols = raw.includes('\t')
        ? raw.split('\t').map((c) => c.trim())
        : raw.split(',').map((c) => c.trim());
    while (cols.length && !cols[cols.length - 1]) cols.pop();
    return cols;
}

/**
 * Parse one line.  Supported formats:
 *   username
 *   email
 *   uid (pure integer)
 */
function parseLine(raw: string, lineNum: number): { lineNum: number; query: string } | null {
    const line = raw.trim();
    if (!line) return null;
    const cols = splitLine(line);
    const query = cols[0];
    if (!query) return null;
    return { lineNum, query };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

class ContestBatchUserHandler extends Handler {
    /** Verify caller has system-edit privilege. */
    async prepare() {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
    }

    /** GET /contest/:tid/batch-add — show the form */
    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: any) {
        const tdoc = await ContestModel.get(domainId, tid);
        this.response.body = { tdoc, tid, messages: [], stats: null };
        this.response.template = 'contest_batch_user.html';
    }

    /** POST — preview or import */
    @param('tid', Types.ObjectId)
    @param('users', Types.Content)
    @param('draft', Types.Boolean)
    async post(domainId: string, tid: any, _users: string, draft = false) {
        const tdoc = await ContestModel.get(domainId, tid);
        const messages: string[] = [];
        const toEnroll: Array<{ uid: number; uname: string }> = [];

        // ── resolve each line ──────────────────────────────────────────────
        for (const [i, rawLine] of _users.split('\n').entries()) {
            if (!rawLine.trim()) continue;
            const row = parseLine(rawLine, i + 1);
            if (!row) {
                messages.push(`Line ${i + 1}: (empty, skipped)`);
                continue;
            }
            const { query } = row;

            let udoc: any = null;

            // Try uid (pure number)
            if (/^\d+$/.test(query)) {
                udoc = await UserModel.getById(domainId, Number(query));
            }
            // Try email
            if (!udoc && query.includes('@')) {
                udoc = await UserModel.getByEmail(domainId, query);
            }
            // Try username
            if (!udoc) {
                udoc = await UserModel.getByUname(domainId, query);
            }

            if (!udoc) {
                messages.push(`Line ${row.lineNum}: User "${query}" not found.`);
                continue;
            }

            // Check already attending
            const attend = await ContestModel.getStatus(domainId, tid, udoc._id);
            if (attend) {
                messages.push(`Line ${row.lineNum}: ${udoc.uname} (uid=${udoc._id}) is already in the contest — skipped.`);
                continue;
            }

            messages.push(`Line ${row.lineNum}: OK — ${udoc.uname} (uid=${udoc._id})`);
            toEnroll.push({ uid: udoc._id, uname: udoc.uname });
        }

        messages.push(`--- ${toEnroll.length} user(s) to be added ---`);

        let added = 0;
        let failed = 0;

        if (!draft) {
            for (const { uid, uname } of toEnroll) {
                try {
                    // attend() registers the user without submitting a solution
                    await ContestModel.attend(domainId, tid, uid);
                    messages.push(`${uname}: enrolled.`);
                    added++;
                } catch (e: any) {
                    messages.push(`${uname}: ERROR — ${e.message}`);
                    failed++;
                }
            }
            messages.push(`Done. Added: ${added}, Failed: ${failed}.`);
        }

        this.response.body = {
            tdoc,
            tid,
            messages,
            stats: draft ? null : { added, failed },
        };
        this.response.template = 'contest_batch_user.html';
    }
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export async function apply(ctx: Context) {
    ctx.Route(
        'contest_batch_user',
        '/contest/:tid/batch-add',
        ContestBatchUserHandler,
        PRIV.PRIV_EDIT_SYSTEM,
    );

    // Inject a button into the contest user management page sidebar
    ctx.injectUI('ContestDetail', 'contest_batch_user', (h) => ({
        icon: 'import',
        displayName: 'Batch Add Users',
        args: { tid: h.args?.tid ?? '' },
    }), PRIV.PRIV_EDIT_SYSTEM);

    ctx.i18n.load('zh', {
        contest_batch_user: '批量添加用户',
        'Batch Add Users': '批量添加用户',
        'Batch Add Users to Contest': '批量添加用户到比赛',
    });
    ctx.i18n.load('en', {
        contest_batch_user: 'Batch Add Users',
        'Batch Add Users': 'Batch Add Users',
        'Batch Add Users to Contest': 'Batch Add Users to Contest',
    });
}
