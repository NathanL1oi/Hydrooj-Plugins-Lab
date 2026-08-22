import {
    i18n, pjax, request, tpl, NamedPage, Notification, $, addPage
} from '@hydrooj/ui-default';

addPage(new NamedPage('article_main', () => {
    const style = document.createElement('style');
    document.head.appendChild(style);

    style.sheet.insertRule(`.discussion__item { border-left: 5px solid transparent; padding-left: 5px; }`, style.sheet.cssRules.length);
    style.sheet.insertRule(`.discussion__item.highlight { border-left: 5px solid #df6589 }`, style.sheet.cssRules.length);
    style.sheet.insertRule(`.discussion__title { font-size: 20px; line-height: 1.2em; margin-bottom: 10px; }`, style.sheet.cssRules.length);
    style.sheet.insertRule(`.discussion__title a:visited { color: #bbb; }`, style.sheet.cssRules.length);
    style.sheet.insertRule(`.discussion__replies { width: 70px; }`, style.sheet.cssRules.length);

    async function handleSetHidden(ev) {
        const did = $(ev.target).data('did');
        try {
            const res = await request.post('', {
                operation: 'hidden',
                did,
            });
            if (res.url && res.url !== window.location.href) window.location.href = res.url;
            else {
                Notification.success(res);
                window.location.reload();
            }
        } catch (error) {
            Notification.error([error.message, ...error.params].join(' '));
        }
    }

    async function handleSetNice(ev) {
        const did = $(ev.target).data('did');
        try {
            const res = await request.post('', {
                operation: 'nice',
                did,
            });
            if (res.url && res.url !== window.location.href) window.location.href = res.url;
            else {
                Notification.success(res);
                window.location.reload();
            }
        } catch (error) {
            Notification.error([error.message, ...error.params].join(' '));
        }
    }

    $(document).on('click', '[name="set_hidden"]', handleSetHidden);
    $(document).on('click', '[name="set_nice"]', handleSetNice);
}));