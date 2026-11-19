/**
 * 名称解析：物品名（中文或英文）→ Universalis 物品 ID。
 *
 * - 中文名走内置词表（随包 data/items.zh.json，纯本地、零 token）。
 *   精确优先；未命中时做分级模糊搜索（包含 / 前缀 / 字符相似度）。
 *   多个接近候选时让工具回执请用户确认，避免静默报错物品。
 * - 英文名走 xivapi v2 搜索（精确匹配优先，部分匹配兜底）。
 * - 纯数字直接当 ID。
 *
 * 词表惰性加载：首次用到才读盘，之后常驻内存。
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { PriceConfigSection } from '../config.ts';
import { findDataFile } from './data-file.ts';

export interface DictionaryEntry {
  /** 词表里的原始名称，用于播报复述 */
  name: string;
  id: number;
}

/** key 是 normalizeName 后的名称，value 保留原始名称用于播报。 */
export type Dictionary = Map<string, DictionaryEntry>;

export interface FuzzyHit {
  name: string;
  id: number;
  score: number;
}

export interface ResolveResult {
  id: number;
  /** 实际匹配到的名称与来源，用于播报里复述 */
  matchedName: string;
  source: 'dictionary' | 'fuzzy' | 'online' | 'id';
  /** true 时 id/matchedName 无意义：存在多个接近候选，需用户确认 */
  ambiguous?: boolean;
  candidates?: FuzzyHit[];
  query?: string;
}

const XIVAPI_SEARCH = 'https://v2.xivapi.com/api/search';
const DEFAULT_FUZZY_MIN_SCORE = 300;
const DEFAULT_FUZZY_LIMIT = 5;
/** top1 领先 top2 达到这个分差就直接采用，不再烦用户确认 */
const AMBIGUOUS_GAP = 80;
/** 字符相似度部分的满分权重；调高可让「羊角笛」召回「青色角笛」 */
const FUZZY_BASE = 500;

/** 归一化：NFKC + 小写 + 去空白/标点/符号，保留中英文与数字。 */
export function normalizeName(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/** 最长公共子序列长度（一维 DP，中文短名足够快）。 */
function lcsLength(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  let prev = new Uint16Array(b.length + 1);
  let cur = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = 0;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[b.length];
}

/** 给一对「已归一化」的名称打分；返回 0 表示不像，999 为最高模糊分（1000 留给精确）。 */
function scorePair(nq: string, nk: string, qGrams: Set<string>): number {
  if (!nq || !nk) return 0;
  if (nq === nk) return 1000;

  let score = 0;
  if (nq.length >= 2 && nk.startsWith(nq)) {
    // 前缀命中：输入是词条开头，如「高等以太」→「高等以太药」
    score = 600 + Math.round((nq.length / nk.length) * 120);
  } else if (nq.length >= 2 && nk.includes(nq)) {
    // 词表项包含输入：如「角笛」→「青色角笛」
    score = 500 + Math.round((nq.length / nk.length) * 180) - Math.max(0, nk.length - nq.length) * 4;
  } else if (nk.length >= 2 && nq.includes(nk)) {
    // 输入包含词表项：如「给我查青色角笛」→「青色角笛」
    score = 450 + Math.round((nk.length / nq.length) * 140) - Math.max(0, nq.length - nk.length) * 2;
  }

  // 字符级相似度：LCS + 二元组覆盖，专治「羊角笛」→「青色角笛」这类错名/漏字
  const lcs = lcsLength(nq, nk);
  const sim = (2 * lcs) / (nq.length + nk.length);
  const kBigrams = bigrams(nk);
  let coverage: number;
  if (qGrams.size === 0) {
    coverage = nk.includes(nq) ? 1 : 0;
  } else {
    let covered = 0;
    for (const g of qGrams) if (kBigrams.has(g)) covered++;
    coverage = covered / qGrams.size;
  }
  const fuzzyBase = Math.round(FUZZY_BASE * (sim * 0.65 + coverage * 0.35));
  if (fuzzyBase > score) score = fuzzyBase;

  if (commonPrefixLen(nq, nk) >= 2) score += 40;
  // 中文物品名常把核心名词放末尾（青色角笛 / 高等以太药），词尾两字相同是强信号。
  // 权重给足，才能让「羊角笛」压过「羚羊角 / 牡羊角 / 山羊角」直接命中「青色角笛」。
  if (commonSuffixLen(nq, nk) >= 2) score += 160;

  // 只撞上一个字不算命中（例如「角」撞上一堆含「角」的物品）
  if (score < 150) return 0;
  return Math.min(score, 999);
}

/**
 * 纯函数：在给定词表里按模糊分排序取候选。
 * 导出便于单测，也便于以后别的 World 复用。
 */
export function rankDictionaryMatches(
  dict: Dictionary,
  query: string,
  minScore = DEFAULT_FUZZY_MIN_SCORE,
  limit = DEFAULT_FUZZY_LIMIT,
): FuzzyHit[] {
  const nq = normalizeName(query);
  if (!nq) return [];
  const qGrams = bigrams(nq);
  const hits: FuzzyHit[] = [];
  for (const [nk, entry] of dict) {
    const score = scorePair(nq, nk, qGrams);
    if (score >= minScore) hits.push({ name: entry.name, id: entry.id, score });
  }
  hits.sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name, 'zh-CN'));
  return hits.slice(0, limit);
}

export class NameResolver {
  private dictionary: Dictionary | null = null;
  private loading: Promise<Dictionary> | null = null;

  constructor(
    private readonly cfg: PriceConfigSection,
    private readonly packageDir: string,
    private readonly fetchJson: (url: string, timeoutMs: number) => Promise<unknown>,
  ) {}

