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

/** 单个玩家在对局中的状态。 */
export interface PlayerState {
  id: string;
  name: string;
  life: number;
  isComputed: boolean;
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