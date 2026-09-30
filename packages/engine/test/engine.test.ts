import { describe, it, expect } from 'vitest';
import { GameEngine, PHASE_SEQUENCE } from '../src/index.js';

function makeEngine() {
  return new GameEngine({
    players: [
      { id: 'p1', name: '人类玩家', isComputed: false },
      { id: 'p2', name: '电脑 AI', isComputed: true },
    ],
  });
}

describe('GameEngine 骨架', () => {
  it('初始化至少需要两名玩家', () => {
    expect(
      () =>
        new GameEngine({
          players: [{ id: 'p1', name: 'solo', isComputed: false }],
        }),
    ).toThrow();
  });

  it('默认起始生命为 20', () => {
    const engine = makeEngine();
    expect(engine.view.players.map((p) => p.life)).toEqual([20, 20]);
  });

  it('暴露固定信息（名称/版本/阶段列表）', () => {
    const engine = makeEngine();
    expect(engine.info.name).toBe('@mtg/engine');
    expect(engine.info.phases).toEqual(PHASE_SEQUENCE);
    expect(engine.info.players).toHaveLength(2);
  });

  it('advance 按阶段顺序推进', () => {
    const engine = makeEngine();
    expect(engine.currentPhase).toBe(PHASE_SEQUENCE[0]);
    engine.advance();
    expect(engine.currentPhase).toBe(PHASE_SEQUENCE[1]);
  });

  it('跨越回合末时轮换主动玩家并增加回合数', () => {
    const engine = makeEngine();
    // 推进到最后一个阶段（ENDING）
    engine.advanceTo('ENDING');
    const activeBefore = engine.activePlayerId;
    engine.advance(); // 越过回合末 → 新回合
    expect(engine.currentPhase).toBe('BEGINNING');
    expect(engine.view.turn).toBe(2);
    expect(engine.activePlayerId).not.toBe(activeBefore);
  });
});