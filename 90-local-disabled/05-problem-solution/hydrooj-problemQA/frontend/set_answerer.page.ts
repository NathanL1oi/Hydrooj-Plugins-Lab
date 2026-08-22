import _ from 'lodash';
import { $, addPage, UserSelectAutoComplete, Notification, NamedPage, api, i18n } from '@hydrooj/ui-default';

function update(uids: number[] = []) {
    const filteredUids = uids.filter(uid =>
        uid !== null &&
        uid !== undefined &&
        !isNaN(uid) &&
        uid > 0
    );
    return api('domain.answerer', {
        uids: filteredUids,
    }, []);
}

addPage(new NamedPage('domain_answerer', () => {
    const targets = {};
    $('input[data-gid]').get().forEach((ele) => {
        const input = UserSelectAutoComplete.getOrConstruct<UserSelectAutoComplete<true>>($(ele), { multi: true, height: 'auto' });
        targets['answerers'] = input;
        let loaded = false;
        input.onChange(() => {
            if (input.value().length && !loaded) {
                loaded = true;
                return;
            }
            if (!loaded) return;
            update(input.value());
        });
    });

    async function handleClickSaveAll() {
        // console.log(targets['answerers'].value());
        try {
            await update(targets['answerers'].value());
        } catch (error) {
            Notification.error(error.message);
        }
        Notification.success(i18n('Saved.'));
    }

    $('[name="save_all"]').on('click', () => handleClickSaveAll());
}));

