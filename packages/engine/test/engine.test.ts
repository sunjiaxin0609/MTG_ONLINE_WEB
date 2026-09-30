import { describe, it, expect } from 'vitest';
import { GameEngine, TURN_ORDER, TurnManager, TurnStep } from '../src/index.js';

function makeEngine() {
  return new GameEngine({
    players: [
      { id: 'p1', name: '人类玩家', isComputed: false },
      { id: 'p2', name: '电脑 AI', isComputed: true },
    ],
  });
}

describe('GameEngine 基础', () => {
  it('初始化至少需要两名玩家', () => {
    expect(
      () =>
        new GameEngine({
          players: [{ id: 'p1', name: 'solo', isComputed: false }],
        }),
    ).toThrow();
  });

  it('默认起始生命为 20，起始步骤为 UNTAP', () => {
    const engine = makeEngine();
    expect(engine.view.players.map((p) => p.life)).toEqual([20, 20]);
    expect(engine.view.step).toBe('UNTAP');
    expect(engine.view.turn).toBe(1);
  });
});

describe('M2 回合与阶段机', () => {
  it('TURN_ORDER 覆盖全部阶段与步骤且顺序正确', () => {
    expect(TURN_ORDER.map((s) => s.step)).toEqual([
      'UNTAP',
      'UPKEEP',
      'DRAW',
      'FIRST_MAIN',
      'BEGIN_COMBAT',
      'DECLARE_ATTACKERS',
      'DECLARE_BLOCKERS',
      'COMBAT_DAMAGE',
      'END_OF_COMBAT',
      'SECOND_MAIN',
      'END',
      'CLEANUP',
    ]);
    // 战斗五步都在 COMBAT 阶段
    const combatSteps = TURN_ORDER.filter((s) => s.phase === 'COMBAT').map((s) => s.step);
    expect(combatSteps).toEqual([
      'BEGIN_COMBAT',
      'DECLARE_ATTACKERS',
      'DECLARE_BLOCKERS',
      'COMBAT_DAMAGE',
      'END_OF_COMBAT',
    ]);
  });

  it('重置步骤与清理步骤不使用优先权', () => {
    const noPriority = TURN_ORDER.filter((s) => !s.usesPriority).map((s) => s.step);
    expect(noPriority).toEqual(['UNTAP', 'CLEANUP']);
  });

  it('advance 按 12 步顺序推进一个完整回合', () => {
    const engine = makeEngine();
    const seen: TurnStep[] = [];
    for (let i = 0; i < TURN_ORDER.length; i++) {
      seen.push(engine.currentStep);
      engine.advance();
    }
    expect(seen).toEqual(TURN_ORDER.map((s) => s.step));
  });

  it('跨越清理步骤后轮换主动玩家并进入第 2 回合', () => {
    const engine = makeEngine();
    engine.advanceToStep('CLEANUP');
    const activeBefore = engine.activePlayerId;
    engine.advance(); // 越过清理 → 新回合
    expect(engine.view.step).toBe('UNTAP');
    expect(engine.view.turn).toBe(2);
    expect(engine.activePlayerId).not.toBe(activeBefore);
  });

  it('优先权持有者默认为主动玩家，超越回合末后随主动玩家切换', () => {
    const engine = makeEngine();
    expect(engine.priorityPlayerId).toBe(engine.activePlayerId);
    engine.advanceToStep('CLEANUP');
    engine.advance();
    expect(engine.priorityPlayerId).toBe(engine.activePlayerId);
  });

  it('passPriority 把优先权传给下一玩家（在优先权步骤内）', () => {
    const engine = makeEngine();
    engine.advanceToStep('FIRST_MAIN');
    const first = engine.activePlayerId;
    expect(engine.priorityPlayerId).toBe(first);
    engine.passPriority();
    expect(engine.priorityPlayerId).not.toBe(first);
  });

  it('TurnManager 单独使用时也遵循同一顺序', () => {
    const tm = new TurnManager({ playerIds: ['a', 'b'] });
    expect(tm.turn).toBe(1);
    for (let i = 0; i < TURN_ORDER.length; i++) {
      tm.advance();
    }
    expect(tm.turn).toBe(2);
  });
});