import { $, addPage, NamedPage, UserSelectAutoComplete } from '@hydrooj/ui-default';

function pad2(n: number) {
  return `${n}`.padStart(2, '0');
}

function formatDate(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatTime(d: Date) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function rangeByKey(key: string) {
  const end = new Date();
  const start = new Date(end.getTime());
  if (key === '1w') start.setDate(start.getDate() - 7);
  else if (key === '1m') start.setMonth(start.getMonth() - 1);
  else if (key === '1y') start.setFullYear(start.getFullYear() - 1);
  else start.setDate(start.getDate() - 1);
  return { start, end };
}

function setRangeInputs(root: HTMLElement, start: Date, end: Date) {
  const startDate = root.querySelector<HTMLInputElement>('.presence-start-date');
  const startTime = root.querySelector<HTMLInputElement>('.presence-start-time');
  const endDate = root.querySelector<HTMLInputElement>('.presence-end-date');
  const endTime = root.querySelector<HTMLInputElement>('.presence-end-time');
  if (!startDate || !startTime || !endDate || !endTime) return;
  startDate.value = formatDate(start);
  startTime.value = formatTime(start);
  endDate.value = formatDate(end);
  endTime.value = formatTime(end);
}

addPage(new NamedPage('domain_user_data', () => {
  UserSelectAutoComplete.getOrConstruct($('[name="uidOrName"]'), {
    clearDefaultValue: false,
  });

  const root = document.querySelector<HTMLElement>('[data-presence-range]');
  if (!root) return null;
  if (root.dataset.presenceInited) return null;
  root.dataset.presenceInited = '1';

  const form = root.closest('form') as HTMLFormElement | null;
  root.querySelectorAll<HTMLButtonElement>('[data-range]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-range') || '1d';
      const { start, end } = rangeByKey(key);
      setRangeInputs(root, start, end);
      form?.submit();
    });
  });

  return null;
}));
