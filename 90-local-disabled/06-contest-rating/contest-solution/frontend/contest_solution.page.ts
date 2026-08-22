import { _, addPage, NamedPage, i18n, request, tpl, Notification, ConfirmDialog, $, pjax, uploadFiles } from '@hydrooj/ui-default';

function ensureAndGetSelectedFiles() {
  const files = _.map(
    $('.files tbody [data-checkbox-group="files"]:checked'),
    (ch) => $(ch).closest('tr').attr('data-filename'),
  );
  if (files.length === 0) {
    Notification.error(i18n('Please select at least one file to perform this operation.'));
    return null;
  }
  return files;
}

async function handleClickUpload(files) {
  console.log("click upload files");
  if (!files) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.click();
    await new Promise((resolve) => { input.onchange = resolve; });
    files = input.files;
  }
  if (!files.length) {
    Notification.warn(i18n('No file selected.'));
    return;
  }
  await uploadFiles('', files, { operation: 'upload_file', pjax: true });
}

async function handleClickRemoveSelected() {
  const selectedFiles = ensureAndGetSelectedFiles();
  if (selectedFiles === null) return;
  const action = await new ConfirmDialog({
    $body: tpl`
    <div class="typo">
      <p>${i18n('Confirm to delete the selected files?')}</p>
    </div>`,
  }).open();
  if (action !== 'yes') return;
  try {
    await request.post('', {
      operation: 'delete_files',
      files: selectedFiles,
    });
    Notification.success(i18n('Selected files have been deleted.'));
    await pjax.request({ push: false });
  } catch (error) {
    Notification.error(error.message);
  }
}

/**
* @param {JQuery.DragOverEvent<HTMLElement, undefined, HTMLElement, HTMLElement>} ev
*/
function handleDragOver(ev) {
  ev.preventDefault();
  // TODO display a drag-drop allowed hint
}

/**
* @param {JQuery.DropEvent<HTMLElement, undefined, HTMLElement, HTMLElement>} ev
*/
function handleDrop(ev) {
  ev.preventDefault();
  if (!$('[name="upload_file"]').length) {
    Notification.error(i18n("You don't have permission to upload file."));
    return;
  }
  ev = ev.originalEvent;
  const files = [];
  if (ev.dataTransfer.items) {
    for (let i = 0; i < ev.dataTransfer.items.length; i++) {
      if (ev.dataTransfer.items[i].kind === 'file') {
        const file = ev.dataTransfer.items[i].getAsFile();
        files.push(file);
      }
    }
  } else {
    for (let i = 0; i < ev.dataTransfer.files.length; i++) {
      files.push(ev.dataTransfer.files[i]);
    }
  }
  handleClickUpload(files);
}

function getContestBasePath() {
  const match = window.location.pathname.match(/^(.*\/contest\/[^/]+)(?:\/.*)?$/);
  return match?.[1] || '';
}

function getTime(value) {
  if (!value) return NaN;
  if (typeof value === 'number') return value;
  return new Date(value).getTime();
}

function isContestDoneForCurrentUser() {
  const context = (globalThis as any).UiContext || {};
  const { tdoc, tsdoc } = context;
  const now = Date.now();
  if (getTime(tdoc?.endAt) <= now) return true;
  if (getTime(tsdoc?.endAt) <= now) return true;
  if (tdoc?.duration && tsdoc?.startAt) {
    return getTime(tsdoc.startAt) + tdoc.duration * 3600000 <= now;
  }
  return false;
}

function linkPath(element) {
  const href = $(element).attr('href');
  if (!href) return '';
  return new URL(href, window.location.href).pathname;
}

function injectContestSolutionLink() {
  const basePath = getContestBasePath();
  if (!basePath) return;
  const solutionPath = `${basePath}/solution`;
  const context = (globalThis as any).UiContext || {};

  $('.section.side ol.menu').each((_, menu) => {
    const $menu = $(menu);
    const hasContestLink = $menu.find('a[href]').toArray().some((link) => linkPath(link).startsWith(basePath));
    if (!hasContestLink || $menu.find('[data-contest-solution-link]').length) return;

    const canManage = $menu.find('a[href]').toArray().some((link) => {
      const path = linkPath(link);
      return path === `${basePath}/edit` || path === `${basePath}/management`;
    });
    const currentPage = window.location.pathname === solutionPath;
    const canView = currentPage || canManage || (!!context.tsdoc?.attend && isContestDoneForCurrentUser());
    if (!canView) return;

    const active = currentPage ? ' active' : '';
    const $item = $(tpl`
      <li class="menu__item" data-contest-solution-link>
        <a class="menu__link${active}" href="${solutionPath}">
          <span class="icon icon-book"></span> ${i18n('Contest Solution')}
        </a>
      </li>`);

    const anchors = $menu.find('a[href]').toArray();
    const $edit = $(anchors.find((link) => linkPath(link) === `${basePath}/edit`)).closest('li');
    const $scoreboard = $(anchors.reverse().find((link) => /\/scoreboard(?:\/.*)?$/.test(linkPath(link)))).closest('li');
    const $problems = $menu.find('a[href]').filter((_, link) => linkPath(link) === `${basePath}/problems`).closest('li');
    if ($edit.length) $item.insertBefore($edit);
    else if ($scoreboard.length) $item.insertAfter($scoreboard);
    else if ($problems.length) $item.insertAfter($problems);
    else $menu.append($item);
  });
}

addPage(new NamedPage([
  'contest_detail',
  'contest_problemlist',
  'contest_scoreboard',
  'contest_scoreboard_view',
  'contest_detail_problem',
  'contest_detail_problem_submit',
  'contest_print',
  'discussion_node',
  'discussion_detail',
  'contest_solution',
], () => {
  injectContestSolutionLink();
}));

addPage(new NamedPage(['contest_solution'], () => {
  injectContestSolutionLink();
  let isEditing = false;

  $('#edit-solution-btn').on('click', () => {
    if (!isEditing) {
      $('#solution-display').hide();
      $('#solution-edit').show();
      $('#edit-solution-btn').text(i18n('Cancel')).removeClass('primary');
      isEditing = true;
    }
  });

  $('#cancel-edit-btn').on('click', () => {
    $('#solution-edit').hide();
    $('#solution-display').show();
    $('#edit-solution-btn').text(i18n('Edit')).addClass('primary');
    isEditing = false;
  });

  $('#solution-form').on('submit', async (e) => {
    e.preventDefault();
    const content = $('[name="content"]').val();

    try {
      const res = await request.post('', { operation: 'update', content });
      Notification.success(i18n('Solution updated successfully'));
      window.location.reload();
    } catch (error) {
      Notification.error(error.message);
    }
  });

  $(document).on('click', '[name="upload_file"]', () => handleClickUpload());
  $(document).on('click', '[name="remove_selected"]', () => handleClickRemoveSelected());
  $(document).on('dragover', '.files', (ev) => handleDragOver(ev));
  $(document).on('drop', '.files', (ev) => handleDrop(ev));
}));
