/**
 * server.ts —— HTTP + WebSocket 服务装配（M11 提取，便于端到端测试与启动分离）。
 *
 * 协议：
 *  入：`{ type: 'play_action', action }` / `{ type: 'restart' }`
 *  出：`game_start`（初始）/ `game_event`（增量）/ `error`
 */

import cors from 'cors';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { DatabaseSync } from 'node:sqlite';
import { GameAction, GameEngine, GameView } from '@mtg/engine';
import { getCounts } from './data/query.js';
import { GameSession } from './session/session.js';

/** 默认数据库路径固定为 apps/server/data/mtg.db（与抓取脚本一致，不随 cwd 变化）。 */
export function defaultDbPath(): string {
  // 本文件位于 src/server.ts 或 dist/server.js —— 上一级即 apps/server
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/mtg.db');
}

export interface GameServerOptions {
  /** 卡池来源。 */
  db: DatabaseSync;
}

export interface GameServer {
  app: express.Express;
  server: Server;
  wss: WebSocketServer;
  /** 开始监听；传 0 使用随机端口。返回实际端口。 */
  listen: (port: number) => Promise<number>;
  close: () => Promise<void>;
}

/**
 * 脱敏：牌库内容不下发（只给数量）；手牌只下发自己的，对手手牌只给数量。
 * 战场与墓地为公开信息，原样下发。
 */
export function redactView(view: GameView, humanId: string) {
  return {
    ...view,
    players: view.players.map((p) => ({
      ...p,
      libraryCount: p.library.length,
      library: [],
      handCount: p.hand.length,
      hand: p.id === humanId ? p.hand : [],
    })),
  };
}

export function createGameServer(opts: GameServerOptions): GameServer {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    const engine = new GameEngine({
      players: [
        { id: 'p1', name: '玩家', isComputed: false },
        { id: 'p2', name: '电脑 AI', isComputed: true },
      ],
    });
    let cardPool = { total: 0, supported: 0 };
    try {
      cardPool = getCounts(opts.db);
    } catch {
      // 卡池尚未抓取时不影响健康检查
    }
    res.json({ ok: true, engine: engine.info, cardPool });
  });

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  /** 组装一次可广播负载：脱敏视图 + 增量事件 + 战斗态势 + 堆叠。 */
  const makePayload = (session: GameSession, extra: Record<string, unknown> = {}) => {
    const snapshot = session.takeSnapshot();
    return {
      ...extra,
      view: redactView(snapshot.view, session.humanId),
      events: snapshot.events,
      attackersDeclared: session.engine.attackersDeclared,
      blockersDeclared: session.engine.blockersDeclared,
      combat: session.engine.combat,
      stack: session.engine.stack,
    };
  };

  wss.on('connection', (socket: WebSocket) => {
    const send = (payload: unknown) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
    };

    // 每连接一局会话
    let session: GameSession;
    try {
      session = new GameSession({ db: opts.db });
    } catch (err) {
      send({ type: 'error', message: `无法创建对局：${(err as Error).message}` });
      socket.close();
      return;
    }

    send({ type: 'game_start', you: session.humanId, ...makePayload(session) });

    socket.on('message', (raw) => {
      let msg: { type?: string; action?: unknown };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        send({ type: 'error', message: '非法消息' });
        return;
      }

      // 再来一局：丢弃当前会话，新建并广播初始状态
      if (msg?.type === 'restart') {
        try {
          session = new GameSession({ db: opts.db });
        } catch (err) {
          send({ type: 'error', message: `无法创建对局：${(err as Error).message}` });
          return;
        }
        send({ type: 'game_start', you: session.humanId, ...makePayload(session) });
        return;
      }

      if (msg?.type !== 'play_action') {
        send({ type: 'error', message: '未知消息类型' });
        return;
      }
      const result = session.playAction(msg.action as GameAction);
      if (!result.ok) {
        send({ type: 'error', message: result.error });
        return;
      }
      send({ type: 'game_event', ...makePayload(session) });
    });

    socket.on('close', () => {
      /* 连接关闭即释放会话（GC 回收） */
    });
  });

  return {
    app,
    server,
    wss,
    listen: (port: number) =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => {
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : port);
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }),
  };
}