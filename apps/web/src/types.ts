/**
 * 前端对局类型（M10）。
 * 与服务端 WebSocket 协议一致：`view` 已脱敏（对手手牌 / 双方牌库只有数量）。
 */

export type ManaSymbol = 'W' | 'U' | 'B' | 'R' | 'G' | 'C';
export type CardCategory = 'land' | 'creature' | 'sorcery' | 'instant' | 'aura';

export interface ClientCard {
  id: string;
  name: string;
  manaCost: string | null;
  typeLine: string;
  colors: string[];
  category: CardCategory;
  power?: number;
  toughness?: number;
  oracleText: string;
  imageUris?: { normal: string; large: string };
  /** 结构化能力（用于判断地是否产费）。 */
  abilities: Array<{ type: string; effect?: { kind: string; color?: ManaSymbol; amount?: number } }>;
}

export interface ClientPermanent {
  id: string;
  card: ClientCard;
  tapped: boolean;
  controllerId: string;
  damageMarked?: number;
  sick?: boolean;
}

export interface ClientPlayer {
  id: string;
  name: string;
  life: number;
  isComputed: boolean;
  landsPlayedThisTurn: number;
  /** 牌库内容不下发，仅数量。 */
  library: ClientCard[];
  libraryCount: number;
  hand: ClientCard[];
  handCount: number;
  battlefield: ClientPermanent[];
  graveyard: ClientCard[];
  manaPool: Record<ManaSymbol, number>;
}

export interface ClientView {
  turn: number;
  phase: string;
  step: string;
  activePlayerId: string;
  priorityPlayerId: string;
  players: ClientPlayer[];
  isOver: boolean;
  winnerId: string | null;
}

export interface CombatState {
  attackers: string[];
  blocks: { blockerId: string; attackerId: string }[];
}

/** 堆叠上的一个物件。 */
export interface StackItemLite {
  id: string;
  kind: string;
  controllerId: string;
  card: ClientCard;
}

export interface GameEvent {
  seq: number;
  by: string;
  type: string;
  message: string;
}

/** 统一的玩家动作（与服务端 `GameAction` 对应）。 */
export type GameAction =
  | { type: 'PASS' }
  | { type: 'PLAY_LAND'; handIndex: number }
  | { type: 'ACTIVATE_MANA'; permanentId: string }
  | { type: 'CAST'; handIndex: number }
  | { type: 'DECLARE_ATTACKERS'; attackerIds: string[] }
  | { type: 'DECLARE_BLOCKERS'; blocks: { blockerId: string; attackerId: string }[] };

export interface GameStartMessage {
  type: 'game_start';
  you: string;
  view: ClientView;
  events: GameEvent[];
  attackersDeclared: boolean;
  blockersDeclared: boolean;
  combat: CombatState;
  stack: StackItemLite[];
}

export interface GameEventMessage {
  type: 'game_event';
  view: ClientView;
  events: GameEvent[];
  attackersDeclared: boolean;
  blockersDeclared: boolean;
  combat: CombatState;
  stack: StackItemLite[];
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type ServerMessage = GameStartMessage | GameEventMessage | ErrorMessage;

/** 需要优先权窗口的步骤（其余步骤不能施放 / 下地）。 */
export const PRIORITY_STEPS = [
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
] as const;

export const STEP_LABELS: Record<string, string> = {
  UNTAP: '重置',
  UPKEEP: '维持',
  DRAW: '抽牌',
  FIRST_MAIN: '主阶段一',
  BEGIN_COMBAT: '开始战斗',
  DECLARE_ATTACKERS: '宣告攻击者',
  DECLARE_BLOCKERS: '宣告阻挡者',
  COMBAT_DAMAGE: '战斗伤害',
  END_OF_COMBAT: '结束战斗',
  SECOND_MAIN: '主阶段二',
  END: '结束',
  CLEANUP: '清理',
};

/** 一个回合的步骤顺序（用于中栏阶段指示器）。 */
export const STEP_ORDER = [
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
] as const;

export const PHASE_OF_STEP: Record<string, string> = {
  UNTAP: 'BEGINNING',
  UPKEEP: 'BEGINNING',
  DRAW: 'BEGINNING',
  FIRST_MAIN: 'FIRST_MAIN',
  BEGIN_COMBAT: 'COMBAT',
  DECLARE_ATTACKERS: 'COMBAT',
  DECLARE_BLOCKERS: 'COMBAT',
  COMBAT_DAMAGE: 'COMBAT',
  END_OF_COMBAT: 'COMBAT',
  SECOND_MAIN: 'SECOND_MAIN',
  END: 'ENDING',
  CLEANUP: 'ENDING',
};

export const PHASE_LABELS: Record<string, string> = {
  BEGINNING: '开始阶段',
  FIRST_MAIN: '主阶段一',
  COMBAT: '战斗阶段',
  SECOND_MAIN: '主阶段二',
  ENDING: '结束阶段',
};

export const MANA_LABELS: Record<ManaSymbol, string> = {
  W: '白',
  U: '蓝',
  B: '黑',
  R: '红',
  G: '绿',
  C: '无',
};
