/**
 * GameEngine —— 万智牌规则引擎的确定性状态机外壳。
 *
 * M2：接入 TurnManager，暴露阶段+步骤+优先权视图。
 * M4：接入法术力系统与基本操作 —— 玩家扩展出牌库/手牌/战场/墓地/法术力池，
 *      支持 `playLand` / `activateMana` / `castFromHand` / `pass` 四类动作，
 *      并挂接步骤钩子（重置、抽牌、清空法术力池）。非法操作返回明确错误且不改状态。
 *
 * 说明：M4 的 cast 采用"立即结算"（不经堆叠），堆叠与完整优先权留到 M5 重构。
 */

import { TurnManager } from './turn.js';
import { Card, GameView, ManaSymbol, Permanent, Phase, PlayerState, TurnStep } from './types.js';
import { canPay, emptyPool, payCost, parseManaCost, addToPool } from './mana.js';

export interface EnginePlayerConfig {
  id: string;
  name: string;
  isComputed: boolean;
}

export interface EngineConfig {
  /** 出战玩家。通常为两个人：人类 + 电脑。 */
  players: EnginePlayerConfig[];
  /** 每人起始生命。标准赛为 20。 */
  startingLife?: number;
  /**
   * 起始牌库（按 playerId 提供）。缺省时引擎用内置 fixture（deck.ts 的起始牌组）。
   * 每人开局抓 7 张起手。
   */
  decks?: Record<string, Card[]>;
  /** 起手牌数，标准赛 7。 */
  handSize?: number;
}

/** 引擎在构造时产生的固定信息（不含可变状态）。 */
export interface EngineInfo {
  name: string;
  version: string;
  players: { id: string; name: string }[];
  phases: readonly Phase[];
  steps: readonly TurnStep[];
}

/** 一个动作的结果：成功 ok=true（可带提示），失败 ok=false 且带 error。 */
export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

/** 默认起始牌库（纯引擎内置，供本地 / 测试使用）。 */
import { buildStarterDeck } from './deck.js';

export class GameEngine {
  static readonly NAME = '@mtg/engine';
  static readonly VERSION = '0.3.0';

  readonly config: EngineConfig;
  private readonly turnMgr: TurnManager;
  private readonly _players: Map<string, PlayerState>;
  private readonly _playerOrder: string[];
  private _permSeq = 0;

  constructor(config: EngineConfig) {
    if (config.players.length < 2) {
      throw new Error('万智牌至少需要两名玩家。');
    }
    this.config = {
      startingLife: 20,
      handSize: 7,
      ...config,
    };

    const startingLife = this.config.startingLife!;
    this._players = new Map();
    this._playerOrder = config.players.map((p) => p.id);
    for (const p of config.players) {
      const deck = this.config.decks?.[p.id] ?? buildStarterDeck();
      const library = [...deck];
      const player: PlayerState = {
        id: p.id,
        name: p.name,
        life: startingLife,
        isComputed: p.isComputed,
        landsPlayedThisTurn: 0,
        library,
        hand: [],
        battlefield: [],
        graveyard: [],
        manaPool: emptyPool(),
      };
      this._players.set(p.id, player);
      // 起手抓牌
      const toDraw = Math.min(this.config.handSize!, library.length);
      player.hand = library.splice(0, toDraw);
      player.library = library;
    }

    this.turnMgr = new TurnManager({ playerIds: this._playerOrder });
  }

  /** 固定信息：供前端 / 服务器展示引擎身份。 */
  get info(): EngineInfo {
    return {
      name: GameEngine.NAME,
      version: GameEngine.VERSION,
      players: this._playerOrder.map((id) => {
        const p = this._players.get(id)!;
        return { id, name: p.name };
      }),
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
      players: this._playerOrder.map((id) => this.clonePlayer(this._players.get(id)!)),
    };
  }

  private clonePlayer(p: PlayerState): PlayerState {
    return {
      ...p,
      library: [...p.library],
      hand: [...p.hand],
      battlefield: p.battlefield.map((perm) => ({ ...perm })),
      graveyard: [...p.graveyard],
      manaPool: { ...p.manaPool },
    };
  }

