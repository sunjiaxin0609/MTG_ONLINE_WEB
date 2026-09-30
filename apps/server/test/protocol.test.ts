import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { openDatabase, closeDatabase } from '../src/data/db.js';
import { createGameServer, type GameServer } from '../src/server.js';
import type { DatabaseSync } from 'node:sqlite';

let db: DatabaseSync;
let gameServer: GameServer;
let port: number;

beforeAll(async () => {
  db = openDatabase(':memory:');
  gameServer = createGameServer({ db });
  port = await gameServer.listen(0); // 随机端口
});

afterAll(async () => {
  await gameServer.close();
  closeDatabase(db);
});

/** 建立连接并等待首条消息（game_start）。 */
function connect(): Promise<{ ws: WebSocket; first: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.once('message', (raw) => resolve({ ws, first: JSON.parse(String(raw)) }));
    ws.once('error', reject);
  });
}

/** 等待下一条消息。 */
function next(ws: WebSocket): Promise<Record<string, any>> {
  return new Promise((resolve) => ws.once('message', (raw) => resolve(JSON.parse(String(raw)))));
}

function send(ws: WebSocket, payload: unknown): void {
  ws.send(JSON.stringify(payload));
}

describe('M11 WebSocket 协议（端到端）', () => {
  it('连接即收到 game_start：己方 7 张手牌，对手手牌与牌库脱敏', async () => {
    const { ws, first } = await connect();
    expect(first.type).toBe('game_start');
    expect(first.you).toBe('p1');

    const me = first.view.players.find((p: any) => p.id === 'p1');
    const opp = first.view.players.find((p: any) => p.id === 'p2');
    expect(me.hand.length).toBe(7);
    expect(me.library).toEqual([]);
    expect(me.libraryCount).toBe(53);
    expect(opp.hand).toEqual([]); // 对手手牌只有数量
    expect(opp.handCount).toBe(7);
    expect(first.stack).toEqual([]);
    expect(first.view.isOver).toBe(false);

    ws.close();
  });

  it('play_action 成功返回 game_event；非法动作返回 error 且状态不变', async () => {
    const { ws } = await connect();

    // 非法：未持有优先权窗口的步骤施放
    send(ws, { type: 'play_action', action: { type: 'CAST', handIndex: 999 } });
    const err = await next(ws);
    expect(err.type).toBe('error');

    // 合法：让过
    send(ws, { type: 'play_action', action: { type: 'PASS' } });
    const evt = await next(ws);
    expect(evt.type).toBe('game_event');
    expect(evt.events.length).toBeGreaterThan(0);

    ws.close();
  });

  it('restart 重开一局：回合归 1、手牌回到 7 张、战场清空', async () => {
    const { ws, first } = await connect();

    // 先推进并下一块地，制造与初始不同的状态
    for (let i = 0; i < 4; i++) {
      send(ws, { type: 'play_action', action: { type: 'PASS' } });
      const e = await next(ws);
      if (e.type === 'error' || e.view?.isOver) break;
    }
    send(ws, { type: 'play_action', action: { type: 'PASS' } });
    await next(ws);

    send(ws, { type: 'restart' });
    const restartMsg = await next(ws);
    expect(restartMsg.type).toBe('game_start');
    expect(restartMsg.view.turn).toBe(1);
    expect(restartMsg.view.step).toBe('UNTAP');
    expect(restartMsg.view.isOver).toBe(false);
    const me = restartMsg.view.players.find((p: any) => p.id === 'p1');
    expect(me.hand.length).toBe(7);
    expect(me.battlefield).toEqual([]);
    expect(restartMsg.events[0].message).toContain('对局开始');
    expect(first.you).toBe(restartMsg.you);

    ws.close();
  });

  it('验收：人类持续让过可打完整局分出胜负，并能再来一局', async () => {
    const { ws } = await connect();
    let last: Record<string, any> | null = null;

    for (let i = 0; i < 900; i++) {
      send(ws, { type: 'play_action', action: { type: 'PASS' } });
      const msg = await next(ws);
      if (msg.type === 'error') break; // 对局结束 / 轮不到人类
      last = msg;
      if (msg.view.isOver) break;
    }

    expect(last).not.toBeNull();
    expect(last!.view.isOver).toBe(true);
    expect(last!.view.winnerId).toBe('p2'); // 人类从不出牌，AI 获胜
    const loser = last!.view.players.find((p: any) => p.id !== 'p2');
    expect(loser.life).toBeLessThanOrEqual(0);

    // 胜负结算后的「再来一局」：回到全新的第 1 回合
    send(ws, { type: 'restart' });
    const fresh = await next(ws);
    expect(fresh.type).toBe('game_start');
    expect(fresh.view.turn).toBe(1);
    expect(fresh.view.isOver).toBe(false);
    expect(fresh.view.winnerId).toBeNull();

    ws.close();
  });
});