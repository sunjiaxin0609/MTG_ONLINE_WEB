/**
 * GameEngine —— 万智牌规则引擎的确定性状态机外壳。
 *
 * M2：接入 TurnManager，暴露阶段+步骤+优先权视图。
 * 后续里程碑将在此之上接入堆叠、优先权轮转、法术力、战斗、状态检查等子系统。
 */

import { TurnManager } from './turn.js';
import { GameView, PlayerState } from './types.js';
import { Phase, TurnStep } from './turn.js';

export interface EngineConfig {
  /** 出战玩家。通常为两个人：人类 + 电脑。 */
  players: { id: string; name: string; isComputed: boolean }[];
  /** 每人起始生命。标准赛为 20。 */
  startingLife?: number;
}

/** 引擎在构造时产生的固定信息（不含可变状态）。 */
export interface EngineInfo {
  name: string;
  version: string;
  players: { id: string; name: string }[];
  phases: readonly Phase[];
  steps: readonly TurnStep[];
}

export class GameEngine {
  /** 引擎包的名称与版本。 */
  static readonly NAME = '@mtg/engine';
  static readonly VERSION = '0.2.0';

  readonly config: EngineConfig;
  private readonly turnMgr: TurnManager;
  private readonly _players: PlayerState[];

  constructor(config: EngineConfig) {
    if (config.players.length < 2) {
      throw new Error('万智牌至少需要两名玩家。');
    }
    this.config = {
      startingLife: 20,
      ...config,
    };
    this._players = this.config.players.map((p) => ({
      id: p.id,
      name: p.name,
      life: this.config.startingLife!,
      isComputed: p.isComputed,
    }));
    this.turnMgr = new TurnManager({ playerIds: this._players.map((p) => p.id) });
  }

  /** 固定信息：供前端 / 服务器展示引擎身份。 */
  get info(): EngineInfo {
    return {
      name: GameEngine.NAME,
      version: GameEngine.VERSION,
      players: this._players.map(({ id, name }) => ({ id, name })),
      phases: ['BEGINNING', 'FIRST_MAIN', 'COMBAT', 'SECOND_MAIN', 'ENDING'] as const,
      steps: [
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
      ] as const,
    };
  }

  /** 当前只读可观察视图。 */
  get view(): GameView {
    return {
      turn: this.turnMgr.turn,
      phase: this.turnMgr.currentPhase,
      step: this.turnMgr.currentStep,
      activePlayerId: this.turnMgr.activePlayerId,
      priorityPlayerId: this.turnMgr.priorityPlayerId,
      players: this._players.map((p) => ({ ...p })),
    };
  }

  get currentPhase(): Phase {
    return this.turnMgr.currentPhase;
  }

  get currentStep(): TurnStep {
    return this.turnMgr.currentStep;
  }

  get activePlayerId(): string {
    return this.turnMgr.activePlayerId;
  }

  get priorityPlayerId(): string {
    return this.turnMgr.priorityPlayerId;
  }

  /** 推进一个步骤（M4+ 会在步骤内插入更多规则逻辑；此处交付回合机本身）。 */
  advance(): void {
    this.turnMgr.advance();
  }

  /** 让当前优先权持有者让过（M5 完整轮转前提供雏形）。 */
  passPriority(): void {
    this.turnMgr.passPriority();
  }

  /** 直接推进到某步骤（测试 / 工具用）。 */
  advanceToStep(step: TurnStep): void {
    this.turnMgr.advanceToStep(step);
  }
}