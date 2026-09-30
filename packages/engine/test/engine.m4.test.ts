import { describe, it, expect } from 'vitest';
import { GameEngine, Card, ActionResult, canPay, parseManaCost, payCost, emptyPool } from '../src/index.js';

// ---------- 测试用合成卡 ----------

const plains = (i: number): Card => ({
  id: `land-${i}`,
  name: 'Plains',
  manaCost: null,
  typeLine: 'Basic Land — Plains',
  colors: ['W'],
  category: 'land',
  abilities: [{ type: 'ACTIVATED', cost: { type: 'TAP' }, effect: { kind: 'ADD_MANA', color: 'W', amount: 1 } }],
  oracleText: '{T}: Add {W}.',
});

/** 纯白生物（费用 {W}，只需 1 点白）。 */
const soldier = (i: number): Card => ({
  id: `cre-${i}`,
  name: 'Squadron Soldier',
  manaCost: '{W}',
  typeLine: 'Creature — Soldier',
  colors: ['W'],
  category: 'creature',
  power: 2,
  toughness: 2,
  abilities: [],
  oracleText: '',
});

/** 通用费用的加血法术（费用 {1}，用任意颜色覆盖通用）。 */
const heal = (i: number): Card => ({
  id: `sor-${i}`,
  name: 'His Glory Calls',
  manaCost: '{1}',
  typeLine: 'Sorcery',
  colors: ['W'],
  category: 'sorcery',
  abilities: [{ type: 'SPELL', effect: { kind: 'LIFEGAIN', amount: 3 } }],
  oracleText: '',
});

const purge = (i: number): Card => ({
  id: `ins-${i}`,
  name: 'Holy Purge',
  manaCost: '{1}',
  typeLine: 'Instant',
  colors: ['W'],
  category: 'instant',
  abilities: [{ type: 'SPELL', effect: { kind: 'DAMAGE', amount: 2 } }],
  oracleText: '',
});

interface EngineOpts {
  p1Top?: Card[];
  p2Top?: Card[];
}
function makeEngine(opts: EngineOpts = {}) {
  const p1Library = [...(opts.p1Top ?? []), ...Array.from({ length: 40 }, (_, i) => plains(200 + i))];
  const p2Library = [...(opts.p2Top ?? []), ...Array.from({ length: 40 }, (_, i) => plains(300 + i))];
  return new GameEngine({
    players: [
      { id: 'p1', name: '人类玩家', isComputed: false },
      { id: 'p2', name: '电脑 AI', isComputed: true },
    ],
    decks: { p1: p1Library, p2: p2Library },
  });
}

/** 把 p1 推进到 FIRST_MAIN（测试辅助：直接跳到主阶段一，避免 DRAW 洗手的干扰）。 */
function toFirstMain(engine: GameEngine): void {
  engine.advanceToStep('FIRST_MAIN');
}

/** 下 1 块地并横置产 1 白（每回合只能下 1 地）。返回永久物 id。 */
function readyMana(engine: GameEngine): string {
  toFirstMain(engine);
  const landIdx = engine.view.players[0].hand.findIndex((c) => c.category === 'land');
  engine.playLand('p1', landIdx);
  const perm = engine.view.players[0].battlefield[0];
  engine.activateMana('p1', perm.id);
  return perm.id;
}

function isOk(r: ActionResult): r is Extract<ActionResult, { ok: true }> {
  return r.ok;
}
function errMsg(r: ActionResult): string {
  return (r as { ok: false; error: string }).error;
}

// ---------- ManaSystem ----------

describe('M4 ManaSystem 费用解析', () => {
  it('解析 {1}{W} → generic 1 + W 1，total 2', () => {
    const c = parseManaCost('{1}{W}')!;
    expect(c.generic).toBe(1);
    expect(c.colors.W).toBe(1);
    expect(c.total).toBe(2);
  });

  it('解析 {2}{W}{W} → generic 2 + W 2，total 4', () => {
    const c = parseManaCost('{2}{W}{W}')!;
    expect(c.generic).toBe(2);
    expect(c.colors.W).toBe(2);
    expect(c.total).toBe(4);
  });

  it('解析 RR → 无通用 + R 2', () => {
    const c = parseManaCost('{R}{R}')!;
    expect(c.generic).toBe(0);
    expect(c.colors.R).toBe(2);
    expect(c.total).toBe(2);
  });

  it('null（地）→ null', () => {
    expect(parseManaCost(null)).toBeNull();
  });
});

