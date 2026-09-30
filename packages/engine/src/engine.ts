/**
 * GameEngine —— 万智牌规则引擎的确定性状态机外壳。
 *
 * M2：接入 TurnManager，暴露阶段+步骤+优先权视图。
 * M4：接入法术力系统与基本操作 —— 玩家扩展出牌库/手牌/战场/墓地/法术力池，
 *      支持 `playLand` / `activateMana` / `castFromHand` / `pass` 四类动作，
 *      并挂接步骤钩子（重置、抽牌、清空法术力池）。
 * M5：接入 StackSystem 与完整优先权 —— 咒语先入堆叠再结算（LIFO），
 *      全员让过且堆叠非空时结算栈顶，全员让过且堆叠为空时推进步骤。
 *      非法操作返回明确错误且不改状态。
 */

import { TurnManager } from './turn.js';
import { Card, GameView, ManaSymbol, Permanent, Phase, PlayerState, TurnStep } from './types.js';
import { canPay, emptyPool, payCost, parseManaCost, addToPool } from './mana.js';
import { Stack, StackItem } from './stack.js';
import {
  canAttack,
  canBlock,
  DamagePass,
  dealsDamageInPass,
  hasKeyword,
  lethalDamage,
} from './combat.js';
import { hasLethalDamage, hasLost } from './sba.js';

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

/** M8：统一的玩家动作（AI 与后端对局协议共用）。 */
export type GameAction =
  | { type: 'PASS' }
  | { type: 'PLAY_LAND'; handIndex: number }
  | { type: 'ACTIVATE_MANA'; permanentId: string }
  | { type: 'CAST'; handIndex: number }
  | { type: 'DECLARE_ATTACKERS'; attackerIds: string[] }
  | { type: 'DECLARE_BLOCKERS'; blocks: { blockerId: string; attackerId: string }[] };

/** 默认起始牌库（纯引擎内置，供本地 / 测试使用）。 */
import { buildStarterDeck } from './deck.js';

export class GameEngine {
  static readonly NAME = '@mtg/engine';
  static readonly VERSION = '0.7.0';

