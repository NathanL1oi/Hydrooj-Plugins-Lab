import {
    i18n, pjax, request, tpl, NamedPage, Notification, $, addPage, ActionDialog, InfoDialog,
    UserSelectAutoComplete
} from '@hydrooj/ui-default';

addPage(new NamedPage('article_main_admin', () => {
    const style = document.createElement('style');
    document.head.appendChild(style);
    style.sheet.insertRule(`td.col--content { display: block; height: 36px !important; }`, style.sheet.cssRules.length);

    const domainSelect = $('[id="domainNameSelect"]');
    const niceSelect = $('[id="niceSelect"]');

    domainSelect.on('change', function () {
        const selectedValue = domainSelect.val();
        // console.log(selectedValue);
        if (selectedValue !== 'all') {
            niceSelect.val('true');
        }
    });
    niceSelect.on('change', function () {
        const selectedValue = niceSelect.val();
        // console.log(selectedValue);
        if (selectedValue !== 'true') {
            domainSelect.val('all');
        }
    });

    const setNiceDialogContent = $(tpl`
        <div>
          <div class="row"><div class="columns">
            <h1>${i18n('Nice')}</h1>
          </div></div>
          <div class="row"><div class="columns">
            <label>
                ${i18n('Article ID')}
              <input name="did" type="text" class="textbox" value="" disabled>
            </label>
          </div></div>
          <div class="row"><div class="columns">
            <label>
              <label>
                ${i18n('Domain')}
                <input name="showedDomain" type="text" class="textbox">
                <p class="help-text">填写域 id，以“,”（英文逗号）分隔（* 表示所有域均展示）</p>
              </label>
            </label>
          </div></div>
        </div>
      `);
    setNiceDialogContent.appendTo(document.body);

    const setNiceDialog = new ActionDialog({
        $body: setNiceDialogContent,
    });

    UserSelectAutoComplete.getOrConstruct($('[name="uidOrName"]'), {
        clearDefaultValue: false,
    });

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
                pjax.request({ url: UiContext.requestUrl, push: false });
            }
        } catch (error) {
            Notification.error([error.message, ...error.params].join(' '));
        }
    }

    async function handleSetNice(ev) {
        console.log('UiContext', UiContext.forceDomain);
        if (UiContext.forceDomain) {
            const $domainInput = setNiceDialogContent.find('input[name="showedDomain"]');
            $domainInput.val(UiContext.forceDomain).prop('disabled', true);
        }
        const did = $(ev.target).data('did');
        let showedDomain = '';
        if ($(ev.target).text().trim() !== '撤下') {
            setNiceDialog.$dom.find('input[name="did"]').val(did);
            const action = await setNiceDialog.open();
            if (action !== 'ok') return;
            showedDomain = setNiceDialog.$dom.find('[name="showedDomain"]').val();
        }
        try {
            const res = await request.post('', {
                operation: 'nice',
                did,
                showedDomain,
            });
            if (res.url && res.url !== window.location.href) window.location.href = res.url;
            else {
                Notification.success(res);
                pjax.request({ url: UiContext.requestUrl, push: false });
            }
        } catch (error) {
            Notification.error([error.message, ...error.params].join(' '));
        }
    }

    async function handleShowDomainName(ev) {
        const val = $(ev.target).text();
        const domainName = $(ev.currentTarget).data('domain_name');
        if (val === '已推荐') {
            const message = `该文章被推荐到 ${domainName} 域展示。（* 表示所有域均展示）`;
            new InfoDialog({
                cancelByClickingBack: false,
                $body: tpl.typoMsg(message, false),
            }).open();
        }
    }

    async function handleSetLock(ev) {
        const did = $(ev.target).data('did');
        try {
            const res = await request.post('', {
                operation: 'lock',
                did,
            });
            if (res.url && res.url !== window.location.href) window.location.href = res.url;
            else {
                Notification.success(res);
                pjax.request({ url: UiContext.requestUrl, push: false });
            }
        } catch (error) {
            Notification.error([error.message, ...error.params].join(' '));
        }
    }

    $(document).on('click', '[name="set_hidden"]', handleSetHidden);
    $(document).on('click', '[name="set_nice"]', handleSetNice);
    $(document).on('click', '[name="set_lock"]', handleSetLock);
    $(document).on('click', '[name="show_domainName"]', handleShowDomainName);
}));