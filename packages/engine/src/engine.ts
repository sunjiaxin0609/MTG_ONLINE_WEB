/**
 * GameEngine —— 万智牌规则引擎的确定性状态机外壳。
 *
 * M1：建立骨架（玩家集合、回合/阶段机、对局视图）。
 * 后续里程碑将在此之上接入堆叠、优先权、法术力、战斗、状态检查等子系统。
 */

import { GameView, PHASE_SEQUENCE, Phase, PlayerState } from './types.js';

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
}

export class GameEngine {
  /** 引擎包的名称与版本。 */
  static readonly NAME = '@mtg/engine';
  static readonly VERSION = '0.1.0';

  readonly config: EngineConfig;
  private _turn = 1;
  private _phaseIndex = 0;
  private _activePlayerIndex = 0;
  private _players: PlayerState[] = [];

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
  }

  /** 固定信息：供前端 / 服务器展示引擎身份。 */
  get info(): EngineInfo {
    return {
      name: GameEngine.NAME,
      version: GameEngine.VERSION,
      players: this._players.map(({ id, name }) => ({ id, name })),
      phases: PHASE_SEQUENCE,
    };
  }

  /** 当前只读可观察视图。 */
  get view(): GameView {
    return {
      turn: this._turn,
      phase: this.currentPhase,
      activePlayerId: this._players[this._activePlayerIndex].id,
      players: this._players.map((p) => ({ ...p })),
    };
  }

  get currentPhase(): Phase {
    return PHASE_SEQUENCE[this._phaseIndex];
  }

  get activePlayerId(): string {
    return this._players[this._activePlayerIndex].id;
  }

  /**
   * 推进一步（M1：推进阶段；到回合末轮换主动玩家并进入下一回合）。
   * 后续里程碑会在阶段内插入优先权交互，此方法将演化为内部步骤机。
   */
  advance(): void {
    if (this._phaseIndex >= PHASE_SEQUENCE.length - 1) {
      // 结束阶段结束 → 新回合
      this._phaseIndex = 0;
      this._activePlayerIndex = (this._activePlayerIndex + 1) % this._players.length;
      this._turn += 1;
    } else {
      this._phaseIndex += 1;
    }
  }

  /** 直接推进到某阶段（测试 / 工具用）。 */
  advanceTo(phase: Phase): void {
    const idx = PHASE_SEQUENCE.indexOf(phase);
    if (idx < 0) {
      throw new Error(`未知阶段: ${phase}`);
    }
    this._phaseIndex = idx;
  }
}