import { addPage, AutoloadPage } from '@hydrooj/ui-default';
import './widget.css';
import { parse } from './parser';

function appendParsedMarkdown(parent: HTMLElement, markdownHtml: string) {
    const parsed = new DOMParser().parseFromString(markdownHtml, 'text/html');
    for (const child of Array.from(parsed.body.childNodes)) {
        parent.appendChild(document.importNode(child, true));
    }
}

function createCloseButton() {
    const close = document.createElement('button');
    close.type = 'button';
    close.title = '关闭';
    close.setAttribute('aria-label', '关闭通知');
    close.className = 'close-btn';
    close.dataset.widgetClose = 'true';
    close.textContent = '×';
    return close;
}

function placeWidget(container: HTMLElement) {
    container.dataset.placement = 'fixed';
    if (container.parentElement !== document.body) document.body.appendChild(container);
}

function setWidgetClass(container: HTMLElement, ...modifiers: string[]) {
    const classes = ['hydro-float-widget'];
    classes.push(...modifiers);
    container.className = classes.join(' ');
}

function createHeader(titleText: string) {
    const header = document.createElement('div');
    header.className = 'widget-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'widget-header-title';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = titleText;
    titleWrap.append(title);

    header.append(titleWrap, createCloseButton());
    return header;
}

function createTrigger() {
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'widget-icon';
    trigger.dataset.widgetTrigger = 'true';
    trigger.title = '查看通知';
    trigger.setAttribute('aria-label', '查看通知');

    const badge = document.createElement('span');
    badge.className = 'widget-icon-badge';
    badge.setAttribute('aria-hidden', 'true');
    trigger.append(badge);
    return trigger;
}

addPage(new AutoloadPage('global_float_widget', () => {
    if (!UiContext.domain?.enableShowNotice) return;
    if (document.getElementById('hydro-addon-widget')) return;

    const container = document.createElement('div');
    container.id = 'hydro-addon-widget';
    container.className = 'hydro-float-widget';

    let isOpen = false;

    const render = (closed: boolean) => {
        const rawNotice = String(UiContext.domain.Notice || '');

        const widgetContent = parse(rawNotice);
        const isLongText = widgetContent.length > 150;

        placeWidget(container);
        if (closed) {
            setWidgetClass(container, 'hydro-float-widget--closed');
            container.replaceChildren(createTrigger());
        } else {
            setWidgetClass(container, 'hydro-float-widget--open');
            const card = document.createElement('div');
            card.className = `widget-card ${isLongText ? 'widget-card--notice' : 'widget-card--normal'}`;
            card.appendChild(createHeader(isLongText ? '重要通知' : '系统公告'));

            const content = document.createElement('div');
            content.className = 'content-warp';
            appendParsedMarkdown(content, widgetContent);
            card.appendChild(content);
            container.replaceChildren(card);
        }

        const closeBtn = container.querySelector<HTMLElement>('[data-widget-close]');
        if (closeBtn) closeBtn.onclick = () => {
            isOpen = false;
            render(true);
        };

        const triggerBtn = container.querySelector<HTMLElement>('[data-widget-trigger]');
        if (triggerBtn) triggerBtn.onclick = () => {
            isOpen = true;
            render(false);
        };
    };

    const renderCurrent = () => {
        render(!isOpen);
    };

    const renderClosed = () => {
        isOpen = false;
        render(true);
    };

    placeWidget(container);
    renderClosed();
    window.addEventListener('resize', renderCurrent, { passive: true });
    document.addEventListener('vjContentNew', renderClosed);
}));
