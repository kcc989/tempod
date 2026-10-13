/** Bun supports header options even when the shared DOM library supplies the global constructor type. */
interface HeaderWebSocketConstructor {
  new (url: string, options: Bun.WebSocketOptions): WebSocket;
}

// SAFETY: this module runs only in Bun, whose WebSocket constructor accepts Bun.WebSocketOptions.
const HeaderWebSocket = WebSocket as typeof WebSocket & HeaderWebSocketConstructor;

export const connectWebSocket = (url: string, options: Bun.WebSocketOptions): WebSocket =>
  new HeaderWebSocket(url, options);
