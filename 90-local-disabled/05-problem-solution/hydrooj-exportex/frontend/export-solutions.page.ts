import { AutoloadPage, ctx, addPage } from '@hydrooj/ui-default';

async function fetchSolutionsForPid(pid: number) {
    try {
        const domainId = (window as any).UiContext?.domainId || '';
        const res = await fetch(`/p/${pid}/solution?domainId=${encodeURIComponent(domainId)}`, {
            credentials: 'same-origin',
            headers: { Accept: 'application/json' },
        });
        if (!res.ok) return null;
        const body = await res.json();
        return body?.psdocs || null;
    } catch (e) {
        return null;
    }
}

addPage(new AutoloadPage('exportSolutions', () => {
    ctx.on('problemset/download', async (pids: number[], name: string, targets: { filename: string, url?: string, content?: string }[]) => {
        if (UserContext.priv !== -1) return;
        const MAX_SOLUTIONS = 100;
        let totalAdded = 0;
        for (const pid of pids) {
            if (totalAdded >= MAX_SOLUTIONS) break;
            try {
                const psdocs = await fetchSolutionsForPid(pid);
                if (!psdocs || !psdocs.length) continue;

                const base = `${pid}/solution`;
                const solutionsToAdd = psdocs
                    .slice(0, MAX_SOLUTIONS - totalAdded)
                    .map((ps: { content: any; }, idx: number) => {
                        const content = typeof ps.content === 'string' ? ps.content : JSON.stringify(ps.content, null, 2);
                        return { filename: `${base}/solution_${idx + 1}.md`, content };
                    });

                targets.push(...solutionsToAdd);
                totalAdded += solutionsToAdd.length;
            } catch (e) {
                continue;
            }
        }
    });
    return null;
}));
