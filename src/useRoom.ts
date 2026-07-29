import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type {
  RoomActionResponse,
  RoomActionResult,
  RoomCommand,
  RoomSnapshot,
} from "../shared/types.js";
import { replaceRoomPath } from "./room-url.js";

export interface RoomConnection {
  room: RoomSnapshot | null;
  connected: boolean;
  connectionError: string;
  createRoom: () => Promise<RoomActionResult>;
  joinRoom: (code: string) => Promise<RoomActionResult>;
  command: RoomCommand;
}

interface RoomClientError extends Error {
  code?: string;
}

export function useRoom(enabled: boolean): RoomConnection {
  const socketRef = useRef<Socket | null>(null);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState("");

  useEffect(() => {
    if (!enabled) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      setRoom(null);
      setConnected(false);
      return undefined;
    }

    const socket = io({ autoConnect: true });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      setConnectionError("");
      socket.timeout(10_000).emit(
        "room:action",
        { type: "resume" },
        (timeoutError: Error | null, response?: RoomActionResponse) => {
          if (!timeoutError && response?.ok) {
            setRoom(response.result.snapshot);
            if (response.result.snapshot) {
              replaceRoomPath(response.result.snapshot.code);
            }
          }
        },
      );
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", (error: Error) => {
      setConnectionError(error.message || "Realtime connection failed.");
    });
    socket.on("room:state", (snapshot: RoomSnapshot) => {
      setRoom(snapshot);
      replaceRoomPath(snapshot.code);
    });
    socket.on("room:left", () => {
      setRoom(null);
      replaceRoomPath(null);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [enabled]);

  const action = useCallback(
    (type: "create" | "join" | "command", payload: Record<string, unknown> = {}) => {
      const socket = socketRef.current;
      if (!socket?.connected) {
        return Promise.reject(
          new Error("The room connection is not ready."),
        ) as Promise<RoomActionResult>;
      }

      return new Promise<RoomActionResult>((resolve, reject) => {
        socket.timeout(15_000).emit(
          "room:action",
          { type, payload },
          (timeoutError: Error | null, response?: RoomActionResponse) => {
            if (timeoutError) {
              reject(new Error("The room did not respond in time."));
            } else if (!response?.ok) {
              const error = new Error(
                response?.error.message ?? "The action failed.",
              ) as RoomClientError;
              error.code = response?.error.code;
              reject(error);
            } else {
              if (response.result.snapshot) {
                setRoom(response.result.snapshot);
                replaceRoomPath(response.result.snapshot.code);
              } else if (response.result.left) {
                setRoom(null);
                replaceRoomPath(null);
              }
              resolve(response.result);
            }
          },
        );
      });
    },
    [],
  );

  const command = useCallback<RoomCommand>(
    (type, payload = {}) =>
      action("command", { code: room?.code, type, payload }),
    [action, room?.code],
  );

  return {
    room,
    connected,
    connectionError,
    createRoom: () => action("create"),
    joinRoom: (code: string) => action("join", { code }),
    command,
  };
}