  readonly config: EngineConfig;
  private readonly turnMgr: TurnManager;
  private readonly _players: Map<string, PlayerState>;
  private readonly _playerOrder: string[];
  private _permSeq = 0;
  /** 堆叠（咒语/异能）。 */
  private readonly _stack = new Stack();
  /** 连续让过计数：≥玩家数（2）时视为"全员让过"，触发结算或推进。 */
  private _passes = 0;
  /** M6：本回合已宣告的攻击者永久物 id（按宣告顺序）。 */
  private _attackers: string[] = [];
  /** M6：阻挡关系 blockerId → attackerId。 */
  private _blocks = new Map<string, string>();
  /** M6：本回合是否已宣告攻击者 / 阻挡者（防止重复宣告）。 */
  private _attackersDeclared = false;
  private _blockersDeclared = false;
  /** M7：对局是否结束及胜者（平局为 null）。 */
  private _isOver = false;
  private _winnerId: string | null = null;

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
      isOver: this._isOver,
      winnerId: this._winnerId,
    };
  }

  /** M7：对局是否已结束。 */
  get isOver(): boolean {
    return this._isOver;
  }

  /** M7：胜者 id（平局为 null）。 */
  get winnerId(): string | null {
    return this._winnerId;
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

  /** M7：对局已结束时禁止一切动作（返回错误，否则 null）。 */
  private _guardOver(): ActionResult | null {
    return this._isOver ? err('对局已结束') : null;
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

  /** 当前堆叠物件（自栈底到栈顶；仅用于观察/测试）。 */
  get stack(): StackItem[] {
    return this._stack.peekAll();
  }

  get stackCount(): number {
    return this._stack.length;
  }

  /** 本回合的防御玩家（两人对局即主动玩家的对手）。 */
  get defenderId(): string {
    return this._playerOrder.find((id) => id !== this.activePlayerId)!;
  }

  /** 当前战斗态势（观察 / 测试用）。 */
  get combat(): { attackers: string[]; blocks: { blockerId: string; attackerId: string }[] } {
    return {
      attackers: [...this._attackers],
      blocks: [...this._blocks].map(([blockerId, attackerId]) => ({ blockerId, attackerId })),
    };
  }

  /** M8：本回合是否已宣告过攻击者 / 阻挡者（AI 与 UI 判断可用动作）。 */
  get attackersDeclared(): boolean {
    return this._attackersDeclared;
  }

  get blockersDeclared(): boolean {
    return this._blockersDeclared;
  }

  /** M8：统一动作入口 —— 把 `GameAction` 分发到对应的具体方法。 */
  playAction(playerId: string, action: GameAction): ActionResult {
    switch (action.type) {
      case 'PASS':
        return this.pass(playerId);
      case 'PLAY_LAND':
        return this.playLand(playerId, action.handIndex);
      case 'ACTIVATE_MANA':
        return this.activateMana(playerId, action.permanentId);
      case 'CAST':
        return this.castFromHand(playerId, action.handIndex);
      case 'DECLARE_ATTACKERS':
        return this.declareAttackers(playerId, action.attackerIds);
      case 'DECLARE_BLOCKERS':
        return this.declareBlockers(playerId, action.blocks);
      default:
        return err('未知动作');
    }
  }

  /** 推进一个步骤，并在步骤边界挂接规则（重置/抽牌/清空法术力池、重置优先权与让过计数）。 */
  advance(): void {
    this.turnMgr.advance();
    this._onStepEntered();
  }

  /** 直接推进到某步骤（测试 / 工具用）。 */
  advanceToStep(step: TurnStep): void {
    this.turnMgr.advanceToStep(step);
    this._onStepEntered();
  }

  /**
   * 让过优先权（M5 完整实现）。
   * 若未全员让过 → 优先权传给下一玩家；
   * 若全员让过且堆叠非空 → 结算栈顶，把优先权还给当前主动玩家；
   * 若全员让过且堆叠为空 → 进入下一步骤。
   */
  pass(playerId: string): ActionResult {
    const over = this._guardOver();
    if (over) return over;
    const p = this.player(playerId);
    if (!p) return err(`未知玩家: ${playerId}`);
    if (playerId !== this.turnMgr.priorityPlayerId) {
      return err(`${p.name} 当前不持有优先权`);
    }
    this._passes += 1;

    if (this._passes < this._playerOrder.length) {
      this.turnMgr.passPriority();
      return { ok: true, message: `${p.name} 让过优先权` };
    }

    // 全员让过
    this._passes = 0;
    const top = this._stack.popTop();
    if (top) {
      this._resolveStackItem(top);
      this._runStateBasedActions(); // 咒语结算后立即检查状态（如致命伤害 / 生命归零）
      this.turnMgr.resetPriority(); // 优先权还给主动玩家
      return { ok: true, message: `全员让过，结算堆叠顶：${top.card.name}` };
    }
    // 堆叠空 → 进入下一步
    this.advance();
    return { ok: true, message: `全员让过，推进到 ${this.currentStep}` };
  }

  /** 兼容 M2 的无参形式：让当前优先权持有者让过优先权。 */
  passPriority(): void {
    this.pass(this.priorityPlayerId);
  }

  /** 下地：把一张地牌从手牌放到战场（每回合限 1 张，仅持有优先权者可在主阶段做）。 */
  playLand(playerId: string, handIndex: number): ActionResult {
    const over = this._guardOver();
    if (over) return over;
    const p = this.player(playerId);
    if (!p) return err(`未知玩家: ${playerId}`);
    if (playerId !== this.turnMgr.priorityPlayerId) {
      return err(`${p.name} 当前不持有优先权，不能下地`);
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
    // 从手牌移除 → 作为永久物进场（地直接进场，不进堆叠）
    p.hand.splice(handIndex, 1);
    p.battlefield.push(this.makePermanent(card, playerId));
    p.landsPlayedThisTurn += 1;
    this._passes = 0; // 主动作重置让过计数，优先权不变
    return { ok: true, message: `${p.name} 下了一张地 ${card.name}` };
  }

  /**
   * 活化地/主动产费：横置一块未横置的、带 ADD_MANA 启动式异能的地，向其法术力池注费。
   * M4 简化：只处理产费地。
   */
  activateMana(playerId: string, permanentId: string): ActionResult {
    const over = this._guardOver();
    if (over) return over;
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
   * 施放一张手牌：先支付费用并把咒语放入堆叠（M5 不再立即结算）。
   * 地需要走 playLand；待所有人让过后由 `_resolveStackItem` 结算栈顶。
   */
  castFromHand(playerId: string, handIndex: number): ActionResult {
    const over = this._guardOver();
    if (over) return over;
    const p = this.player(playerId);
    if (!p) return err(`未知玩家: ${playerId}`);
    if (playerId !== this.turnMgr.priorityPlayerId) {
      return err(`${p.name} 当前不持有优先权，不能施放`);
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
    // 支付费用，咒语离手并进入堆叠
    payCost(p.manaPool, cost);
    p.hand.splice(handIndex, 1);
    this._stack.push(playerId, card);
    this._passes = 0; // 主动作重置让过计数
    return { ok: true, message: `${p.name} 施放 ${card.name}，咒语进入堆叠` };
  }

  private makePermanent(card: Card, controllerId: string): Permanent {
    this._permSeq += 1;
    return {
      id: `perm-${controllerId}-${this._permSeq}`,
      card,
      tapped: false,
      controllerId,
      damageMarked: 0,
      // 生物有召唤病（除非具敏捷）；地在下一回合前不可攻击，无需标记
      sick: card.category === 'creature',
    };
  }

  /** 结算一个栈顶物件（当前仅咒语）。永久物咒语进战场；法术/瞬间结算后进墓地。 */
  private _resolveStackItem(item: StackItem): void {
    const p = this.player(item.controllerId);
    if (!p) return;
    const card = item.card;
    if (card.category === 'creature' || card.category === 'aura') {
      p.battlefield.push(this.makePermanent(card, item.controllerId));
      return;
    }
    // 法术 / 瞬间：执行效果后进墓地
    this.resolveSpell(p, card);
    p.graveyard.push(card);
  }

  // ---------- M6 战斗 ----------

  /**
   * 宣告攻击者（主动玩家在宣告攻击者步骤进行）。
   * 合法者横置（具警戒者不横置）；传空数组表示本回合不攻击。
   */
  declareAttackers(playerId: string, permanentIds: string[]): ActionResult {
    const over = this._guardOver();
    if (over) return over;
    if (this.currentStep !== 'DECLARE_ATTACKERS') {
      return err('当前不是宣告攻击者步骤');
    }
    const p = this.player(playerId);
    if (!p) return err(`未知玩家: ${playerId}`);
    if (playerId !== this.activePlayerId) return err('只有主动玩家可以宣告攻击者');
    if (this._attackersDeclared) return err('本回合已宣告过攻击者');
    if (new Set(permanentIds).size !== permanentIds.length) return err('攻击者重复');

    for (const id of permanentIds) {
      const perm = p.battlefield.find((x) => x.id === id);
      if (!perm) return err(`战场上没有这个永久物: ${id}`);
      if (!canAttack(perm)) {
        return err(`${perm.card.name} 不能攻击（已横置 / 具守军 / 召唤病）`);
      }
    }

    this._attackers = [...permanentIds];
    this._attackersDeclared = true;
    for (const id of this._attackers) {
      const perm = p.battlefield.find((x) => x.id === id)!;
      if (!hasKeyword(perm, 'VIGILANCE')) perm.tapped = true;
    }
    this._passes = 0;
    return { ok: true, message: `${p.name} 宣告 ${permanentIds.length} 个攻击者` };
  }

  /**
   * 宣告阻挡者（防御玩家在宣告阻挡者步骤进行）。
   * `assignments` 中的顺序即同一攻击者所受多阻挡者的伤害分配顺序；传空数组表示不阻挡。
   */
  declareBlockers(
    playerId: string,
    assignments: { blockerId: string; attackerId: string }[],
  ): ActionResult {
    const over = this._guardOver();
    if (over) return over;
    if (this.currentStep !== 'DECLARE_BLOCKERS') {
      return err('当前不是宣告阻挡者步骤');
    }
    const p = this.player(playerId);
    if (!p) return err(`未知玩家: ${playerId}`);
    if (playerId === this.activePlayerId) return err('主动玩家不能宣告阻挡者');
    if (playerId !== this.defenderId) return err('只有防御玩家可以宣告阻挡者');
    if (this._blockersDeclared) return err('本回合已宣告过阻挡者');

    const seen = new Set<string>();
    for (const { blockerId, attackerId } of assignments) {
      if (seen.has(blockerId)) return err('同一个生物不能阻挡多个攻击者');
      seen.add(blockerId);
      if (!this._attackers.includes(attackerId)) {
        return err(`该生物未被宣告攻击: ${attackerId}`);
      }
      const blocker = p.battlefield.find((x) => x.id === blockerId);
      if (!blocker) return err(`战场上没有这个永久物: ${blockerId}`);
      const attacker = this._findPermanent(attackerId);
      if (!attacker) return err(`找不到攻击者: ${attackerId}`);
      if (!canBlock(blocker, attacker)) {
        return err(`${blocker.card.name} 不能阻挡 ${attacker.card.name}（飞行 / 威吓等限制）`);
      }
    }

    this._blocks = new Map(assignments.map((a) => [a.blockerId, a.attackerId]));
    this._blockersDeclared = true;
    this._passes = 0;
    return { ok: true, message: `${p.name} 宣告 ${assignments.length} 个阻挡者` };
  }

  /** 跨所有玩家战场查找永久物。 */
  private _findPermanent(id: string): Permanent | undefined {
    for (const pid of this._playerOrder) {
      const found = this._players.get(pid)!.battlefield.find((x) => x.id === id);
      if (found) return found;
    }
    return undefined;
  }

  /** 某攻击者当前的阻挡者（按宣告顺序）。 */
  private _blockersOf(attackerId: string): Permanent[] {
    const result: Permanent[] = [];
    for (const [blockerId, atkId] of this._blocks) {
      if (atkId !== attackerId) continue;
      const perm = this._findPermanent(blockerId);
      if (perm) result.push(perm);
    }
    return result;
  }

  /** 战斗伤害结算：先攻子步骤 + 普通子步骤。 */
  private _resolveCombatDamage(): void {
    this._combatDamagePass('FIRST_STRIKE');
    this._combatDamagePass('REGULAR');
  }

  /** 单个伤害子步骤：符合条件的攻击者与阻挡者互相造成伤害。 */
  private _combatDamagePass(pass: DamagePass): void {
    const defender = this.player(this.defenderId);

    // 攻击者造成伤害
    for (const attackerId of this._attackers) {
      const attacker = this._findPermanent(attackerId);
      if (!attacker || !dealsDamageInPass(attacker, pass)) continue;
      const power = attacker.card.power ?? 0;
      if (power <= 0) continue;

      const blockers = this._blockersOf(attackerId);
      if (blockers.length === 0) {
        // 未被阻挡 → 伤害直接打防御玩家
        if (defender) defender.life -= power;
        continue;
      }
      // 被阻挡 → 按顺序分配致命伤害；溢出部分践踏给玩家，否则归最后一个阻挡者
      let remaining = power;
      let lastBlocker: Permanent | undefined;
      const deathtouch = hasKeyword(attacker, 'DEATHTOUCH');
      for (const blocker of blockers) {
        if (remaining <= 0) break;
        const assigned = Math.min(remaining, lethalDamage(attacker, blocker));
        blocker.damageMarked = (blocker.damageMarked ?? 0) + assigned;
        if (deathtouch && assigned > 0) blocker.deathtouchDamage = true;
        remaining -= assigned;
        lastBlocker = blocker;
      }
      if (remaining > 0) {
        if (hasKeyword(attacker, 'TRAMPLE') && defender) {
          defender.life -= remaining;
        } else if (lastBlocker) {
          // 无践踏时伤害仍须全部分配（多出的部分堆在最后一个阻挡者上）
          lastBlocker.damageMarked = (lastBlocker.damageMarked ?? 0) + remaining;
          if (deathtouch) lastBlocker.deathtouchDamage = true;
        }
      }
    }

    // 阻挡者造成伤害（打其阻挡的攻击者）
    for (const [blockerId, attackerId] of this._blocks) {
      const blocker = this._findPermanent(blockerId);
      const attacker = this._findPermanent(attackerId);
      if (!blocker || !attacker) continue;
      if (!dealsDamageInPass(blocker, pass)) continue;
      const power = blocker.card.power ?? 0;
      if (power <= 0) continue;
      attacker.damageMarked = (attacker.damageMarked ?? 0) + power;
      if (hasKeyword(blocker, 'DEATHTOUCH')) attacker.deathtouchDamage = true;
    }
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
      else p.drewFromEmptyLibrary = true; // 空牌库抽牌 → 状态检查判负（M7）
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

  /**
   * M7 状态检查：每当状态可能变化后执行。
   *  1) 受到致命伤害（普通致命或死触）的生物被消灭并进入其操控者墓地；
   *  2) 生命 ≤ 0 或曾从空牌库抽牌的玩家判负；若无剩余玩家则为平局。
   */
  private _runStateBasedActions(): void {
    if (this._isOver) return;

    // 1) 致命伤害死亡
    for (const id of this._playerOrder) {
      const p = this._players.get(id)!;
      for (let i = p.battlefield.length - 1; i >= 0; i--) {
        const perm = p.battlefield[i];
        if (perm.card.category === 'creature' && hasLethalDamage(perm)) {
          p.battlefield.splice(i, 1);
          p.graveyard.push(perm.card);
        }
      }
    }

    // 2) 判负与胜负归属
    const losers = this._playerOrder.filter((id) => hasLost(this._players.get(id)!));
    if (losers.length > 0) {
      this._isOver = true;
      this._winnerId = this._playerOrder.find((id) => !losers.includes(id)) ?? null;
    }
  }

  /** 在步骤边界执行规则：重置/抽牌/清空法术力池、战斗态势与伤害，并重置优先权计数。 */
  private _onStepEntered(): void {
    this._passes = 0; // 进入新步骤即开启全新优先权窗口
    const step = this.turnMgr.currentStep;
    const active = this.activePlayerId;
    if (step === 'UNTAP') {
      // 新回合（含第 1 回合初始）：重置下地计数、清空法术力池、重置主动玩家的永久物与召唤病
      for (const id of this._playerOrder) {
        const p = this._players.get(id)!;
        p.landsPlayedThisTurn = 0;
        p.manaPool = emptyPool();
      }
      const ap = this.player(active)!;
      for (const perm of ap.battlefield) {
        perm.tapped = false;
        perm.sick = false; // 该玩家回合开始 → 其生物不再有召唤病
      }
    }
    if (step === 'DRAW') {
      // 抽牌步骤：主动玩家抓 1 张
      const ap = this.player(active);
      if (ap) this.drawCards(ap, 1);
    }
    if (step === 'BEGIN_COMBAT') {
      // 进入战斗阶段：清空上回合战斗态势
      this._attackers = [];
      this._blocks = new Map();
      this._attackersDeclared = false;
      this._blockersDeclared = false;
    }
    if (step === 'COMBAT_DAMAGE') {
      // 战斗伤害步骤：结算先攻 + 普通两轮伤害
      this._resolveCombatDamage();
    }
    if (step === 'CLEANUP') {
      // 清理步骤：回合末清除所有永久物上的伤害标记与死触标记
      for (const id of this._playerOrder) {
        for (const perm of this._players.get(id)!.battlefield) {
          perm.damageMarked = 0;
          perm.deathtouchDamage = false;
        }
      }
    }
    this._runStateBasedActions(); // 步骤边界统一做一次状态检查（伤害 / 判负）
  }
}

function err(error: string): ActionResult {
  return { ok: false, error };
}

/** 把费用字符串转成可读提示（直接沿用 Scryfall 原文）。 */
function formatCost(s: string): string {
  return s;
}