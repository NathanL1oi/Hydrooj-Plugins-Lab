import { $, addPage, NamedPage } from '@hydrooj/ui-default';

function initDuplicateDetector() {
  const $range = $('input[name="threshold"]');
  const $label = $('#pdd-threshold-label');
  if ($range.length && $label.length) {
    const update = () => $label.text(`${$range.val()}%`);
    $range.off('input.problemDuplicateDetector').on('input.problemDuplicateDetector', update);
    update();
  }
  $('.pdd-ignore').off('submit.problemDuplicateDetector').on('submit.problemDuplicateDetector', function onSubmit() {
    return window.confirm('确认忽略这组疑似重复题？');
  });
}

addPage(new NamedPage('problem_duplicate_detector', initDuplicateDetector));
$(document).on('vjContentNew', initDuplicateDetector);
