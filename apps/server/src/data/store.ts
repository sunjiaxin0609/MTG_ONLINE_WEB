/**
 * store.ts —— 卡牌写入层。
 * 把引擎产出的结构化 `Card`（含 abilities）持久化到 SQLite 的 cards / abilities 两表。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Card } from '@mtg/engine';

/** 清空卡与能力表（抓取前会重建，保证幂等）。 */
export function clearCards(db: DatabaseSync): void {
  db.exec('DELETE FROM abilities;');
  db.exec('DELETE FROM cards;');
}

/** 写入单张卡及其能力。把每个能力序列化为 JSON payload 存到 abilities 表按顺序排列。 */
export function insertCard(
  db: DatabaseSync,
  card: Card,
  opts: { legalStandard: boolean },
): void {
  db.exec('BEGIN;');
  try {
    db.prepare(
      `INSERT INTO cards (id, name, mana_cost, type_line, colors, category, power, toughness, oracle_text, image_normal, image_large, supported, legal_standard)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      card.id,
      card.name,
      card.manaCost,
      card.typeLine,
      JSON.stringify(card.colors),
      card.category,
      card.power ?? null,
      card.toughness ?? null,
      card.oracleText,
      card.imageUris?.normal ?? null,
      card.imageUris?.large ?? null,
      1,
      opts.legalStandard ? 1 : 0,
    );

    const stmt = db.prepare(
      'INSERT INTO abilities (card_id, position, payload) VALUES (?, ?, ?)',
    );
    card.abilities.forEach((ability, index) => {
      stmt.run(card.id, index, JSON.stringify(ability));
    });

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

/** 批量写入（建议在单个事务外调用，内部已逐张开事务；抓取场景可结合 clear + 改批）。 */
export function insertCards(
  db: DatabaseSync,
  cards: Card[],
  opts: { legalStandard: boolean },
): void {
  for (const card of cards) {
    insertCard(db, card, opts);
  }
}