import { describe, it, expect } from 'vitest';
import {
  NameResolver,
  normalizeName,
  rankDictionaryMatches,
  type Dictionary,
} from '../src/services/names.ts';
import { PRICE_DEFAULTS, type PriceConfigSection } from '../src/config.ts';

function makeDict(entries: Array<[string, number]>): Dictionary {
  const map: Dictionary = new Map();
  for (const [name, id] of entries) {
    const key = normalizeName(name);
    if (!map.has(key)) map.set(key, { name, id });
  }
  return map;
}

const small = makeDict([
  ['青色角笛', 47560],
  ['加拉尔号角', 11203],
  ['高等以太药', 27786],
  ['以太药', 1234],
  ['力量之药', 4567],
  ['力量药水', 8910],
]);

describe('normalizeName', () => {
  it('去空白、全角符号并统一大小写', () => {
    expect(normalizeName(' 羊角笛 ')).toBe('羊角笛');
    expect(normalizeName('Tincture　of　Strength')).toBe('tinctureofstrength');
  });
});

describe('rankDictionaryMatches', () => {
  it('精确名永远排第一', () => {
    const hits = rankDictionaryMatches(small, '以太药');
    expect(hits[0]?.name).toBe('以太药');
    expect(hits[0]?.score).toBe(1000);
  });

  it('错名/漏字也能召回相近物品：羊角笛 → 青色角笛', () => {
    const hits = rankDictionaryMatches(small, '羊角笛');
    expect(hits[0]?.name).toBe('青色角笛');
    expect(hits[0]?.score).toBeGreaterThanOrEqual(300);
    // 不相干的「加拉尔号角」不能抢到第一
    expect(hits.map((h) => h.name)).not.toContain('加拉尔号角');
  });

  it('词表项包含输入时优先命中', () => {
    expect(rankDictionaryMatches(small, '角笛')[0]?.name).toBe('青色角笛');
  });

  it('输入里带着物品名也能命中', () => {
    expect(rankDictionaryMatches(small, '给我查青色角笛')[0]?.name).toBe('青色角笛');
  });

  it('太泛的词返回多个接近候选（交给用户确认）', () => {
    const hits = rankDictionaryMatches(small, '药');
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0].score - hits[1].score).toBeLessThan(80);
  });

  it('完全不相干的名字不给候选', () => {
    expect(rankDictionaryMatches(small, '红玉海')).toEqual([]);
  });
});

describe('NameResolver 模糊解析（真实词表）', () => {
  const cfg: PriceConfigSection = {
    ...PRICE_DEFAULTS,
    enabled: true,
    dataCenter: '红玉海',
    nameStrategy: 'local-only',
  };
  const noNetwork = async (): Promise<unknown> => {
    throw new Error('中文名不应走在线查询');
  };

  it('「羊角笛」模糊命中带「角笛」的实际物品', async () => {
    const resolver = new NameResolver(cfg, '', noNetwork);
    const hit = await resolver.resolve('羊角笛');
    expect(hit).not.toBeNull();
    expect(hit!.source).toBe('fuzzy');
    expect(hit!.matchedName).toContain('角笛');
  });

  it('关掉模糊搜索后返回 null', async () => {
    const resolver = new NameResolver({ ...cfg, fuzzyMatch: false }, '', noNetwork);
    expect(await resolver.resolve('羊角笛')).toBeNull();
  });

  it('纯数字仍直接当 ID', async () => {
    const resolver = new NameResolver(cfg, '', noNetwork);
    expect(await resolver.resolve('27786')).toMatchObject({ id: 27786, source: 'id' });
  });
});
