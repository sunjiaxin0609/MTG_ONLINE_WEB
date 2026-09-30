/**
 * TurnManager —— 回合与阶段机（M2 深化版）。
 *
 * 万智牌的一个回合由「阶段(Phase)」和「步骤(Step)」构成。这里用双层模型：
 *  - Phase：五大阶段 BEGINNING / FIRST_MAIN / COMBAT / SECOND_MAIN / ENDING。
 *  - Step：每个阶段内部具体的步骤（如维持、抽牌、宣告攻击者、战斗伤害、清理…）。
 *
 * 回合机负责：
 *   1. 按固定顺序推进步骤；
 *   2. 到达回合末（清理步骤）后轮换主动玩家并进入下一回合；
 *   3. 在每个需要优先权的步骤，把优先权交给主动玩家（真正的优先权轮转在 M5 实现）。
 */

export type Phase = 'BEGINNING' | 'FIRST_MAIN' | 'COMBAT' | 'SECOND_MAIN' | 'ENDING';

export type TurnStep =
  | 'UNTAP'
  | 'UPKEEP'
  | 'DRAW'
  | 'FIRST_MAIN'
  | 'BEGIN_COMBAT'
  | 'DECLARE_ATTACKERS'
  | 'DECLARE_BLOCKERS'
  | 'COMBAT_DAMAGE'
  | 'END_OF_COMBAT'
  | 'SECOND_MAIN'
  | 'END'
  | 'CLEANUP';

/** 一个步骤的定义。 */
export interface StepDef {
  step: TurnStep;
  phase: Phase;
  /** 该步骤是否创建优先权窗口（万智牌里重置步骤与清理步骤通常不在正常优先权流程内推进）。 */
  usesPriority: boolean;
}

/** 一个完整回合的顺序。 */
export const TURN_ORDER: readonly StepDef[] = [
  { step: 'UNTAP', phase: 'BEGINNING', usesPriority: false },
  { step: 'UPKEEP', phase: 'BEGINNING', usesPriority: true },
  { step: 'DRAW', phase: 'BEGINNING', usesPriority: true },
  { step: 'FIRST_MAIN', phase: 'FIRST_MAIN', usesPriority: true },
  { step: 'BEGIN_COMBAT', phase: 'COMBAT', usesPriority: true },
  { step: 'DECLARE_ATTACKERS', phase: 'COMBAT', usesPriority: true },
  { step: 'DECLARE_BLOCKERS', phase: 'COMBAT', usesPriority: true },
  { step: 'COMBAT_DAMAGE', phase: 'COMBAT', usesPriority: true },
  { step: 'END_OF_COMBAT', phase: 'COMBAT', usesPriority: true },
  { step: 'SECOND_MAIN', phase: 'SECOND_MAIN', usesPriority: true },
  { step: 'END', phase: 'ENDING', usesPriority: true },
  { step: 'CLEANUP', phase: 'ENDING', usesPriority: false },
];

/** 仅为导出用：阶段顺序列表。 */
export const PHASES: readonly Phase[] = ['BEGINNING', 'FIRST_MAIN', 'COMBAT', 'SECOND_MAIN', 'ENDING'];

export interface TurnManagerConfig {
  playerIds: string[];
}

/**
 * 回合机状态机。纯逻辑、无副作用，只维护"指针"和"轮换"。
 * 真实效果（重置/抓牌/维持触发等）由引擎在步骤切换时挂接。
 */
export class TurnManager {
  private readonly playerIds: string[];
  private _turn = 1;
  private _stepIndex = 0;
  private _activePlayerIndex = 0;
  /** 当前持有优先权的玩家 id（M2 阶段：每步骤开始时为主动玩家，M5 实现完整轮转）。 */
  private _priorityPlayerIndex = 0;

  constructor(config: TurnManagerConfig) {
    if (config.playerIds.length < 2) {
      throw new Error('万智牌至少需要两名玩家。');
    }
    this.playerIds = [...config.playerIds];
  }

  get turn(): number {
    return this._turn;
  }

  get currentStep(): TurnStep {
    return TURN_ORDER[this._stepIndex].step;
  }

  get currentPhase(): Phase {
    return TURN_ORDER[this._stepIndex].phase;
  }

  get currentStepUsesPriority(): boolean {
    return TURN_ORDER[this._stepIndex].usesPriority;
  }

  get activePlayerId(): string {
    return this.playerIds[this._activePlayerIndex];
  }

  get priorityPlayerId(): string {
    return TURN_ORDER[this._stepIndex].usesPriority
      ? this.playerIds[this._priorityPlayerIndex]
      : this.activePlayerId;
  }

  /** 设当前主动玩家为优先权持有者（进入新步骤时调用）。 */
  resetPriority(): void {
    this._priorityPlayerIndex = this._activePlayerIndex;
  }

  /** 优先权传给下一玩家（M5 完整实现前提供雏形）。 */
  passPriority(): void {
    this._priorityPlayerIndex = (this._priorityPlayerIndex + 1) % this.playerIds.length;
  }

  /** 推进一个步骤；到达回合末则轮换主动玩家并开启新回合。 */
  advance(): void {
    if (this._stepIndex >= TURN_ORDER.length - 1) {
      this._stepIndex = 0;
      this._activePlayerIndex = (this._activePlayerIndex + 1) % this.playerIds.length;
      this._turn += 1;
    } else {
      this._stepIndex += 1;
    }
    this.resetPriority();
  }

  /** 直接跳到某个步骤（测试/工具用）。 */
  advanceToStep(step: TurnStep): void {
    const idx = TURN_ORDER.findIndex((s) => s.step === step);
    if (idx < 0) {
      throw new Error(`未知步骤: ${step}`);
    }
    this._stepIndex = idx;
    this.resetPriority();
  }
}