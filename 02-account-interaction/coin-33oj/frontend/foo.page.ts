import { $, addPage, NamedPage, UserSelectAutoComplete, Notification, delay, i18n, url, request, ConfirmDialog, tpl } from '@hydrooj/ui-default'

addPage(new NamedPage(['coin_inc', 'coin_gift'], () => {
    UserSelectAutoComplete.getOrConstruct($('[name="uidOrName"]'), {
        clearDefaultValue: false,
    });
}));

addPage (new NamedPage('coin_inc', () => {
  $(document).on('click', '[type="submit"]', async (ev) => {
    ev.preventDefault();

    const $form = $(ev.currentTarget).closest('form');
    try {
      const res = await request.post('', {
        uidOrName: $form.find('[name="uidOrName"]').val(),
        amount: $form.find('[name="amount"]').val(),
        text: $form.find('[name="text"]').val(),
      });
      if (res.url) {
        Notification.success(i18n('硬币发放成功'));
        await delay(1000);
        window.location.href = res.url;
      }
    } catch (e) {
      Notification.error(e.message);
    }
  });
}));

addPage (new NamedPage('coin_import', () => {
  async function post(draft) {
    try {
      const res = await request.post('', {
        coins: $('[name="coins"]').val(),
        draft,
      });
      if (!draft) {
        if (res.url) window.location.href = res.url;
        else if (res.error) throw new Error(res.error?.message || res.error);
        else {
          Notification.success(i18n('Updated {0} coin records.', res.coins.length));
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

addPage (new NamedPage('goods_add', () => {
  $(document).on('click', '[type="submit"]', async (ev) => {
    ev.preventDefault();

    const $form = $(ev.currentTarget).closest('form');
    try {
      const res = await request.post('', {
        name: $form.find('[name="name"]').val(),
        price: $form.find('[name="price"]').val(),
        num: $form.find('[name="num"]').val(),
      });
      if (res.success) {
        Notification.success(i18n('添加商品成功'));
        await delay(1000);
        window.location.reload();
      }
    } catch (e) {
      Notification.error(e.message);
    }
  });
}));

addPage(new NamedPage('goods_edit', () => {
  $(document).on('click', '[name="operation"][value="update"]', async (ev) => {
    ev.preventDefault();

    const $form = $(ev.currentTarget).closest('form');
    try {
      const res = await request.post('', {
        operation: 'update',
        id: $form.find('[name="id"]').val(),
        name: $form.find('[name="name"]').val(),
        price: $form.find('[name="price"]').val(),
        num: $form.find('[name="num"]').val(),
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
    const message = '确认删除此商品吗？删除后将无法恢复。';
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
      if (res.url) {
        window.location.href = res.url;
      }
    } catch (e) {
        Notification.error(e.message);
    }
    });
}));

addPage (new NamedPage('coin_exchange', () => {
  $(document).on('click', '[type="submit"]', async (ev) => {
    ev.preventDefault();

    const $form = $(ev.currentTarget).closest('form');
    try {
      const res = await request.post('', {
        id: $form.find('[name="id"]').val(),
        num: $form.find('[name="num"]').val(),
      });
      if (res.url) {
        Notification.success(i18n('兑换商品成功'));
        await delay(1000);
        window.location.href = res.url;  
      }
    } catch (e) {
      Notification.error(e.message);
    }
  });
}));

addPage(new NamedPage('coin_myrecord', () => {
  $(document).on('click', '[type="submit"]', async (ev) => {
    ev.preventDefault();
    const message = '确认取消此订单吗？订单取消成功后，硬币将返还至你的账户。';
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
          id: $form.find('[name="id"]').val(),
        });
      if (res.success) {
        Notification.success(i18n('取消订单成功'));
        await delay(1000);
        window.location.reload();
      }
    } catch (e) {
        Notification.error(e.message);
    }
  });
}));

addPage(new NamedPage('coin_record', () => {
  $(document).on('click', '[type="submit"]', async (ev) => {
    ev.preventDefault();
    const message = '确定要兑换该订单？';
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
          id: $form.find('[name="id"]').val(),
        });
      if (res.success) {
        Notification.success(i18n('兑换成功'));
        await delay(1000);
        window.location.reload();
      }
    } catch (e) {
        Notification.error(e.message);
    }
  });
}));

addPage (new NamedPage('coin_gift', () => {
  $(document).on('click', '[type="submit"]', async (ev) => {
    ev.preventDefault();

    const $form = $(ev.currentTarget).closest('form');
    try {
      const res = await request.post('', {
        password: $form.find('[name="password"]').val(),
        uidOrName: $form.find('[name="uidOrName"]').val(),
        amount: $form.find('[name="amount"]').val(),
      });
      if (res.success) {
        Notification.success(i18n('赠送硬币成功'));
        await delay(1000);
        window.location.reload(); 
      }
    } catch (e) {
      Notification.error(e.message);
    }
  });
}));

addPage (new NamedPage('uname_change', () => {
  $(document).on('click', '[type="submit"]', async (ev) => {
    ev.preventDefault();

    const $form = $(ev.currentTarget).closest('form');
    const operation = $(ev.currentTarget).attr('value');
    try {
      const res = await request.post('', {
        operation: operation,
        password: $form.find('[name="password"]').val(),
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

//添加修改用户名的按钮
addPage(new NamedPage('home_account', () => {
  $('.section__title#setting_info').closest('.section__header')
    .append('<div class="section__tools"><a class="button rounded" href="../../uname/change">修改用户名</a></div>');
}));