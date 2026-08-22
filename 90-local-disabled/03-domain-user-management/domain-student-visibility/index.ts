import {
    Context, ForbiddenError, Handler, PERM, PRIV, Types, db, param,
} from 'hydrooj';

const PLUGIN_ID = 'domain-student-visibility';

interface VisibilityConfig {
    _id: string;
    domainId: string;
    allowProblemSet: boolean;
    showProblemStats: boolean;
    showProblemDifficultyTags: boolean;
    updatedAt?: Date;
    updatedBy?: number;
}

const collConfig = db.collection('domain.studentVisibility.config' as any);

const DEFAULT_CONFIG: Omit<VisibilityConfig, '_id' | 'domainId'> = {
    allowProblemSet: true,
    showProblemStats: true,
    showProblemDifficultyTags: true,
};

const cache = new Map<string, VisibilityConfig>();

function runtimeEnabled() {
    const pluginSwitch = (globalThis as any).Hydro?.model?.pluginSwitch;
    return pluginSwitch?.isEnabledSync?.(PLUGIN_ID) !== false;
}

function normalizeConfig(domainId: string, raw?: Partial<VisibilityConfig> | null): VisibilityConfig {
    return {
        _id: domainId,
        domainId,
        allowProblemSet: raw?.allowProblemSet ?? DEFAULT_CONFIG.allowProblemSet,
        showProblemStats: raw?.showProblemStats ?? DEFAULT_CONFIG.showProblemStats,
        showProblemDifficultyTags: raw?.showProblemDifficultyTags ?? DEFAULT_CONFIG.showProblemDifficultyTags,
        updatedAt: raw?.updatedAt,
        updatedBy: raw?.updatedBy,
    };
}

async function getConfig(domainId: string) {
    if (cache.has(domainId)) return cache.get(domainId)!;
    const doc = await collConfig.findOne({ _id: domainId }) as VisibilityConfig | null;
    const config = normalizeConfig(domainId, doc);
    cache.set(domainId, config);
    return config;
}

async function setConfig(domainId: string, config: VisibilityConfig, uid: number) {
    const next = {
        ...config,
        _id: domainId,
        domainId,
        updatedAt: new Date(),
        updatedBy: uid,
    };
    await collConfig.updateOne(
        { _id: domainId },
        { $set: next, $setOnInsert: { createdAt: new Date() } },
        { upsert: true },
    );
    cache.set(domainId, next);
    return next;
}

function canBypass(handler: any) {
    return handler.user?.hasPriv?.(PRIV.PRIV_EDIT_SYSTEM)
        || handler.user?.hasPerm?.(PERM.PERM_EDIT_DOMAIN)
        || handler.user?.hasPerm?.(PERM.PERM_EDIT_PROBLEM)
        || handler.user?.hasPerm?.(PERM.PERM_CREATE_PROBLEM)
        || handler.user?.hasPerm?.(PERM.PERM_EDIT_TRAINING);
}

function studentView(handler: any) {
    return !canBypass(handler);
}

function publicConfig(config: VisibilityConfig, studentMode: boolean) {
    return {
        studentMode,
        allowProblemSet: !studentMode || config.allowProblemSet,
        showProblemStats: !studentMode || config.showProblemStats,
        showProblemDifficultyTags: !studentMode || config.showProblemDifficultyTags,
    };
}

function sanitizeProblemDoc(pdoc: any, config: VisibilityConfig) {
    if (!pdoc) return;
    if (!config.showProblemStats) {
        pdoc.nSubmit = 0;
        pdoc.nAccept = 0;
    }
    if (!config.showProblemDifficultyTags) {
        pdoc.difficulty = '-';
        pdoc.tag = [];
    }
}

function sanitizeProblemList(args: any, config: VisibilityConfig) {
    if (!args) return;
    for (const pdoc of args.pdocs || []) sanitizeProblemDoc(pdoc, config);
}

function sanitizeResponseBody(handler: any, config: VisibilityConfig) {
    const body = handler.response?.body;
    if (!body) return;
    sanitizeProblemList(body, config);
    sanitizeProblemDoc(body.pdoc, config);
    if (body.pdict) {
        for (const pdoc of Object.values(body.pdict as Record<string, any>)) sanitizeProblemDoc(pdoc, config);
    }
}

