/**
 * mana.ts —— ManaSystem（M4：法术力系统）。
 *
 * 职责：
 *  1. 把卡牌的 `manaCost` 字符串（如 "{2}{W}"、"{1}{B}{B}"、"RR"）解析为结构化 `CostBreakdown`。
 *  2. 提供法术力池（ManaPool，按颜色记数）的"能否支付"与"实际支付"判定。
 *
 * 规则要点：
 *  - `generic` 为通用部分，任何颜色 + 无色（C）都能付；
 *  - `colors` 为指定颜色要求，只能用对应颜色付；
 *  - 支付通用部分时优先消耗无色 C，再消耗富余的有色法术力。
 */

import type { CostBreakdown, ManaColor, ManaPool, ManaSymbol } from './types.js';

/** 五色列表（不含 C）。 */
export const MANA_COLORS: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

const COLOR_SET = new Set<string>(MANA_COLORS);

/** 从零开始的一个空法术力池。 */
export function emptyPool(): ManaPool {
  return { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
}

/**
 * 解析法术力费用字符串为结构化费用。
 * `null` 表示"无费用"（例如地）；无法识别（如含 {X}）返回 null，由调用方决定。
 */
export function parseManaCost(manaCost: string | null): CostBreakdown | null {
  if (!manaCost || !manaCost.includes('{')) return null;
  const colors: Record<ManaColor, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  let generic = 0;
  let total = 0;
  const re = /\{([0-9RCWUBG])\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(manaCost)) !== null) {
    const token = m[1];
    const n = Number(token);
    if (!Number.isNaN(n)) {
      generic += n;
      total += n;
    } else if (token === 'C') {
      // 无色 {C} 归入通用部分（首版简化：无色要求视作通用可付）
      generic += 1;
      total += 1;
    } else if (COLOR_SET.has(token)) {
      colors[token as ManaColor] += 1;
      total += 1;
    } else {
      return null;
    }
  }
  return { generic, colors, total };
}

/**
 * 判断当前法术力池能否支付该费用。
 * 先保证每种指定颜色都满足，再判断剩余法术力能否覆盖通用部分。
 */
export function canPay(pool: ManaPool, cost: CostBreakdown): boolean {
  for (const c of MANA_COLORS) {
    if ((pool[c] ?? 0) < cost.colors[c]) return false;
  }
  const coloredLeftover = MANA_COLORS.reduce((sum, c) => sum + ((pool[c] ?? 0) - cost.colors[c]), 0);
  const colorless = (pool.C ?? 0) + coloredLeftover;
  return colorless >= cost.generic;
}

/**
 * 从法术力池支付该费用（原地修改 pool）。调用方须先经 canPay 校验。
 * 指定颜色各扣对应量；通用部分先扣无色 C，再扣富余有色。
 */
export function payCost(pool: ManaPool, cost: CostBreakdown): void {
  for (const c of MANA_COLORS) {
    pool[c] = Math.max(0, (pool[c] ?? 0) - cost.colors[c]);
  }
  // 通用部分：优先用无色 C
  let need = cost.generic;
  const order: ManaSymbol[] = ['C', ...MANA_COLORS];
  for (const sym of order) {
    if (need <= 0) break;
    const take = Math.min(pool[sym] ?? 0, need);
    pool[sym] = (pool[sym] ?? 0) - take;
    need -= take;
  }
}

/** 往法术力池注入 N 点指定颜色法术力（原地修改）。 */
export function addToPool(pool: ManaPool, color: ManaSymbol, amount: number): void {
  pool[color] = (pool[color] ?? 0) + amount;
}