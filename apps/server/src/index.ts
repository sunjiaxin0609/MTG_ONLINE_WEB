/**
 * MTG Online 后端入口（M9：对局会话 + WebSocket）。
 *
 *  HTTP：
 *    - `/api/health`：服务、引擎与卡池概况。
 *  WebSocket `/ws`：
 *    - 连接建立 → 新建一局 `GameSession`，推送 `game_start`（初始视图 + 事件）。
 *    - 收到 `{ type: 'play_action', action }` → 交给会话处理；成功则推送
 *      `game_event`（视图 + 增量事件），非法操作推送 `error`。
 *    - 每局一个会话，连接关闭即释放。
 */

import cors from 'cors';
import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { DatabaseSync } from 'node:sqlite';
import { GameAction, GameEngine } from '@mtg/engine';
import { openDatabase } from './data/db.js';
import { getCounts } from './data/query.js';
import { GameSession } from './session/session.js';

const PORT = Number(process.env.PORT ?? 3000);

/** 默认数据库路径固定为 apps/server/data/mtg.db（与抓取脚本一致，不随 cwd 变化）。 */
function defaultDbPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/mtg.db');
}

const app = express();
app.use(cors());
app.use(express.json());

/** 卡池数据库：进程内单例、懒加载。 */
let db: DatabaseSync | null = null;
function getDb(): DatabaseSync {
  if (!db) db = openDatabase(process.env.MTG_DB ?? defaultDbPath());
  return db;
}

app.get('/api/health', (_req, res) => {
  const engine = new GameEngine({
    players: [
      { id: 'p1', name: '玩家', isComputed: false },
      { id: 'p2', name: '电脑 AI', isComputed: true },
    ],
  });
  let cardPool = { total: 0, supported: 0 };
  try {
    cardPool = getCounts(getDb());
  } catch {
    // 卡池尚未抓取时不影响健康检查
  }
  res.json({ ok: true, engine: engine.info, cardPool });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket: WebSocket) => {
  const send = (payload: unknown) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  };

  // 每连接一局会话
  let session: GameSession;
  try {
    session = new GameSession({ db: getDb() });
  } catch (err) {
    send({ type: 'error', message: `无法创建对局：${(err as Error).message}` });
    socket.close();
    return;
  }

  const initial = session.takeSnapshot();
  send({ type: 'game_start', you: session.humanId, view: initial.view, events: initial.events });

  socket.on('message', (raw) => {
    let msg: { type?: string; action?: unknown };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      send({ type: 'error', message: '非法消息' });
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
    const snapshot = session.takeSnapshot();
    send({ type: 'game_event', view: snapshot.view, events: snapshot.events });
  });

  socket.on('close', () => {
    /* 连接关闭即释放会话（GC 回收） */
  });
});

server.listen(PORT, () => {
  console.log(`[MTG server] http://localhost:${PORT}  (WebSocket: ws://localhost:${PORT}/ws)`);
});