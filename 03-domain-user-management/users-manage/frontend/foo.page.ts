import { $, addPage, NamedPage, UserSelectAutoComplete, Notification, delay, i18n, url, request, ConfirmDialog, tpl } from '@hydrooj/ui-default'

addPage(new NamedPage(['realname_set','users_unamechange', 'users_resetpwd'], () => {
    UserSelectAutoComplete.getOrConstruct($('[name="uidOrName"]'), {
        clearDefaultValue: false,
    });
}));

addPage(new NamedPage('user_edit', () => {
  $(document).on('click', '[name="operation"][value="ban"]', async (ev) => {
    ev.preventDefault();
    const $form = $(ev.currentTarget).closest('form'); 
    const uname = $form.find('[name="uname"]').val();
    const message = `确定要封禁用户 ${uname} ？`;
    const action = await new ConfirmDialog({
        $body: tpl`
            <div class="typo">
                <p>${i18n(message)}</p>
            </div>`,
    }).open();
    if (action !== 'yes') return;

    try {
        const res = await request.post('', {
          operation: 'ban',
          uid: $form.find('[name="uid"]').val(),
        });
      if (res.success) {
        Notification.success(i18n('封禁成功'));
        await delay(1000);
        window.location.reload();
      }
    } catch (e) {
        Notification.error(e.message);
    }
  });

  $(document).on('click', '[name="operation"][value="unban"]', async (ev) => {
    ev.preventDefault();
    const $form = $(ev.currentTarget).closest('form'); 
    const uname = $form.find('[name="uname"]').val();
    const message = `确定要解禁用户 ${uname} ？`;
    const action = await new ConfirmDialog({
        $body: tpl`
            <div class="typo">
                <p>${i18n(message)}</p>
            </div>`,
    }).open();
    if (action !== 'yes') return;

    try {
        const res = await request.post('', {
          operation: 'unban',
          uid: $form.find('[name="uid"]').val(),
        });
      if (res.success) {
        Notification.success(i18n('解禁成功'));
        await delay(1000);
        window.location.reload();
      }
    } catch (e) {
        Notification.error(e.message);
    }
  });

  $(document).on('click', '[name="operation"][value="logout"]', async (ev) => {
    ev.preventDefault();
    const $form = $(ev.currentTarget).closest('form'); 
    const uname = $form.find('[name="uname"]').val();
    const message = `确定要强制登出用户 ${uname} ？`;
    const action = await new ConfirmDialog({
        $body: tpl`
            <div class="typo">
                <p>${i18n(message)}</p>
            </div>`,
    }).open();
    if (action !== 'yes') return;

    try {
        const res = await request.post('', {
          operation: 'logout',
          uid: $form.find('[name="uid"]').val(),
        });
      if (res.success) {
        Notification.success(i18n('强制登出成功'));
        await delay(1000);
        window.location.reload();
      }
    } catch (e) {
        Notification.error(e.message);
    }
  });

  $(document).on('click', '[name="operation"][value="set_info"]', async (ev) => {
    ev.preventDefault();
    const $form = $(ev.currentTarget).closest('form'); 
    try {
        const res = await request.post('', {
          operation: 'set_info',
          uid: $form.find('[name="uid"]').val(),
          phone: $form.find('[name="phone"]').val(),
          mail: $form.find('[name="mail"]').val(),
        });
      if (res.success) {
        Notification.success(i18n('修改信息成功'));
        await delay(1000);
        window.location.reload();
      }
    } catch (e) {
        Notification.error(e.message);
    }
  });

  $(document).on('click', '[name="operation"][value="set_displayname"]', async (ev) => {
    ev.preventDefault();
    const $form = $(ev.currentTarget).closest('form'); 
    try {
        const res = await request.post('', {
          operation: 'set_displayname',
          uid: $form.find('[name="uid"]').val(),
          displayName: $form.find('[name="displayName"]').val(),
        });
      if (res.success) {
        Notification.success(i18n('修改显示名成功'));
        await delay(1000);
        window.location.reload();
      }
    } catch (e) {
        Notification.error(e.message);
    }
  });

  $(document).on('click', '[type="submit"]', async (ev) => {
    ev.preventDefault();
    const $button = $(ev.currentTarget);
    if ($button.attr('name') === 'operation' && $button.attr('value')) {
      return;
    }
    const $form = $button.closest('form');
    const formData = $form.serializeArray();
    const requestData: any = {
        operation: '',
    };

    formData.forEach((item) => {
      if (item.name !== 'operation') {
        requestData[item.name] = item.value;
      }
    });

    try {
      const res = await request.post('', requestData);
      if (res.success) {
        Notification.success(i18n('修改成功'));
        await delay(1000);
        window.location.reload();
      }
    } catch (e) {
      Notification.error(e.message);
    }
  });

}));

addPage (new NamedPage('realname_set', () => {
  $(document).on('click', '[type="submit"]', async (ev) => {
    ev.preventDefault();

    const $form = $(ev.currentTarget).closest('form');
    try {
      const res = await request.post('', {
        uidOrName: $form.find('[name="uidOrName"]').val(),
        flag: $form.find('[name="flag"]').val(),
        name: $form.find('[name="name"]').val(),
      });
      if (res.url) {
        Notification.success(i18n('添加实名成功'));
        await delay(1000);
        window.location.href = res.url;  
      }
    } catch (e) {
      Notification.error(e.message);
    }
  });
}));

addPage (new NamedPage('realname_import', () => {
  async function post(draft) {
    try {
      const res = await request.post('', {
        realnames: $('[name="realnames"]').val(),
        draft,
      });
      if (!draft) {
        if (res.url) window.location.href = res.url;
        else if (res.error) throw new Error(res.error?.message || res.error);
        else {
          Notification.success(i18n('Updated {0} realname records.', res.realnames.length));
          await delay(2000);
          window.location.reload();
        }
      } else {
        $('[name="messages"]').text(res.messages.join('\n'));
      }
    } catch (e) {
      Notification.error(e.message);
    }
  }

  $('[name="preview"]').on('click', () => post(true));
  $('[name="submit"]').on('click', () => post(false));
}));

addPage (new NamedPage('users_unamechange', () => {
  $(document).on('click', '[type="submit"]', async (ev) => {
    ev.preventDefault();

    const $form = $(ev.currentTarget).closest('form');
    const operation = $(ev.currentTarget).attr('value');
    try {
      const res = await request.post('', {
        operation: operation,
        uidOrName: $form.find('[name="uidOrName"]').val(),
        newUname: $form.find('[name="newUname"]').val(),
      });
      if (res.url) {
        Notification.success(i18n('修改用户名成功'));
        await delay(1000);
        window.location.href = res.url;
      }
    } catch (e) {
      Notification.error(e.message);
    }
  });
}));

addPage (new NamedPage('users_resetpwd', () => {
  $(document).on('click', '[type="submit"]', async (ev) => {
    ev.preventDefault();

    const $form = $(ev.currentTarget).closest('form');
    try {
      const res = await request.post('', {
        uidOrName: $form.find('[name="uidOrName"]').val(),
        resetpwd: $form.find('[name="resetpwd"]').val(),
      });
      if (res.url) {
        Notification.success(i18n('重置密码成功'));
        await delay(1000);
        window.location.href = res.url;  
      }
    } catch (e) {
      Notification.error(e.message);
    }
  });
}));
