import { describe, it, expect } from 'vitest';
import {
  GameEngine,
  Card,
  KeywordId,
  Permanent,
  ActionResult,
  canAttack,
  canBlock,
  dealsDamageInPass,
  lethalDamage,
} from '../src/index.js';

// ---------- 测试用合成卡 ----------

/** 横置产 2 点白的双地，便于一回合施放一张 {1} 生物。 */
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

/** 造一副牌：把指定卡放最前，其余用双地填充（保证开局 7 张手牌够用）。 */
function deck(lead: Card[]): Card[] {
  return [...lead, ...Array.from({ length: 40 }, (_, i) => dual(900 + i))];
}

function makeEngine(p1Lead: Card[], p2Lead: Card[]) {
  return new GameEngine({
    players: [
      { id: 'p1', name: '人类玩家', isComputed: false },
      { id: 'p2', name: '电脑 AI', isComputed: true },
    ],
    decks: { p1: deck(p1Lead), p2: deck(p2Lead) },
  });
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
function findByName(engine: GameEngine, id: string, name: string): Permanent {
  const p = battlefield(engine, id).find((x) => x.card.name === name);
  if (!p) throw new Error(`${id} 战场上找不到 ${name}`);
  return p;
}

/** 让双方轮流让过直到堆叠清空。 */
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
  if (!r.ok) throw new Error('施放失败：' + errMsg(r));
  letStackResolve(engine);
}

/** 结束当前回合，交给对手。 */
function passTurn(engine: GameEngine): void {
  engine.advanceToStep('CLEANUP');
  engine.advance();
}

/**
 * 双方各施放一张生物，并推进到 p1 的第二个回合（p1 生物召唤病已清除）。
 * 返回时处于 p1 回合的 UNTAP 之后。
 */
function setupBothCreatures(engine: GameEngine, p1Creature: string, p2Creature: string): void {
  activeCastCreature(engine, p1Creature); // p1 回合 1
  passTurn(engine); // → p2 回合
  activeCastCreature(engine, p2Creature); // p2 施放阻挡者
  passTurn(engine); // → p1 回合 2
}

// ---------- 纯函数：伤害步骤与关键字 ----------

describe('M6 combat 纯函数', () => {
  const plain = perm(cre('Plain', 2, 2));
  const firstStrike = perm(cre('FS', 2, 2, ['FIRST_STRIKE']));
  const doubleStrike = perm(cre('DS', 2, 2, ['DOUBLE_STRIKE']));

  it('先攻 / 连击 的伤害步骤判定', () => {
    expect(dealsDamageInPass(plain, 'FIRST_STRIKE')).toBe(false);
    expect(dealsDamageInPass(plain, 'REGULAR')).toBe(true);
    expect(dealsDamageInPass(firstStrike, 'FIRST_STRIKE')).toBe(true);
    expect(dealsDamageInPass(firstStrike, 'REGULAR')).toBe(false);
    expect(dealsDamageInPass(doubleStrike, 'FIRST_STRIKE')).toBe(true);
    expect(dealsDamageInPass(doubleStrike, 'REGULAR')).toBe(true); // 连击两次
  });

  it('canAttack：守军 / 横置 / 召唤病 不能攻击，敏捷可无视召唤病', () => {
    expect(canAttack(perm(cre('A', 2, 2)))).toBe(true);
    expect(canAttack(perm(cre('D', 2, 2, ['DEFENDER'])))).toBe(false);
    expect(canAttack(perm(cre('T', 2, 2), { tapped: true }))).toBe(false);
    expect(canAttack(perm(cre('S', 2, 2), { sick: true }))).toBe(false);
    expect(canAttack(perm(cre('H', 2, 2, ['HASTE']), { sick: true }))).toBe(true);
  });

  it('canBlock：飞行只能被飞行或延势阻挡', () => {
    const flyer = perm(cre('Flyer', 2, 2, ['FLYING']));
    expect(canBlock(perm(cre('Ground', 2, 2)), flyer)).toBe(false);
    expect(canBlock(perm(cre('Flyer2', 2, 2, ['FLYING'])), flyer)).toBe(true);
    expect(canBlock(perm(cre('Reach', 2, 2, ['REACH'])), flyer)).toBe(true);
  });

  it('canBlock：威吓须与攻击者共享颜色', () => {
    const intimidator = perm(cre('Intim', 2, 2, ['INTIMIDATE'], ['W']));
    expect(canBlock(perm(cre('Blue', 2, 2, [], ['U'])), intimidator)).toBe(false);
    expect(canBlock(perm(cre('White', 2, 2, [], ['W'])), intimidator)).toBe(true);
  });

  it('lethalDamage：死触视为 1，否则补足剩余防御力', () => {
    const blocker = perm(cre('B', 1, 3), { damageMarked: 1 });
    expect(lethalDamage(perm(cre('A', 2, 2)), blocker)).toBe(2); // 3 - 1
    expect(lethalDamage(perm(cre('DT', 1, 1, ['DEATHTOUCH'])), blocker)).toBe(1);
  });
});

// ---------- 宣告合法性 ----------

