import { addPage, NamedPage } from '@hydrooj/ui-default';

declare const UiContext: any;

addPage(new NamedPage(['contest_detail'], () => {
    const config = UiContext.contestBulkSubmit;
    if (!config?.url || document.getElementById('contest-bulk-submit-card')) return;

    const side = document.querySelector('.medium-3.columns');
    if (!side) return;

    const section = document.createElement('div');
    section.id = 'contest-bulk-submit-card';
    section.className = 'section side';

    const header = document.createElement('div');
    header.className = 'section__header';
    const title = document.createElement('h1');
    title.className = 'section__title';
    title.textContent = '管理员工具';
    header.appendChild(title);

    const body = document.createElement('div');
    body.className = 'section__body';
    const link = document.createElement('a');
    link.className = 'rounded primary button expanded';
    link.href = config.url;
    link.innerHTML = '<span class="icon icon-upload"></span> 批量上传提交';
    body.appendChild(link);

    section.appendChild(header);
    section.appendChild(body);
    side.insertBefore(section, side.firstChild);
}));
