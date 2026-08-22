import {
    NamedPage, Notification, $, addPage, tpl
} from '@hydrooj/ui-default';

addPage(new NamedPage('record_detail', () => {
    if (UiContext.tdoc || !UiContext.domain?.enableDownloadFirst) {
        return;
    }
    function insertDownloadLinks() {
        if (document.getElementById('download_input')) return;
        const failText = $('td.col--status span.record-status--text.fail').first();
        if (!failText.length) return;

        const currentUrl = window.location.href;
        const inputLink = `${currentUrl}/download-data/in`;
        const outputLink = `${currentUrl}/download-data/out`;

        const links = $(tpl`<span>
          <a id="download_input" target="_blank" href="${inputLink}">下载输入文件</a>
          <a id="download_output" target="_blank" href="${outputLink}">下载输出文件</a>
        </span>`);

        links.on('click', (e: MouseEvent) => {
            e.stopPropagation();
        });
        links.insertAfter(failText);
    }
    insertDownloadLinks();
    $(document).on('vjContentNew', insertDownloadLinks);
}));