describe('M6 宣告攻击 / 阻挡合法性', () => {
  it('非主动玩家不能宣告攻击者', () => {
    const engine = makeEngine([cre('A', 2, 2)], [cre('B', 2, 2)]);
    setupBothCreatures(engine, 'A', 'B');
    engine.advanceToStep('DECLARE_ATTACKERS');
    const r = engine.declareAttackers('p2', []);
    expect(isOk(r)).toBe(false);
    expect(errMsg(r)).toContain('主动玩家');
  });

  it('召唤病生物不能攻击（本回合刚施放）', () => {
    const engine = makeEngine([cre('A', 2, 2)], [cre('B', 2, 2)]);
    activeCastCreature(engine, 'A'); // p1 回合 1 施放
    engine.advanceToStep('DECLARE_ATTACKERS'); // 同回合尝试攻击
    const a = findByName(engine, 'p1', 'A');
    const r = engine.declareAttackers('p1', [a.id]);
    expect(isOk(r)).toBe(false);
    expect(errMsg(r)).toContain('召唤病');
  });

  it('飞行攻击者不能被无飞行/延势生物阻挡', () => {
    const engine = makeEngine([cre('Flyer', 2, 2, ['FLYING'])], [cre('Ground', 3, 3)]);
    setupBothCreatures(engine, 'Flyer', 'Ground');
    engine.advanceToStep('DECLARE_ATTACKERS');
    engine.declareAttackers('p1', [findByName(engine, 'p1', 'Flyer').id]);
    engine.advanceToStep('DECLARE_BLOCKERS');
    const r = engine.declareBlockers('p2', [
      { blockerId: findByName(engine, 'p2', 'Ground').id, attackerId: findByName(engine, 'p1', 'Flyer').id },
    ]);
    expect(isOk(r)).toBe(false);
    expect(errMsg(r)).toContain('不能阻挡');
  });
});

// ---------- 攻击与横置 ----------

describe('M6 攻击与横置', () => {
  it('非警戒生物攻击后横置', () => {
    const engine = makeEngine([cre('A', 2, 2)], [cre('B', 2, 2)]);
    setupBothCreatures(engine, 'A', 'B');
    engine.advanceToStep('DECLARE_ATTACKERS');
    const r = engine.declareAttackers('p1', [findByName(engine, 'p1', 'A').id]);
    expect(isOk(r)).toBe(true);
    expect(findByName(engine, 'p1', 'A').tapped).toBe(true);
  });

  it('警戒生物攻击后不横置', () => {
    const engine = makeEngine([cre('Vig', 2, 2, ['VIGILANCE'])], [cre('B', 2, 2)]);
    setupBothCreatures(engine, 'Vig', 'B');
    engine.advanceToStep('DECLARE_ATTACKERS');
    engine.declareAttackers('p1', [findByName(engine, 'p1', 'Vig').id]);
    expect(findByName(engine, 'p1', 'Vig').tapped).toBe(false);
  });
});

// ---------- 伤害结算 ----------

describe('M6 战斗伤害结算', () => {
  /** 走完攻击→阻挡→伤害，返回引擎。 */
  function runCombat(
    engine: GameEngine,
    attackerName: string,
    block?: { blockerName: string },
  ): void {
    engine.advanceToStep('DECLARE_ATTACKERS');
    engine.declareAttackers('p1', [findByName(engine, 'p1', attackerName).id]);
    engine.advanceToStep('DECLARE_BLOCKERS');
    if (block) {
      engine.declareBlockers('p2', [
        {
          blockerId: findByName(engine, 'p2', block.blockerName).id,
          attackerId: findByName(engine, 'p1', attackerName).id,
        },
      ]);
    } else {
      engine.declareBlockers('p2', []);
    }
    engine.advanceToStep('COMBAT_DAMAGE'); // 进入即结算
  }

  it('未被阻挡的攻击者把伤害打给防御玩家', () => {
    const engine = makeEngine([cre('A', 3, 3)], [cre('B', 2, 2)]);
    setupBothCreatures(engine, 'A', 'B');
    runCombat(engine, 'A');
    expect(engine.view.players[1].life).toBe(17); // 20 - 3
  });

  it('被阻挡：攻防双方互相标记伤害，玩家生命不变', () => {
    const engine = makeEngine([cre('A', 2, 2)], [cre('B', 2, 2)]);
    setupBothCreatures(engine, 'A', 'B');
    runCombat(engine, 'A', { blockerName: 'B' });
    expect(findByName(engine, 'p2', 'B').damageMarked).toBe(2);
    expect(findByName(engine, 'p1', 'A').damageMarked).toBe(2);
    expect(engine.view.players[1].life).toBe(20);
  });

  it('践踏：补足致命伤害后溢出打给玩家', () => {
    const engine = makeEngine([cre('A', 4, 4, ['TRAMPLE'])], [cre('B', 2, 2)]);
    setupBothCreatures(engine, 'A', 'B');
    runCombat(engine, 'A', { blockerName: 'B' });
    expect(findByName(engine, 'p2', 'B').damageMarked).toBe(2); // 致命 2
    expect(engine.view.players[1].life).toBe(18); // 溢出 2
  });

  it('先攻：先攻生物与普通阻挡者只在各自步骤造成一次伤害', () => {
    const engine = makeEngine([cre('FS', 2, 2, ['FIRST_STRIKE'])], [cre('B', 1, 1)]);
    setupBothCreatures(engine, 'FS', 'B');
    runCombat(engine, 'FS', { blockerName: 'B' });
    expect(findByName(engine, 'p2', 'B').damageMarked).toBe(2); // 先攻步骤打 2
    expect(findByName(engine, 'p1', 'FS').damageMarked).toBe(1); // 普通步骤被挡者打 1
  });

  it('连击：两个伤害步骤各造成一次伤害', () => {
    const engine = makeEngine([cre('DS', 2, 2, ['DOUBLE_STRIKE'])], [cre('B', 3, 3)]);
    setupBothCreatures(engine, 'DS', 'B');
    runCombat(engine, 'DS', { blockerName: 'B' });
    expect(findByName(engine, 'p2', 'B').damageMarked).toBe(4); // 2 + 2
    expect(findByName(engine, 'p1', 'DS').damageMarked).toBe(3);
  });
});