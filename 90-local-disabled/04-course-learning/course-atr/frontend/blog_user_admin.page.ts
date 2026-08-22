import {
    i18n, pjax, request, tpl, NamedPage, Notification, $, addPage, ActionDialog, InfoDialog,
    UserSelectAutoComplete
} from '@hydrooj/ui-default';

addPage(new NamedPage('blog_user_admin', () => {
    const setUserDialogContent = $(tpl`
        <div>
          <div class="row"><div class="columns">
            <h1>${i18n('Set Blog Status')}</h1>
          </div></div>
          <div class="row"><div class="columns">
            <label>
              ${i18n('Users')}
              <input name="add_user" type="text" class="textbox" autocomplete="off">
            </label>
          </div></div>
          <div class="row"><div class="columns">
            <label>
              <label>
                ${i18n('Blog Status')} 
                <select class="compact select" name="status">
                  <option value="none"></option>
                  <option value="disabled">禁用</option>
                  <option value="enabled">启用</option>
                </select>
              </label>
            </label>
          </div></div>
        </div>
      `);
    setUserDialogContent.appendTo(document.body);

    const userSelect: any = UserSelectAutoComplete.getOrConstruct(
        setUserDialogContent.find('[name="add_user"]'),
    );

    const setUserDialog = new ActionDialog({
        $body: setUserDialogContent,
        onDispatch(action) {
            if (action === 'ok' && !userSelect.value()) {
                userSelect.focus();
                return false;
            }
            return true;
        },
    });
    setUserDialog.clear = function () {
        userSelect.clear();
        return this;
    };

    async function handleClickSelectUser() {
        const action = await setUserDialog.clear().open();
        if (action !== 'ok') return;
        const status = setUserDialog.$dom.find('[name="status"]').val();
        const user = userSelect.value();
        try {
            const res = await request.post('', {
                operation: 'set_status',
                uids: [user._id],
                status,
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

    UserSelectAutoComplete.getOrConstruct($('[name="uidOrName"]'), {
        clearDefaultValue: false,
    });

    async function handleSetStatus(ev) {
        const uid = $(ev.target).data('uid');
        try {
            // console.log(uid);
            const res = await request.post('', {
                operation: 'set_status',
                uids: [uid],
                status: "udoc_status"
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

    const setGroupDialogContent = $(tpl`
        <div>
          <div class="row"><div class="columns">
            <h1>${i18n('Set Blog Status')}</h1>
          </div></div>
          <div class="row"><div class="columns">
            <label>
              ${i18n('Groups')}
                <select class="compact select" name="group">
                </select>
            </label>
          </div></div>
          <div class="row"><div class="columns">
            <label>
              <label>
                ${i18n('Blog Status')} 
                <select class="compact select" name="status">
                  <option value="none"></option>
                  <option value="disabled">禁用</option>
                  <option value="enabled">启用</option>
                </select>
              </label>
            </label>
          </div></div>
        </div>
      `);
    UiContext.groups.forEach(opt => {
        setGroupDialogContent.find('[name="group"]').append(`<option value="${opt.uids.join(',')}">${opt.name}</option>`);
    });
    setGroupDialogContent.appendTo(document.body);

    const setGroupDialog = new ActionDialog({
        $body: setGroupDialogContent,
        onDispatch(action) {
            const $name = setGroupDialog.$dom.find('[name="group"]');
            if (action === 'ok' && !$name.val()) {
                $name.focus();
                return false;
            }
            return true;
        },
    });

    async function handleClickSelectGroup() {
        const action = await setGroupDialog.open();
        if (action !== 'ok') return;
        const status = setGroupDialog.$dom.find('[name="status"]').val();
        const group = setGroupDialog.$dom.find('[name="group"]').val();
        // console.log(group);
        try {
            const res = await request.post('', {
                operation: 'set_status',
                uids: group,
                status,
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

    $('[name="select_user"]').on('click', () => handleClickSelectUser());
    $('[name="select_group"]').on('click', () => handleClickSelectGroup());
    $(document).on('click', '[name="set_status"]', handleSetStatus);
}));