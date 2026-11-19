import { describe, it, expect } from 'vitest';
import { composeSpeech } from '../src/services/report.ts';
import { lowestByQuality, type PriceSnapshot } from '../src/services/prices.ts';

const snap: PriceSnapshot = {
  itemId: 27786,
  dataCenter: 'Chaos',
  lastUpdated: Date.now(),
  listings: [
    { pricePerUnit: 731, worldName: 'Louisoix', hq: false },
    { pricePerUnit: 734, worldName: 'Cerberus', hq: false },
    { pricePerUnit: 3500, worldName: 'Moogle', hq: true },
  ],
};

describe('lowestByQuality', () => {
  it('分别取 NQ 与 HQ 的最低价', () => {
    const { nq, hq } = lowestByQuality(snap);
    expect(nq?.pricePerUnit).toBe(731);
    expect(hq?.pricePerUnit).toBe(3500);
  });
});

describe('composeSpeech', () => {
  const parts = { itemName: '力量之药', dataCenter: 'Chaos' };

  it('lowest 只报最低价并带服务器', () => {
    const s = composeSpeech(snap, 'lowest', 5, parts);
    expect(s).toContain('Louisoix');
    expect(s).toContain('731');
    expect(s).toContain('最便宜');
    expect(s).not.toContain('3500'); // 不报 HQ
  });

  it('lowest-hq 报最低价 + 高品质最低价', () => {
    const s = composeSpeech(snap, 'lowest-hq', 5, parts);
    expect(s).toContain('Louisoix');
    expect(s).toContain('731');
    expect(s).toContain('Moogle');
    expect(s).toContain('3500');
    expect(s).toContain('高品质');
  });

  it('all 全报并标出最低', () => {
    const s = composeSpeech(snap, 'all', 2, parts);
    expect(s).toContain('1.');
    expect(s).toContain('2.');
    expect(s).toContain('还有 1 条');
  });

  it('无挂单时给出提示', () => {
    const s = composeSpeech({ ...snap, listings: [] }, 'lowest', 5, parts);
    expect(s).toContain('没有挂单');
  });
});
