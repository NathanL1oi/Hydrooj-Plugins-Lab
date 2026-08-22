import {
    i18n, pjax, request, tpl, NamedPage, Notification, $, addPage
} from '@hydrooj/ui-default';

addPage(new NamedPage('course_main', () => {
    const style = document.createElement('style');
    document.head.appendChild(style);

    style.sheet.insertRule(`.discussion__item { border-left: 5px solid transparent; padding-left: 5px; }`, style.sheet.cssRules.length);
    style.sheet.insertRule(`.discussion__item.highlight { border-left: 5px solid #df6589 }`, style.sheet.cssRules.length);
    style.sheet.insertRule(`.discussion__title { font-size: 20px; line-height: 1.2em; margin-bottom: 10px; }`, style.sheet.cssRules.length);
    style.sheet.insertRule(`.discussion__title a:visited { color: #bbb; }`, style.sheet.cssRules.length);
    style.sheet.insertRule(`.discussion__replies { width: 70px; }`, style.sheet.cssRules.length);
    // style.sheet.insertRule(`.training__intro { color: #777777; font-size: 14px; margin: 1em 0; }`, style.sheet.cssRules.length);
    style.sheet.insertRule(`.training__progress { line-height: 1.0625rem; vertical-align: top }`, style.sheet.cssRules.length);
}));