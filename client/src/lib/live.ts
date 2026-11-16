import { useEffect, useRef, useState } from 'react';
import type { ServerMessage } from '../../../server/src/shared/types';

export type LiveStatus = 'connecting' | 'live' | 'offline';

/**
 * Keeps a WebSocket open to /ws with automatic reconnection. After a reconnect the
 * handler receives a synthetic "changed" message so the caller refetches anything missed.
 */
export function useLive(onMessage: (m: ServerMessage) => void, enabled = true): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const handler = useRef(onMessage);
  handler.current = onMessage;

  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let stopped = false;
    let attempt = 0;
    let timer: number | undefined;
    let everConnected = false;

    const connect = () => {
      setStatus('connecting');
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}/ws`);
      ws.onopen = () => {
        attempt = 0;
        setStatus('live');
        if (everConnected) handler.current({ type: 'changed', roles: [], gm: true, catalog: true });
        everConnected = true;
      };
      ws.onmessage = (ev) => {
        try {
          handler.current(JSON.parse(String(ev.data)) as ServerMessage);
        } catch {
          /* ignore malformed */
        }
      };
      ws.onclose = (ev) => {
        if (stopped) return;
        setStatus('offline');
        if (ev.code === 4001) {
          window.dispatchEvent(new Event('ledger:unauthorized'));
          return;
        }
        attempt++;
        timer = window.setTimeout(connect, Math.min(10_000, 500 * 2 ** Math.min(attempt, 5)));
      };
    };
    connect();
    const onVisible = () => {
      if (document.visibilityState === 'visible' && ws && ws.readyState > 1) {
        window.clearTimeout(timer);
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      ws?.close();
    };
  }, [enabled]);

  return status;
}

/** Re-renders the component on an interval (for countdowns). */
export function useTicker(ms: number, active = true): number {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setN((n) => n + 1), ms);
    return () => window.clearInterval(id);
  }, [ms, active]);
  return Date.now();
}

/** Coalesces bursts of calls into one (e.g. several "changed" messages → one refetch). */
export function useDebounced(fn: () => void, ms: number): () => void {
  const ref = useRef(fn);
  ref.current = fn;
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return useRef(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => ref.current(), ms);
  }).current;
}
