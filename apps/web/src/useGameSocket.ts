/**
 * useGameSocket —— 与后端对局会话的 WebSocket 通道（M10）。
 * 负责连接、收发 `play_action`、维护视图 / 事件日志 / 连接状态。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientView, CombatState, GameAction, GameEvent, ServerMessage, StackItemLite } from './types';

const MAX_LOG = 200;

export interface GameSocket {
  view: ClientView | null;
  /** 我方玩家 id。 */
  you: string | null;
  events: GameEvent[];
  conn: 'connecting' | 'open' | 'closed';
  error: string | null;
  attackersDeclared: boolean;
  blockersDeclared: boolean;
  combat: CombatState;
  stack: StackItemLite[];
  send: (action: GameAction) => void;
  clearError: () => void;
}

const EMPTY_COMBAT: CombatState = { attackers: [], blocks: [] };

export function useGameSocket(): GameSocket {
  const [view, setView] = useState<ClientView | null>(null);
  const [you, setYou] = useState<string | null>(null);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [conn, setConn] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [attackersDeclared, setAttackersDeclared] = useState(false);
  const [blockersDeclared, setBlockersDeclared] = useState(false);
  const [combat, setCombat] = useState<CombatState>(EMPTY_COMBAT);
  const [stack, setStack] = useState<StackItemLite[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    wsRef.current = ws;
    let intentionallyClosed = false;

    ws.onopen = () => {
      if (ws === wsRef.current) setConn('open');
    };
    ws.onclose = () => {
      if (ws === wsRef.current) setConn('closed');
    };
    ws.onerror = () => {
      if (!intentionallyClosed && ws === wsRef.current) setError('WebSocket 连接错误');
    };
    ws.onmessage = (e) => {
      // StrictMode 双挂载会短暂存在两个连接；只接受当前连接的消息，避免重复会话事件
      if (ws !== wsRef.current) return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(e.data as string) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === 'error') {
        setError(msg.message);
        return;
      }
      setView(msg.view);
      setAttackersDeclared(msg.attackersDeclared ?? false);
      setBlockersDeclared(msg.blockersDeclared ?? false);
      setCombat(msg.combat ?? EMPTY_COMBAT);
      setStack(msg.stack ?? []);
      const incoming = msg.events ?? [];
      if (msg.type === 'game_start') {
        // 新对局：重置事件流与身份（StrictMode 会短暂建立两次连接，第二次连接即新的会话）
        setYou(msg.you);
        setEvents(incoming.slice(-MAX_LOG));
      } else if (incoming.length > 0) {
        setEvents((prev) => [...prev, ...incoming].slice(-MAX_LOG));
      }
    };

    return () => {
      intentionallyClosed = true;
      ws.close();
    };
  }, []);

  const send = useCallback((action: GameAction) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'play_action', action }));
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return {
    view,
    you,
    events,
    conn,
    error,
    attackersDeclared,
    blockersDeclared,
    combat,
    stack,
    send,
    clearError,
  };
}
