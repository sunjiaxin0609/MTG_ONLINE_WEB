import { describe, it, expect } from 'vitest';
import {
  GameEngine,
  Card,
  KeywordId,
  Permanent,
  GameAction,
  decideAction,
  currentActor,
  runAi,
} from '../src/index.js';

// ---------- 测试用合成卡 ----------

const dual = (i: number): Card => ({
  id: `dual-${i}`,
  name: 'Twin Plains',
  manaCost: null,
  typeLine: 'Basic Land — Plains',
  colors: ['W'],
  category: 'land',
  abilities: [{ type: 'ACTIVATED', cost: { type: 'TAP' }, effect: { kind: 'ADD_MANA', color: 'W', amount: 2 } }],
  oracleText: '{T}: Add {W}{W}.',
});

function cre(name: string, power: number, toughness: number, keywords: KeywordId[] = []): Card {
  return {
    id: `cre-${name}`,
    name,
    manaCost: '{1}',
    typeLine: 'Creature — Test',
    colors: ['W'],
    category: 'creature',
    power,
    toughness,
    abilities: keywords.map((keyword) => ({ type: 'KEYWORD' as const, keyword })),
    oracleText: '',
  };
}

/** 地/生物交错的一副牌（开局即有地又有生物）。 */
function battleDeck(): Card[] {
  const d: Card[] = [];
  for (let i = 0; i < 20; i++) {
    d.push(dual(i));
    d.push(cre(`C${i}`, 3, 3));
  }
  return d;
}

function deck(lead: Card[]): Card[] {
  return [...lead, ...Array.from({ length: 40 }, (_, i) => dual(900 + i))];
}

function players() {
  return [
    { id: 'p1', name: '人类玩家', isComputed: false },
    { id: 'p2', name: '电脑 AI', isComputed: true },
  ];
}

function makeEngine(p1Lead: Card[], p2Lead: Card[]) {
  return new GameEngine({ players: players(), decks: { p1: deck(p1Lead), p2: deck(p2Lead) } });
}

function playerIdx(engine: GameEngine, id: string): number {
  return engine.view.players.findIndex((p) => p.id === id);
}
function battlefield(engine: GameEngine, id: string): Permanent[] {
  return engine.view.players[playerIdx(engine, id)].battlefield;
}
function findByName(engine: GameEngine, id: string, name: string): Permanent {
  const p = battlefield(engine, id).find((x) => x.card.name === name);
  if (!p) throw new Error(`${id} 战场上找不到 ${name}`);
  return p;
}

function letStackResolve(engine: GameEngine): void {
  let guard = 0;
  while (engine.stackCount > 0) {
    engine.pass(engine.priorityPlayerId);
    guard += 1;
    if (guard > 40) throw new Error('堆叠未能结算');
  }
}

/** 当前主动玩家：下 1 块地、产费、施放指定名生物并结算。 */
function activeCastCreature(engine: GameEngine, name: string): void {
  engine.advanceToStep('FIRST_MAIN');
  const pid = engine.activePlayerId;
  const idx = playerIdx(engine, pid);
  const landIdx = engine.view.players[idx].hand.findIndex((c) => c.category === 'land');
  if (landIdx >= 0) engine.playLand(pid, landIdx);
  for (const p of battlefield(engine, pid)) {
    if (p.card.category === 'land' && !p.tapped) engine.activateMana(pid, p.id);
  }
  const cIdx = engine.view.players[idx].hand.findIndex((c) => c.name === name);
  const r = engine.castFromHand(pid, cIdx);
  if (!r.ok) throw new Error('施放失败');
  letStackResolve(engine);
}

function passTurn(engine: GameEngine): void {
  engine.advanceToStep('CLEANUP');
  engine.advance();
}

/** 双方各施放一张生物，并推进到 p1 的第二个回合。 */
function setupBothCreatures(engine: GameEngine, p1Creature: string, p2Creature: string): void {
  activeCastCreature(engine, p1Creature);
  passTurn(engine);
  activeCastCreature(engine, p2Creature);
  passTurn(engine);
}

// ---------- 决策：主阶段 ----------

