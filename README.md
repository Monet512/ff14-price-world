# cortico-world-ff14-price

桌宠 Coo（Coopanion / Cortico）的 FF14 查价 World。用物品名（中文或英文）查 Universalis 公开市场行情，播报成陪玩口吻，带服务器名。

**只读公开行情**，不碰游戏进程、不下单、不涉及游戏内交易。

## 它做什么

主人问「XX 多少钱」「去哪个服买 XX 便宜」时，Coo 调用 `ff14_price` 工具：

1. **名称解析**：中文名查内置词表（4.1 万条，离线、零 token），精确优先、未命中自动模糊搜索；英文名走 xivapi v2；也可直接传数字物品 ID。
2. **查价**：Universalis API v2。
   - 「最低价」「最低价+HQ」两档用 `aggregated` 聚合端点，服务端算好，扩展内零比价。
   - 「全报」档用普通端点 + `fields` 裁剪，只取单价/服务器/HQ 三项。
3. **播报**：扩展内生成一句成品文案，模型只看到这句、直接照说——不会因为读长 JSON 而费 token。

## 中文模糊搜索

名字记不全、错一两个字也能查：输入「羊角笛」会找到最接近的「青色角笛」；输入「角笛」「高等以太」同样能命中。播报里用的是**实际匹配到的物品名**，不会照抄你输错的名字。

命中唯一或第一名明显领先时直接查价；若同时有多个接近候选（比如只输入「药」），工具会回「需要确认」并列出前 5 个名字，Coo 先问一句再查，不瞎猜。想关掉用 `fuzzyMatch=false`，想调松紧用 `fuzzyMinScore`（默认 300，越小越宽松、也越容易认错）。

## 三档播报（可随时改，立即生效）

配置 `worlds.ff14-price.reportMode`：

| 值 | 效果 | 示例 |
| --- | --- | --- |
| `lowest` | 只报最低价 | 查到了，去 Louisoix 买最便宜，只要 731 吉，这是 Chaos 最便宜的！ |
| `lowest-hq`（默认） | 最低价 + 高品质最低价 | 查到了，去 Louisoix 买最便宜，只要 731 吉；高品质的去 Cerberus 买最便宜，只要 3,500 吉，都在 Chaos！ |
| `all` | 全报（默认最多 5 条） | 查到了，力量之药在 Chaos 的挂单：1. 去 Omega 买最便宜，只要 1 吉；2. ……最低就是第 1 条！ |

## 国服 / 数据中心（重要）

`dataCenter` 既可以填**数据中心名**（如 `Chaos`、`Elemental`），也可以填**具体世界名或世界ID**（如 `红玉海`、`1167`）。

- 填数据中心 → 报整个数据中心的最低价，服务器名由 worldId 映射得出（可能是大区里别的服）。
- 填具体世界 → **只报本世界的最低价**（取 aggregated 的 `world` 层），服务器名就是它自己。国服世界 Universalis 有收录，如红玉海（1167）、紫水栈桥（1043）、晨曦王座（1175）。
- 示例：国服红玉海（worldId 1167）；代码默认值是 `Chaos`。

## 配置项（`worlds.ff14-price`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dataCenter` | `Chaos` | 数据中心名或具体世界名/ID；播报会带上它。热改。 |
| `reportMode` | `lowest-hq` | 上表三档。热改。 |
| `maxListings` | `5` | 全报档条数上限（1–20）。热改。 |
| `nameStrategy` | `local-first` | `local-first` / `local-only`（完全离线）/ `online-first`。热改。 |
| `timeoutMs` | `15000` | 请求超时。重启生效。 |
| `dictionaryPath` | 空 | 自定义词表路径（相对包根）；留空用 `data/items.zh.json`。重启生效。 |
| `fuzzyMatch` | `true` | 中文模糊搜索开关；精确名永远优先。热改。 |
| `fuzzyMinScore` | `300` | 模糊命中门槛（100–900），越小越宽松。热改。 |

## 扩展后续功能

架构已分层：`tools()` 集中注册工具，外部 IO 收拢在 `src/services/`（names / prices / report / http）。加新功能时：

1. 在 `world.ts` 的 `PRICE_TOOL_DECLS` 追加工具声明；
2. 在 `tools()` 追加对应 handler；
3. 更新 `definition.ts` 的 `describe.tools` 与 `describe.json`；
4. 需要的外部能力放 `src/services/` 新文件。

## 本地校验

```bash
corepack pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
```

> 开发时我已用真实网络端到端验证：中文词表命中、xivapi 精确匹配、Universalis 两个端点、worldId→服务器名、三档文案；并用 TypeScript 5.7 严格模式通过类型检查。

## 数据来源与许可

- 行情：[Universalis](https://universalis.app/)（公开 API，无需 key）。
- 中文物品名：[thewakingsands/ffxiv-datamining-cn](https://github.com/thewakingsands/ffxiv-datamining-cn)（抹茶作者维护的国服词表）。
- 名称在线兜底：[xivapi v2](https://v2.xivapi.com/)。
- 本包：MIT。
