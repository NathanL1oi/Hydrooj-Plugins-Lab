import { Context, DocumentModel, ForbiddenError, PERM, ProblemModel, SolutionModel, SolutionNotFoundError, StorageModel, UserModel } from 'hydrooj';

export const description = '题目引用增强';

function solutionId(psdoc: any) {
    return psdoc?.docId || psdoc?._id;
}

function solImageHelper() {
    return (global as any).Hydro?.model?.solImage || (global as any).Hydro?.model?.sol2image;
}

async function applySolutionImageContent(domainId: string, psdoc: any, viewer: any) {
    const helper = solImageHelper();
    if (helper?.applySolutionImageContent) {
        await helper.applySolutionImageContent(domainId, psdoc, viewer);
        return;
    }
    if (String(psdoc.owner) === String(viewer?._id) || viewer?.hasPerm?.(PERM.PERM_EDIT_PROBLEM_SOLUTION)) return;
    const psid = solutionId(psdoc);
    if (psdoc.filename && psdoc.status === 'completed') {
        const target = `problem-sol/${domainId}/${psid}/${psdoc.filename}`;
        const exists = await StorageModel.exists(target).catch(() => false);
        if (exists) {
            const url = await StorageModel.signDownloadLink(target, psdoc.filename, false, 'user');
            psdoc.content = `![solution](${url})`;
        } else {
            await DocumentModel.set(domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, psid, { status: 'failed' }).catch(() => null);
            psdoc.content = '系统提示：题解图片文件缺失，请联系管理员在原题子域批量渲染题解。';
        }
    } else if (psdoc.status === 'failed') {
        psdoc.content = '系统提示：题解图片渲染失败，请联系管理员处理。';
    } else if (psdoc.filename) {
        psdoc.content = '系统提示：题解图片正在渲染中，请稍后刷新页面查看。';
    } else {
        psdoc.content = '系统提示：该题解还没有渲染成图片，请联系管理员在原题子域批量渲染题解。';
    }
}

export function apply(ctx: Context) {
    ctx.on('handler/after/ProblemDetail#get', async (h: any) => {
        if (h.pdoc && h.pdoc.reference) {
            const { domainId, pid } = h.pdoc.reference;
            const refProblem = await ProblemModel.get(domainId, pid);
            if (refProblem) {
                const refDocId = refProblem.docId;
                h.response.body.pdoc.content = refProblem.content
                    .replace(/file:\/\/([^ \n)\\"]+)/g, (str: string) => {
                        const info = str.match(/file:\/\/([^ \n)\\"]+)/);
                        const fileinfo = info[1];
                        let filename = fileinfo.split('?')[0];
                        try { filename = decodeURIComponent(filename); } catch (e) { }
                        if (!refProblem.additional_file?.find((f: any) => f.name === filename)) return str;
                        return `/d/${domainId}/p/${refDocId}/file/${fileinfo}`;
                    });
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
            const udict = await UserModel.getList(domainId, uids);
            const pssdict = await SolutionModel.getListStatus(domainId, docids, h.user._id);

            const udoc = await UserModel.getById(domainId, h.user._id);
            for (const psdoc of psdocs) {
                await applySolutionImageContent(domainId, psdoc, udoc);
            }

            h.response.body.psdocs = psdocs;
            h.response.body.pcount = pcount;
            h.response.body.pscount = pscount;
            h.response.body.udict = udict;
            h.response.body.pssdict = pssdict;
        }
    });

    ctx.on('handler/before/ProblemSolution#post', async (h: any) => {
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
