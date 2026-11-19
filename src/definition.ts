import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { PRICE_DEFAULTS, type PriceConfigSection } from './config.ts';
import { PRICE_TOOL_DECLS, PriceWorld } from './world.ts';

export const FF14_PRICE: WorldDefinition<PriceConfigSection> = {
  id: 'ff14-price',
  label: 'FF14 查价',
  defaults: () => ({ ...PRICE_DEFAULTS }),
  create: (ctx) =>
    new PriceWorld({
      cfg: ctx.cfg,
      packageDir: ctx.packageDir,
      timezone: ctx.timezone,
    }),
  // 自描述：全部工具 + 会推出的事件（本 World 不产事件，events 为空）。
  describe: {
    tools: describeTools(PRICE_TOOL_DECLS, {
      ff14_price: {
        zh: '用物品名或ID查 Universalis 市场价，返回含服务器名的最低价播报文案。',
        en: 'Looks up Universalis market price by item name or ID and returns a ready-to-say report with server names.',
      },
    }),
    events: [],
  },
};
