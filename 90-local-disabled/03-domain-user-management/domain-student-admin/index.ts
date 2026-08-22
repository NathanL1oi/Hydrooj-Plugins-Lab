import {
    Context,
    db,
    DomainModel,
    ForbiddenError,
    Handler,
    param,
    PERM,
    PRIV,
    Types,
    UserModel,
    ValidationError,
} from 'hydrooj';

type ImportMode = 'quick' | 'table';
type PasswordMode = 'fixed' | 'username' | 'random';

interface StudentCandidate {
    lineNum: number;
    name: string;
    studentId: string;
    username: string;
    email: string;
    password: string;
    role: string;
    groups: string[];
    errors: string[];
    uid?: number;
    created?: boolean;
    existing?: boolean;
    imported?: boolean;
}

interface ImportOptions {
    mode: ImportMode;
    prefix: string;
    startNumber: number;
    idWidth: number;
    defaultRole: string;
    defaultGroup: string;
    passwordMode: PasswordMode;
    fixedPassword: string;
    quickNames: string;
    tableText: string;
}

interface ImportForm {
    mode?: ImportMode;
    prefix?: string;
    startStudentId?: string;
    idWidth?: number | string;
    defaultRole?: string;
    defaultGroup?: string;
    passwordMode?: PasswordMode;
    fixedPassword?: string;
    quickNames?: string;
    tableText?: string;
}

const collManaged = db.collection('domain.studentAccount' as any);
const collGroup = db.collection('user.group' as any);

const ROLE_BLOCKLIST = new Set(['root', 'guest']);
const HEADER_ALIASES: Record<string, keyof Pick<StudentCandidate, 'name' | 'studentId' | 'password' | 'role'> | 'groups'> = {
    name: 'name',
    displayname: 'name',
    realname: 'name',
    '姓名': 'name',
    '名字': 'name',
    '学生姓名': 'name',
    studentid: 'studentId',
    sid: 'studentId',
    id: 'studentId',
    '学号': 'studentId',
    '编号': 'studentId',
    password: 'password',
    pass: 'password',
    pwd: 'password',
    '密码': 'password',
    role: 'role',
    '角色': 'role',
    group: 'groups',
    groups: 'groups',
    '小组': 'groups',
    '分组': 'groups',
};

function asText(value: any, fallback = '') {
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return fallback;
    return String(value);
}

function normalizePrefix(value: string, fallback: string) {
    const source = (value || fallback || 'domain').trim().toLowerCase();
    const prefix = source.replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
    return prefix || 'domain';
}

function normalizeStudentId(value: string) {
    return asText(value).trim().replace(/\s+/g, '');
}

function formatStudentId(n: number, width: number) {
    return String(n).padStart(Math.max(1, width || 1), '0');
}

function autoUsername(name: string) {
    return name.replace(/\s+/g, '').trim();
}