  private dictPath(): string | null {
    const rel = this.cfg.dictionaryPath?.trim() || 'data/items.zh.json';
    // 自定义绝对路径直接用（用户显式指定，优先级最高）
    if (isAbsolute(rel)) return rel;
    // 从扩展源码位置逐级向上找 data/<name>。不要用 packageDir/ctx.packageDir：
    // Coo 运行时它指向 cormini bot 包目录，不是本扩展目录，会拼出错误路径。
    const name = rel.replace(/^\.\//, '').replace(/^data\//, '');
    return findDataFile(name);
  }

  private async dictionaryMap(): Promise<Dictionary> {
    if (this.dictionary) return this.dictionary;
    if (!this.loading) {
      const path = this.dictPath();
      if (!path) {
        console.error('[ff14-price] 中文词表定位失败：在扩展包 data/ 下找不到 items.zh.json');
        return Promise.resolve(new Map<string, DictionaryEntry>());
      }
      this.loading = readFile(path, 'utf8').then((text) => {
        const obj = JSON.parse(text.replace(/^\uFEFF/, '')) as Record<string, number>;
        const map: Dictionary = new Map<string, DictionaryEntry>();
        for (const [name, id] of Object.entries(obj)) {
          if (typeof id !== 'number' || !Number.isFinite(id)) continue;
          const display = name.trim();
          if (!display) continue;
          const key = normalizeName(display);
          if (!key || map.has(key)) continue; // 同名归一化冲突保留首次
          map.set(key, { name: display, id });
        }
        this.dictionary = map;
        console.log(`[ff14-price] 中文词表已加载：${map.size} 条（${path}）`);
        return map;
      }).catch((err) => {
        // 加载失败要能被看见：否则中文名会静默"空手回来"，无从排查。
        console.error(`[ff14-price] 中文词表加载失败（${path}）：${err instanceof Error ? err.message : String(err)}`);
        this.loading = null; // 允许下次重试，不永久缓存失败
        return new Map<string, DictionaryEntry>();
      });
    }
    return this.loading;
  }

  /** 重新加载词表（改了词典文件后可手动触发，无需重启 World 实例的结构）。 */
  reload(): void {
    this.dictionary = null;
    this.loading = null;
  }

  async resolve(raw: string): Promise<ResolveResult | null> {
    const name = raw.trim();
    if (!name) return null;

    // 1) 纯数字直接当 ID
    if (/^\d{1,9}$/.test(name)) {
      return { id: Number(name), matchedName: name, source: 'id' };
    }

    const strategy = this.cfg.nameStrategy || 'local-first';
    const isCjk = /[\u3400-\u9fff]/.test(name);

    // 中文名在线搜索不可靠，强制走词表（含模糊搜索）
    if (isCjk && strategy !== 'online-first') {
      return this.localLookup(name);
    }

    if (strategy === 'online-first' || !isCjk) {
      const online = await this.onlineLookup(name);
      if (online) return online;
      if (strategy === 'local-only') return null;
      return this.localLookup(name);
    }

    // local-first（英文或未知）：先词表后在线
    const local = await this.localLookup(name);
    if (local) return local;
    return this.onlineLookup(name);
  }

  private async localLookup(name: string): Promise<ResolveResult | null> {
    try {
      const dict = await this.dictionaryMap();

      // 精确命中（归一化后比较，容忍空格/标点差异）
      const exact = dict.get(normalizeName(name));
      if (exact) return { id: exact.id, matchedName: exact.name, source: 'dictionary' };

      if (this.cfg.fuzzyMatch === false) return null;
      const configuredMin = this.cfg.fuzzyMinScore;
      const minScore = typeof configuredMin === 'number' && Number.isFinite(configuredMin)
        ? Math.max(100, Math.min(900, configuredMin))
        : DEFAULT_FUZZY_MIN_SCORE;
      const hits = rankDictionaryMatches(dict, name, minScore, DEFAULT_FUZZY_LIMIT);
      if (!hits.length) return null;

      // 唯一命中，或第一名明显领先：直接用，避免每次都追问用户
      if (hits.length === 1 || hits[0].score - hits[1].score >= AMBIGUOUS_GAP) {
        return { id: hits[0].id, matchedName: hits[0].name, source: 'fuzzy' };
      }
      return { id: 0, matchedName: '', source: 'fuzzy', ambiguous: true, candidates: hits, query: name };
    } catch {
      return null;
    }
  }

  private async onlineLookup(name: string): Promise<ResolveResult | null> {
    // xivapi v2 查询语法：Name="精确" 优先，Name~"部分" 兜底；sheets=Item，language=en
    for (const query of [`Name="${escapeQuery(name)}"`, `Name~"${escapeQuery(name)}"`]) {
      try {
        const u = new URL(XIVAPI_SEARCH);
        u.searchParams.set('query', query);
        u.searchParams.set('sheets', 'Item');
        u.searchParams.set('fields', 'Name');
        u.searchParams.set('language', 'en');
        u.searchParams.set('limit', '5');
        const json = await this.fetchJson(u.toString(), this.cfg.timeoutMs) as {
          results?: Array<{ row_id: number; fields?: { Name?: string }; score?: number }>;
        };
        const results = json.results || [];
        if (!results.length) continue;
        // 优先取精确命中（score 最高或 Name 完全等于输入）
        const exact = results.find((r) => r.fields?.Name?.toLowerCase() === name.toLowerCase()) || results[0];
        if (exact && exact.row_id) {
          return { id: exact.row_id, matchedName: exact.fields?.Name || name, source: 'online' };
        }
      } catch {
        // 换下一个查询写法
      }
    }
    return null;
  }
}

function escapeQuery(s: string): string {
  // xivapi 查询串里引号需转义；这里只做最小处理
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
