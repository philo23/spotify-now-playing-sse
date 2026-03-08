const DEFAULT_PORT = 3000;
const DEFAULT_SSE_ALLOW_ORIGIN = '*';
export const STATE_COOKIE_NAME = 'spotify_auth_state';

export interface AppConfig {
  port: number;
  allowStatic: boolean;
  appUrl: string;
  redirectUri: string;
  sseAllowOrigin: string;
  exposePausedPlayback: boolean;
  hideExplicit: boolean;
  stateCookieSecure: boolean;
  spotifyClientId: string;
  spotifyClientSecret: string;
}

export const config: AppConfig = loadConfig(process.env);

function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const port = parsePort(env.PORT, DEFAULT_PORT);
  const appUrl = parseUrl(env.PUBLIC_URL, `http://127.0.0.1:${port}/`);
  const stateCookieSecure = parseBoolean(
    env.STATE_COOKIE_SECURE,
    new URL(appUrl).protocol === 'https:',
  );

  return {
    port,
    allowStatic: parseBoolean(env.ALLOW_STATIC, false),
    appUrl,
    redirectUri: new URL('return', appUrl).toString(),
    sseAllowOrigin: parseOrigin(env.SSE_ALLOW_ORIGIN, DEFAULT_SSE_ALLOW_ORIGIN),
    exposePausedPlayback: parseBoolean(env.EXPOSE_PAUSED_PLAYBACK, false),
    hideExplicit: parseBoolean(env.HIDE_EXPLICIT, false),
    stateCookieSecure,
    spotifyClientId: requireString('SPOTIFY_CLIENT_ID', env.SPOTIFY_CLIENT_ID),
    spotifyClientSecret: requireString(
      'SPOTIFY_CLIENT_SECRET',
      env.SPOTIFY_CLIENT_SECRET,
    ),
  };
}

function requireString(name: string, value: string | undefined): string {
  const trimmed = value?.trim();

  if (!trimmed) {
    throw new Error(`Missing required environment variable ${name}`);
  }

  return trimmed;
}

function parseBoolean(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new Error(`Invalid boolean value: ${value}`);
}

function parsePort(value: string | undefined, defaultPort: number): number {
  if (!value) {
    return defaultPort;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }

  return port;
}

function parseUrl(value: string | undefined, defaultValue: string): string {
  const rawValue = value?.trim() || defaultValue;

  try {
    return new URL(rawValue).toString();
  } catch {
    throw new Error(`Invalid PUBLIC_URL: ${rawValue}`);
  }
}

function parseOrigin(value: string | undefined, defaultValue: string): string {
  const rawValue = value?.trim() || defaultValue;

  if (rawValue === '*') {
    return rawValue;
  }

  try {
    return new URL(rawValue).origin;
  } catch {
    throw new Error(`Invalid SSE_ALLOW_ORIGIN: ${rawValue}`);
  }
}
