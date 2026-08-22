import {
    i18n, pjax, request, tpl, NamedPage, Notification, $, addPage
} from '@hydrooj/ui-default';

addPage(new NamedPage('blog_detail', () => {
    async function onCommentClickReplyReply(ev) {
        const $evTarget = $(ev.currentTarget);
        const $mediaBody = $evTarget.closest('.media__body');
        // console.log($mediaBody);
        const uid = $mediaBody
            .find('.user-profile-name')
            .attr('href').split('/user/')[1];
        const initialText = `@[](/user/${uid.trim()}) `;
        // console.log(initialText);
        $('[name="dczcomments__dummy-box"]').trigger('click');
        $('form.dczcomments__box textarea[name="content"]').val(initialText).focus();
    }
    $(document).on('click', '[data-op="reply_comment"][data-type="comment"]', onCommentClickReplyReply);

}));