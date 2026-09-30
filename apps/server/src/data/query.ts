/**
 * query.ts —— 卡池查询层（卡池构建接口）。
 * 从 SQLite 读出，重建为引擎的 `Card` 对象。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Card, CardAbility, CardCategory } from '@mtg/engine';

interface CardRow {
  id: string;
  name: string;
  mana_cost: string | null;
  type_line: string;
  colors: string;
  category: CardCategory;
  power: number | null;
  toughness: number | null;
  oracle_text: string;
  image_normal: string | null;
  image_large: string | null;
}

/** 由一行 cards + 该卡 abilities 重建完整 Card。 */
function rowToCard(db: DatabaseSync, row: CardRow): Card {
  const abilityRows = db
    .prepare('SELECT payload FROM abilities WHERE card_id = ? ORDER BY position ASC')
    .all(row.id) as { payload: string }[];
  const abilities: CardAbility[] = abilityRows.map((a) => JSON.parse(a.payload));

  const card: Card = {
    id: row.id,
    name: row.name,
    manaCost: row.mana_cost,
    typeLine: row.type_line,
    colors: JSON.parse(row.colors) as string[],
    category: row.category,
    abilities,
    oracleText: row.oracle_text,
    imageUris:
      row.image_normal || row.image_large
        ? { normal: row.image_normal ?? '', large: row.image_large ?? '' }
        : undefined,
  };
  if (row.power !== null) card.power = row.power;
  if (row.toughness !== null) card.toughness = row.toughness;
  return card;
}

const CARD_COLUMNS = `id, name, mana_cost, type_line, colors, category, power, toughness,
  oracle_text, image_normal, image_large`;

/** 按 id 取一张卡；不存在返回 null。 */
export function getCardById(db: DatabaseSync, id: string): Card | null {
  const row = db.prepare(`SELECT ${CARD_COLUMNS} FROM cards WHERE id = ?`).get(id) as CardRow | undefined;
  return row ? rowToCard(db, row) : null;
}

export interface CardPoolOptions {
  /** 只返回引擎可执行的卡（默认 true）。 */
  supportedOnly?: boolean;
  /** 限定类别：land / creature / sorcery / instant / aura。 */
  category?: CardCategory;
}

/** 卡池构建接口：按条件查询并重建 Card 列表。 */
export function getCardPool(db: DatabaseSync, opts: CardPoolOptions = {}): Card[] {
  const where: string[] = [];
  const params: string[] = [];
  if (opts.supportedOnly !== false) where.push('supported = 1');
  if (opts.category) {
    where.push('category = ?');
    params.push(opts.category);
  }
  const sql = `SELECT ${CARD_COLUMNS} FROM cards${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY name`;
  const rows = db.prepare(sql).all(...params) as unknown as CardRow[];
  return rows.map((r) => rowToCard(db, r));
}

/** 统计：总卡数 / 可执行卡数（按类别可选）。 */
export function getCounts(db: DatabaseSync, category?: CardCategory) {
  const catWhere = category ? ' AND category = ?' : '';
  const catParam: string[] = category ? [category] : [];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM cards WHERE 1${catWhere}`).get(...catParam) as unknown as {
    n: number;
  };
  const supported = db
    .prepare(`SELECT COUNT(*) AS n FROM cards WHERE supported = 1${catWhere}`)
    .get(...catParam) as unknown as { n: number };
  return { total: Number(total.n), supported: Number(supported.n) };
}