/**
 * MTG Online 后端入口（M11：装配与启动分离）。
 *
 * 服务装配见 `server.ts`；这里只负责解析配置、打开卡池数据库并启动监听。
 *
 *   HTTP：`/api/health` —— 服务、引擎与卡池概况。
 *   WebSocket `/ws`：`game_start` / `game_event` / `error`；入参 `play_action`、`restart`。
 */

import { openDatabase } from './data/db.js';
import { createGameServer, defaultDbPath } from './server.js';

const PORT = Number(process.env.PORT ?? 3000);

const db = openDatabase(process.env.MTG_DB ?? defaultDbPath());
const gameServer = createGameServer({ db });

gameServer.listen(PORT).then((port) => {
  console.log(`[MTG server] http://localhost:${port}  (WebSocket: ws://localhost:${port}/ws)`);
});
