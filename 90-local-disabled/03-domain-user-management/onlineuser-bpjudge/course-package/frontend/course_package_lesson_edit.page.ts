import {
  $, addPage, NamedPage, ProblemSelectAutoComplete
} from '@hydrooj/ui-default';

addPage(new NamedPage(['course_package_lesson_create', 'course_package_lesson_edit'], () => {
  ProblemSelectAutoComplete.getOrConstruct($('[name="pids"]'), {
    multi: true,
    clearDefaultValue: false,
  });
}));
