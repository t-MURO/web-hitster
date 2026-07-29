const ROOM_PATH_PATTERN = /^\/room\/([a-z0-9]{5})\/?$/i;

export function normalizeRoomCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
}

export function roomPath(code: string): string {
  return `/room/${normalizeRoomCode(code)}`;
}

export function inviteCodeFromPath(pathname: string): string | null {
  const match = ROOM_PATH_PATTERN.exec(pathname);
  return match?.[1]?.toUpperCase() ?? null;
}

export function roomInviteUrl(code: string, origin: string): string {
  return new URL(roomPath(code), origin).toString();
}

export function replaceRoomPath(code: string | null): void {
  const nextPath = code ? roomPath(code) : "/";
  if (window.location.pathname !== nextPath) {
    window.history.replaceState({}, "", nextPath);
  }
}
