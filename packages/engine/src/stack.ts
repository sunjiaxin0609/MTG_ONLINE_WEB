/**
 * stack.ts —— StackSystem（M5：堆叠）。
 *
 * 堆叠按"后进先出"（LIFO）结算：后入堆叠的咒语/异能先结算。
 * M5 阶段只入堆"咒语"（SPELL）；异能（启动/触发）后续里程碑再入栈。
 */

import type { Card } from './types.js';

/** 堆叠上的一个物件。 */
export interface StackItem {
  /** 堆叠实例唯一 id。 */
  id: string;
  /** M5 只支持咒语。 */
  kind: 'SPELL';
  /** 操控者玩家 id。 */
  controllerId: string;
  /** 被施放的卡牌（结算时决定进战场还是结算后进墓地）。 */
  card: Card;
}

export class Stack {
  private items: StackItem[] = [];
  private seq = 0;

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  get length(): number {
    return this.items.length;
  }

  /** 栈顶（最后入栈，最先结算）；空返回 undefined。 */
  get top(): StackItem | undefined {
    return this.items[this.items.length - 1];
  }

  /** 把咒语/异能入栈。 */
  push(controllerId: string, card: Card): StackItem {
    this.seq += 1;
    const item: StackItem = { id: `stack-${this.seq}`, kind: 'SPELL', controllerId, card };
    this.items.push(item);
    return item;
  }

  /** 弹出栈顶（LIFO）。 */
  popTop(): StackItem | undefined {
    return this.items.pop();
  }

  /** 只读快照（自栈底到栈顶）。 */
  peekAll(): StackItem[] {
    return this.items.map((i) => ({ ...i, card: { ...i.card } }));
  }
}