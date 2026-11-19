import type { ConfigGroup } from 'cortico/core/types.ts';

/**
 * 播报档位：
 * - all         全报（所有挂单，按价格升序，最多 maxListings 条）
 * - lowest      只报最低价（含所在服务器与 HQ 标记）
 * - lowest-hq   只报最低价 + 高品质最低价（各自含服务器）
 */
export type ReportMode = 'all' | 'lowest' | 'lowest-hq';
export const REPORT_MODES: readonly ReportMode[] = ['all', 'lowest', 'lowest-hq'];

/** config.json 的 worlds.ff14-price 段。默认禁用；由部署或 bot 启用。 */
export interface PriceConfigSection {
  enabled: boolean;
  /**
   * 查询的数据中心（Universalis 的 dataCenter 名，如 Chaos / Elemental / Gaia / Aether / Primal / Crystal / Light / Shadow）。
   * 也接受具体世界名。留空时用默认数据中心。热改。
   */
  dataCenter: string;
  /** 播报档位。热改。 */
  reportMode: ReportMode;
  /** "全报"档最多列几条挂单。热改。 */
  maxListings: number;
  /** 单次 HTTP 请求超时（毫秒）。热改。 */
  timeoutMs: number;
  /**
   * 名称解析策略：
   * - local-first  先查内置中文词表，未命中再走在线英文搜索（默认）
   * - local-only   只查内置词表，未命中直接报错（完全离线）
   * - online-first 先走在线英文搜索，失败再查内置词表
   */
  nameStrategy: 'local-first' | 'local-only' | 'online-first';
  /** 内置词表路径（相对包根）；留空用随包附带的 data/items.zh.json。重启生效。 */
  dictionaryPath: string;
  /** 中文名模糊搜索开关；默认开启。精确名永远优先，不受此项影响。 */
  fuzzyMatch?: boolean;
  /** 模糊匹配最低分（100–900）；默认 300。调低更宽松、也更容易误命中。 */
  fuzzyMinScore?: number;
}

export const PRICE_DEFAULTS: PriceConfigSection = {
  enabled: false,
  dataCenter: 'Chaos',
  reportMode: 'lowest-hq',
  maxListings: 5,
  timeoutMs: 15000,
  nameStrategy: 'local-first',
  dictionaryPath: '',
  fuzzyMatch: true,
  fuzzyMinScore: 300,
};

/** World 配置的 JSON Schema 声明（WebUI 设置页）。 */
export const PRICE_CONFIG_GROUP: ConfigGroup = {
  id: 'world:ff14-price',
  owner: 'world:ff14-price',
  schema: {
    type: 'object',
    title: 'FF14 查价',
    description: '用物品名（中文或英文）查询 Universalis 市场价，由 Coo 播报。只读公开行情，不碰游戏。',
    properties: {
      'worlds.ff14-price.dataCenter': {
        type: 'string',
        title: '数据中心 / 服务器',
        description: 'Universalis 的数据中心名，如 Chaos、Elemental、Gaia；也可填具体世界名。播报会带上服务器名。',
        'x-hot': true,
      },
      'worlds.ff14-price.reportMode': {
        type: 'string',
        title: '播报档位',
        description: 'all=全报所有挂单；lowest=只报最低价；lowest-hq=最低价+高品质最低价。可随时改，立即生效。',
        enum: [...REPORT_MODES],
        'x-hot': true,
      },
      'worlds.ff14-price.maxListings': {
        type: 'integer',
        title: '全报条数上限',
        description: '"全报"档最多列几条挂单。',
        minimum: 1,
        maximum: 20,
        'x-hot': true,
      },
      'worlds.ff14-price.nameStrategy': {
        type: 'string',
        title: '名称解析策略',
        description: 'local-first=先查内置中文词表再联网；local-only=完全离线；online-first=先联网再查词表。',
        enum: ['local-first', 'local-only', 'online-first'],
        'x-hot': true,
      },
      'worlds.ff14-price.timeoutMs': {
        type: 'integer',
        title: '请求超时',
        description: '单次查价/搜索请求的超时，毫秒。',
        minimum: 3000,
        maximum: 60000,
        'x-hot': false,
      },
      'worlds.ff14-price.dictionaryPath': {
        type: 'string',
        title: '词表路径',
        description: '内置中文词表路径（相对包根）。留空用随包附带的 data/items.zh.json。重启生效。',
        'x-hot': false,
      },
      'worlds.ff14-price.fuzzyMatch': {
        type: 'boolean',
        title: '中文模糊搜索',
        description: '精确名找不到时，按包含/前缀/相似度猜最接近的物品；多个接近候选会让 Coo 先问一句。默认开启，热改。',
        'x-hot': true,
      },
      'worlds.ff14-price.fuzzyMinScore': {
        type: 'integer',
        title: '模糊匹配门槛',
        description: '模糊命中最低分（100–900），默认 300。调低更宽松，但也更容易认错物品。热改。',
        minimum: 100,
        maximum: 900,
        'x-hot': true,
      },
    },
  },
};
