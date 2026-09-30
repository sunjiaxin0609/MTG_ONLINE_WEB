/**
 * deck.ts —— 从真实卡池（SQLite）构建一副起始牌组（M4 fixture）。
 *
 * M4 阶段未接入对战会话（M9），本函数作为「起始牌库」的提供来源：
 * 从 getCardPool 挑地/生物/法术拼一副 60 张的简单标准牌组，供本地演示与引擎测试使用。
 * 数量不足时按类别循环补齐（保证恰好 60 张）。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Card, CardCategory } from '@mtg/engine';
import { getCardPool } from './query.js';

const LANDS = 20;
const CREATURES = 16;
const SPELLS = 24; // 法术 + 瞬间 + 基础灵气
const TOTAL = 60;

/** 把若干张牌扩到 n 张（不足则循环复用，且交错分布避免同一张集中）。 */
function fillTo(deck: Card[], pool: Card[], n: number): void {
  if (pool.length === 0) return;
  let i = 0;
  while (deck.length < n && deck.length < TOTAL) {
    deck.push(pool[i % pool.length]);
    i += 1;
  }
}

/**
 * 从卡池构建一副 60 张起始牌组。
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
  return deck;
}