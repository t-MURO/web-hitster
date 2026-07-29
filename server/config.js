const DEFAULT_PORT = 4317;

function asBoolean(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

export function loadConfig(env = process.env) {
  const port = Number.parseInt(env.PORT ?? String(DEFAULT_PORT), 10);
  const publicBaseUrl = trimTrailingSlash(
    env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`,
  );
  const isProduction = env.NODE_ENV === "production";

  return {
    port,
    publicBaseUrl,
    isProduction,
    demoMode: asBoolean(env.DEMO_MODE),
    spotifyClientId: env.SPOTIFY_CLIENT_ID ?? "",
    spotifyClientSecret: env.SPOTIFY_CLIENT_SECRET ?? "",
    sessionSecret: env.SESSION_SECRET ?? "development-only-change-me",
    cookieSecure: asBoolean(env.COOKIE_SECURE, publicBaseUrl.startsWith("https://")),
    disconnectGraceMs: Number.parseInt(env.DISCONNECT_GRACE_MS ?? "120000", 10),
    deckSize: Number.parseInt(env.DECK_SIZE ?? "50", 10),
    winningTimelineSize: Number.parseInt(env.WINNING_TIMELINE_SIZE ?? "10", 10),
  };
}

export function validateConfig(config) {
  const errors = [];

  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    errors.push("PORT must be a valid TCP port.");
  }

  if (!config.demoMode && (!config.spotifyClientId || !config.spotifyClientSecret)) {
    errors.push("SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are required.");
  }

  if (
    config.isProduction &&
    (!config.sessionSecret || config.sessionSecret === "development-only-change-me")
  ) {
    errors.push("SESSION_SECRET must be set to a strong random value in production.");
  }

  if (config.deckSize < 12) {
    errors.push("DECK_SIZE must be at least 12.");
  }

  return errors;
}
