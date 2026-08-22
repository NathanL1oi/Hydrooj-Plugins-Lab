// @filename: index.ts
import { Context } from 'hydrooj';
import markdown from '@hydrooj/ui-default/backendlib/markdown'
import { Setting } from 'hydrooj/src/model/setting';

export async function apply(ctx: Context) {
    ctx.setting.DomainSetting(
        Setting('setting_domain', 'Notice', null, 'markdown',
            '浮窗公告'),
        Setting('setting_domain', 'enableShowNotice', false, 'boolean',
            '是否展示浮窗公告')
    );
    console.log('Floating widget plugin loaded.'); 
}
