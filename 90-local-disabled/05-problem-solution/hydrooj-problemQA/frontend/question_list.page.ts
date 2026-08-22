import './button.css';

import {
    NamedPage, UserSelectAutoComplete, ProblemSelectAutoComplete, _, $, addPage
} from '@hydrooj/ui-default';

addPage(new NamedPage('question_list', () => {
    UserSelectAutoComplete.getOrConstruct($('[name="uidOrName"]'), {
        clearDefaultValue: false,
    });
    ProblemSelectAutoComplete.getOrConstruct($('[name="problemId"]'), {
        clearDefaultValue: false,
    });
}));