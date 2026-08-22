import { $, addPage, NamedPage, UserSelectAutoComplete } from '@hydrooj/ui-default'

addPage(new NamedPage(['添加实名认证','Reset Password'], () => {
    UserSelectAutoComplete.getOrConstruct($('[name="uidOrName"]'), {
        clearDefaultValue: false,
    });
}));
