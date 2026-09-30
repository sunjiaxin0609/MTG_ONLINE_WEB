/**
 * session.ts —— 对局会话（M9）。
 *
 * 职责：从卡池构建双方牌组 → 驱动引擎 → 让 AI 自动响应 → 输出可广播的
 * 「完整视图 + 增量事件流」。传输层（WebSocket）只负责收发，不含规则逻辑。
 */

import {
  GameEngine,
  GameAction,
  ActionResult,
  GameView,
  EngineConfig,
  Card,
  buildStarterDeck,
  runAiWith,
} from '@mtg/engine';
import type { DatabaseSync } from 'node:sqlite';
import { buildStandardDeck } from '../data/deck.js';

/** 一条对局事件（增量广播用）。 */
export interface GameEvent {
  seq: number;
  /** 动作发起者（人类 / AI / system）。 */
  by: string;
  /** 动作类型（便于前端图标化）。 */
  type: GameAction['type'] | 'SYSTEM';
  /** 人类可读描述。 */
  message: string;
}

/** 一次可广播快照：当前视图 + 自上次广播以来的新增事件。 */
export interface SessionSnapshot {
  view: GameView;
  events: GameEvent[];
}

export interface GameSessionOptions {
  /** 卡池来源（SQLite）。 */
  db: DatabaseSync;
  humanId?: string;
  aiId?: string;
  startingLife?: number;
}

export class GameSession {
  readonly engine: GameEngine;
  readonly humanId: string;
  readonly aiId: string;
  private readonly aiIds: Set<string>;
  private readonly events: GameEvent[] = [];
  private seq = 0;

  constructor(opts: GameSessionOptions) {
    const humanId = opts.humanId ?? 'p1';
    const aiId = opts.aiId ?? 'p2';

    // 从真实卡池构建牌组；若卡池尚未抓取（为空）则退回引擎内置牌组，保证会话可用
    let deck: Card[] = [];
    try {
      deck = buildStandardDeck(opts.db);
    } catch {
      deck = [];
    }
    if (deck.length === 0) deck = buildStarterDeck();

    const config: EngineConfig = {
      players: [
        { id: humanId, name: '玩家', isComputed: false },
        { id: aiId, name: '电脑 AI', isComputed: true },
      ],
      decks: { [humanId]: deck, [aiId]: deck },
    };
    if (opts.startingLife !== undefined) config.startingLife = opts.startingLife;

    this.engine = new GameEngine(config);
    this.humanId = humanId;
    this.aiId = aiId;
    this.aiIds = new Set([aiId]);

    this.record('system', 'SYSTEM', `对局开始（${deck.length} 张牌组），${humanId} 先手`);
    this.runAiResponses(); // 若开局轮到 AI，先让 AI 行动
  }

  /** 人类玩家提交动作。非法动作返回错误且不改状态。 */
  playAction(action: GameAction): ActionResult {
    if (this.engine.isOver) return { ok: false, error: '对局已结束' };
    const result = this.engine.playAction(this.humanId, action);
    if (!result.ok) return result;
    this.record(this.humanId, action.type, result.message ?? action.type);
    this.runAiResponses();
    return { ok: true, message: result.message };
  }

  /** 当前完整视图（不含事件）。 */
  get view(): GameView {
    return this.engine.view;
  }

  /** 取出快照：完整视图 + 本次新增的事件（事件取出后清空，实现增量广播）。 */
  takeSnapshot(): SessionSnapshot {
    return {
      view: this.engine.view,
      events: this.events.splice(0, this.events.length),
    };
  }

  private record(by: string, type: GameEvent['type'], message: string): void {
    this.seq += 1;
    this.events.push({ seq: this.seq, by, type, message });
  }

  /** 让 AI 持续行动直到轮到人类 / 对局结束，并把 AI 动作记入事件流。 */
  private runAiResponses(): void {
    runAiWith(this.engine, this.aiIds, (actor, action, message) => {
      this.record(actor, action.type, message);
    });
  }
}