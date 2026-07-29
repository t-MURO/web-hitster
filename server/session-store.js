import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const COOKIE_NAME = "music_timeline_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

function parseCookies(header = "") {
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

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export class SessionStore {
  #secret;
  #secure;
  #sessions = new Map();

  constructor({ secret, secure }) {
    this.#secret = secret;
    this.#secure = secure;
  }

  #sign(id) {
    return createHmac("sha256", this.#secret).update(id).digest("base64url");
  }

  #serialize(id) {
    return `${id}.${this.#sign(id)}`;
  }

  #readId(cookieHeader) {
    const value = parseCookies(cookieHeader)[COOKIE_NAME];
    if (!value) return null;
    const separator = value.lastIndexOf(".");
    if (separator < 0) return null;
    const id = value.slice(0, separator);
    const signature = value.slice(separator + 1);
    return safeEqual(signature, this.#sign(id)) ? id : null;
  }

  #cookie(value, maxAge = MAX_AGE_SECONDS) {
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

  middleware() {
    return (request, response, next) => {
      let id = this.#readId(request.headers.cookie);
      let session = id ? this.#sessions.get(id) : null;

      if (!session) {
        id = randomBytes(24).toString("base64url");
        session = {
          id,
          createdAt: Date.now(),
          touchedAt: Date.now(),
          spotify: null,
          oauthState: null,
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

  fromCookieHeader(cookieHeader) {
    const id = this.#readId(cookieHeader);
    return id ? this.#sessions.get(id) ?? null : null;
  }

  get(id) {
    return this.#sessions.get(id) ?? null;
  }

  destroy(id, response) {
    this.#sessions.delete(id);
    if (response) {
      response.setHeader("Set-Cookie", this.#cookie("", 0));
    }
  }
}
