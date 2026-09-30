/**
 * fetch-cards.ts —— M3 卡池抓取脚本。
 *
 * 说明：设计文档提到使用 Scryfall `bulk-data`（default-cards）再做标准赛过滤。
 * 但 default-cards 是整个牌池（体积数白 MB、几近百万行），本地抓取与解析开销巨大。
 * 本脚本改用 Scryfall `cards/search` 的 `f:s` 查询直接拉取「标准赛合法」的独一卡牌
 * （unique=cards 按名称去重），正好命中目标卡池，体积可控、更易测。
 *
 * 流程：
 *   1. 分页拉取 standard 合法卡；
 *   2. 每张经引擎 `parseScryfallCard` 解析为结构化 Card；
 *   3. 可执行的卡写入 SQLite（cards + abilities）；
 *   4. 输出统计摘要。
 *
 * 运行：`pnpm --filter @mtg/server fetch:cards`
 * 数据库默认写入 `apps/server/data/mtg.db`（可用环境变量 MTG_DB 覆盖）。
 */

import { parseScryfallCard, isStandardLegal } from '@mtg/engine';
import { openDatabase, closeDatabase } from '../src/data/db.js';
import { clearCards, insertCard } from '../src/data/store.js';
import { getCounts } from '../src/data/query.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SEARCH_URL = 'https://api.scryfall.com/cards/search';
const REQUEST_DELAY_MS = 120; // 尊重 Scryfall 限频（~10 rps）
const REQUEST_TIMEOUT_MS = 30_000; // 单次请求超时：避免连接静默挂起导致整轮抓取卡死
const MAX_RETRIES = 5; // 超时 / 429 的最大重试次数

function resolveDbPath(): string {
  if (process.env.MTG_DB) return process.env.MTG_DB;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/mtg.db');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, attempt = 0): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'mtg-online-dev/0.1' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (attempt >= MAX_RETRIES) {
      throw new Error(`Scryfall 请求超时/中断（已重试 ${attempt} 次）：${(err as Error).message}`);
    }
    await sleep(1000 * (attempt + 1));
    return fetchWithRetry(url, attempt + 1);
  }
  if (res.status === 429) {
    if (attempt >= MAX_RETRIES) {
      throw new Error(`Scryfall 限频，已重试 ${attempt} 次仍失败：${url}`);
    }
    const retryAfter = Number(res.headers.get('retry-after') ?? 2) * 1000;
    await sleep(retryAfter);
    return fetchWithRetry(url, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`Scryfall 请求失败 ${res.status}: ${url}`);
  }
  return res;
}

/** 分页拉取，`onCard` 每张回调一次；返回拉取总数。 */
async function fetchStandardCards(onCard: (c: unknown) => void): Promise<number> {
  let url = `${SEARCH_URL}?q=${encodeURIComponent('f:s')}&unique=cards&format=json`;
  let fetched = 0;
  let page = 0;
  while (url) {
    const json = (await (await fetchWithRetry(url)).json()) as {
      data: unknown[];
      has_more: boolean;
      next_page?: string;
      total_cards?: number;
    };
    for (const c of json.data) onCard(c);
    fetched += json.data.length;
    page += 1;
    console.log(`  第 ${page} 页：累计 ${fetched}/${json.total_cards ?? '?'} 张`);
    url = json.has_more && json.next_page ? json.next_page : '';
    if (url) await sleep(REQUEST_DELAY_MS);
  }
  return fetched;
}

async function main(): Promise<void> {
  const dbPath = resolveDbPath();
  const db = openDatabase(dbPath);
  clearCards(db);

  const byCategory = new Map<string, number>();
  let supported = 0;
  let unsupported = 0;

  const total = await fetchStandardCards((raw) => {
    const card = raw as { type_line?: string };
    const parsed = parseScryfallCard(raw as never);
    const legal = isStandardLegal(raw as never);

    if (parsed.supported && parsed.card) {
      insertCard(db, parsed.card, { legalStandard: legal });
      supported++;
    } else {
      unsupported++;
      const cat = (card.type_line?.match(/\S+/)?.[0] ?? 'other').toLowerCase();
      byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1);
    }
  });

  const counts = getCounts(db);
  const topUnsupported = [...byCategory.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log('抓取完成：');
  console.log(`  拉取标准赛卡牌       ${total}`);
  console.log(`  可执行并写入 SQLite   ${supported}`);
  console.log(`  被过滤（不支持）      ${unsupported}`);
  if (topUnsupported.length) {
    console.log('  过滤原因 Top5：' + topUnsupported.map(([k, v]) => `${k}×${v}`).join(', '));
  }
  console.log(
    `  DB 汇总              总 ${counts.total} 张（supported=${counts.supported}）`,
  );
  console.log(`  数据库文件            ${dbPath}`);

  closeDatabase(db);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});