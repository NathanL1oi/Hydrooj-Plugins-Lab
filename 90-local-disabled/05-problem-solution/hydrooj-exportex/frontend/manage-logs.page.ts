import { $, addPage, NamedPage, ActionDialog, ProblemSelectAutoComplete, UserSelectAutoComplete } from "@hydrooj/ui-default";

addPage(new NamedPage(['problem_export_log'], async () => {
    ProblemSelectAutoComplete.getOrConstruct($('[name="pid"]'), {
        clearDefaultValue: false,
    });
    UserSelectAutoComplete.getOrConstruct($('[name="uidOrName"]'), {
        clearDefaultValue: false,
    });
    $('[name="log_detail"]').on('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const logId = $(e.currentTarget).data('id') as string;
        const data = window.UiContext[`log-${logId}`];

        const content = Object.keys(data).filter(key => key !== '_id').map(key => {
            const c = data[key];
            if (typeof c === 'object') {
                const jsonString = JSON.stringify(c, null, 2);
                return `<tr><td style="width: 120px; vertical-align: top">${key}</td><td><pre data-plugin-log style="white-space: pre-wrap; max-height: 300px; overflow: auto; background: #f5f5f5; padding: 10px; border-radius: 4px;">${jsonString}</pre></td></tr>`;
            }
            if (key === 'time') {
                return `<tr><td style="width: 120px">${key}</td><td>${new Date(c).toLocaleString()}</td></tr>`;
            }
            return `<tr><td style="width: 120px">${key}</td><td style="max-width: 400px; padding: 5px;"><div style="white-space: nowrap; overflow-x: auto; max-width: 100%; text-overflow: clip;">${c}</div></td></tr>`;
        });

        const confirmDialogContent = $(`  
        <div style="max-height: 70vh; overflow: auto; padding: 10px;">  
            <table class="data-table">  
                <thead>  
                    <tr>  
                        <th style="width: 120px">Key</th>  
                        <th>Value</th>  
                    </tr>  
                </thead>  
                <tbody>  
                    ${content.join('')}  
                </tbody>  
            </table>  
        </div>  
    `);

        const confirmDialog = new ActionDialog({
            $body: confirmDialogContent,
        });
        confirmDialog.open();
    });
}))

// thanks to gtn1024/hydro-aoplog
