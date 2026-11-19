/**
 * 播报文案生成：把价格快照转成 Coo 说的话。
 *
 * 全部在 World 进程内完成 —— 模型只收到这一句成品文案，直接照说即可，
 * 不会因为要读一长串挂单 JSON 而消耗 token。
 *
 * 三档：
 * - lowest      只报最低价
 * - lowest-hq   最低价 + 高品质最低价（默认）
 * - all         全报（最多 maxListings 条）
 *
 * 每档的服务器名都会带上（示例：「去 Louisoix 买最便宜」）。
 */
import type { ReportMode } from '../config.ts';
import { lowestByQuality, type Listing, type PriceSnapshot } from './prices.ts';

const fmt = (n: number): string => n.toLocaleString('zh-CN');

interface SpeakParts {
  itemName: string;
  dataCenter: string;
}

/** 生成给模型的成品播报文案。 */
export function composeSpeech(snapshot: PriceSnapshot, mode: ReportMode, maxListings: number, parts: SpeakParts): string {
  if (snapshot.listings.length === 0) {
    return `查到了，${parts.itemName}在${parts.dataCenter}暂时没有挂单，市场上没人卖。`;
  }

  const { nq, hq } = lowestByQuality(snapshot);
  const prefix = `查到了，`;

  switch (mode) {
    case 'lowest': {
      const cheapest = snapshot.listings[0]; // 已按价格升序
      return `${prefix}${partLine(cheapest)}，这是${parts.dataCenter}最便宜的！`;
    }
    case 'lowest-hq': {
      const lines: string[] = [];
      if (nq) lines.push(partLine(nq));
      if (hq && hq !== nq) lines.push(partLine(hq)); // partLine 已带"高品质"标记，不再重复
      if (!nq && hq) lines[0] = partLine(hq);
      return `${prefix}${lines.join('；')}，都在${parts.dataCenter}！`;
    }
    case 'all': {
      const top = snapshot.listings.slice(0, maxListings);
      const segs = top.map((l, i) => `${i + 1}. ${partLine(l)}`);
      const more = snapshot.listings.length > top.length ? `……还有 ${snapshot.listings.length - top.length} 条更贵的就不念了` : '';
      return `${prefix}${parts.itemName}在${parts.dataCenter}的挂单：${segs.join('；')}${more}。最低就是第 1 条！`;
    }
  }
}

function partLine(l: Listing): string {
  const tag = l.hq ? '高品质' : '';
  return `${tag ? tag + '的' : ''}去${l.worldName}买最便宜，只要${fmt(l.pricePerUnit)}吉`;
}

/**
 * 「查价前确认句」——给用户听的第一句，对应示例：
 * 「要这个'物品名'的价格吗？我查查。」
 * 这一句由模型在调用工具前说，不在这里生成；此函数仅供需要时复用文案。
 */
export function confirmLine(itemName: string): string {
  return `要这个「${itemName}」的价格吗？我查查。`;
}
