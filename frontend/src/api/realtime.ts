/**
 * Authorized live updates over WebSocket.
 *
 * The browser sends the session cookie with the handshake (same-origin or
 * same-site behind the proxy). The backend checks the session and scope before
 * accepting, filters each message by department, and closes with:
 *   4401  not authenticated or session ended
 *   4403  authenticated but not allowed on this channel
 */
import { API_BASE_URL, emitSessionEnded } from "./http";

export interface LiveChannelHandlers {
  onMessage: (data: unknown) => void;
  onDenied?: () => void;
  onStatus?: (status: "connecting" | "open" | "closed") => void;
}

function toWebSocketUrl(path: string): string {
  const base = API_BASE_URL.startsWith("http") ? API_BASE_URL : `${window.location.origin}${API_BASE_URL}`;
  return `${base.replace(/^http/, "ws")}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Opens a channel and returns a function that closes it. */
export function connectLiveChannel(path: string, handlers: LiveChannelHandlers): () => void {
  let socket: WebSocket | null = null;
  let attempts = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    handlers.onStatus?.("connecting");
    socket = new WebSocket(toWebSocketUrl(path));
    socket.onopen = () => {
      attempts = 0;
      handlers.onStatus?.("open");
    };
    socket.onmessage = (event) => {
      try {
        handlers.onMessage(JSON.parse(String(event.data)));
      } catch {
        /* ignore malformed frames */
      }
    };
    socket.onclose = (event) => {
      handlers.onStatus?.("closed");
      if (stopped) return;
      if (event.code === 4401) {
        emitSessionEnded("expired");
        return;
      }
      if (event.code === 4403) {
        handlers.onDenied?.();
        return;
      }
      attempts += 1;
      timer = setTimeout(open, Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5)));
    };
  };

  open();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    socket?.close(1000, "client closed");
  };
}
