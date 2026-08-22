import { i18n, request, NamedPage, Notification, $, addPage } from '@hydrooj/ui-default';
import { _, UiContextBase } from 'hydrooj';

addPage(new NamedPage('blog_edit', () => {
    const role = $('#select_course_for_admin').length ? 'admin' : 'user';
    if (role == "admin" && !UiContext.forcedRef) {
        const $secWrap = $('#select_section_for_admin');
        const $subWrap = $('#select_subsec_for_admin');
        const preCourseId = ($('#preCourseId').val() || '').toString();
        const preSectionId = ($('#preSectionId').val() || '').toString();
        const preSubId = ($('#preSubId').val() || '').toString();
        const setOptions = ($sel: any, items: Array<{ value: string; label: string }>, placeholder: string) => {
            $sel.html(`<option value="">${placeholder}</option>`);
            items.forEach(it => {
                const opt = document.createElement('option');
                opt.value = it.value;
                opt.textContent = it.label;
                $sel[0].appendChild(opt);
            });
        };
        const loadCourses = async () => {
            try {
                const { cdocs } = await request.get(`/d/${UiContext.domainId}/article/course`); // [{title, docId}]
                setOptions($('#course_select'), cdocs.map((c: any) => ({ value: String(c.docId), label: c.title })), i18n('Select a course'));
                if (preCourseId) { $('#course_select').val(preCourseId); await onCourseChange(preCourseId, true); }
            } catch (e) { Notification.error('Load courses failed'); console.error(e); }
        };
        const loadSections = async (courseId: string) => {
            try {
                const { csdocs } = await request.get(`/d/${UiContext.domainId}/article/course/${courseId}`); // [{title, docId}]
                setOptions($('#section_select'), csdocs.map((s: any) => ({ value: String(s.docId), label: s.title })), i18n('Select a section'));
                $('#section_select').prop('disabled', false);
                if (preSectionId) { $('#section_select').val(preSectionId); await onSectionChange(preSectionId, true); }
            } catch (e) { Notification.error('Load sections failed'); console.error(e); }
        };
        const loadSubsections = async (sectionId: string) => {
            try {
                const { nodes } = await request.get(`/d/${UiContext.domainId}/article/subsections/${sectionId}`); // [{_id,title}]
                setOptions($('#subsec_select'), (nodes || []).map((n: any) => ({ value: String(n._id), label: n.title })), i18n('Select a subsec'));
                $('#subsec_select').prop('disabled', !nodes || !nodes.length);
                if (preSubId) $('#subsec_select').val(preSubId);
            } catch (e) { Notification.error('Load subsections failed'); console.error(e); }
        };
        const onCourseChange = async (cid: string, silent = false) => {
            $('#section_select').prop('disabled', true).val('');
            $('#subsec_select').prop('disabled', true).val('');
            if (role === 'admin') { $secWrap.toggleClass('hidden', !cid); $subWrap.addClass('hidden'); }
            if (!cid) return;
            if (!silent) $('#preSectionId,#preSubId').val('');
            await loadSections(cid);
        };
        const onSectionChange = async (sid: string, silent = false) => {
            $('#subsec_select').prop('disabled', true).val('');
            if (role === 'admin') $subWrap.toggleClass('hidden', !sid);
            if (!sid) return;
            if (!silent) $('#preSubId').val('');
            await loadSubsections(sid);
        };
        if (role === 'user') {
            $('#course_select').prop('disabled', true);
            $('#section_select').prop('disabled', true);
            $('#subsec_select').prop('disabled', true);
        } else {
            if (!preCourseId) $secWrap.addClass('hidden');
            if (!preSectionId) $subWrap.addClass('hidden');
        }
        $('#course_select').on('change', (e) => onCourseChange((e.target as HTMLSelectElement).value));
        $('#section_select').on('change', (e) => onSectionChange((e.target as HTMLSelectElement).value));
        loadCourses();
    } else {
        $('#course_select, #section_select, #subsec_select').prop('disabled', true);
    }
}));
