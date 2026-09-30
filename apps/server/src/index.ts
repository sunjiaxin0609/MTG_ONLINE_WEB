/**
 * MTG Online 后端入口 —— M1 骨架。
 *
 * 现在只做两件事：
 *   1. HTTP `/api/health`：返回服务与引擎的固定信息（验证共享引擎包已接通）。
 *   2. WebSocket `/ws`：新建一个后台引擎实例，回传引擎对局视图；收到文本就推送引擎当前视图。
 * 后续里程碑在 `GameSession` / 对局协议上扩展。
 */

import cors from 'cors';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { GameEngine } from '@mtg/engine';

const PORT = Number(process.env.PORT ?? 3000);

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
  res.json({
    ok: true,
    engine: engine.info,
  });
});

const server = createServer(app);

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket: WebSocket) => {
  // 每个连接独立一个后台引擎实例（M1 演示用；多局对局会话在 M9 实现）。
  const engine = new GameEngine({
    players: [
      { id: 'p1', name: '玩家', isComputed: false },
      { id: 'p2', name: '电脑 AI', isComputed: true },
    ],
  });

  const sendView = () => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'game_event', view: engine.view }));
    }
  };

  // 连接建立即推送一次当前视图
  sendView();

  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg?.type === 'advance') {
        engine.advance();
      }
      sendView();
    } catch {
      socket.send(JSON.stringify({ type: 'error', message: '非法消息' }));
    }
  });

  socket.on('close', () => {
    /* M1：连接关闭即释放实例 */
  });
});

server.listen(PORT, () => {
  console.log(`[MTG server] http://localhost:${PORT}  (WebSocket: ws://localhost:${PORT}/ws)`);
});