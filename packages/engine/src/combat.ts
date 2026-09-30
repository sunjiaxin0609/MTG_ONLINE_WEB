/**
 * combat.ts —— CombatSystem 的纯函数部分（M6）。
 *
 * 只做与战斗相关的"判定"，不持有状态：
 *  - 关键字查询与伤害步骤判定（先攻/连击）；
 *  - 宣告攻击 / 宣告阻挡的合法性；
 *  - 致命伤害需求（践踏溢出、死触）。
 * 真实的状态变更（横置、记录伤害、扣生命）由引擎负责。
 */

import type { KeywordId, Permanent } from './types.js';

/** 战斗伤害的两个子步骤：先攻伤害、普通伤害。 */
export type DamagePass = 'FIRST_STRIKE' | 'REGULAR';

/** 该永久物是否具备某关键字。 */
export function hasKeyword(perm: Permanent, keyword: KeywordId): boolean {
  return perm.card.abilities.some((a) => a.type === 'KEYWORD' && a.keyword === keyword);
}

/** 是否为生物永久物。 */
export function isCreature(perm: Permanent): boolean {
  return perm.card.category === 'creature';
}

/**
 * 该永久物是否应在给定伤害步骤造成战斗伤害。
 * 先攻步骤：具先攻或连击者；
 * 普通步骤：不具先攻者，或具连击者（连击结算两次）。
 */
export function dealsDamageInPass(perm: Permanent, pass: DamagePass): boolean {
  const firstStrike = hasKeyword(perm, 'FIRST_STRIKE');
  const doubleStrike = hasKeyword(perm, 'DOUBLE_STRIKE');
  if (pass === 'FIRST_STRIKE') return firstStrike || doubleStrike;
  return !firstStrike || doubleStrike;
}

/** 能否宣告攻击：须为未横置、非守军、无召唤病的生物。 */
export function canAttack(perm: Permanent): boolean {
  if (!isCreature(perm)) return false;
  if (hasKeyword(perm, 'DEFENDER')) return false;
  if (perm.tapped) return false;
  if (perm.sick && !hasKeyword(perm, 'HASTE')) return false;
  return true;
}

/**
 * 能否用 `blocker` 阻挡 `attacker`。
 * 飞行：仅具飞行或延势者可挡；
 * 威吓：须与攻击者共享颜色（本引擎无神器生物，故只判共享颜色）。
 */
export function canBlock(blocker: Permanent, attacker: Permanent): boolean {
  if (!isCreature(blocker)) return false;
  if (blocker.tapped) return false;
  if (hasKeyword(attacker, 'FLYING')) {
    if (!hasKeyword(blocker, 'FLYING') && !hasKeyword(blocker, 'REACH')) return false;
  }
  if (hasKeyword(attacker, 'INTIMIDATE')) {
    const shares = attacker.card.colors.some((c) => blocker.card.colors.includes(c));
    if (!shares) return false;
  }
  return true;
}

/**
 * 攻击者对该阻挡者"至少需分配"的伤害量（用于伤害分配顺序与践踏溢出）。
 * 具死触者视为 1 点即致命；否则需补足其剩余防御力。
 */
export function lethalDamage(attacker: Permanent, blocker: Permanent): number {
  if (hasKeyword(attacker, 'DEATHTOUCH')) return 1;
  const remaining = (blocker.card.toughness ?? 0) - (blocker.damageMarked ?? 0);
  return Math.max(1, remaining);
}