function emailFrom(username: string) {
    let hash = 2166136261;
    for (const char of username) {
        hash ^= char.codePointAt(0) || 0;
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return `student_${hash.toString(36)}@local.invalid`;
}

function refreshCandidateIdentity(candidate: StudentCandidate) {
    candidate.username = autoUsername(candidate.name);
    candidate.email = emailFrom(candidate.username);
}

function splitGroups(value: string) {
    return Array.from(new Set(asText(value)
        .split(/[|;；]+/)
        .map((item) => item.trim())
        .filter(Boolean)));
}

function randomPassword() {
    const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    for (let i = 0; i < 10; i++) result += chars[Math.floor(Math.random() * chars.length)];
    return result;
}

function isValidPassword(password: string) {
    try {
        return Types.Password[1](password);
    } catch (e) {
        return false;
    }
}

function splitLine(line: string) {
    const delimiter = line.includes('\t') ? '\t' : ',';
    return line.split(delimiter).map((item) => item.trim());
}

function normalizeHeader(text: string) {
    return text.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function hasHeader(cols: string[]) {
    return cols.some((col) => HEADER_ALIASES[normalizeHeader(col)]);
}

function passwordFor(mode: PasswordMode, fixedPassword: string, username: string, rowPassword = '') {
    if (rowPassword) return rowPassword;
    if (mode === 'username') return username;
    if (mode === 'random') return randomPassword();
    return fixedPassword;
}

function addCandidate(
    rows: StudentCandidate[],
    lineNum: number,
    name: string,
    rawStudentId: string,
    rawPassword: string,
    rawRole: string,
    rawGroups: string,
    options: ImportOptions,
    counter: { value: number; used: Set<string> },
) {
    const errors: string[] = [];
    name = name.trim();
    if (!name) errors.push('姓名不能为空。');

    let studentId = normalizeStudentId(rawStudentId);
    if (!studentId) {
        do {
            studentId = formatStudentId(counter.value++, options.idWidth);
        } while (counter.used.has(studentId));
    } else {
        const numeric = Number.parseInt(studentId, 10);
        if (/^\d+$/.test(studentId) && numeric >= counter.value) counter.value = numeric + 1;
    }
    counter.used.add(studentId);

    if (!/^[A-Za-z0-9_-]+$/.test(studentId)) errors.push('学号只能包含字母、数字、下划线或短横线。');

    const username = autoUsername(name);
    const email = emailFrom(username);
    const role = (rawRole || options.defaultRole || 'default').trim();
    const groups = rawGroups.trim() ? splitGroups(rawGroups) : splitGroups(options.defaultGroup);
    const password = passwordFor(options.passwordMode, options.fixedPassword, username, rawPassword.trim());

    if (!Types.Username[1](username)) errors.push(`生成用户名 ${username} 不合法。`);
    if (!Types.Email[1](email)) errors.push(`生成邮箱 ${email} 不合法。`);
    if (!isValidPassword(password)) errors.push('密码不符合 Hydro 密码规则。');

    rows.push({
        lineNum,
        name,
        studentId,
        username,
        email,
        password,
        role,
        groups,
        errors,
    });
}

function parseQuick(options: ImportOptions) {
    const rows: StudentCandidate[] = [];
    const counter = { value: options.startNumber, used: new Set<string>() };
    for (const [index, line] of options.quickNames.split('\n').entries()) {
        const name = line.trim();
        if (!name || name.startsWith('#')) continue;
        addCandidate(rows, index + 1, name, '', '', '', '', options, counter);
    }
    return rows;
}

function parseTable(options: ImportOptions) {
    const lines = options.tableText.split('\n')
        .map((line, index) => ({ line, lineNum: index + 1 }))
        .filter(({ line }) => line.trim() && !line.trim().startsWith('#'));
    const rows: StudentCandidate[] = [];
    const counter = { value: options.startNumber, used: new Set<string>() };
    if (!lines.length) return rows;

    let start = 0;
    let columns: Record<string, number> = { name: 0, studentId: 1, password: 2, role: 3, groups: 4 };
    const first = splitLine(lines[0].line);
    if (hasHeader(first)) {
        columns = {};
        first.forEach((col, index) => {
            const key = HEADER_ALIASES[normalizeHeader(col)];
            if (key) columns[key] = index;
        });
        start = 1;
    }

    for (let i = start; i < lines.length; i++) {
        const cols = splitLine(lines[i].line);
        const get = (key: string) => cols[columns[key]] || '';
        addCandidate(
            rows,
            lines[i].lineNum,
            get('name'),
            get('studentId'),
            get('password'),
            get('role'),
            get('groups'),
            options,
            counter,
        );
    }
    return rows;
}

function normalizeOptions(domainId: string, form: ImportForm, fallbackStartNumber: number) {
    const startStudentId = asText(form.startStudentId);
    return {
        mode: form.mode === 'table' ? 'table' : 'quick',
        prefix: normalizePrefix(asText(form.prefix), domainId),
        startNumber: Number.parseInt(startStudentId, 10) || fallbackStartNumber,
        idWidth: Math.max(Number(form.idWidth) || 3, normalizeStudentId(startStudentId).length || 0, 1),
        defaultRole: asText(form.defaultRole, 'default') || 'default',
        defaultGroup: asText(form.defaultGroup),
        passwordMode: form.passwordMode === 'username' || form.passwordMode === 'random' ? form.passwordMode : 'fixed',
        fixedPassword: asText(form.fixedPassword),
        quickNames: asText(form.quickNames),
        tableText: asText(form.tableText),
    } as ImportOptions;
}

function serializePreviewPayload(options: ImportOptions, candidates: StudentCandidate[]) {
    return JSON.stringify({
        form: {
            mode: options.mode,
            prefix: options.prefix,
            startStudentId: formatStudentId(options.startNumber, options.idWidth),
            idWidth: options.idWidth,
            defaultRole: options.defaultRole,
            defaultGroup: options.defaultGroup,
            passwordMode: options.passwordMode,
            fixedPassword: options.fixedPassword,
            quickNames: options.quickNames,
            tableText: options.tableText,
        },
        candidates: candidates.map((candidate) => ({
            lineNum: candidate.lineNum,
            name: candidate.name,
            studentId: candidate.studentId,
            username: candidate.username,
            email: candidate.email,
            password: candidate.password,
            role: candidate.role,
            groups: candidate.groups,
        })),
    });
}

function parsePreviewPayload(text: string) {
    if (!text) return null;
    try {
        const payload = JSON.parse(text);
        if (!payload || typeof payload !== 'object' || !Array.isArray(payload.candidates)) return null;
        const candidates = payload.candidates.map((raw: any, index: number) => ({
            lineNum: Number(raw.lineNum) || index + 1,
            name: asText(raw.name).trim(),
            studentId: normalizeStudentId(raw.studentId),
            username: '',
            email: '',
            password: asText(raw.password),
            role: asText(raw.role, 'default').trim() || 'default',
            groups: Array.isArray(raw.groups) ? raw.groups.map((group: any) => asText(group).trim()).filter(Boolean) : [],
            errors: [],
        })) as StudentCandidate[];
        for (const candidate of candidates) refreshCandidateIdentity(candidate);
        return {
            form: (payload.form || {}) as ImportForm,
            candidates,
        };
    } catch (e) {
        return null;
    }
}

async function nextStudentNumber(domainId: string) {
    const docs = await collManaged.find({ domainId }).project({ studentId: 1 }).toArray() as any[];
    let max = 0;
    for (const doc of docs) {
        const sid = asText(doc.studentId);
        if (/^\d+$/.test(sid)) max = Math.max(max, Number.parseInt(sid, 10));
    }
    return max + 1;
}

async function validateCandidates(domainId: string, candidates: StudentCandidate[], roles: Set<string>, groups: Set<string>) {
    const seenUsernames = new Set<string>();
    const seenEmails = new Set<string>();
    const seenStudentIds = new Set<string>();
    for (const candidate of candidates) {
        refreshCandidateIdentity(candidate);
        if (!candidate.name) candidate.errors.push('姓名不能为空。');
        if (!Types.Username[1](candidate.username)) candidate.errors.push(`生成用户名 ${candidate.username} 不合法。`);
        if (!Types.Email[1](candidate.email)) candidate.errors.push(`生成邮箱 ${candidate.email} 不合法。`);
        if (!isValidPassword(candidate.password)) candidate.errors.push('密码不符合 Hydro 密码规则。');
        if (!/^[A-Za-z0-9_-]+$/.test(candidate.studentId)) candidate.errors.push('学号只能包含字母、数字、下划线或短横线。');

        if (ROLE_BLOCKLIST.has(candidate.role)) candidate.errors.push('导入学生不能使用 root/guest 角色。');
        else if (!roles.has(candidate.role)) candidate.errors.push(`角色 ${candidate.role} 不存在。`);

        for (const group of candidate.groups) {
            if (!groups.has(group)) candidate.errors.push(`小组 ${group} 不存在。`);
        }

        if (seenUsernames.has(candidate.username)) candidate.errors.push(`本批次用户名 ${candidate.username} 重复。`);
        if (seenEmails.has(candidate.email)) candidate.errors.push(`本批次邮箱 ${candidate.email} 重复。`);
        if (seenStudentIds.has(candidate.studentId)) candidate.errors.push(`本批次学号 ${candidate.studentId} 重复。`);
        seenUsernames.add(candidate.username);
        seenEmails.add(candidate.email);
        seenStudentIds.add(candidate.studentId);

        const [resolved, managed] = await Promise.all([
            resolveExistingCandidateUser(candidate),
            collManaged.findOne({ domainId, studentId: candidate.studentId }) as Promise<any>,
        ]);
        if (resolved.error) candidate.errors.push(resolved.error);
        if (resolved.uid) {
            candidate.uid = resolved.uid;
            candidate.existing = true;
        }
        if (managed) {
            if (candidate.uid && Number(managed.uid) === candidate.uid) {
                candidate.existing = true;
            } else {
                candidate.errors.push(`学号 ${candidate.studentId} 已在本域托管。`);
            }
        }
    }
}

function userUid(udoc: any) {
    return Number(udoc?._id || 0);
}

function userMatchesCandidate(udoc: any, candidate: StudentCandidate) {
    return asText(udoc?.uname).trim().toLowerCase() === candidate.username.toLowerCase()
        && asText(udoc?.mail).trim().toLowerCase() === candidate.email.toLowerCase();
}

async function resolveExistingCandidateUser(candidate: StudentCandidate) {
    const [byName, byEmail] = await Promise.all([
        UserModel.getByUname('system', candidate.username),
        UserModel.getByEmail('system', candidate.email),
    ]);
    if (byName && byEmail && userUid(byName) !== userUid(byEmail)) {
        return { error: `用户名 ${candidate.username} 和邮箱 ${candidate.email} 已分别属于不同用户。` };
    }
    const udoc = byName || byEmail;
    if (!udoc) return {};
    if (!userMatchesCandidate(udoc, candidate)) {
        return { error: `用户名 ${candidate.username} 或邮箱 ${candidate.email} 已被其他用户占用。` };
    }
    if (userUid(udoc) <= 1 || udoc.hasPriv?.(PRIV.PRIV_EDIT_SYSTEM)) {
        return { error: `账号 ${candidate.username} 权限过高，不能作为托管学生账号。` };
    }
    return { uid: userUid(udoc) };
}

async function ensureCandidateUser(candidate: StudentCandidate, ip: string) {
    const resolved = await resolveExistingCandidateUser(candidate);
    if (resolved.error) throw new Error(resolved.error);
    if (resolved.uid) return { uid: resolved.uid, created: false };

    try {
        const uid = await UserModel.create(candidate.email, candidate.username, candidate.password, undefined, ip);
        return { uid, created: true };
    } catch (e) {
        const retry = await resolveExistingCandidateUser(candidate);
        if (!retry.error && retry.uid) return { uid: retry.uid, created: false };
        throw e;
    }
}

async function addUserToGroups(domainId: string, uid: number, groups: string[]) {
    for (const group of groups) {
        const gdoc = await collGroup.findOne({ domainId, name: group }) as any;
        const uids = new Set<number>(Array.isArray(gdoc?.uids) ? gdoc.uids : []);
        uids.add(uid);
        await UserModel.updateGroup(domainId, group, Array.from(uids));
    }
}

async function listManagedStudents(domainId: string) {
    const students = await collManaged.find({ domainId }).sort({ studentId: 1, createdAt: 1 }).limit(500).toArray() as any[];
    const udict = await UserModel.getList(domainId, students.map((student) => student.uid));
    return students.map((student) => ({
        ...student,
        user: udict[student.uid],
        groupText: (student.groups || []).join(', '),
    }));
}

class DomainStudentAdminHandler extends Handler {
    async prepare() {
        this.checkPerm(PERM.PERM_EDIT_DOMAIN);
    }

    async buildBody(domainId: string, extra: Record<string, any> = {}) {
        const [rolesRaw, groupsRaw, nextNo, students] = await Promise.all([
            DomainModel.getRoles(domainId),
            UserModel.listGroup(domainId),
            nextStudentNumber(domainId),
            listManagedStudents(domainId),
        ]);
        const roles = rolesRaw.filter((role: any) => !ROLE_BLOCKLIST.has(role._id));
        const defaultRole = roles.some((role: any) => role._id === 'default') ? 'default' : roles[0]?._id || 'default';
        const prefix = normalizePrefix(extra.form?.prefix || '', domainId);
        return {
            page_name: 'domain_student_admin',
            domainId,
            domainName: this.domain.name || this.domain._id,
            roles,
            groups: groupsRaw,
            students,
            nextStudentId: formatStudentId(nextNo, 3),
            form: {
                mode: 'quick',
                prefix,
                startStudentId: formatStudentId(nextNo, 3),
                idWidth: 3,
                defaultRole,
                defaultGroup: '',
                passwordMode: 'fixed',
                fixedPassword: '123456',
                quickNames: '',
                tableText: '',
                ...(extra.form || {}),
            },
            messages: extra.messages || [],
            candidates: extra.candidates || [],
            previewPayload: extra.previewPayload || '',
        };
    }

    async get({ domainId }) {
        this.response.template = 'domain_student_admin.html';
        this.response.body = await this.buildBody(domainId);
    }

    @param('action', Types.Range(['preview', 'import', 'reset_password']), true)
    @param('mode', Types.Range(['quick', 'table']), true)
    @param('prefix', Types.String, true)
    @param('startStudentId', Types.String, true)
    @param('idWidth', Types.PositiveInt, true)
    @param('defaultRole', Types.String, true)
    @param('defaultGroup', Types.String, true)
    @param('passwordMode', Types.Range(['fixed', 'username', 'random']), true)
    @param('fixedPassword', Types.String, true)
    @param('quickNames', Types.Content, true)
    @param('tableText', Types.Content, true)
    @param('previewPayload', Types.Content, true)
    @param('targetUid', Types.PositiveInt, true)
    @param('newPassword', Types.String, true)
    async post(
        { domainId },
        action: 'preview' | 'import' | 'reset_password' = 'preview',
        mode: ImportMode = 'quick',
        prefix = '',
        startStudentId = '',
        idWidth = 3,
        defaultRole = 'default',
        defaultGroup = '',
        passwordMode: PasswordMode = 'fixed',
        fixedPassword = '123456',
        quickNames = '',
        tableText = '',
        previewPayload = '',
        targetUid = 0,
        newPassword = '',
    ) {
        if (action === 'reset_password') {
            await this.resetPassword(domainId, targetUid, newPassword);
            return;
        }
        const fallbackStartNumber = await nextStudentNumber(domainId);
        let previewCandidates: StudentCandidate[] | undefined;
        let payloadError = '';
        const submitted = normalizeOptions(domainId, {
            mode,
            prefix,
            startStudentId,
            idWidth,
            defaultRole,
            defaultGroup,
            passwordMode,
            fixedPassword,
            quickNames,
            tableText,
        }, fallbackStartNumber);
        let options = submitted;
        if (action === 'import' && previewPayload) {
            const payload = parsePreviewPayload(previewPayload);
            if (payload) {
                options = normalizeOptions(domainId, payload.form, fallbackStartNumber);
                previewCandidates = payload.candidates;
            } else {
                payloadError = '确认导入参数已失效，请重新预览后再导入。';
            }
        }
        await this.importStudents(
            domainId,
            action,
            options,
            previewCandidates,
            payloadError,
        );
    }

    async importStudents(
        domainId: string,
        action: 'preview' | 'import',
        options: ImportOptions,
        previewCandidates?: StudentCandidate[],
        payloadError = '',
    ) {
        const [rolesRaw, groupsRaw] = await Promise.all([
            DomainModel.getRoles(domainId),
            UserModel.listGroup(domainId),
        ]);
        const roles = new Set(rolesRaw.map((role: any) => role._id));
        const groups = new Set(groupsRaw.map((group: any) => group.name));
        const candidates = previewCandidates || (options.mode === 'table' ? parseTable(options) : parseQuick(options));
        const messages: string[] = [];
        for (const candidate of candidates) refreshCandidateIdentity(candidate);
        if (payloadError) messages.push(payloadError);
        if (!candidates.length) messages.push('没有解析到学生，请检查输入内容。');
        await validateCandidates(domainId, candidates, roles, groups);

        const hasErrors = Boolean(payloadError) || candidates.some((candidate) => candidate.errors.length);
        if (action === 'preview' || hasErrors) {
            const reusable = candidates.filter((candidate) => candidate.existing && !candidate.errors.length).length;
            messages.push(hasErrors
                ? '预览发现错误，修正后再导入。'
                : `预览通过：${candidates.length} 个学生可导入${reusable ? `，其中 ${reusable} 个将加入/修复到当前子域` : ''}。`);
            const previewPayload = hasErrors ? '' : serializePreviewPayload(options, candidates);
            this.response.template = 'domain_student_admin.html';
            this.response.body = await this.buildBody(domainId, {
                form: this.optionsToForm(options),
                candidates,
                messages,
                previewPayload,
            });
            return;
        }

        let success = 0;
        let created = 0;
        let repaired = 0;
        for (const candidate of candidates) {
            try {
                const userResult = await ensureCandidateUser(candidate, this.request.ip || '127.0.0.1');
                const now = new Date();
                await DomainModel.setUserInDomain(domainId, userResult.uid, {
                    join: true,
                    role: candidate.role,
                    displayName: candidate.name,
                });
                await addUserToGroups(domainId, userResult.uid, candidate.groups);
                await collManaged.updateOne(
                    { domainId, uid: userResult.uid },
                    {
                        $set: {
                            domainId,
                            uid: userResult.uid,
                            uname: candidate.username,
                            email: candidate.email,
                            name: candidate.name,
                            studentId: candidate.studentId,
                            role: candidate.role,
                            groups: candidate.groups,
                            managed: true,
                            updatedBy: this.user._id,
                            updatedAt: now,
                        },
                        $setOnInsert: {
                            createdBy: this.user._id,
                            createdAt: now,
                        },
                    },
                    { upsert: true },
                );
                candidate.uid = userResult.uid;
                candidate.created = userResult.created;
                candidate.existing = !userResult.created;
                candidate.imported = true;
                if (userResult.created) created++;
                else repaired++;
                success++;
            } catch (e: any) {
                candidate.errors.push(e.message || String(e));
            }
        }

        messages.push(`导入完成：成功 ${success} 个（新建 ${created} 个，加入/修复 ${repaired} 个），失败 ${candidates.length - success} 个。`);
        this.response.template = 'domain_student_admin.html';
        this.response.body = await this.buildBody(domainId, {
            form: this.optionsToForm(options),
            candidates,
            messages,
        });
    }

    async resetPassword(domainId: string, uid: number, password: string) {
        if (!uid) throw new ValidationError('targetUid', null, '请选择要重置密码的学生。');
        if (!isValidPassword(password)) throw new ValidationError('newPassword', null, '新密码不符合 Hydro 密码规则。');
        const managed = await collManaged.findOne({ domainId, uid, managed: true }) as any;
        if (!managed) throw new ForbiddenError('只能重置本子域托管学生的密码。');
        const udoc = await UserModel.getById(domainId, uid);
        if (!udoc || uid <= 1 || udoc.hasPriv?.(PRIV.PRIV_EDIT_SYSTEM)) throw new ForbiddenError('不能重置高权限账号密码。');
        await UserModel.setPassword(uid, password);
        await collManaged.updateOne(
            { domainId, uid },
            { $set: { lastPasswordResetBy: this.user._id, lastPasswordResetAt: new Date(), updatedAt: new Date() } },
        );
        this.response.template = 'domain_student_admin.html';
        this.response.body = await this.buildBody(domainId, {
            messages: [`已重置 ${managed.name || uid} 的密码。`],
        });
    }

    optionsToForm(options: ImportOptions) {
        return {
            mode: options.mode,
            prefix: options.prefix,
            startStudentId: formatStudentId(options.startNumber, options.idWidth),
            idWidth: options.idWidth,
            defaultRole: options.defaultRole,
            defaultGroup: options.defaultGroup,
            passwordMode: options.passwordMode,
            fixedPassword: options.fixedPassword,
            quickNames: options.quickNames,
            tableText: options.tableText,
        };
    }
}

export async function apply(ctx: Context) {
    await db.ensureIndexes(
        collManaged,
        { key: { domainId: 1, studentId: 1 }, name: 'domain_student_id', unique: true },
        { key: { domainId: 1, uid: 1 }, name: 'domain_student_uid', unique: true },
    );
    ctx.Route('domain_student_admin', '/domain/student-admin', DomainStudentAdminHandler, PERM.PERM_EDIT_DOMAIN);
    ctx.injectUI('DomainManage', 'domain_student_admin', { family: 'User', icon: 'user' }, PERM.PERM_EDIT_DOMAIN);
    ctx.i18n.load('zh', {
        domain_student_admin: '学生账号管理',
    });
    ctx.i18n.load('en', {
        domain_student_admin: 'Student Accounts',
    });
}
