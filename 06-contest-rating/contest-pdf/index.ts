import {
    Context, ProblemModel, ProblemDoc, _, PERM,
    ForbiddenError, PermissionError, Handler, param, Types, ContestModel,
    ObjectId, ContestNotEndedError, ContestNotFoundError, ContestNotLiveError, ContestNotAttendedError
} from 'hydrooj';

class ContestPDFHandler extends Handler {
    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: ObjectId) {
        const tdoc = await ContestModel.get(domainId, tid);
        const tsdoc = await ContestModel.getStatus(domainId, tid, this.user._id);
        if (!tdoc) throw new ContestNotFoundError(domainId, tid);
        if (!this.user.own(tdoc) && !this.user.hasPerm(PERM.PERM_EDIT_CONTEST)) {
            if (ContestModel.isNotStarted(tdoc)) throw new ContestNotLiveError(domainId, tid);
            if (!ContestModel.isDone(tdoc) && !tsdoc?.attend) throw new ContestNotAttendedError(domainId, tid);
        }
        if (tsdoc?.attend && !tsdoc.startAt && ContestModel.isOngoing(tdoc)) {
            await ContestModel.setStatus(domainId, tid, this.user._id, { startAt: new Date() });
        }
        const problems = await ProblemModel.getList(domainId, tdoc.pids, true, false, undefined, true);
        for (const p in problems) {
            problems[p].content = problems[p].content.replace(/\(file:\/\/(.+?)\)/g, u => {
                let d = u.match(/\(file:\/\/(.+?)\)/);
                return `(../../p/${p}/file/${d[1]}${d[1].includes("?") ? "&" : "?"}tid=${tid})`
            }).replace(/="file:\/\/(.+?)"/g, u => {
                let d = u.match(/="file:\/\/(.+?)"/);
                return `="../../p/${p}/file/${d[1]}${d[1].includes("?") ? "&" : "?"}tid=${tid}"`
            }).replace(/=\\"file:\/\/(.+?)\\"/g, u => {
                let d = u.match(/=\\"file:\/\/(.+?)\\"/);
                return `=\\"../../p/${p}/file/${d[1]}${d[1].includes("?") ? "&" : "?"}tid=${tid}\\"`
            });
        }
        this.response.template = "contest_pdf.html";
        this.response.body = {
            tdoc: tdoc,
            pdict: problems
        }
    }
}

export async function apply(ctx: Context) {
    ctx.Route("contest_pdf", "/contest/:tid/pdf", ContestPDFHandler, PERM.PERM_VIEW_CONTEST);
}
