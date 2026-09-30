/**
 * deck.ts —— 从真实卡池（SQLite）构建一副起始牌组。
 *
 * 从 getCardPool 挑地/生物/法术拼一副 60 张的简单标准牌组，供对局使用。
 * 数量不足时按类别循环补齐（保证恰好 60 张）；最后洗牌，
 * 否则牌库会呈现「先 20 张地、再 16 张生物、再 24 张法术」的分组顺序，
 * 导致起手与前期抽牌全是地。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Card, CardCategory } from '@mtg/engine';
import { getCardPool } from './query.js';

const LANDS = 20;
const CREATURES = 16;
const SPELLS = 24; // 法术 + 瞬间 + 基础灵气
const TOTAL = 60;

/** 把牌堆按类别循环扩到 n 张（不足则复用池中卡牌）。 */
function fillTo(deck: Card[], pool: Card[], n: number): void {
  if (pool.length === 0) return;
  let i = 0;
  while (deck.length < n && deck.length < TOTAL) {
    deck.push(pool[i % pool.length]);
    i += 1;
  }
}

/** Fisher–Yates 洗牌（原地）。 */
function shuffle(cards: Card[]): void {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
}

/**
 * 从卡池构建一副 60 张、已洗牌的起始牌组。
 * 构成：20 地 + 16 生物 + 24 法术/瞬间/灵气。
 */
export function buildStandardDeck(db: DatabaseSync): Card[] {
  const lands = getCardPool(db, { supportedOnly: true, category: 'land' });
  const creatures = getCardPool(db, { supportedOnly: true, category: 'creature' });
  const spells: Card[] = [];
  for (const cat of ['sorcery', 'instant', 'aura'] as CardCategory[]) {
    spells.push(...getCardPool(db, { supportedOnly: true, category: cat }));
  }

  const deck: Card[] = [];
  fillTo(deck, lands, LANDS);
  fillTo(deck, creatures, LANDS + CREATURES);
  fillTo(deck, spells, TOTAL);
  shuffle(deck);
  return deck;
}