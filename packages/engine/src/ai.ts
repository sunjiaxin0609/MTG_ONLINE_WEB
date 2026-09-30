/**
 * ai.ts —— 启发式 AI 玩家（M8）。
 *
 * 设计目标：**能稳定打完整局、不卡死**，不追求最优。通过统一的
 * `engine.playAction()` 接入，便于后端（M9）以同一协议驱动。
 *
 * 决策优先级：
 *  1. 自己回合的主阶段先下地（每回合 1 张）；
 *  2. 选择"最值得施放"的牌（生物按 P/T 计分优先，其次灵气/法术/瞬间），
 *     费用不足时逐块横置地补足（会优先横置仍缺颜色的地）；
 *  3. 攻击：所有可攻击的生物全部进攻；
 *  4. 阻挡：只在"能击杀攻击者且自身能存活"时阻挡（划算的阻挡）；
 *  5. 其余情况一律让过。
 *
 * 已知简化：不做法术力预留（不刻意留费放瞬间）、不做复杂的多阻挡者分配。
 */

import type { GameEngine, GameAction } from './engine.js';
import type { CostBreakdown, ManaColor, ManaPool, ManaSymbol, Permanent, PlayerState } from './types.js';
import { canPay, parseManaCost } from './mana.js';
import { canAttack, canBlock } from './combat.js';

/** 驱动循环的安全上限，防止意外死循环。 */
const MAX_STEPS = 20000;

const COLOR_ORDER: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

/** 取某玩家的可观察状态。 */
function view(engine: GameEngine, id: string): PlayerState {
  const p = engine.view.players.find((x) => x.id === id);
  if (!p) throw new Error(`未知玩家: ${id}`);
  return p;
}

/** 一块地的产费（颜色与数量）；非产费地返回 null。 */
function landProduction(perm: Permanent): { color: ManaSymbol; amount: number } | null {
  for (const ab of perm.card.abilities) {
    if (
      ab.type === 'ACTIVATED' &&
      (ab.cost === null || ab.cost.type === 'TAP') &&
      ab.effect.kind === 'ADD_MANA'
    ) {
      return { color: ab.effect.color, amount: ab.effect.amount };
    }
  }
  return null;
}

/** 把当前池 + 所有未横置地的产费相加，得到"把地全横置"的上限法术力池。 */
function potentialPool(engine: GameEngine, id: string): ManaPool {
  const p = view(engine, id);
  const pool: ManaPool = { ...p.manaPool };
  for (const perm of p.battlefield) {
    if (perm.tapped) continue;
    const prod = landProduction(perm);
    if (prod) pool[prod.color] += prod.amount;
  }
  return pool;
}

/** 卡牌价值评分：生物按 P/T 计分最高，其次灵气，最后法术/瞬间。 */
function scoreCard(card: { category: string; power?: number; toughness?: number }): number {
  if (card.category === 'creature') return 100 + (card.power ?? 0) + (card.toughness ?? 0);
  if (card.category === 'aura') return 40;
  return 30;
}

interface SpellTarget {
  index: number;
  card: { manaCost: string | null };
  score: number;
}

/** 选出最值得施放、且"把地全横置后能付得起"的牌；无则返回 null。 */
function chooseSpell(engine: GameEngine, id: string): SpellTarget | null {
  const p = view(engine, id);
  const isOwnTurn = engine.activePlayerId === id;
  const step = engine.currentStep;
  const isMain = step === 'FIRST_MAIN' || step === 'SECOND_MAIN';
  const canSorcery = isOwnTurn && isMain; // 法术/生物/灵气只在自家主阶段施放
  const pot = potentialPool(engine, id);

  let best: SpellTarget | null = null;
  p.hand.forEach((card, index) => {
    if (card.category === 'land') return;
    const isInstant = card.category === 'instant';
    if (!isInstant && !canSorcery) return;
    const cost = parseManaCost(card.manaCost);
    if (!cost || !canPay(pot, cost)) return;
    const score = scoreCard(card);
    if (!best || score > best.score) best = { index, card, score };
  });
  return best;
}

/** 选一块要横置的地：优先补足仍缺的颜色，否则取第一块可产费的地。 */
function chooseLandToTap(engine: GameEngine, id: string, cost: CostBreakdown): Permanent | null {
  const p = view(engine, id);
  const lands = p.battlefield.filter((x) => !x.tapped && landProduction(x));
  if (lands.length === 0) return null;
  const needed = COLOR_ORDER.filter((c) => (p.manaPool[c] ?? 0) < cost.colors[c]);
  const helpful = lands.find((l) => needed.includes(landProduction(l)!.color as ManaColor));
  return helpful ?? lands[0];
}

function findPermanent(engine: GameEngine, permId: string): Permanent | null {
  for (const pl of engine.view.players) {
    const found = pl.battlefield.find((x) => x.id === permId);
    if (found) return found;
  }
  return null;
}

/** 优先权窗口下的动作（下地 / 产费 / 施法 / 让过）。 */
function decidePriorityAction(engine: GameEngine, id: string): GameAction {
  const p = view(engine, id);
  const step = engine.currentStep;
  const isOwnTurn = engine.activePlayerId === id;
  const isMain = step === 'FIRST_MAIN' || step === 'SECOND_MAIN';

  // 1) 自己回合的主阶段：先下地
  if (isOwnTurn && isMain && p.landsPlayedThisTurn < 1) {
    const landIdx = p.hand.findIndex((c) => c.category === 'land');
    if (landIdx >= 0) return { type: 'PLAY_LAND', handIndex: landIdx };
  }

  // 2) 挑一张最有价值的牌；费用不够就先横置地
  const target = chooseSpell(engine, id);
  if (target) {
    const cost = parseManaCost(target.card.manaCost)!;
    if (canPay(p.manaPool, cost)) return { type: 'CAST', handIndex: target.index };
    const land = chooseLandToTap(engine, id, cost);
    if (land) return { type: 'ACTIVATE_MANA', permanentId: land.id };
  }

  return { type: 'PASS' };
}