describe('M4 法术力池 canPay / payCost', () => {
  it('2 白可付 {1}{W}（通用用富余的 W 覆盖）', () => {
    const pool = { W: 2, U: 0, B: 0, R: 0, G: 0, C: 0 };
    const cost = parseManaCost('{1}{W}')!;
    expect(canPay(pool, cost)).toBe(true);
    payCost(pool, cost);
    expect(pool.W).toBe(0);
  });

  it('1 白不足以付 {1}{W}（通用缺 1）', () => {
    const pool = { W: 1, U: 0, B: 0, R: 0, G: 0, C: 0 };
    expect(canPay(pool, parseManaCost('{1}{W}')!)).toBe(false);
  });

  it('红法术力不能支付蓝色指定要求', () => {
    const pool = { W: 0, U: 0, B: 0, R: 2, G: 0, C: 0 };
    expect(canPay(pool, parseManaCost('{U}')!)).toBe(false);
    expect(canPay(pool, parseManaCost('{2}')!)).toBe(true); // 通用 2 红即可
  });

  it('emptyPool 返回全 0 池', () => {
    expect(emptyPool()).toEqual({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 });
  });
});

// ---------- play_land ----------

describe('M4 playLand 下地', () => {
  it('主动玩家在主阶段能下一块地，进战场并记入本回合次数', () => {
    const lib = [plains(1), soldier(1), heal(1), purge(1), plains(2), plains(3), plains(4)];
    const engine = makeEngine({ p1Top: lib });
    toFirstMain(engine);
    const r = engine.playLand('p1', 0); // 第 0 张是地
    expect(isOk(r)).toBe(true);
    const p1 = engine.view.players[0];
    expect(p1.battlefield.length).toBe(1);
    expect(p1.battlefield[0].card.category).toBe('land');
    expect(p1.landsPlayedThisTurn).toBe(1);
    expect(p1.hand.length).toBe(6);
  });

  it('同一玩家第二块地报错且不改状态', () => {
    const lib = [plains(1), plains(2), plains(3), plains(4), plains(5), plains(6), plains(7)];
    const engine = makeEngine({ p1Top: lib });
    toFirstMain(engine);
    engine.playLand('p1', 0);
    const before = engine.view.players[0].battlefield.length;
    const r = engine.playLand('p1', 0); // 下一张仍是地
    expect(isOk(r)).toBe(false);
    expect(errMsg(r)).toContain('已经下过地');
    expect(engine.view.players[0].battlefield.length).toBe(before);
  });

  it('非主阶段不能下地', () => {
    const engine = makeEngine({ p1Top: [plains(1), plains(2), plains(3), plains(4), plains(5), plains(6), plains(7)] });
    const r = engine.playLand('p1', 0); // 仍处于 UNTAP
    expect(isOk(r)).toBe(false);
    expect(engine.view.players[0].battlefield.length).toBe(0);
  });

  it('非主动玩家不能下地', () => {
    const engine = makeEngine({ p1Top: [plains(1), plains(2), plains(3), plains(4), plains(5), plains(6), plains(7)] });
    toFirstMain(engine); // p1 主动
    const r = engine.playLand('p2', 0);
    expect(isOk(r)).toBe(false);
  });

  it('不能把手牌中的生物用"下地"动作放下', () => {
    const engine = makeEngine({ p1Top: [soldier(1), plains(1), plains(2), plains(3), plains(4), plains(5), plains(6)] });
    toFirstMain(engine);
    const r = engine.playLand('p1', 0); // 第 0 张是生物
    expect(isOk(r)).toBe(false);
    expect(engine.view.players[0].battlefield.length).toBe(0);
  });
});

// ---------- activate_mana ----------

describe('M4 activateMana 产费', () => {
  it('横置地注入 1 点白法术力并横置该永久物', () => {
    const engine = makeEngine({ p1Top: [plains(1), plains(2), plains(3), plains(4), plains(5), plains(6), plains(7)] });
    const id = readyMana(engine);
    const p1 = engine.view.players[0];
    expect(p1.manaPool.W).toBe(1);
    expect(p1.battlefield.find((x) => x.id === id)!.tapped).toBe(true);
  });

  it('已横置的地再次产费报错，且池不重复入账', () => {
    const engine = makeEngine({ p1Top: [plains(1), plains(2), plains(3), plains(4), plains(5), plains(6), plains(7)] });
    const id = readyMana(engine);
    const r = engine.activateMana('p1', id);
    expect(isOk(r)).toBe(false);
    expect(errMsg(r)).toContain('已横置');
    expect(engine.view.players[0].manaPool.W).toBe(1);
  });
});

/** 让双方轮流让过，直到堆叠清空（用于断言施放结算后的状态）。 */
function letStackResolve(engine: GameEngine): void {
  let guard = 0;
  while (engine.stackCount > 0) {
    const r = engine.pass(engine.priorityPlayerId);
    if (!r.ok) throw new Error('堆叠结算失败：' + (<{ error: string }>r).error);
    guard += 1;
    if (guard > 40) throw new Error('堆叠未能结算');
  }
}

// ---------- cast ----------

