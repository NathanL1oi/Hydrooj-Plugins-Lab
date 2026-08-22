import { $, addPage, NamedPage, UserSelectAutoComplete, Notification, delay, i18n, url, request, ConfirmDialog, tpl } from '@hydrooj/ui-default'

addPage(new NamedPage(['badge_add','badge_edit'], () => {
    UserSelectAutoComplete.getOrConstruct<true>($('[name="users"]'), { 
        multi: true, clearDefaultValue: false 
    });
}));

addPage (new NamedPage('badge_add', () => {
  $(document).on('click', '[type="submit"]', async (ev) => {
    ev.preventDefault();

    const $form = $(ev.currentTarget).closest('form');
    try {
      const res = await request.post('', {
        short: $form.find('[name="short"]').val(),
        title: $form.find('[name="title"]').val(),
        backgroundColor: $form.find('[name="backgroundColor"]').val(),
        fontColor: $form.find('[name="fontColor"]').val(),
        content: $form.find('[name="content"]').val(),
        users: $form.find('[name="users"]').val(),
      });
      if (res.url) {
        window.location.href = res.url;
      }
    } catch (e) {
      Notification.error(e.message);
    }
  });
}));

addPage(new NamedPage('badge_edit', () => {
  $(document).on('click', '[name="operation"][value="update"]', async (ev) => {
    ev.preventDefault();

    const $form = $(ev.currentTarget).closest('form');
    try {
      const res = await request.post('', {
        operation: 'update',
        id: $form.find('[name="id"]').val(),
        short: $form.find('[name="short"]').val(),
        title: $form.find('[name="title"]').val(),
        backgroundColor: $form.find('[name="backgroundColor"]').val(),
        fontColor: $form.find('[name="fontColor"]').val(),
        content: $form.find('[name="content"]').val(),
        users: $form.find('[name="users"]').val(),
      });
      if (res.url) {
        window.location.href = res.url;
      }
    } catch (e) {
      Notification.error(e.message);
    }
  });

  $(document).on('click', '[name="operation"][value="delete"]', async (ev) => {
    ev.preventDefault();
    const message = '确认删除此徽章吗？删除后将无法恢复。';
    const action = await new ConfirmDialog({
        $body: tpl`
            <div class="typo">
                <p>${i18n(message)}</p>
            </div>`,
    }).open();
    if (action !== 'yes') return;

    try {
        const res = await request.post('', { operation: 'delete' });
        if (res.url) {
            window.location.href = res.url;
        }
    } catch (e) {
        Notification.error(e.message);
    }
  });
}));
