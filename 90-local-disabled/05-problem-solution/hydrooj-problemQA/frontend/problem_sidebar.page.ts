import {
  NamedPage, _, $, addPage, i18n
} from '@hydrooj/ui-default';

addPage(new NamedPage('problem_detail', () => {

  if (!document.getElementById('question-tools')) {
    const section = document.createElement('div');
    section.className = 'section side';
    section.id = 'question-tools';
    const domainId = encodeURIComponent(String(UiContext.domain._id));
    const problemId = encodeURIComponent(String(UiContext.pdoc.docId));
    const wrap = document.createElement('div');
    const menu = document.createElement('ol');
    menu.className = 'menu';
    const entries = [
      { href: `/d/${domainId}/question/create/${problemId}`, icon: 'icon-edit', text: '创建答疑' },
      { href: `/d/${domainId}/question?problemId=${problemId}`, icon: 'icon-star', text: '相关答疑' },
    ];
    for (const entry of entries) {
      const item = document.createElement('li');
      item.className = 'menu__item';
      const link = document.createElement('a');
      link.className = 'menu__link';
      link.href = entry.href;
      link.name = 'your-action';
      const icon = document.createElement('span');
      icon.className = `icon ${entry.icon}`;
      link.append(icon, document.createTextNode(` ${entry.text}`));
      item.appendChild(link);
      menu.appendChild(item);
    }
    wrap.appendChild(menu);
    section.appendChild(wrap);
    $('.section--problem-sidebar').after(section);
  }

}));
