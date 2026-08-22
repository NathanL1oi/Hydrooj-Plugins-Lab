import { $, addPage } from '@hydrooj/ui-default';

declare const UiContext: any;

function domainBase() {
    const domainId = UiContext?.domain?._id || UiContext?.domainId;
    return domainId ? `/d/${domainId}` : '';
}

function mountCourseSidebarEntry() {
    if (!/\/course(\/|$)/.test(window.location.pathname)) return;
    const oldEntry = document.getElementById('mistake-reflection-course-entry');
    if (oldEntry) {
        if (oldEntry.tagName.toLowerCase() === 'li') return;
        oldEntry.remove();
    }
    const $sticky = $('[data-sticky="large"]').first();
    if (!$sticky.length) return;

    const $firstSection = $sticky.find('> .section.side').first();
    const $menu = $firstSection.find('ol.menu').first();
    if ($menu.length) {
        const li = document.createElement('li');
        li.className = 'menu__item course-side-integrated-entry';
        li.id = 'mistake-reflection-course-entry';
        li.innerHTML = `
          <a class="menu__link" href="${domainBase()}/reflection">
            <span class="icon icon-edit"></span> 错因复盘
          </a>
        `;
        const $separator = $menu.children('.menu__seperator').first();
        if ($separator.length) $separator.before(li);
        else $menu.append(li);
        return;
    }

    const section = document.createElement('div');
    section.className = 'section side';
    section.innerHTML = `
      <div>
        <ol class="menu">
          <li class="menu__item" id="mistake-reflection-course-entry">
            <a class="menu__link" href="${domainBase()}/reflection">
              <span class="icon icon-edit"></span> 错因复盘
            </a>
          </li>
        </ol>
      </div>
    `;
    if ($firstSection.length) $firstSection.after(section);
    else $sticky.append(section);
}

addPage(mountCourseSidebarEntry);
