import { addPage, NamedPage } from '@hydrooj/ui-default';

function getDomainId() {
    return (window as any).UiContext?.domainId || 'system';
}

addPage(new NamedPage(['domain_group'], () => {
    if (document.querySelector('[data-group-batch-link]')) return;

    const createBtn = document.querySelector('a.primary.button, button.primary.button');
    if (!createBtn) return;

    const batchBtn = document.createElement('a');
    batchBtn.href = `/d/${getDomainId()}/domain/group-batch`;
    batchBtn.className = 'rounded button';
    batchBtn.dataset.groupBatchLink = 'true';
    batchBtn.style.marginLeft = '8px';
    batchBtn.innerHTML = '<span class="icon icon-users"></span> 批量管理成员';

    createBtn.parentNode?.insertBefore(batchBtn, createBtn.nextSibling);
}));

addPage(new NamedPage(['group_batch'], () => {
    const form = document.querySelector<HTMLFormElement>('[data-group-batch-form]');
    if (!form || form.dataset.bound === '1') return;
    form.dataset.bound = '1';

    const textarea = form.querySelector<HTMLTextAreaElement>('[data-group-users]');
    const counter = form.querySelector<HTMLElement>('[data-line-counter]');
    const groupSelect = form.querySelector<HTMLSelectElement>('[data-group-select]');
    const executeButton = form.querySelector<HTMLButtonElement>('[data-execute-button]');
    const actionCards = Array.from(form.querySelectorAll<HTMLLabelElement>('[data-action-card]'));
    const initialPreviewValue = form.dataset.previewReady === '1' ? textarea?.value || '' : '';

    const updateCounter = () => {
        if (!textarea || !counter) return;
        const count = textarea.value
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith('#'))
            .length;
        counter.textContent = String(count);
        if (textarea.value !== initialPreviewValue) form.removeAttribute('data-preview-ready');
    };

    const updateActionCards = () => {
        for (const card of actionCards) {
            const input = card.querySelector<HTMLInputElement>('input[type="radio"]');
            card.classList.toggle('is-active', !!input?.checked);
        }
    };

    for (const chip of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-group-chip]'))) {
        chip.addEventListener('click', () => {
            if (!groupSelect) return;
            groupSelect.value = chip.dataset.groupChip || '';
            groupSelect.dispatchEvent(new Event('change', { bubbles: true }));
        });
    }

    for (const card of actionCards) {
        card.addEventListener('click', () => setTimeout(updateActionCards, 0));
    }

    textarea?.addEventListener('input', updateCounter);
    executeButton?.addEventListener('click', (event) => {
        if (!textarea?.value.trim()) {
            event.preventDefault();
            alert('请先粘贴用户名。');
            textarea?.focus();
            return;
        }

        const hasPreview = form.dataset.previewReady === '1';
        const message = hasPreview
            ? '确认按当前内容执行批量修改？'
            : '当前内容还没有预览。建议先点“预览检查”。仍然直接执行吗？';
        if (!confirm(message)) event.preventDefault();
    });

    updateCounter();
    updateActionCards();
}));
