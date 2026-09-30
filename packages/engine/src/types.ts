/**
 * 核心类型定义 —— 万智牌规则引擎（`@mtg/engine`）
 * M1：定义骨架所需的基础类型，后续里程碑在此基础上扩展。
 */

/** 万智牌卡牌基础类型（能力指令模型，详见设计文档第 4 节）。 */
export interface Card {
  id: string;
  name: string;
  /** 法术力费用，如 "2W"、"1G"、"RR"。null 代表没有费用（如地）。 */
  manaCost: string | null;
  typeLine: string;
  colors: string[];
  power?: number;
  toughness?: number;
  abilities: CardAbility[];
  oracleText: string;
  imageUris?: { normal: string; large: string };
}

/** 能力指令：把卡牌文字拆解为可执行的结构化技能。 */
export type CardAbility =
  | { type: 'KEYWORD'; keyword: KeywordId }
  | { type: 'ACTIVATED'; activation: unknown }
  | { type: 'TRIGGERED'; trigger: unknown; effect: unknown }
  | { type: 'STATIC'; effect: unknown };

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
 * 回合的阶段与步骤。
 * 顺序：开始→维持→抽牌→主1→开始战斗→宣告攻击者→宣告阻挡者→战斗伤害→结束战斗→主2→结束→清理。
 */
export const PHASE_SEQUENCE = [
  'BEGINNING',
  'FIRST_MAIN',
  'BEGIN_COMBAT',
  'DECLARE_ATTACKERS',
  'DECLARE_BLOCKERS',
  'COMBAT_DAMAGE',
  'END_OF_COMBAT',
  'SECOND_MAIN',
  'ENDING',
] as const;

export type Phase = (typeof PHASE_SEQUENCE)[number];

/** 单个玩家在对局中的状态。 */
export interface PlayerState {
  id: string;
  name: string;
  life: number;
  isComputed: boolean;
}

/**
 * 对局引擎的可被观察总视图（简单版，M1 仅提供基础字段）。
 * 后续里程碑会扩展出手牌、战场、堆叠等区域视图。
 */
export interface GameView {
  turn: number;
  phase: Phase;
  activePlayerId: string;
  players: PlayerState[];
}