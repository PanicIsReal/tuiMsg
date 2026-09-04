import { io, type Socket } from "socket.io-client";
import { parseChatGuid } from "../domain/ids.ts";
import { parseMessage } from "../domain/parse.ts";
import type { AppEvent } from "../domain/model.ts";

export type SocketHandlers = {
  dispatch: (event: AppEvent) => void
};

export function connectBbSocket(args: {
  url: string
  password: string
  handlers: SocketHandlers
}): Socket {
  const socket = io(args.url, {
    transports: ["websocket", "polling"],
    query: { password: args.password },
    autoConnect: true,
    reconnection: true,
  });

  const dispatch = (event: AppEvent) => args.handlers.dispatch(event);

  socket.on("connect", () => {
    dispatch({ type: "connection", connection: "online" });
  });
  socket.on("disconnect", () => {
    dispatch({ type: "connection", connection: "offline" });
  });
  socket.on("connect_error", () => {
    dispatch({ type: "connection", connection: "auth-failed" });
  });
  socket.on("new-message", (payload: unknown) => {
    const message = parseMessage(payload);
    if (message) dispatch({ type: "message-upserted", message });
  });
  socket.on("updated-message", (payload: unknown) => {
    const message = parseMessage(payload);
    if (message) dispatch({ type: "message-upserted", message });
  });
  socket.on("typing-indicator", (payload: unknown) => {
    if (typeof payload !== "object" || payload === null) return;
    const record = payload as Record<string, unknown>;
    const raw = typeof record.chatGuid === "string" ? record.chatGuid : typeof record.guid === "string" ? record.guid : "";
    if (raw.length === 0) return;
    try {
      dispatch({
        type: "typing",
        chatGuid: parseChatGuid(raw),
        display: record.display === true,
      });
    } catch {
      return;
    }
  });

  return socket;
}
