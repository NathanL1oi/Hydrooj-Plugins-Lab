import {
  $, addPage, i18n, NamedPage, Notification, request,
} from '@hydrooj/ui-default';

function renderLanguages() {
  return Object.entries(window.LANGS || {})
    .filter(([, value]: any) => !value?.hidden && !value?.remote)
    .map(([key, value]: any) => `<option value="${key}">${value.display || key}</option>`)
    .join('');
}

function renderPanel() {
  return `
    <div class="section std-time-calibrator">
      <div class="section__header">
        <h1 class="section__title">${i18n('Calibrate By Standard Solution')}</h1>
      </div>
      <div class="section__body">
        <div class="row">
          <div class="medium-12 columns">
            <label>
              ${i18n('Language')}
              <select name="std_time_calibrator__lang" class="select">${renderLanguages()}</select>
            </label>
          </div>
          <div class="medium-12 columns">
            <label>
              ${i18n('Standard Solution')}
              <textarea name="std_time_calibrator__code" class="textbox" rows="16" style="font-family: var(--font-family-mono); width: 100%;"></textarea>
            </label>
          </div>
          <div class="medium-12 columns">
            <button name="std_time_calibrator__submit" class="primary rounded button" type="button">
              <span class="icon icon-stopwatch"></span> ${i18n('Run Standard Solution')}
            </button>
            <span name="std_time_calibrator__status" style="margin-left: 12px;"></span>
          </div>
        </div>
      </div>
    </div>
  `;
}

async function pollStatus(rid: string) {
  const $status = $('[name="std_time_calibrator__status"]');
  for (;;) {
    const res = await request.post('./std-time-calibrator', { operation: 'status', rid });
    if (!res.done) {
      $status.text(`${i18n('Waiting for judge result...')} ${Math.floor(res.progress || 0)}%`);
      await new Promise((resolve) => { setTimeout(resolve, 2000); });
      continue;
    }
    if (!res.updated) {
      Notification.error(`${res.statusText || res.status}: ${(res.compilerTexts || []).concat(res.judgeTexts || []).join('\n')}`);
      $status.text(res.statusText || '');
      return;
    }
    const summary = res.result.map((item) => `#${item.id}: ${item.time}ms / ${item.memory}MB`).join(', ');
    Notification.success(`${i18n('Time limits have been updated.')} ${summary}`);
    window.location.reload();
    return;
  }
}

addPage(new NamedPage('problem_config', () => {
  const $main = $('#ProblemConfig').closest('.section');
  if (!$main.length || $('.std-time-calibrator').length) return;
  $main.after(renderPanel());
  const $panel = $('.std-time-calibrator');
  $panel.find('[name="std_time_calibrator__submit"]').on('click', async () => {
    const $button = $panel.find('[name="std_time_calibrator__submit"]');
    const lang = $panel.find('[name="std_time_calibrator__lang"]').val();
    const code = $panel.find('[name="std_time_calibrator__code"]').val();
    if (!code) {
      Notification.error(i18n('Please enter standard solution.'));
      return;
    }
    $button.prop('disabled', true);
    try {
      const res = await request.post('./std-time-calibrator', { operation: 'submit', lang, code });
      Notification.success(i18n('Calibration submitted.'));
      await pollStatus(res.rid);
    } catch (e) {
      Notification.error(e.message);
      $button.prop('disabled', false);
    }
  });
}));
