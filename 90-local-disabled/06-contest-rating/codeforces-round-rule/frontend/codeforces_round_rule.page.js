import { addPage } from '@hydrooj/ui-default';

const STYLE_ID = 'codeforces-round-rule-style';

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .contest-type--codeforces .contest-type-tag {
      background: #dc2626;
    }

    .contest-type--codeforces .contest-type-tag:hover {
      background: #ef4444;
    }
  `;
  document.head.appendChild(style);
}

addPage(ensureStyle);
