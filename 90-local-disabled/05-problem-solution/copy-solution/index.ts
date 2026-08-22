import { Context, SolutionModel } from 'hydrooj';

export const description = '复制题目同步复制题解';

export function apply(ctx: Context) {
    ctx.on('problem/add', async (args: any, result: number) => {
        if (!args.reference || typeof args.reference !== 'object') return;

        const sourceDomainId = args.reference.domainId;
        const sourceProblemId = args.reference.pid;
        if (!sourceDomainId || !sourceProblemId) return;

        const targetDomainId = args.domainId;
        const targetProblemId = result;

        try {
            const solutions = await SolutionModel.getMulti(sourceDomainId, sourceProblemId).toArray();
            await Promise.all(solutions.map((sol) => SolutionModel.add(targetDomainId, targetProblemId, sol.owner, sol.content)));
        } catch (e) {
            console.error('Failed to copy solutions for problem:', targetDomainId, targetProblemId, e);
        }
    });
}
