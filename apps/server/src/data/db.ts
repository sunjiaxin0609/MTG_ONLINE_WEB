/**
 * db.ts —— SQLite 数据层（M3 核心数据层）。
 *
 * 使用 Node 内置 `node:sqlite`（Node >= 22.5，本环境 Node 24），同步 API，零原生依赖。
 * 职责：
 *   - 打开数据库；默认文件 `data/mtg.db`，测试可传 `:memory:`。
 *   - 建表：cards（卡） + abilities（能力）。
 */

// node:sqlite 通过 createRequire 动态加载，避免静态 ESM 导入被工具链（vite/vitest）误解析。
// 类型仍来自 @types/node 的 `node:sqlite` 模块声明（纯类型导入，运行时被擦除）。
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const {
  DatabaseSync: DatabaseSyncCtor,
}: { DatabaseSync: new (filename: string) => DatabaseSync } = require('node:sqlite');

/**
 * 打开（并在必要时初始化）SQLite 数据库。
 * @param filename 数据库文件路径，或 `:memory:`（测试用）。
 */
export function openDatabase(filename: string): DatabaseSync {
  if (filename !== ':memory:') {
    mkdirSync(dirname(filename), { recursive: true });
  }
  const db = new DatabaseSyncCtor(filename);
  db.exec('PRAGMA journal_mode = WAL;');
  createSchema(db);
  return db;
}

/** 建表。卡表存卡牌主数据，能力表存解析后的结构化能力（JSON payload）。 */
export function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cards (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      mana_cost   TEXT,
      type_line   TEXT NOT NULL,
      colors      TEXT NOT NULL,          -- JSON 数组
      category    TEXT NOT NULL,          -- land/creature/sorcery/instant/aura
      power       INTEGER,
      toughness   INTEGER,
      oracle_text TEXT NOT NULL,
      image_normal TEXT,
      image_large  TEXT,
      supported   INTEGER NOT NULL,       -- 0/1：引擎可执行
      legal_standard INTEGER NOT NULL     -- 0/1
    );
    CREATE INDEX IF NOT EXISTS idx_cards_supported ON cards(supported);
    CREATE INDEX IF NOT EXISTS idx_cards_category ON cards(category);
    CREATE INDEX IF NOT EXISTS idx_cards_name ON cards(name);

    CREATE TABLE IF NOT EXISTS abilities (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id  TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      payload  TEXT NOT NULL,             -- JSON 序列化的 CardAbility
      UNIQUE (card_id, position)
    );
  `);
}

/** 关闭数据库。 */
export function closeDatabase(db: DatabaseSync): void {
  db.close();
}