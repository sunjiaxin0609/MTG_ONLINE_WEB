import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parseScryfallCard, ScryfallCardRaw } from '@mtg/engine';
import { openDatabase, closeDatabase } from '../src/data/db.js';
import { insertCard, clearCards } from '../src/data/store.js';
import { getCardById, getCardPool, getCounts } from '../src/data/query.js';
import { buildStandardDeck } from '../src/data/deck.js';
import type { DatabaseSync } from 'node:sqlite';
import type { Card } from '@mtg/engine';

let db: DatabaseSync;

function makeCard(raw: Partial<ScryfallCardRaw>): Card {
  const r = parseScryfallCard({
    id: raw.id ?? 'c1',
    name: raw.name ?? 'Sample',
    type_line: raw.type_line ?? 'Creature — Human',
    colors: ['W'],
    legalities: { standard: 'legal' },
    ...raw,
  });
  if (!r.supported || !r.card) throw new Error(`样本应受支持: ${r.reason}`);
  return r.card;
}

beforeAll(() => {
  db = openDatabase(':memory:');
});

afterAll(() => {
  closeDatabase(db);
});

describe('SQLite 卡池往返', () => {
  it('写入并读取一张卡：字段与 abilities 完整还原', () => {
    clearCards(db);
    const original = makeCard({
      id: 'c-plains',
      name: 'Plains',
      type_line: 'Basic Land — Plains',
      category: 'land',
      mana_cost: null,
      oracle_text: '{T}: Add {W}.',
    });
    insertCard(db, original, { legalStandard: true });

    const loaded = getCardById(db, 'c-plains');
    expect(loaded).toEqual(original);
    expect(loaded?.abilities).toEqual([{ type: 'ACTIVATED', cost: { type: 'TAP' }, effect: { kind: 'ADD_MANA', color: 'W', amount: 1 } }]);
  });

  it('卡池接口支持按类别与 supported 过滤', () => {
    clearCards(db);
    const land = makeCard({ id: 'c1', type_line: 'Basic Land — Plains', oracle_text: '{T}: Add {W}.' });
    const creature = makeCard({ id: 'c2', type_line: 'Creature — Bear', oracle_text: 'Flying', power: '2', toughness: '2' });
    insertCard(db, land, { legalStandard: true });
    insertCard(db, creature, { legalStandard: true });

    expect(getCardPool(db).length).toBe(2);
    expect(getCardPool(db, { category: 'creature' }).map((c) => c.name)).toEqual(['Sample']);
    expect(getCounts(db).total).toBe(2);
    expect(getCounts(db).supported).toBe(2);
  });

  it('clearCards 清空后可重建（幂等抓取）', () => {
    clearCards(db);
    expect(getCounts(db).total).toBe(0);
  });
});

describe('M4 起始牌组 fixture', () => {
  it('从卡池构建正好 60 张的牌组，且含地/生物/法术三类', () => {
    clearCards(db);
    insertCard(db, makeCard({ id: 'l1', type_line: 'Basic Land — Plains', oracle_text: '{T}: Add {W}.' }), { legalStandard: true });
    insertCard(db, makeCard({ id: 'c1', type_line: 'Creature — Bear', oracle_text: 'Flying', power: '2', toughness: '2' }), { legalStandard: true });
    insertCard(db, makeCard({ id: 's1', type_line: 'Sorcery', oracle_text: 'Deal 2 damage' }), { legalStandard: true });

    const deck = buildStandardDeck(db);
    expect(deck.length).toBe(60);
    expect(deck.some((c) => c.category === 'land')).toBe(true);
    expect(deck.some((c) => c.category === 'creature')).toBe(true);
    expect(deck.some((c) => c.category === 'sorcery')).toBe(true);
  });
});