function wrapRenderHTML(handler: any, config: VisibilityConfig) {
    if (handler.__studentVisibilityRenderWrapped) return;
    handler.__studentVisibilityRenderWrapped = true;
    const original = handler.renderHTML.bind(handler);
    handler.renderHTML = (templateName: string, args: Record<string, any>) => {
        if (templateName === 'partials/problem_list.html' || templateName === 'partials/training_detail.html') {
            sanitizeProblemList(args, config);
            if (args?.pdict) {
                for (const pdoc of Object.values(args.pdict as Record<string, any>)) sanitizeProblemDoc(pdoc, config);
            }
        }
        return original(templateName, args);
    };
}

function patchProblemNavChecker() {
    const hydro = (globalThis as any).Hydro;
    const nodes = hydro?.ui?.nodes?.Nav || hydro?.ui?.getNodes?.('Nav') || [];
    const node = nodes.find((item: any) => item.name === 'problem_main');
    if (!node || node.__studentVisibilityPatched) return;
    const original = typeof node.checker === 'function' ? node.checker : () => true;
    node.checker = (handler: any) => {
        if (!original(handler)) return false;
        if (!runtimeEnabled()) return true;
        const visibility = handler.UiContext?.domainStudentVisibility;
        return visibility?.allowProblemSet !== false;
    };
    node.__studentVisibilityPatched = true;
}

class DomainStudentVisibilityHandler extends Handler {
    async prepare() {
        this.checkPerm(PERM.PERM_EDIT_DOMAIN);
    }

    async get({ domainId }) {
        const config = await getConfig(domainId);
        this.response.template = 'domain_student_visibility.html';
        this.response.body = {
            page_name: 'domain_student_visibility',
            config,
        };
    }

    @param('allowProblemSet', Types.Boolean, true)
    @param('showProblemStats', Types.Boolean, true)
    @param('showProblemDifficultyTags', Types.Boolean, true)
    async post({ domainId }, allowProblemSet = false, showProblemStats = false, showProblemDifficultyTags = false) {
        const current = await getConfig(domainId);
        await setConfig(domainId, {
            ...current,
            allowProblemSet,
            showProblemStats,
            showProblemDifficultyTags,
        }, this.user._id);
        this.back({ message: '学生可见性设置已保存。' });
    }
}

export async function apply(ctx: Context) {
    patchProblemNavChecker();

    ctx.Route('domain_student_visibility', '/domain/student-visibility', DomainStudentVisibilityHandler, PERM.PERM_EDIT_DOMAIN);
    ctx.injectUI('DomainManage', 'domain_student_visibility', { family: '访问控制', icon: 'eye' }, PERM.PERM_EDIT_DOMAIN);

    ctx.on('handler/create/http', async (handler: any) => {
        if (!runtimeEnabled()) return;
        const domainId = handler.domain?._id || handler.args?.domainId || 'system';
        const config = await getConfig(domainId);
        handler.UiContext = handler.UiContext || {};
        handler.UiContext.domainStudentVisibility = publicConfig(config, studentView(handler));
        patchProblemNavChecker();
    });

    ctx.on('handler/before/ProblemMain#get', async (handler: any) => {
        if (!runtimeEnabled()) return;
        const config = await getConfig(handler.domain._id);
        if (!studentView(handler)) return;
        if (!config.allowProblemSet) throw new ForbiddenError('本域已关闭学生查看题库。');
        wrapRenderHTML(handler, config);
    });

    ctx.on('handler/after/ProblemMain#get', async (handler: any) => {
        if (!runtimeEnabled()) return;
        if (!studentView(handler)) return;
        sanitizeResponseBody(handler, await getConfig(handler.domain._id));
    });

    ctx.on('handler/after/ProblemDetail#get', async (handler: any) => {
        if (!runtimeEnabled()) return;
        if (!studentView(handler)) return;
        sanitizeResponseBody(handler, await getConfig(handler.domain._id));
    });

    ctx.on('handler/after/TrainingDetail#get', async (handler: any) => {
        if (!runtimeEnabled()) return;
        if (!studentView(handler)) return;
        sanitizeResponseBody(handler, await getConfig(handler.domain._id));
    });

    ctx.i18n.load('zh', {
        domain_student_visibility: '学生可见性',
    });
    ctx.i18n.load('en', {
        domain_student_visibility: 'Student Visibility',
    });
}
