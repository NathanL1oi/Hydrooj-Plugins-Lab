import {
    Context, ProblemModel, ProblemDoc, _, PERM, PRIV,
    ForbiddenError, PermissionError, Handler, param, Types, ContestModel,
    ObjectId, ContestNotEndedError, ContestNotFoundError, ContestNotLiveError, ContestNotAttendedError
} from 'hydrooj';

function canExportContestPdf(handler: any) {
    return !!handler?.user?.hasPriv?.(PRIV.PRIV_EDIT_SYSTEM);
}

function alphabeticId(index: number) {
    let n = index + 1;
    let result = '';
    while (n > 0) {
        n -= 1;
        result = String.fromCharCode(65 + (n % 26)) + result;
        n = Math.floor(n / 26);
    }
    return result;
}

function safePathSegment(value: any, fallback: string) {
    const cleaned = String(value || '')
        .trim()
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/^_+|_+$/g, '');
    return cleaned || fallback;
}

function contestPdfProblemMeta(pdoc: any, index: number) {
    const label = alphabeticId(index);
    const fileIoName = pdoc?.config?.type === 'default' && pdoc?.config?.subType
        ? String(pdoc.config.subType).trim()
        : '';
    const directory = safePathSegment(fileIoName || pdoc?.pid || pdoc?.docId || label, label);
    return {
        label,
        directory,
        sourceFile: `${directory}.cpp`,
        fileIoName,
        fileIoDisplay: fileIoName || '否',
        inputFile: fileIoName ? `${fileIoName}.in` : '-',
        outputFile: fileIoName ? `${fileIoName}.out` : '-',
    };
}

class ContestPDFHandler extends Handler {
    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: ObjectId) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
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
            const index = tdoc.pids.findIndex((pid: any) => (
                String(pid) === String(problems[p].docId)
                || String(pid) === String(problems[p].pid)
            ));
            (problems[p] as any).contestPdf = contestPdfProblemMeta(problems[p], index < 0 ? 0 : index);
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
    ctx.Route("contest_pdf", "/contest/:tid/pdf", ContestPDFHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.injectUI('ContestDetail' as any, 'contest_pdf', (handler: any) => ({
        icon: 'book',
        displayName: 'Export Problem PDF',
        args: { tid: handler.args?.tid || handler.tdoc?.docId || handler.tdoc?._id },
    }), canExportContestPdf);
    ctx.on('handler/after/ContestDetail#get', async (handler: any) => {
        if (!canExportContestPdf(handler)) return;
        handler.UiContext ||= {};
        handler.UiContext.contestPdf = {
            url: handler.url('contest_pdf', { tid: handler.args?.tid || handler.tdoc?.docId }),
            title: '\u5bfc\u51fa\u9898\u9762',
        };
    });
    ctx.i18n.load('zh', {
        contest_pdf: '\u5bfc\u51fa\u9898\u9762',
        'Export Problem PDF': '\u5bfc\u51fa\u9898\u9762',
    });
    ctx.i18n.load('en', {
        contest_pdf: 'Export Statements',
        'Export Problem PDF': 'Export Statements',
    });
}
