import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { PlayerProfile } from "../shared/types.js";

const COOKIE_NAME = "music_timeline_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export interface Session {
  id: string;
  createdAt: number;
  touchedAt: number;
  profile: PlayerProfile | null;
  roomCode: string | null;
}

declare global {
  namespace Express {
    interface Request {
      session: Session;
    }
  }
}

function parseCookies(header = ""): Record<string, string> {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        if (separator < 0) return [part, ""];
        return [
          decodeURIComponent(part.slice(0, separator)),
          decodeURIComponent(part.slice(separator + 1)),
        ];
      }),
  );
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export class SessionStore {
  readonly #secret: string;
  readonly #secure: boolean;
  readonly #sessions = new Map<string, Session>();

  constructor({ secret, secure }: { secret: string; secure: boolean }) {
    this.#secret = secret;
    this.#secure = secure;
  }

  #sign(id: string): string {
    return createHmac("sha256", this.#secret).update(id).digest("base64url");
  }

  #serialize(id: string): string {
    return `${id}.${this.#sign(id)}`;
  }

  #readId(cookieHeader?: string): string | null {
    const value = parseCookies(cookieHeader)[COOKIE_NAME];
    if (!value) return null;
    const separator = value.lastIndexOf(".");
    if (separator < 0) return null;
    const id = value.slice(0, separator);
    const signature = value.slice(separator + 1);
    return safeEqual(signature, this.#sign(id)) ? id : null;
  }

  #cookie(value: string, maxAge = MAX_AGE_SECONDS): string {
    const parts = [
      `${COOKIE_NAME}=${encodeURIComponent(value)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${maxAge}`,
    ];
    if (this.#secure) parts.push("Secure");
    return parts.join("; ");
  }

  middleware(): RequestHandler {
    return (request: Request, response: Response, next: NextFunction) => {
      let id = this.#readId(request.headers.cookie);
      let session = id ? this.#sessions.get(id) : undefined;

      if (!session) {
        id = randomBytes(24).toString("base64url");
        session = {
          id,
          createdAt: Date.now(),
          touchedAt: Date.now(),
          profile: null,
          roomCode: null,
        };
        this.#sessions.set(id, session);
        response.setHeader("Set-Cookie", this.#cookie(this.#serialize(id)));
      } else {
        session.touchedAt = Date.now();
      }

      request.session = session;
      next();
    };
  }

  fromCookieHeader(cookieHeader?: string): Session | null {
    const id = this.#readId(cookieHeader);
    return id ? (this.#sessions.get(id) ?? null) : null;
  }

  get(id: string): Session | null {
    return this.#sessions.get(id) ?? null;
  }

  destroy(id: string, response?: Response): void {
    this.#sessions.delete(id);
    if (response) {
      response.setHeader("Set-Cookie", this.#cookie("", 0));
    }
  }
}
