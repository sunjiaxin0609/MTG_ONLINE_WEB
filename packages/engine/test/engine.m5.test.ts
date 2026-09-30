import { describe, it, expect } from 'vitest';
import { GameEngine, Card, ActionResult, Stack } from '../src/index.js';

// ---------- 测试用合成卡 ----------

/** 一块每次横置产 2 点白的"强化地"，便于一回合连施两咒（用于堆叠顺序测试）。 */
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

/** 对对手造成 5 点伤害的瞬间。 */
const bolt = (i: number): Card => ({
  id: `bol-${i}`,
  name: 'Holy Purge',
  manaCost: '{1}',
  typeLine: 'Instant',
  colors: ['W'],
  category: 'instant',
  abilities: [{ type: 'SPELL', effect: { kind: 'DAMAGE', amount: 5 } }],
  oracleText: '',
});

/** 回复 2 点生命的法术。 */
const heal = (i: number): Card => ({
  id: `hsl-${i}`,
  name: 'His Glory Calls',
  manaCost: '{1}',
  typeLine: 'Sorcery',
  colors: ['W'],
  category: 'sorcery',
  abilities: [{ type: 'SPELL', effect: { kind: 'LIFEGAIN', amount: 2 } }],
  oracleText: '',
});

function makeEngine(p1Top: Card[]) {
  const p1Library = [...p1Top, ...Array.from({ length: 40 }, (_, i) => dual(200 + i))];
  const p2Library = Array.from({ length: 40 }, (_, i) => dual(300 + i));
  return new GameEngine({
    players: [
      { id: 'p1', name: '人类玩家', isComputed: false },
      { id: 'p2', name: '电脑 AI', isComputed: true },
    ],
    decks: { p1: p1Library, p2: p2Library },
  });
}

/** 直接推进到首个主阶段（p1 主动且持有优先权）。 */
function toFirstMain(engine: GameEngine): void {
  engine.advanceToStep('FIRST_MAIN');
}

/** 下 1 块强化地并横置产 2 白。 */
function readyMana(engine: GameEngine): void {
  toFirstMain(engine);
  const landIdx = engine.view.players[0].hand.findIndex((c) => c.category === 'land');
  engine.playLand('p1', landIdx);
  engine.activateMana('p1', engine.view.players[0].battlefield[0].id);
}

function isOk(r: ActionResult): r is Extract<ActionResult, { ok: true }> {
  return r.ok;
}
function errMsg(r: ActionResult): string {
  return (r as { ok: false; error: string }).error;
}

// ---------- Stack 单元 ----------

describe('M5 StackSystem 单元', () => {
  it('按 LIFO 结算：后入栈的先弹出', () => {
    const stack = new Stack();
    const a = bolt(1);
    const b = heal(2);
    stack.push('p1', a);
    expect(stack.length).toBe(1);
    stack.push('p1', b);
    expect(stack.length).toBe(2);
    expect(stack.top!.card.name).toBe('His Glory Calls'); // 栈顶是后入的
    const popped = stack.popTop()!;
    expect(popped.card.name).toBe('His Glory Calls');
    expect(stack.popTop()!.card.name).toBe('Holy Purge');
    expect(stack.isEmpty).toBe(true);
    expect(stack.peekAll().length).toBe(0);
  });
});

// ---------- 优先权 ----------

describe('M5 优先权轮转', () => {
  it('未持有优先权者施放报错', () => {
    const engine = makeEngine([bolt(1), dual(1), dual(2), dual(3), dual(4), dual(5), dual(6)]);
    readyMana(engine); // p1 持有优先权
    const r = engine.castFromHand('p2', 0); // p2 无优先权
    expect(isOk(r)).toBe(false);
    expect(errMsg(r)).toContain('不持有优先权');
  });

  it('未持有优先权者让过报错', () => {
    const engine = makeEngine([bolt(1), dual(1), dual(2), dual(3), dual(4), dual(5), dual(6)]);
    readyMana(engine); // p1 持有优先权
    const r = engine.pass('p2');
    expect(isOk(r)).toBe(false);
  });

  it('施放后优先权仍留在施放者，可连续施放', () => {
    const engine = makeEngine([bolt(1), bolt(2), dual(1), dual(2), dual(3), dual(4), dual(5)]);
    readyMana(engine);
    const first = engine.priorityPlayerId;
    engine.castFromHand('p1', 0);
    expect(engine.priorityPlayerId).toBe(first); // 仍持有
    expect(engine.stackCount).toBe(1);
    engine.castFromHand('p1', 0); // 连续施放第二张
    expect(engine.stackCount).toBe(2);
  });

  it('全员让过且堆叠为空 → 推进到下一步骤', () => {
    const engine = makeEngine([bolt(1), dual(1), dual(2), dual(3), dual(4), dual(5), dual(6)]);
    toFirstMain(engine);
    expect(engine.currentStep).toBe('FIRST_MAIN');
    engine.pass('p1');
    engine.pass('p2'); // 全员让过、堆叠空
    expect(engine.currentStep).toBe('BEGIN_COMBAT');
  });
});

// ---------- 堆叠结算顺序 ----------

describe('M5 堆叠结算（LIFO）', () => {
  it('先入栈的咒语后结算', () => {
    const engine = makeEngine([bolt(1), heal(2), dual(1), dual(2), dual(3), dual(4), dual(5)]);
    readyMana(engine); // 2 白
    const boltIdx = engine.view.players[0].hand.findIndex((c) => c.category === 'instant');
    engine.castFromHand('p1', boltIdx); // 先施放：对对手打 5
    // 施放后手牌已移项，需重新定位后一张法术
    const healIdx = engine.view.players[0].hand.findIndex((c) => c.category === 'sorcery');
    engine.castFromHand('p1', healIdx); // 后施放：自己回 2
    expect(engine.stackCount).toBe(2);
    expect(engine.view.players[1].life).toBe(20); // 尚未结算

    // 第一次全员让过 → 结算栈顶 = 后入的 heal
    engine.pass('p1');
    engine.pass('p2');
    expect(engine.stackCount).toBe(1);
    expect(engine.view.players[0].life).toBe(22); // 回 2 已生效
    expect(engine.view.players[1].life).toBe(20); // 伤害还没结算
    expect(engine.priorityPlayerId).toBe('p1'); // 结算后优先权还给主动玩家

    // 第二次全员让过 → 结算 bolt
    engine.pass('p1');
    engine.pass('p2');
    expect(engine.stackCount).toBe(0);
    expect(engine.view.players[1].life).toBe(15); // 打 5 生效
    expect(engine.view.players[0].life).toBe(22);
  });

  it('全部让过且堆叠未空时才结算，结算后仍留在原步骤', () => {
    const engine = makeEngine([bolt(1), dual(1), dual(2), dual(3), dual(4), dual(5), dual(6)]);
    readyMana(engine);
    const boltIdx = engine.view.players[0].hand.findIndex((c) => c.category === 'instant');
    engine.castFromHand('p1', boltIdx);
    engine.pass('p1');
    engine.pass('p2'); // 全员让过 → 结算
    expect(engine.stackCount).toBe(0);
    expect(engine.view.players[1].life).toBe(15);
    // 结算后仍留在原步骤
    expect(engine.currentStep).toBe('FIRST_MAIN');
  });
});