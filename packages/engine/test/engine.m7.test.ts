import { describe, it, expect } from 'vitest';
import {
  GameEngine,
  Card,
  KeywordId,
  Permanent,
  ActionResult,
  hasLethalDamage,
  hasLost,
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

function cre(
  name: string,
  power: number,
  toughness: number,
  keywords: KeywordId[] = [],
  colors: string[] = ['W'],
): Card {
  return {
    id: `cre-${name}`,
    name,
    manaCost: '{1}',
    typeLine: 'Creature — Test',
    colors,
    category: 'creature',
    power,
    toughness,
    abilities: keywords.map((keyword) => ({ type: 'KEYWORD' as const, keyword })),
    oracleText: '',
  };
}

function perm(card: Card, over: Partial<Permanent> = {}): Permanent {
  return { id: 'perm-x', card, tapped: false, controllerId: 'p1', damageMarked: 0, sick: false, ...over };
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

function isOk(r: ActionResult): r is Extract<ActionResult, { ok: true }> {
  return r.ok;
}
function errMsg(r: ActionResult): string {
  return (r as { ok: false; error: string }).error;
}

function playerIdx(engine: GameEngine, id: string): number {
  return engine.view.players.findIndex((p) => p.id === id);
}
function battlefield(engine: GameEngine, id: string): Permanent[] {
  return engine.view.players[playerIdx(engine, id)].battlefield;
}
function graveyard(engine: GameEngine, id: string): Card[] {
  return engine.view.players[playerIdx(engine, id)].graveyard;
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
  if (!r.ok) throw new Error('施放失败：' + errMsg(r));
  letStackResolve(engine);
}

function passTurn(engine: GameEngine): void {
  engine.advanceToStep('CLEANUP');
  engine.advance();
}

/** p1 施放一张生物并推进到 p1 的第二个回合（召唤病已清除）。 */
function setupAttackerOnly(engine: GameEngine, name: string): void {
  activeCastCreature(engine, name); // p1 回合 1
  passTurn(engine); // → p2 回合
  passTurn(engine); // → p1 回合 2
}

/** 走完攻击→（不阻挡）→伤害。 */
function attackUnblocked(engine: GameEngine, name: string): void {
  engine.advanceToStep('DECLARE_ATTACKERS');
  engine.declareAttackers('p1', [findByName(engine, 'p1', name).id]);
  engine.advanceToStep('DECLARE_BLOCKERS');
  engine.declareBlockers('p2', []);
  engine.advanceToStep('COMBAT_DAMAGE'); // 进入即结算并触发状态检查
}

// ---------- 纯函数 ----------

describe('M7 状态检查纯函数', () => {
  it('hasLethalDamage：伤害 ≥ 防御力即致命', () => {
    const bear = cre('Bear', 2, 2);
    expect(hasLethalDamage(perm(bear, { damageMarked: 1 }))).toBe(false);
    expect(hasLethalDamage(perm(bear, { damageMarked: 2 }))).toBe(true);
    expect(hasLethalDamage(perm(bear, { damageMarked: 3 }))).toBe(true);
  });

  it('hasLethalDamage：死触标记下任何正伤害都致命', () => {
    const big = cre('Big', 5, 9);
    expect(hasLethalDamage(perm(big, { damageMarked: 1, deathtouchDamage: true }))).toBe(true);
  });

  it('hasLost：生命 ≤ 0 或从空牌库抽牌', () => {
    expect(hasLost({ life: 1 })).toBe(false);
    expect(hasLost({ life: 0 })).toBe(true);
    expect(hasLost({ life: -3 })).toBe(true);
    expect(hasLost({ life: 20, drewFromEmptyLibrary: true })).toBe(true);
  });
});

// ---------- 致命伤害死亡 ----------

describe('M7 致命伤害死亡', () => {
  it('双方 2/2 互斗后同归于尽，各进墓地', () => {
    const engine = makeEngine([cre('A', 2, 2)], [cre('B', 2, 2)]);
    // p1 施放 A，p2 施放 B，推进到 p1 第二回合
    activeCastCreature(engine, 'A');
    passTurn(engine);
    activeCastCreature(engine, 'B');
    passTurn(engine);

    engine.advanceToStep('DECLARE_ATTACKERS');
    engine.declareAttackers('p1', [findByName(engine, 'p1', 'A').id]);
    engine.advanceToStep('DECLARE_BLOCKERS');
    engine.declareBlockers('p2', [
      { blockerId: findByName(engine, 'p2', 'B').id, attackerId: findByName(engine, 'p1', 'A').id },
    ]);
    engine.advanceToStep('COMBAT_DAMAGE');

    expect(graveyard(engine, 'p1').some((c) => c.name === 'A')).toBe(true);
    expect(graveyard(engine, 'p2').some((c) => c.name === 'B')).toBe(true);
    expect(battlefield(engine, 'p1').length).toBe(1); // 只剩 1 块地
    expect(battlefield(engine, 'p2').length).toBe(1);
  });

  it('死触：1 点伤害即可击杀大生物', () => {
    const engine = makeEngine([cre('Assassin', 1, 1, ['DEATHTOUCH'])], [cre('Giant', 5, 5)]);
    activeCastCreature(engine, 'Assassin'); // p1 回合 1
    passTurn(engine); // → p2 回合
    activeCastCreature(engine, 'Giant'); // p2 施放阻挡者
    passTurn(engine); // → p1 回合 2

    engine.advanceToStep('DECLARE_ATTACKERS');
    engine.declareAttackers('p1', [findByName(engine, 'p1', 'Assassin').id]);
    engine.advanceToStep('DECLARE_BLOCKERS');
    engine.declareBlockers('p2', [
      { blockerId: findByName(engine, 'p2', 'Giant').id, attackerId: findByName(engine, 'p1', 'Assassin').id },
    ]);
    engine.advanceToStep('COMBAT_DAMAGE');

    expect(graveyard(engine, 'p2').some((c) => c.name === 'Giant')).toBe(true); // 死触击杀
    expect(graveyard(engine, 'p1').some((c) => c.name === 'Assassin')).toBe(true); // 1/1 被 5 点打死
  });
});

// ---------- 判负 ----------

describe('M7 胜负判定', () => {
  it('生命降到 0 判负，对手获胜', () => {
    const engine = makeEngine([cre('Colossus', 20, 20)], [cre('B', 2, 2)]);
    setupAttackerOnly(engine, 'Colossus');
    attackUnblocked(engine, 'Colossus');
    expect(engine.view.players[1].life).toBe(0);
    expect(engine.isOver).toBe(true);
    expect(engine.winnerId).toBe('p1');
  });

  it('从空牌库抽牌判负', () => {
    const engine = new GameEngine({
      players: players(),
      decks: {
        p1: [dual(1), dual(2), dual(3), dual(4), dual(5), dual(6), dual(7)], // 恰好 7 张，抽完后牌库为空
        p2: deck([cre('B', 2, 2)]),
      },
    });
    expect(engine.view.players[0].library.length).toBe(0);
    engine.advanceToStep('DRAW'); // p1 抽牌步骤：空牌库抽牌
    expect(engine.isOver).toBe(true);
    expect(engine.winnerId).toBe('p2');
  });

  it('对局结束后一切动作都被拒绝', () => {
    const engine = makeEngine([cre('Colossus', 20, 20)], [cre('B', 2, 2)]);
    setupAttackerOnly(engine, 'Colossus');
    attackUnblocked(engine, 'Colossus');
    expect(engine.isOver).toBe(true);

    const r = engine.castFromHand('p1', 0);
    expect(isOk(r)).toBe(false);
    expect(errMsg(r)).toContain('对局已结束');
    expect(engine.pass('p1')).toMatchObject({ ok: false });
  });
});