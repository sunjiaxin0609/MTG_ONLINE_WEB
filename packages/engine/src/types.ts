/**
 * 核心类型定义 —— 万智牌规则引擎（`@mtg/engine`）
 * M2：回合从粗粒度 Phase 深化为「阶段 + 步骤」双层结构，并提供优先权地基。
 */

/** 万智牌卡牌基础类型（能力指令模型，详见设计文档第 4 节）。 */
export interface Card {
  id: string;
  name: string;
  /** 法术力费用，如 "2W"、"1G"、"RR"。null 代表没有费用（如地）。 */
  manaCost: string | null;
  typeLine: string;
  /** 卡牌颜色（W/U/B/R/G），无色的地/器物为空数组。 */
  colors: string[];
  /** 首版支持的卡牌大类别。 */
  category: CardCategory;
  power?: number;
  toughness?: number;
  abilities: CardAbility[];
  oracleText: string;
  imageUris?: { normal: string; large: string };
}

/** 首版支持的大类别：地 / 生物 / 法术 / 瞬间 / 基础灵气。 */
export type CardCategory = 'land' | 'creature' | 'sorcery' | 'instant' | 'aura';

/**
 * 能力指令：把卡牌文字拆解为可执行的结构化技能（M3 深化）。
 * 每条 Oracle 文本行都映射成一种结构化能力；解析不出的行记为 UNKNOWN，
 * 拥有 UNKNOWN 能力的卡在卡池构建阶段被过滤（supported=false）。
 */

/** 基础法术力颜色（万智牌五色 + 无色 C）。 */
export type ManaSymbol = 'W' | 'U' | 'B' | 'R' | 'G' | 'C';

/** 五色（卡牌费用只可能用它；C 归入无色/通用费用）。 */
export type ManaColor = 'W' | 'U' | 'B' | 'R' | 'G';

/** 玩家当前的法术力池：每种颜色+无色的可用量。 */
export type ManaPool = Record<ManaSymbol, number>;

/**
 * 卡牌费用结构化拆解。
 * `generic` 为通用法术力部分（任何颜色+无色都能付）；
 * `colors` 为指定颜色要求；`total` 为总法术力值（CMC）。
 */
export interface CostBreakdown {
  generic: number;
  colors: Record<ManaColor, number>;
  total: number;
}

/** 效果指令。后续里程碑（M4+ EffectSystem）逐步充实这些指令的语义。 */
export type AbilityEffect =
  | { kind: 'ADD_MANA'; color: ManaSymbol; amount: number }
  | { kind: 'POWER_TOUGHNESS'; powerMod: number; toughnessMod: number; duration: 'ENDOF_TURN' | 'PERMANENT' }
  | { kind: 'DAMAGE'; amount: number }
  | { kind: 'LIFEGAIN'; amount: number }
  | { kind: 'DRAW'; amount: number }
  | { kind: 'DESTROY'; what: string }
  | { kind: 'AURA'; target: string }
  | { kind: 'UNKNOWN'; text: string };

/** 启动式异能费用。 */
export type ActivatedCost =
  | { type: 'TAP' }
  | { type: 'MANA'; cost: string };

/** 触发式异能的触发时机。 */
export type TriggerInfo =
  | { kind: 'ETB' }
  | { kind: 'UPKEEP' }
  | { kind: 'END_STEP' }
  | { kind: 'UNKNOWN'; text: string };

export type CardAbility =
  | { type: 'KEYWORD'; keyword: KeywordId }
  | { type: 'ACTIVATED'; cost: ActivatedCost | null; effect: AbilityEffect }
  | { type: 'TRIGGERED'; trigger: TriggerInfo; effect: AbilityEffect }
  | { type: 'SPELL'; effect: AbilityEffect }
  | { type: 'STATIC'; effect: AbilityEffect };

/** 首版支持的关键字（M6 战斗系统逐步接入）。 */
export const KEYWORDS = [
  'FLYING',
  'TRAMPLE',
  'DOUBLE_STRIKE',
  'VIGILANCE',
  'FIRST_STRIKE',
  'INTIMIDATE',
  'REACH',
  'HASTE',
  'DEFENDER',
  'DEATHTOUCH',
] as const;

export type KeywordId = (typeof KEYWORDS)[number];

/** 游戏区域。 */
export type Zone = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'stack';

/**
 * 战场上的一个永久物（地/生物/灵气等）。
 * `id` 为战场实例唯一 id（同一张牌的多个复制各有一份）；`cardRef` 表示其所属卡牌。
 */
export interface Permanent {
  /** 战场实例唯一 id（引擎内自增）。 */
  id: string;
  /** 所属卡牌（含费用、类别、能力指令）。 */
  card: Card;
  /** 是否横置（地产费后为 true；重置步骤恢复）。 */
  tapped: boolean;
  /** 操控者玩家 id。 */
  controllerId: string;
  /** M6：本回合累计受到的伤害（清理步骤清空；致命判定由 M7 状态检查处理）。 */
  damageMarked?: number;
  /**
   * M6：召唤病 —— 生物进场当回合为 true，直到其操控者的下一个重置步骤清除。
   * 具敏捷（HASTE）的生物忽略此限制。
   */
  sick?: boolean;
}

/** 单个玩家在对局中的状态（M4：扩展出牌库/手牌/战场/墓地/法术力池）。 */
export interface PlayerState {
  id: string;
  name: string;
  life: number;
  isComputed: boolean;
  /** 当前回合的本回合已下地数量（标准赛每回合 1 张，此处按已用计数）。 */
  landsPlayedThisTurn: number;
  /** 牌库（按从上到下顺序）。 */
  library: Card[];
  /** 手牌（顺序无关）。 */
  hand: Card[];
  /** 该玩家操控的战场永久物（M4 简化：战场按操控者分区，永久物带 controllerId）。 */
  battlefield: Permanent[];
  /** 墓地。 */
  graveyard: Card[];
  /** 法术力池（横置地后注入，结算/支付后扣除；结束阶段清空）。 */
  manaPool: ManaPool;
}

/**
 * 对局引擎的可观察总视图（简单版，M2 暴露阶段、步骤与优先权）。
 * 后续里程碑扩展出手牌、战场、堆叠等区域视图。
 */
export interface GameView {
  turn: number;
  phase: Phase;
  step: TurnStep;
  activePlayerId: string;
  priorityPlayerId: string;
  players: PlayerState[];
}

// 阶段与步骤类型由 turn.ts 提供
import type { Phase, TurnStep } from './turn.js';
export type { Phase, TurnStep };