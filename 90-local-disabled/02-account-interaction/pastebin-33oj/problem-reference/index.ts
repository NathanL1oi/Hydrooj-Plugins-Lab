import { Context, ForbiddenError, ProblemModel, SolutionModel, SolutionNotFoundError, UserModel } from 'hydrooj';

export const description = '题目引用增强';

export function apply(ctx: Context) {
    ctx.on('handler/after/ProblemDetail#get', async (h: any) => {
        if (h.pdoc && h.pdoc.reference) {
            const { domainId, pid } = h.pdoc.reference;
            const refProblem = await ProblemModel.get(domainId, pid);
            if (refProblem) {
                h.response.body.pdoc.content = refProblem.content;
                const scnt = await SolutionModel.count(domainId, { parentType: 10, parentId: pid });
                h.response.body.solutionCount = scnt;
            }
        }
    });

    ctx.on('handler/after/ProblemSolution#get', async (h: any) => {
        h.UiContext.pdoc = h.pdoc;
        if (h.pdoc && h.pdoc.reference) {
            const { domainId, pid } = h.pdoc.reference;
            const page = h.args.page || 1;

            let [psdocs, pcount, pscount] = await h.paginate(
                SolutionModel.getMulti(domainId, pid),
                page,
                'solution',
            );

            if (h.args.sid) {
                psdocs = [await SolutionModel.get(domainId, h.args.sid)];
                if (!psdocs[0]) throw new SolutionNotFoundError(domainId, h.args.sid);
            }

            const uids = [h.pdoc.owner];
            const docids = [];
            for (const psdoc of psdocs) {
                docids.push(psdoc.docId);
                uids.push(psdoc.owner);
                if (psdoc.reply && psdoc.reply.length) {
                    for (const psrdoc of psdoc.reply) uids.push(psrdoc.owner);
                }
            }
            const udict = await UserModel.getList(h.args.domainId || domainId, uids);
            const pssdict = await SolutionModel.getListStatus(h.args.domainId || domainId, docids, h.user._id);

            h.response.body.psdocs = psdocs;
            h.response.body.pcount = pcount;
            h.response.body.pscount = pscount;
            h.response.body.udict = udict;
            h.response.body.pssdict = pssdict;
        }
    });

    ctx.on('handler/before/ProblemSolution#post', async (h: any) => {
        console.log(h.pdoc);
        if (h.pdoc && h.pdoc.reference) {
            throw new ForbiddenError('当前题目为引用题目，不允许进行题解操作。');
        }
    });

    ctx.on('handler/before/ProblemEdit#post', async (h: any) => {
        if (h.pdoc && h.pdoc.reference) {
            const newContent = (h.request.body.content || '').replace(/\r\n/g, '\n').trim();
            const oldContent = (h.pdoc.content || '').replace(/\r\n/g, '\n').trim();

            if (newContent !== oldContent) {
                throw new ForbiddenError('当前题目为引用题目，不允许修改题面。');
            }
        }
    });
}
