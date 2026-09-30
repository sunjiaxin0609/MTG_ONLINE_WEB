/**
 * deck.ts —— 起始牌库 fixture（M4）。
 * 纯引擎内置的一副简单白色标准牌组（60 张：地 + 生物 + 法术 + 瞬间），
 * 供未显式提供牌库的引擎实例 / 本地演示使用。引擎测试亦可直接复用。
 */

import type { Card } from './types.js';

let seq = 0;

/** 制造一张基本地（横置产 {W}）。 */
function makePlains(name = `Plains`): Card {
  seq += 1;
  return {
    id: `syn-plains-${seq}`,
    name,
    manaCost: null,
    typeLine: 'Basic Land — Plains',
    colors: ['W'],
    category: 'land',
    abilities: [
      { type: 'ACTIVATED', cost: { type: 'TAP' }, effect: { kind: 'ADD_MANA', color: 'W', amount: 1 } },
    ],
    oracleText: '{T}: Add {W}.',
  };
}

/** 制造一张白色生物。 */
function makeCreature(name: string, cost: string, power: number, toughness: number, oracle?: string): Card {
  seq += 1;
  return {
    id: `syn-cre-${seq}`,
    name,
    manaCost: cost,
    typeLine: 'Creature — Soldier',
    colors: ['W'],
    category: 'creature',
    power,
    toughness,
    abilities: cost === '{1}{W}' ? [] : [{ type: 'KEYWORD', keyword: 'VIGILANCE' }],
    oracleText: oracle ?? '',
  };
}

/** 制造一张白色法术。 */
function makeSorcery(name: string, cost: string, effect: Card['abilities']): Card {
  seq += 1;
  return {
    id: `syn-sor-${seq}`,
    name,
    manaCost: cost,
    typeLine: 'Sorcery',
    colors: ['W'],
    category: 'sorcery',
    abilities: effect,
    oracleText: '',
  };
}

/** 制造一张白色瞬间。 */
function makeInstant(name: string, cost: string, effect: Card['abilities']): Card {
  seq += 1;
  return {
    id: `syn-ins-${seq}`,
    name,
    manaCost: cost,
    typeLine: 'Instant',
    colors: ['W'],
    category: 'instant',
    abilities: effect,
    oracleText: '',
  };
}

/**
 * 构建一副 60 张的起始牌组（白）：20 地 + 16 生物 + 12 法术 + 12 瞬间。
 */
export function buildStarterDeck(): Card[] {
  const deck: Card[] = [];
  for (let i = 0; i < 20; i++) deck.push(makePlains());
  for (let i = 0; i < 8; i++) deck.push(makeCreature('Squadron Soldier', '{1}{W}', 2, 2));
  for (let i = 0; i < 8; i++) deck.push(makeCreature('Temple Guard', '{2}{W}', 3, 3));
  for (let i = 0; i < 12; i++) {
    deck.push(makeSorcery('His Glory Calls', '{2}{W}', [{ type: 'SPELL', effect: { kind: 'LIFEGAIN', amount: 3 } }]));
  }
  for (let i = 0; i < 12; i++) {
    deck.push(makeInstant('Holy Purge', '{1}{W}', [{ type: 'SPELL', effect: { kind: 'DAMAGE', amount: 2 } }]));
  }
  // 洗牌（简单 shuffle，保证随机构造不同的开局）
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}