describe('M8 主阶段决策', () => {
  it('自己回合的主阶段优先下地', () => {
    const engine = makeEngine([dual(1), cre('A', 3, 3)], [cre('B', 3, 3)]);
    engine.advanceToStep('FIRST_MAIN');
    const action = decideAction(engine, 'p1');
    expect(action.type).toBe('PLAY_LAND');
  });

  it('下地后不足费用则横置地产费，再施放生物', () => {
    const engine = makeEngine([dual(1), cre('A', 3, 3)], [cre('B', 3, 3)]);
    engine.advanceToStep('FIRST_MAIN');
    const pid = 'p1';

    // 1) 下地
    let action = decideAction(engine, pid);
    expect(action.type).toBe('PLAY_LAND');
    expect(engine.playAction(pid, action).ok).toBe(true);

    // 2) 费用不足 → 横置地产费
    action = decideAction(engine, pid);
    expect(action.type).toBe('ACTIVATE_MANA');
    expect(engine.playAction(pid, action).ok).toBe(true);

    // 3) 费用已够 → 施放生物
    action = decideAction(engine, pid);
    expect(action.type).toBe('CAST');
    expect(engine.playAction(pid, action).ok).toBe(true);

    letStackResolve(engine);
    expect(battlefield(engine, 'p1').some((p) => p.card.name === 'A')).toBe(true);
  });
});

// ---------- 决策：攻击 / 阻挡 ----------

describe('M8 攻击与阻挡决策', () => {
  it('宣告攻击者：所有可攻击生物一起进攻', () => {
    const engine = makeEngine([cre('A', 3, 3)], [cre('B', 3, 3)]);
    activeCastCreature(engine, 'A');
    passTurn(engine);
    passTurn(engine); // → p1 第二回合，A 召唤病已清除

    engine.advanceToStep('DECLARE_ATTACKERS');
    const action = decideAction(engine, 'p1');
    expect(action.type).toBe('DECLARE_ATTACKERS');
    expect((action as Extract<GameAction, { type: 'DECLARE_ATTACKERS' }>).attackerIds).toEqual([
      findByName(engine, 'p1', 'A').id,
    ]);
  });

  it('阻挡：仅在能击杀且能存活时阻挡', () => {
    const engine = makeEngine([cre('Small', 2, 2)], [cre('Guard', 3, 5)]);
    setupBothCreatures(engine, 'Small', 'Guard');

    engine.advanceToStep('DECLARE_ATTACKERS');
    engine.declareAttackers('p1', [findByName(engine, 'p1', 'Small').id]);
    engine.advanceToStep('DECLARE_BLOCKERS');
    const action = decideAction(engine, 'p2');
    expect(action.type).toBe('DECLARE_BLOCKERS');
    const blocks = (action as Extract<GameAction, { type: 'DECLARE_BLOCKERS' }>).blocks;
    expect(blocks).toEqual([
      { blockerId: findByName(engine, 'p2', 'Guard').id, attackerId: findByName(engine, 'p1', 'Small').id },
    ]);
  });

  it('阻挡：打不过就不挡', () => {
    const engine = makeEngine([cre('Giant', 5, 5)], [cre('Weak', 2, 2)]);
    setupBothCreatures(engine, 'Giant', 'Weak');

    engine.advanceToStep('DECLARE_ATTACKERS');
    engine.declareAttackers('p1', [findByName(engine, 'p1', 'Giant').id]);
    engine.advanceToStep('DECLARE_BLOCKERS');
    const action = decideAction(engine, 'p2');
    const blocks = (action as Extract<GameAction, { type: 'DECLARE_BLOCKERS' }>).blocks;
    expect(blocks).toEqual([]);
  });
});

// ---------- 驱动 ----------

describe('M8 对局驱动', () => {
  it('AI 对 AI 能打完整局并分出胜负', () => {
    const engine = new GameEngine({
      players: players(),
      decks: { p1: battleDeck(), p2: battleDeck() },
    });
    runAi(engine, ['p1', 'p2']);
    expect(engine.isOver).toBe(true);
    expect(['p1', 'p2']).toContain(engine.winnerId);
    // 胜者生命为正、败者生命 ≤ 0
    const loser = engine.view.players.find((p) => p.id !== engine.winnerId)!;
    expect(loser.life).toBeLessThanOrEqual(0);
  });

  it('只有一个 AI 时，轮到人类会停下并交还控制权', () => {
    const engine = new GameEngine({
      players: players(),
      decks: { p1: battleDeck(), p2: battleDeck() },
    });
    engine.advanceToStep('FIRST_MAIN'); // 直接进入 p1 主阶段，让 AI 有事可做
    runAi(engine, ['p1']); // 只驱动 p1，p2 视为人类

    expect(engine.isOver).toBe(false);
    expect(currentActor(engine, new Set(['p1']))).toBeNull(); // 已轮到人类（p2）
    // p1 确实做了事（至少下了一张地）
    expect(battlefield(engine, 'p1').some((p) => p.card.category === 'land')).toBe(true);
  });
});