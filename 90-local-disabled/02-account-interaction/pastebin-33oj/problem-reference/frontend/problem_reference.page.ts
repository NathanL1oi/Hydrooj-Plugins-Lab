import { $, addPage, NamedPage } from '@hydrooj/ui-default';

addPage(new NamedPage(['problem_detail', 'contest_detail_problem', 'homework_detail_problem'], () => {
  const pdoc = UiContext.pdoc;
  if (pdoc && pdoc.reference) {
    const canEdit = $('a[href$="/edit"]').length > 0;
    if (canEdit) {
      $('.section__body.typo').first().prepend('<blockquote class="note"><p>当前题目为引用题目，不允许修改题面，请直接修改原题。</p></blockquote>');
    }
  }
}));

addPage(new NamedPage('problem_solution', () => {
  const pdoc = UiContext.pdoc;
  if (pdoc && pdoc.reference) {
    $('.section__header').first().prepend('<blockquote class="note"><p>当前题目为引用题目，已展示原题题解。</p></blockquote>');
    $('.vote-op').hide();
    $('.dczcomments__operations').hide();
  }
}));