  private player(id: string): PlayerState | undefined {
    return this._players.get(id);
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

  /** 推进一个步骤，并在步骤边界挂接 M4 规则（重置/抽牌/清空法术力池）。 */
  advance(): void {
    this.turnMgr.advance();
    this._onStepEntered();
  }

  /** 直接推进到某步骤（测试 / 工具用）。 */
  advanceToStep(step: TurnStep): void {
    this.turnMgr.advanceToStep(step);
    this._onStepEntered();
  }

  /** 让当前优先权持有者让过（M4 仍为雏形；完整轮转在 M5）。 */
  pass(playerId: string): ActionResult {
    const p = this.player(playerId);
    if (!p) return err(`未知玩家: ${playerId}`);
    if (playerId !== this.turnMgr.priorityPlayerId) {
      return err(`${p.name} 当前不持有优先权`);
    }
    this.turnMgr.passPriority();
    return { ok: true, message: `${p.name} 让过优先权` };
  }

  /** 兼容 M2 的无参形式：让当前优先权持有者让过优先权。 */
  passPriority(): void {
    this.turnMgr.passPriority();
  }

  /** 下地：把一张地牌从手牌放到战场（每回合限 1 张，仅主动玩家在主要以阶段可做）。 */
  playLand(playerId: string, handIndex: number): ActionResult {
    const p = this.player(playerId);
    if (!p) return err(`未知玩家: ${playerId}`);
    if (playerId !== this.turnMgr.activePlayerId) {
      return err(`${p.name} 不是当前回合主动玩家，不能下地`);
    }
    if (this.currentStep !== 'FIRST_MAIN' && this.currentStep !== 'SECOND_MAIN') {
      return err('只能在主阶段的优先权窗口下地');
    }
    if (p.landsPlayedThisTurn >= 1) {
      return err('本回合已经下过地');
    }
    const card = p.hand[handIndex];
    if (!card) return err('手牌下标越界');
    if (card.category !== 'land') {
      return err(`${card.name} 不是地，不能以"下地"动作进场`);
    }
    // 从手牌移除 → 作为永久物进场
    p.hand.splice(handIndex, 1);
    p.battlefield.push(this.makePermanent(card, playerId));
    p.landsPlayedThisTurn += 1;
    return { ok: true, message: `${p.name} 下了一张地 ${card.name}` };
  }

  /**
   * 活化地/主动产费：横置一块未横置的、带 ADD_MANA 启动式异能的地，向其法术力池注费。
   * M4 简化：只处理产费地。
   */
  activateMana(playerId: string, permanentId: string): ActionResult {
    const p = this.player(playerId);
    if (!p) return err(`未知玩家: ${playerId}`);
    const perm = p.battlefield.find((x) => x.id === permanentId);
    if (!perm) return err('战场上没有这个永久物');
    if (perm.tapped) return err('该永久物已横置');
    const card = perm.card;
    if (card.category !== 'land') return err(`${card.name} 不是地，无法产费`);
    // 寻找产费异能：ACTIVATED cost 为 TAP（或 null），effect 为 ADD_MANA
    let prodColor = null as ManaSymbol | null;
    let prodAmount = 0;
    for (const ab of card.abilities) {
      if (ab.type !== 'ACTIVATED') continue;
      if (!(ab.cost === null || ab.cost.type === 'TAP')) continue;
      if (ab.effect.kind !== 'ADD_MANA') continue;
      prodColor = ab.effect.color;
      prodAmount = ab.effect.amount;
      break;
    }
    if (prodColor === null) {
      return err(`${card.name} 没有可执行的产费异能`);
    }
    perm.tapped = true;
    addToPool(p.manaPool, prodColor, prodAmount);
    return { ok: true, message: `${p.name} 横置 ${card.name}，产出 ${prodAmount} 点 ${prodColor} 法术力` };
  }

  /**
   * 施放一张手牌：校验费用可支付后立即结算（M4 不经堆叠）。
   * 地需要走 playLand；生物/灵气进战场；法术/瞬间执行简单 SPELL 效果后进墓地。
   */
  castFromHand(playerId: string, handIndex: number): ActionResult {
    const p = this.player(playerId);
    if (!p) return err(`未知玩家: ${playerId}`);
    if (playerId !== this.turnMgr.activePlayerId) {
      return err(`${p.name} 不是当前回合主动玩家，不能施放`);
    }
    if (!this.turnMgr.currentStepUsesPriority) {
      return err('当前步骤没有优先权窗口，无法施放');
    }
    const card = p.hand[handIndex];
    if (!card) return err('手牌下标越界');
    if (card.category === 'land') {
      return err(`${card.name} 是地，请用"下地"动作`);
    }
    const cost = parseManaCost(card.manaCost);
    if (!cost) return err(`无法解析 ${card.name} 的法术力费用`);
    if (!canPay(p.manaPool, cost)) {
      return err(`法术力不足以施放 ${card.name}（需要 ${formatCost(card.manaCost!)}）`);
    }
    // 支付费用
    payCost(p.manaPool, cost);
    // 从手牌移除
    p.hand.splice(handIndex, 1);

    if (card.category === 'creature' || card.category === 'aura') {
      p.battlefield.push(this.makePermanent(card, playerId));
      return { ok: true, message: `${p.name} 施放 ${card.name} 进场` };
    }

    // 法术 / 瞬间：执行简单效果后进墓地
    this.resolveSpell(p, card);
    p.graveyard.push(card);
    return { ok: true, message: `${p.name} 施放 ${card.name}（立即结算）` };
  }

  private makePermanent(card: Card, controllerId: string): Permanent {
    this._permSeq += 1;
    return { id: `perm-${controllerId}-${this._permSeq}`, card, tapped: false, controllerId };
  }

  /** 法术/瞬间的最简效果执行（M4：仅处理可执行指令，DAMAGE/DRAW/LIFEGAIN/DESTROY/POWER_TOUGHNESS）。 */
  private resolveSpell(p: PlayerState, card: Card): void {
    for (const ab of card.abilities) {
      if (ab.type !== 'SPELL') continue;
      const fx = ab.effect;
      switch (fx.kind) {
        case 'DAMAGE': {
          const target = this.opponent(p.id);
          if (target) target.life = Math.max(0, target.life - fx.amount);
          break;
        }
        case 'DRAW': {
          this.drawCards(p, fx.amount);
          break;
        }
        case 'LIFEGAIN': {
          p.life += fx.amount;
          break;
        }
        case 'DESTROY': {
          this.destroyFirstOpponentCreature(p);
          break;
        }
        case 'POWER_TOUGHNESS': {
          // M4：静态/持续性增益在此不作量化（战斗系统在 M6 接入）；可安全忽略。
          break;
        }
        case 'ADD_MANA':
        case 'AURA':
        case 'UNKNOWN':
        default:
          break;
      }
    }
  }

  private opponent(id: string): PlayerState | undefined {
    const oid = this._playerOrder.find((o) => o !== id);
    return oid ? this.player(oid) : undefined;
  }

  private drawCards(p: PlayerState, n: number): void {
    for (let i = 0; i < n; i++) {
      const card = p.library.shift();
      if (card) p.hand.push(card);
    }
  }

  private destroyFirstOpponentCreature(attacker: PlayerState): void {
    const opp = this.opponent(attacker.id);
    if (!opp) return;
    const idx = opp.battlefield.findIndex((perm) => perm.card.category === 'creature');
    if (idx >= 0) {
      const perm = opp.battlefield.splice(idx, 1)[0];
      opp.graveyard.push(perm.card);
    }
  }

  /** 在步骤边界执行 M4 规则（近似）：新回合重置、维持阶段抓牌、结束清空法术力池。 */
  private _onStepEntered(): void {
    const step = this.turnMgr.currentStep;
    const active = this.activePlayerId;
    if (step === 'UNTAP') {
      // 新回合（含第 1 回合初始）：重置下地计数、清空法术力池、重置主动玩家的永久物
      for (const id of this._playerOrder) {
        const p = this._players.get(id)!;
        p.landsPlayedThisTurn = 0;
        p.manaPool = emptyPool();
      }
      const ap = this.player(active)!;
      for (const perm of ap.battlefield) perm.tapped = false;
    }
    if (step === 'DRAW') {
      // 抽牌步骤：主动玩家抓 1 张
      const ap = this.player(active);
      if (ap) this.drawCards(ap, 1);
    }
  }
}

function err(error: string): ActionResult {
  return { ok: false, error };
}

/** 把费用字符串转成可读提示（直接沿用 Scryfall 原文）。 */
function formatCost(s: string): string {
  return s;
}