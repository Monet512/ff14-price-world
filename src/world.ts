/**
 * FF14 查价 World —— 只提供"请求/响应"工具，不产事件、不碰游戏进程。
 *
 * 架构为后续加功能预留：
 * - 每个功能 = 一组 TOOL_DECLS + 一个 handler 私有方法；
 * - 所有外部 IO 收拢在 services/（names 名称解析、prices 查价、http 请求、report 文案）；
 * - 加新功能时只需：在 TOOL_DECLS 追加声明、在 tools() 追加 handler、更新 definition 的 describe。
 */
import { fileURLToPath } from 'node:url';
import type { ToolDef, World, WorldWebUiDecl, WorldHost } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import type { PriceConfigSection } from './config.ts';
import { PRICE_CONFIG_GROUP } from './config.ts';
import { fetchJson } from './services/http.ts';
import { NameResolver } from './services/names.ts';
import { PriceClient, lowestByQuality } from './services/prices.ts';
import { composeSpeech } from './services/report.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

export interface PriceWorldOptions {
  /** worlds.ff14-price 的活引用；热改项现读即生效。 */
  cfg: PriceConfigSection;
  /** 包目录绝对路径，用于定位内置词表。 */
  packageDir: string;
  timezone: string;
}

/**
 * 全部工具声明（不含 handler）。define 的 describe 与 tools() 共用这份，
 * 保证自描述与实际工具永远一致。
 */
export const PRICE_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'ff14_price',
    description:
      '查询 FF14 市场（Universalis）里某个物品的价格。传入物品名（中文或英文）或数字物品ID；中文支持模糊搜索（如「羊角笛」会找到相近物品），多个接近候选时会先请你确认。返回已经写好、可以直接说给用户听的播报文案，含最低价与所在服务器。只读公开行情，不涉及游戏内交易。',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        item: {
          type: 'string',
          description: '物品名，中文或英文均可；中文支持模糊搜索，名字记不全也能查；也可直接传数字物品ID。例如「高等以太药」「羊角笛」「Tincture of Strength」「27786」。',
        },
      },
      required: ['item'],
    },
  },
];

export class PriceWorld implements World {
  readonly id = 'ff14-price';
  private readonly opts: PriceWorldOptions;
  private readonly resolver: NameResolver;

  constructor(opts: PriceWorldOptions) {
    this.opts = opts;
    this.resolver = new NameResolver(opts.cfg, opts.packageDir, fetchJson);
  }

  /** 变量表为空：ENV_PROMPT.md 是静态说明，不注入动态值。 */
  envPromptVars(): Record<string, string> {
    return {};
  }

  tools(): ToolDef[] {
    return [this.ff14PriceTool()];
    // 后续加功能：return [this.ff14PriceTool(), this.someNewTool()];
  }

  webUi(_language: Language = 'zh'): WorldWebUiDecl {
    return {
      config: [PRICE_CONFIG_GROUP],
      promptDocs: [
        {
          key: 'worlds.ff14-price.envPrompt',
          title: 'FF14 查价 · 环境提示词',
          description: '进 system 前缀的那段：告诉 Coo 什么时候调查价工具、怎么把播报文案说得像陪玩。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
        },
      ],
    };
  }

  async start(_host: WorldHost): Promise<void> {}
  async stop(): Promise<void> {}

  // ── 工具实现 ────────────────────────────────────────────────

  private ff14PriceTool(): ToolDef {
    return {
      ...PRICE_TOOL_DECLS[0],
      handler: async (args) => {
        const raw = typeof args.item === 'string' ? args.item.trim() : '';
        if (!raw) return '[bad input] 需要给出物品名或物品ID。';

        // 1) 名称 → ID
        let resolved;
        try {
          resolved = await this.resolver.resolve(raw);
        } catch (e) {
          return `[查价失败] 名称解析出错：${e instanceof Error ? e.message : String(e)}`;
        }
        if (!resolved) {
          return '[查价失败] 没找到这个物品，也没有足够接近的候选。请换个说法、用英文物品名，或直接甩个数字物品ID。';
        }

        // 模糊搜索撞上多个接近候选：先让用户确认，不猜一个就查（会报错物品）
        if (resolved.ambiguous) {
          const names = (resolved.candidates || [])
            .slice(0, 5)
            .map((c) => `「${c.name}」`)
            .join('、');
          return `[需要确认] 没找到完全一样的「${resolved.query || raw}」，最接近的是：${names}。请回一个物品名或数字ID，我再查价。`;
        }

        // 2) ID → 价格快照（fields 裁剪，进程内比价）
        const cfg = this.opts.cfg;
        const client = new PriceClient(cfg.dataCenter, fetchJson, cfg.timeoutMs, this.opts.packageDir);
        const mode = cfg.reportMode || 'lowest-hq';
        let snapshot;
        try {
          // 最低价两档走聚合端点（服务端算好、零比价）；全报走 listings + fields 裁剪。
          snapshot = mode === 'all'
            ? await client.queryListings(resolved.id)
            : await client.queryAggregated(resolved.id);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // 模糊搜索可能命中"名字像但不可交易"的物品，Universalis 会回 400。
          if (/HTTP 400/.test(msg)) {
            return `[查价失败] 「${resolved.matchedName}」在公开市场没有行情（多半是不可交易或没被收录的物品），换个能交易的物品名或ID再试试。`;
          }
          return `[查价失败] 查询市场出错：${msg}`;
        }

        // 3) 快照 → 成品播报文案（模型只看到这一句）
        const speech = composeSpeech(snapshot, mode, cfg.maxListings, {
          itemName: resolved.matchedName,
          dataCenter: cfg.dataCenter || 'Chaos',
        });

        // 附一条极短的元信息，便于调试；不影响播报主体
        const src = resolved.source === 'dictionary'
          ? '本地词表'
          : resolved.source === 'fuzzy'
            ? '模糊匹配'
            : resolved.source === 'online'
              ? '在线匹配'
              : '直接ID';
        return `${speech}\n（物品ID ${resolved.id} · ${mode} · ${src}）`;
      },
    };
  }
}