describe('M4 castFromHand 施法', () => {
  it('法术力不足时施放报错且不改状态', () => {
    const engine = makeEngine({ p1Top: [soldier(1), plains(1), plains(2), plains(3), plains(4), plains(5), plains(6)] });
    toFirstMain(engine);
    // 手牌第 0 张是 soldier({W})，尚无法术力
    const before = engine.view.players[0];
    const handBefore = before.hand.length;
    const r = engine.castFromHand('p1', 0);
    expect(isOk(r)).toBe(false);
    expect(errMsg(r)).toContain('法术力不足');
    expect(engine.view.players[0].battlefield.length).toBe(0); // 未进场
    expect(engine.view.players[0].hand.length).toBe(handBefore); // 未离手
    expect(engine.stackCount).toBe(0);
  });

  it('备足费用后施放生物：咒语先入堆叠，全员让过后进场并扣费', () => {
    const engine = makeEngine({ p1Top: [soldier(1), plains(1), plains(2), plains(3), plains(4), plains(5), plains(6)] });
    readyMana(engine);
    const soldierIdx = engine.view.players[0].hand.findIndex((c) => c.category === 'creature');
    const r = engine.castFromHand('p1', soldierIdx);
    expect(isOk(r)).toBe(true);
    expect(engine.stackCount).toBe(1); // 仍在堆叠，未进场
    expect(engine.view.players[0].battlefield.filter((x) => x.card.category === 'creature').length).toBe(0);

    letStackResolve(engine); // 双方让过 → 结算栈顶
    const p1 = engine.view.players[0];
    expect(p1.battlefield.filter((x) => x.card.category === 'creature').length).toBe(1);
    expect(p1.manaPool.W).toBe(0); // 1 白用于 {W}
    expect(engine.stackCount).toBe(0);
  });

  it('备足费用后施放法术：结算 LIFEGAIN 后进墓地', () => {
    const engine = makeEngine({ p1Top: [heal(1), plains(1), plains(2), plains(3), plains(4), plains(5), plains(6)] });
    readyMana(engine);
    const lifeBefore = engine.view.players[0].life;
    const healIdx = engine.view.players[0].hand.findIndex((c) => c.category === 'sorcery');
    const r = engine.castFromHand('p1', healIdx);
    expect(isOk(r)).toBe(true);
    expect(engine.view.players[0].life).toBe(lifeBefore); // 未结算，生命没变

    letStackResolve(engine);
    const p1 = engine.view.players[0];
    expect(p1.life).toBe(lifeBefore + 3);
    expect(p1.battlefield.length).toBe(1); // 只有 1 块地，法术没进场
    expect(p1.graveyard.some((c) => c.category === 'sorcery')).toBe(true);
    expect(p1.manaPool.W).toBe(0); // {1} 用那 1 点白覆盖
  });

  it('地对 cast 直接报错，提示改用下地动作', () => {
    const engine = makeEngine({ p1Top: [soldier(1), plains(1), plains(2), plains(3), plains(4), plains(5), plains(6)] });
    readyMana(engine);
    const landIdx = engine.view.players[0].hand.findIndex((c) => c.category === 'land');
    const r = engine.castFromHand('p1', landIdx); // 地
    expect(isOk(r)).toBe(false);
    expect(errMsg(r)).toContain('请用"下地"');
  });
});

// ---------- 启动状态 & 重置 ----------

describe('M4 开局与回合钩子', () => {
  it('开局双方各抓 7 张起手，牌库剩 33 张，生命 20', () => {
    const engine = makeEngine();
    const p1 = engine.view.players[0];
    expect(p1.hand.length).toBe(7);
    expect(p1.library.length).toBe(33);
    expect(p1.life).toBe(20);
  });

  it('进入 p1 第二回合 UNTAP：重置下地计数与法术力池，地变回未横置', () => {
    const engine = makeEngine({ p1Top: [plains(1), soldier(1), plains(2), plains(3), plains(4), plains(5), plains(6)] });
    readyMana(engine); // p1 主阶段一，1 块地被横置产费
    engine.advanceToStep('CLEANUP'); // 走完 p1 回合
    engine.advance(); // p2 回合 UNTAP
    engine.advanceToStep('CLEANUP'); // 走完 p2 回合
    engine.advance(); // p1 第二回合 UNTAP
    const p = engine.view.players[0];
    expect(p.manaPool.W).toBe(0);
    expect(p.landsPlayedThisTurn).toBe(0);
    expect(p.battlefield.find((x) => x.card.category === 'land')!.tapped).toBe(false);
  });

  it('pass 在优先权持有者让过后改变优先权', () => {
    const engine = makeEngine({ p1Top: [plains(1), plains(2), plains(3), plains(4), plains(5), plains(6), plains(7)] });
    toFirstMain(engine);
    const first = engine.priorityPlayerId;
    const r = engine.pass(first);
    expect(isOk(r)).toBe(true);
    expect(engine.priorityPlayerId).not.toBe(first);
  });
});