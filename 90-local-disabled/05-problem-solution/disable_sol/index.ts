import {
    Context, Handler, PERM, PRIV, PermissionError, ProblemModel, Types, ValidationError, param,
} from 'hydrooj';

declare module 'hydrooj' {
    interface ProblemDoc {
        disable_sol: boolean;
    }
}

const EDIT_COURSE_PERM = (PERM as any).PERM_EDIT_TRAINING || PERM.PERM_EDIT_DOMAIN;
const FALSE_VALUES = new Set(['false', 'off', 'no', '0', 'open', 'enable', 'enabled', 'show']);

function parseDisableSol(value: any) {
    return !FALSE_VALUES.has(String(value ?? 'false').trim().toLowerCase());
}

function normalizePid(pid: any) {
    if (typeof pid === 'number') return pid;
    if (typeof pid === 'string' && /^\d+$/.test(pid)) return +pid;
    if (typeof pid === 'string' && /^P\d+$/i.test(pid)) return +pid.slice(1);
    return pid;
}

function collectDagPids(dag: any[] = []) {
    const pids: any[] = [];
    for (const node of dag) {
        if (Array.isArray(node?.pids)) pids.push(...node.pids);
    }
    return pids;
}

function uniquePids(rawPids: any[]) {
    const result: any[] = [];
    const seen = new Set<string>();
    for (const rawPid of rawPids) {
        const pid = normalizePid(rawPid);
        if (!pid && pid !== 0) continue;
        const key = String(pid);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(pid);
    }
    return result;
}

function getCourseModel() {
    const CourseModel = (global as any).Hydro?.model?.course;
    if (!CourseModel) throw new ValidationError('scope', null, 'course-atr plugin is not loaded.');
    return CourseModel;
}

function canManageCourseSolution(user: any) {
    return user.hasPerm(PERM.PERM_EDIT_DOMAIN) || user.hasPerm(EDIT_COURSE_PERM);
}

function canManageProblemSolution(user: any, pdoc: any) {
    return user.hasPerm(PERM.PERM_EDIT_DOMAIN)
        || user.hasPerm(PERM.PERM_EDIT_PROBLEM)
        || user.own?.(pdoc, PERM.PERM_EDIT_PROBLEM_SELF);
}

class CourseSolutionSwitchHandler extends Handler {
    @param('scope', Types.Range(['course', 'section', 'subsec', 'problem']))
    @param('disable_sol', Types.String)
    @param('cid', Types.ObjectId, true)
    @param('csid', Types.ObjectId, true)
    @param('ssid', Types.ObjectId, true)
    @param('pid', Types.String, true)
    async post(domainId: string, scope: string, disableSolValue: string, cid?: any, csid?: any, ssid?: any, pid?: string) {
        if (!canManageCourseSolution(this.user)) throw new PermissionError();

        const CourseModel = scope === 'problem' ? null : getCourseModel();
        const disable_sol = parseDisableSol(disableSolValue);
        let pids: any[] = [];

        if (scope === 'course') {
            if (!cid) throw new ValidationError('cid');
            await CourseModel.get(domainId, cid);
            const sections = await CourseModel.getMultiSection(domainId, cid).toArray();
            pids = uniquePids(sections.flatMap((section: any) => collectDagPids(section?.dag || [])));
        } else if (scope === 'section') {
            if (!csid) throw new ValidationError('csid');
            const section = await CourseModel.getSection(domainId, csid);
            pids = uniquePids(collectDagPids(section?.dag || []));
        } else if (scope === 'subsec') {
            if (!csid || !ssid) throw new ValidationError('ssid');
            const [, subsec] = await CourseModel.getSubSection(domainId, csid, ssid);
            pids = uniquePids(subsec?.pids || []);
        } else if (scope === 'problem') {
            if (!pid) throw new ValidationError('pid');
            pids = uniquePids([pid]);
        }

        let updated = 0;
        const failed: any[] = [];
        for (const currentPid of pids) {
            try {
                await ProblemModel.edit(domainId, currentPid, { disable_sol });
                updated += 1;
            } catch (error) {
                failed.push(currentPid);
            }
        }

        try {
            if (CourseModel && scope === 'course' && cid) await CourseModel.edit(domainId, cid, { disable_sol });
            if (CourseModel && scope === 'section' && csid) await CourseModel.editSection(domainId, csid, { disable_sol });
            if (CourseModel && scope === 'subsec' && csid && ssid) await CourseModel.editSubSection(domainId, csid, ssid, { disable_sol });
        } catch (error) {
            // Parent course nodes may come from older course-atr versions; problem states were already updated.
        }

        this.back({
            message: disable_sol ? 'solution_closed' : 'solution_opened',
            updated: String(updated),
            failed: String(failed.length),
        });
    }
}

class ProblemSolutionSwitchHandler extends Handler {
    @param('pid', Types.String)
    @param('disable_sol', Types.String)
    async post(domainId: string, pid: string, disableSolValue: string) {
        const pdoc = await ProblemModel.get(domainId, normalizePid(pid));
        if (!pdoc) throw new ValidationError('pid');
        if (!canManageProblemSolution(this.user, pdoc)) throw new PermissionError(PERM.PERM_EDIT_PROBLEM);

        const disable_sol = parseDisableSol(disableSolValue);
        await ProblemModel.edit(domainId, pdoc.docId, { disable_sol });
        this.back({ message: disable_sol ? 'solution_closed' : 'solution_opened' });
    }
}

function exposeProblemSolutionSwitch(handler: any) {
    if (!handler.pdoc || handler.tdoc) return;
    if (!canManageProblemSolution(handler.user, handler.pdoc)) return;
    handler.UiContext ||= {};
    handler.UiContext.disableSolProblem = {
        canManage: true,
        closed: !!handler.pdoc.disable_sol,
        pid: handler.pdoc.pid || handler.pdoc.docId,
        docId: handler.pdoc.docId,
        action: handler.url('disable_sol_problem_toggle'),
    };
}

export async function apply(ctx: Context) {
    if (!ProblemModel.PROJECTION_PUBLIC.includes('disable_sol' as any)) {
        ProblemModel.PROJECTION_PUBLIC.push('disable_sol' as any);
    }

    ctx.Route('disable_sol_course_toggle', '/domain/course-solution-visibility', CourseSolutionSwitchHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('disable_sol_problem_toggle', '/domain/problem-solution-visibility', ProblemSolutionSwitchHandler, PRIV.PRIV_USER_PROFILE);

    ctx.on('handler/after/ProblemEdit#post', async (that) => {
        const disable_sol = parseDisableSol(that.args.disable_sol);
        await ProblemModel.edit(that.args.domainId, that.pdoc.docId, { disable_sol });
    });
    ctx.on('handler/after/ProblemCreate#post', async (that) => {
        const disable_sol = parseDisableSol(that.args.disable_sol);
        let pid = that.response.body.pid;
        if (typeof pid !== 'string') pid = `P${pid}`;
        const pdoc = await ProblemModel.get(that.args.domainId, pid);
        await ProblemModel.edit(that.args.domainId, pdoc.docId, { disable_sol });
    });
    ctx.on('handler/before/ProblemSolution', async (that) => {
        if (that.pdoc.disable_sol && !canManageProblemSolution(that.user, that.pdoc)) {
            throw new PermissionError();
        }
    });
    ctx.on('handler/before/ProblemSolutionRaw', async (that) => {
        if (that.pdoc.disable_sol && !canManageProblemSolution(that.user, that.pdoc)) {
            throw new PermissionError();
        }
    });
    ctx.on('handler/after/ProblemDetail#get', async (that) => exposeProblemSolutionSwitch(that));
}
