/**
 * 查价：Universalis API v2。借鉴了两个插件的做法：
 * - ffxiv-priceinsight：用 aggregated 聚合端点（服务端已算好 NQ/HQ 最低价、按 world/dc/region 分层），
 *   配合 worldId→世界名映射；缓存策略。
 * - fields 裁剪：普通端点只取挂单 3 项，避免长 JSON 进上下文。
 *
 * 双端点策略（省数据 + 零冗余）：
 * - "最低价 / 最低价+HQ" 两档 → aggregated，服务端算好，扩展内不比价。
 * - "全报" 档 → 普通 listings + fields 裁剪，扩展内排序。
 *
 * 无论哪条路，模型最终只收到一句播报文案。
 */
import { readFile } from 'node:fs/promises';
import { findDataFile } from './data-file.ts';

export interface Listing {
  pricePerUnit: number;
  worldName: string;
  hq: boolean;
}

/** 聚合端点给出的单个品质最低挂单。 */
export interface AggregatedLow {
  price: number;
  worldName: string;
}

export interface PriceSnapshot {
  itemId: number;
  dataCenter: string;
  listings: Listing[];
  nqLow?: AggregatedLow;
  hqLow?: AggregatedLow;
  lastUpdated: number | null;
}

/** 普通端点只请求这几项；实测完整返回约 2.8KB，裁剪后每条约 40 字节。 */
const FIELDS = ['listings.pricePerUnit', 'listings.worldName', 'listings.hq', 'lastUploadTime'].join(',');

const API = 'https://universalis.app/api/v2';

export class PriceClient {
  private worlds: Map<number, string> | null = null;
  private worldsLoading: Promise<Map<number, string>> | null = null;

  constructor(
    private readonly dataCenter: string,
    private readonly fetchJson: (url: string, timeoutMs: number) => Promise<unknown>,
    private readonly timeoutMs: number,
    private readonly packageDir: string,
  ) {}

  /** worldId → 世界名，随包 data/worlds.id.json；惰性加载。 */
  private async worldNames(): Promise<Map<number, string>> {
    if (this.worlds) return this.worlds;
    if (!this.worldsLoading) {
      const path = findDataFile('worlds.id.json');
      if (!path) {
        console.error('[ff14-price] 世界映射定位失败：在扩展包 data/ 下找不到 worlds.id.json');
        return new Map<number, string>();
      }
      this.worldsLoading = readFile(path, 'utf8')
        .then((text) => {
          const obj = JSON.parse(text.replace(/^\uFEFF/, '')) as Record<string, string>;
          const m = new Map<number, string>();
          for (const [id, name] of Object.entries(obj)) m.set(Number(id), name);
          this.worlds = m;
          return m;
        })
        .catch(() => new Map<number, string>());
    }
    return this.worldsLoading;
  }

  private async worldName(worldId: number | undefined): Promise<string> {
    if (!worldId) return '未知服务器';
    const m = await this.worldNames();
    return m.get(worldId) || `服务器${worldId}`;
  }

  /**
   * scope 是否指向一个具体世界（而非数据中心）。
   * dataCenter 配置可填数据中心名（Chaos）或具体世界名/ID（红玉海 / 1167）。
   * 命中 world 映射即为单世界——此时查价要取 world 层的本世界价，
   * 而不是 dc 层（那会是同一个国服大区里别的服务器的低价，报错对象）。
   */
  private async resolveWorldScope(): Promise<{ isWorld: boolean; worldId?: number }> {
    const scope = this.dataCenter.trim();
    if (/^\d+$/.test(scope)) return { isWorld: true, worldId: Number(scope) };
    const m = await this.worldNames();
    for (const [id, name] of m) {
      if (name === scope || name.toLowerCase() === scope.toLowerCase()) return { isWorld: true, worldId: id };
    }
    return { isWorld: false };
  }

  private get scope(): string {
    return encodeURIComponent(this.dataCenter.trim() || 'Chaos');
  }

  /** "全报"：普通 listings + fields 裁剪，进程内排序。 */
  async queryListings(itemId: number): Promise<PriceSnapshot> {
    const url = `${API}/${this.scope}/${itemId}?fields=${encodeURIComponent(FIELDS)}`;
    const json = await this.fetchJson(url, this.timeoutMs) as {
      listings?: Array<{ pricePerUnit?: number; worldName?: string; hq?: boolean }>;
      lastUploadTime?: number;
    };
    const listings: Listing[] = (json.listings || [])
      .filter((l) => typeof l.pricePerUnit === 'number' && l.pricePerUnit > 0)
      .map((l) => ({ pricePerUnit: l.pricePerUnit as number, worldName: l.worldName || '未知服务器', hq: !!l.hq }))
      .sort((a, b) => a.pricePerUnit - b.pricePerUnit);
    return { itemId, dataCenter: this.dataCenter, listings, lastUpdated: typeof json.lastUploadTime === 'number' ? json.lastUploadTime : null };
  }

  /** "最低价/最低价+HQ"：aggregated 聚合端点，服务端算好，零比价。 */
  async queryAggregated(itemId: number): Promise<PriceSnapshot> {
    const url = `${API}/aggregated/${this.scope}/${itemId}`;
    const json = await this.fetchJson(url, this.timeoutMs) as {
      results?: Array<{
        itemId: number;
        nq?: { minListing?: { dc?: { price?: number; worldId?: number }; world?: { price?: number } } };
        hq?: { minListing?: { dc?: { price?: number; worldId?: number }; world?: { price?: number } } };
      }>;
    };
    const r = json.results?.[0];
    const ws = await this.resolveWorldScope();
    const pick = async (q: { minListing?: { dc?: { price?: number; worldId?: number }; world?: { price?: number } } } | undefined): Promise<AggregatedLow | undefined> => {
      const wl = q?.minListing;
      if (!wl) return undefined;
      if (ws.isWorld) {
        // 单世界：取本世界（world 层）最低价，服务器名就是配置的世界名。
        const world = wl.world;
        if (!world || typeof world.price !== 'number') return undefined;
        return { price: world.price, worldName: this.dataCenter.trim() };
      }
      // 数据中心：取 dc 层，worldId 映射出真正最便宜的服务器。
      const dc = wl.dc;
      if (!dc || typeof dc.price !== 'number') return undefined;
      return { price: dc.price, worldName: await this.worldName(dc.worldId) };
    };
    const nqLow = await pick(r?.nq);
    const hqLow = await pick(r?.hq);
    // 构造一个最小 listings 供播报复用（按价格升序）
    const listings: Listing[] = [];
    if (nqLow) listings.push({ pricePerUnit: nqLow.price, worldName: nqLow.worldName, hq: false });
    if (hqLow) listings.push({ pricePerUnit: hqLow.price, worldName: hqLow.worldName, hq: true });
    listings.sort((a, b) => a.pricePerUnit - b.pricePerUnit);
    return { itemId, dataCenter: this.dataCenter, listings, nqLow, hqLow, lastUpdated: null };
  }
}

/** 取 NQ / HQ 各自最低价挂单（供 all 档从 listings 里分品质用）。 */
export function lowestByQuality(snapshot: PriceSnapshot): { nq?: Listing; hq?: Listing } {
  const nq = snapshot.listings.find((l) => !l.hq);
  const hq = snapshot.listings.find((l) => l.hq);
  return { nq, hq };
}
