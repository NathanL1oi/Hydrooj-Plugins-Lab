import { $, addPage, NamedPage, UserSelectAutoComplete, AssignSelectAutoComplete, Notification, delay, i18n, url, request, ConfirmDialog, tpl } from '@hydrooj/ui-default'

addPage(new NamedPage(['domain_bulk_message'], () => {
    AssignSelectAutoComplete.getOrConstruct($('[name="recipients"]'), {
        multi: true
    });
}));

addPage (new NamedPage('domain_import', () => {
  async function post(draft) {
    try {
      const res = await request.post('', {
        users: $('[name="users"]').val(),
        draft,
      });
      if (!draft) {
        if (res.url) window.location.href = res.url;
        else if (res.error) throw new Error(res.error?.message || res.error);
        else {
          Notification.success(i18n('Updated {0} user records.', res.users.length));
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

addPage (new NamedPage('domain_bulk_message', () => {
  $(document).on('click', '[type="submit"]', async (ev) => {
    ev.preventDefault();

    const $form = $(ev.currentTarget).closest('form');
    try {
      const res = await request.post('', {
        recipients: $form.find('[name="recipients"]').val(),
        content: $form.find('[name="content"]').val(),
      });
      if (res.success) {
        Notification.success(i18n('消息发送成功'));
        await delay(1000);
        window.location.reload();  
      }
    } catch (e) {
      Notification.error(e.message);
    }
  });
}));

addPage(new NamedPage('manage_messages', () => {
  $(document).on('click', '[name="operation"][value="delete"]', async (ev) => {
    ev.preventDefault();
    const message = '确认删除此消息吗？删除后将无法恢复。';
    const action = await new ConfirmDialog({
        $body: tpl`
            <div class="typo">
                <p>${i18n(message)}</p>
            </div>`,
    }).open();
    if (action !== 'yes') return;

    const $form = $(ev.currentTarget).closest('form'); 
    try {
        const res = await request.post('', {
          operation: 'delete',
          id: $form.find('[name="id"]').val(),
        });
      if (res.success) {
        Notification.success(i18n('删除消息成功'));
        await delay(1000);
        window.location.reload();
      }
    } catch (e) {
        Notification.error(e.message);
    }
  });
}));