/** 宣告攻击者：所有可攻击的生物全部进攻。 */
function decideAttackers(engine: GameEngine, id: string): GameAction {
  const p = view(engine, id);
  const attackerIds = p.battlefield.filter((x) => canAttack(x)).map((x) => x.id);
  return { type: 'DECLARE_ATTACKERS', attackerIds };
}

/** 宣告阻挡者：只在"能击杀攻击者且自身能存活"时阻挡。 */
function decideBlockers(engine: GameEngine, id: string): GameAction {
  const p = view(engine, id);
  const used = new Set<string>();
  const blocks: { blockerId: string; attackerId: string }[] = [];

  for (const attackerId of engine.combat.attackers) {
    const attacker = findPermanent(engine, attackerId);
    if (!attacker) continue;
    const lethal = attacker.card.toughness ?? 0;
    const candidates = p.battlefield.filter(
      (b) => !used.has(b.id) && !b.tapped && canBlock(b, attacker),
    );
    // 划算的阻挡：能击杀攻击者（力量 ≥ 其防御力）且能存活（防御力 > 其力量）
    const good = candidates
      .filter((b) => (b.card.power ?? 0) >= lethal && (b.card.toughness ?? 0) > (attacker.card.power ?? 0))
      .sort((a, b) => (a.card.power ?? 0) - (b.card.power ?? 0));
    const chosen = good[0];
    if (chosen) {
      used.add(chosen.id);
      blocks.push({ blockerId: chosen.id, attackerId });
    }
  }
  return { type: 'DECLARE_BLOCKERS', blocks };
}

/** 为 `actor` 计算下一步动作。 */
export function decideAction(engine: GameEngine, actor: string): GameAction {
  const step = engine.currentStep;
  if (step === 'DECLARE_ATTACKERS' && actor === engine.activePlayerId && !engine.attackersDeclared) {
    return decideAttackers(engine, actor);
  }
  if (step === 'DECLARE_BLOCKERS' && actor === engine.defenderId && !engine.blockersDeclared) {
    return decideBlockers(engine, actor);
  }
  return decidePriorityAction(engine, actor);
}

/**
 * 当前"应该行动"的玩家：若是 AI 则返回其 id，否则返回 null（需等待人类输入）。
 *  - 宣告攻击者步骤：主动玩家（尚未宣告时）；
 *  - 宣告阻挡者步骤：防御玩家（尚未宣告时）；
 *  - 其余：优先权持有者。
 */
export function currentActor(engine: GameEngine, aiIds: Set<string>): string | null {
  if (engine.isOver) return null;
  const step = engine.currentStep;
  // 宣告攻击者：由 AI 主动玩家负责宣告；否则交回优先权判断（让持有优先权的 AI 让过以推进）
  if (step === 'DECLARE_ATTACKERS' && !engine.attackersDeclared && aiIds.has(engine.activePlayerId)) {
    return engine.activePlayerId;
  }
  // 宣告阻挡者：由 AI 防御玩家负责宣告；否则交回优先权判断
  if (step === 'DECLARE_BLOCKERS' && !engine.blockersDeclared && aiIds.has(engine.defenderId)) {
    return engine.defenderId;
  }
  const priority = engine.priorityPlayerId;
  return aiIds.has(priority) ? priority : null;
}

/** 兜底动作：保证一定能推进，避免 AI 决策失败导致死锁。 */
function fallbackAction(engine: GameEngine, actor: string): GameAction {
  const step = engine.currentStep;
  if (step === 'DECLARE_ATTACKERS' && actor === engine.activePlayerId) {
    return { type: 'DECLARE_ATTACKERS', attackerIds: [] };
  }
  if (step === 'DECLARE_BLOCKERS' && actor === engine.defenderId) {
    return { type: 'DECLARE_BLOCKERS', blocks: [] };
  }
  return { type: 'PASS' };
}

/**
 * 驱动所有 AI 持续行动，直到"该人类输入"或对局结束。
 * 每个实际执行的动作都会回调 `onAction`（用于会话层记录事件流）。
 * `aiIds` 为受控 AI 的玩家 id 集合；剩余玩家被视为人类，需要外部输入。
 */
export function runAiWith(
  engine: GameEngine,
  aiIds: Iterable<string>,
  onAction?: (actor: string, action: GameAction, message: string) => void,
): void {
  const set = new Set(aiIds);
  let safety = 0;
  while (!engine.isOver && safety < MAX_STEPS) {
    safety += 1;
    const actor = currentActor(engine, set);
    if (!actor) break; // 轮到人类，交还控制权

    const action = decideAction(engine, actor);
    const result = engine.playAction(actor, action);
    if (result.ok) {
      onAction?.(actor, action, result.message ?? action.type);
      continue;
    }
    // 决策非法时用兜底动作保证推进；若兜底也失败则退出，避免死循环
    const fb = fallbackAction(engine, actor);
    const fbResult = engine.playAction(actor, fb);
    if (!fbResult.ok) break;
    onAction?.(actor, fb, fbResult.message ?? fb.type);
  }
}

/** 驱动所有 AI 行动（无事件回调的便捷形式）。 */
export function runAi(engine: GameEngine, aiIds: Iterable<string>): void {
  runAiWith(engine, aiIds);
}