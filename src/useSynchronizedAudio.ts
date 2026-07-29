import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RoomCommand, RoomSnapshot } from "../shared/types.js";

interface SynchronizedAudioState {
  hosted: boolean;
  enabled: boolean;
  loading: boolean;
  ready: boolean;
  allReady: boolean;
  readyCount: number;
  requiredCount: number;
  error: string;
  enable: () => Promise<void>;
}

function stopSource(source: AudioBufferSourceNode | null): void {
  if (!source) return;
  try {
    source.stop();
  } catch {
    // A source that already ended cannot be stopped again.
  }
  source.disconnect();
}

async function audioError(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as
    | { error?: { message?: string } }
    | null;
  return payload?.error?.message ?? "The round audio could not be loaded.";
}

export function useSynchronizedAudio(
  room: RoomSnapshot,
  command: RoomCommand,
): SynchronizedAudioState {
  const hosted = room.deck?.audioMode === "hosted";
  const roundNumber = room.game?.roundNumber ?? 0;
  const contextRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const loadedRoundRef = useRef(0);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [bufferVersion, setBufferVersion] = useState(0);
  const [loadAttempt, setLoadAttempt] = useState(0);

  const enable = useCallback(async () => {
    let context = contextRef.current;
    if (!context || context.state === "closed") {
      context = new AudioContext();
      contextRef.current = context;
    }
    await context.resume();
    setEnabled(true);
    setError("");
    setLoadAttempt((value) => value + 1);
  }, []);

  useEffect(
    () => () => {
      stopSource(sourceRef.current);
      sourceRef.current = null;
      const context = contextRef.current;
      contextRef.current = null;
      if (context && context.state !== "closed") void context.close();
    },
    [],
  );

  useEffect(() => {
    if (!hosted || !enabled || roundNumber < 1) return undefined;
    const context = contextRef.current;
    if (!context) return undefined;

    const controller = new AbortController();
    bufferRef.current = null;
    loadedRoundRef.current = 0;
    setBufferVersion((value) => value + 1);
    setLoading(true);
    setError("");

    void fetch(`/api/rooms/${room.code}/audio/${roundNumber}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(await audioError(response));
        return response.arrayBuffer();
      })
      .then((bytes) => context.decodeAudioData(bytes))
      .then(async (buffer) => {
        if (controller.signal.aborted) return;
        bufferRef.current = buffer;
        loadedRoundRef.current = roundNumber;
        setBufferVersion((value) => value + 1);
        await command("audioReady", { roundNumber });
      })
      .catch((requestError: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          requestError instanceof Error
            ? requestError.message
            : "The round audio could not be loaded.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [command, enabled, hosted, loadAttempt, room.code, roundNumber]);

  const {
    status,
    cueVersion,
    startAt,
    positionMs,
  } = room.playback;
  useEffect(() => {
    stopSource(sourceRef.current);
    sourceRef.current = null;

    if (
      !hosted ||
      !enabled ||
      status !== "playing" ||
      loadedRoundRef.current !== roundNumber
    ) {
      return undefined;
    }
    const context = contextRef.current;
    const buffer = bufferRef.current;
    if (!context || !buffer || startAt == null) return undefined;

    const delaySeconds = Math.max(0, startAt - Date.now()) / 1000;
    const elapsedMs = Math.max(0, Date.now() - startAt);
    const offsetSeconds =
      (positionMs + (Date.now() >= startAt ? elapsedMs : 0)) / 1000;
    if (offsetSeconds >= buffer.duration) return undefined;

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(context.currentTime + delaySeconds, offsetSeconds);
    sourceRef.current = source;

    return () => {
      if (sourceRef.current === source) sourceRef.current = null;
      stopSource(source);
    };
  }, [
    bufferVersion,
    cueVersion,
    enabled,
    hosted,
    positionMs,
    roundNumber,
    startAt,
    status,
  ]);

  const connectedPlayerIds = useMemo(
    () =>
      room.players
        .filter((player) => player.connected)
        .map((player) => player.id),
    [room.players],
  );
  const readyPlayerIds = room.playback.readyPlayerIds;
  const readyCount = connectedPlayerIds.filter((id) =>
    readyPlayerIds.includes(id),
  ).length;

  return {
    hosted,
    enabled,
    loading,
    ready: readyPlayerIds.includes(room.viewerId),
    allReady:
      connectedPlayerIds.length > 0 &&
      connectedPlayerIds.every((id) => readyPlayerIds.includes(id)),
    readyCount,
    requiredCount: connectedPlayerIds.length,
    error,
    enable,
  };
}
