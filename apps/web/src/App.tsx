import { useEffect, useRef, useState } from 'react';

interface Health {
  ok: boolean;
  engine: { name: string; version: string; players: { id: string; name: string }[]; phases: unknown[] };
}

interface GameEvent {
  type: 'game_event';
  view: { turn: number; phase: string; activePlayerId: string; players: { id: string; name: string; life: number }[] };
}

interface Err {
  type: 'error';
  message: string;
}

/**
 * M1 骨架页面：验证 后端 HTTP 连通 + WebSocket 实时视图 + 阶段推进。
 * 后续里程碑将替换为真正的牌桌 UI。
 */
export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [view, setView] = useState<GameEvent['view'] | null>(null);
  const [conn, setConn] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [lastError, setLastError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    wsRef.current = ws;
    ws.onopen = () => setConn('open');
    ws.onclose = () => setConn('closed');
    ws.onerror = () => setLastError('WebSocket 连接错误');
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data) as GameEvent | Err;
      if (msg.type === 'error') {
        setLastError(msg.message);
      } else {
        setView(msg.view);
      }
    };
    fetch('/api/health')
      .then((r) => r.json())
      .then(setHealth as never)
      .catch(() => setLastError('无法连接后端 /api/health'));
    return () => ws.close();
  }, []);

  const advance = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'advance' }));
    }
  };

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>⚔ MTG Online — M1 骨架</h1>

      <section>
        <h2>后端连通性</h2>
        {health ? (
          <ul>
            <li>引擎：{health.engine.name} v{health.engine.version}</li>
            <li>玩家：{health.engine.players.map((p) => p.name).join('、')}</li>
            <li>阶段数：{health.engine.phases.length}</li>
          </ul>
        ) : (
          <em>加载中…</em>
        )}
      </section>

      <section>
        <h2>对局视图（WebSocket）</h2>
        <div>连接状态：{conn}</div>
        {view ? (
          <ul>
            <li>回合：{view.turn} · 阶段：{view.phase}</li>
            <li>主动玩家：{view.activePlayerId}</li>
            <li>生命：{view.players.map((p) => `${p.name}=${p.life}`).join('、')}</li>
          </ul>
        ) : (
          <em>等待对局视图…</em>
        )}
        <button onClick={advance}>推进阶段</button>
      </section>

      {lastError && <p style={{ color: '#b00020' }}>⚠ {lastError}</p>}
    </main>
  );
}