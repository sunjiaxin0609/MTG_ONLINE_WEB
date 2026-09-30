/**
 * sba.ts —— 状态检查（State-Based Actions）的纯函数部分（M7）。
 *
 * 状态检查是"每当有玩家将获得优先权时自动反复执行"的规则。本模块只提供判定谓词，
 * 真正的区域移动（进墓地）与判负由引擎完成。
 */

import type { Permanent } from './types.js';

/** 该生物是否受到致命伤害：普通致命（伤害 ≥ 防御力）或曾受死触伤害。 */
export function hasLethalDamage(perm: Permanent): boolean {
  const damage = perm.damageMarked ?? 0;
  if (damage <= 0) return false;
  if (perm.deathtouchDamage) return true;
  return damage >= (perm.card.toughness ?? 0);
}

/** 该玩家是否已满足判负条件：生命 ≤ 0，或曾尝试从空牌库抽牌。 */
export function hasLost(player: { life: number; drewFromEmptyLibrary?: boolean }): boolean {
  return player.life <= 0 || player.drewFromEmptyLibrary === true;
}