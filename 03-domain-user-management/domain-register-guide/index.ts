import { Context, PRIV, Schema, SystemModel } from 'hydrooj';

export const name = 'domain-register-guide';

export const Config = Schema.object({
  domainIds: Schema.array(Schema.string()).default(['hyoi']).description('Domain IDs where the guide is shown. Empty means all domains.'),
  buttonText: Schema.string().default('注册引导').description('Floating guide button text'),
  autoOpen: Schema.boolean().default(false).description('Open the guide automatically once per browser in matching domains'),
}).description('Domain registration guide');

type PluginConfig = ReturnType<typeof Config>;

function getDomainId(handler: any) {
  return String(handler.args?.domainId || handler.domain?._id || '');
}

function shouldEnable(domainId: string, config: PluginConfig) {
  const ids = config.domainIds || [];
  return !ids.length || ids.includes(domainId);
}

export async function apply(ctx: Context, config: PluginConfig) {
  ctx.on('handler/after', async (handler: any) => {
    const domainId = getDomainId(handler);
    if (!domainId || !shouldEnable(domainId, config)) return;
    if (!handler.UiContext) return;
    if (!SystemModel.get('server.login')) return;
    if (!handler.user?.hasPriv?.(PRIV.PRIV_REGISTER_USER)) return;

    handler.UiContext.domainRegisterGuide = {
      enabled: true,
      domainId,
      registerUrl: handler.url('user_register'),
      loginUrl: handler.url('user_login'),
      buttonText: config.buttonText || '注册引导',
      autoOpen: !!config.autoOpen,
    };
  });
}
