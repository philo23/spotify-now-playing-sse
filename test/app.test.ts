import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SpotifyActivityService,
  type SpotifyClient,
} from '../activity-service.ts';
import { createApp } from '../app.ts';
import type { AppConfig } from '../config.ts';

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 3000,
    allowStatic: false,
    appUrl: 'http://127.0.0.1:3000/',
    redirectUri: 'http://127.0.0.1:3000/return',
    trustProxy: false,
    sseAllowOrigin: '*',
    exposePausedPlayback: false,
    hideExplicit: false,
    stateCookieSecure: false,
    spotifyClientId: 'client-id',
    spotifyClientSecret: 'client-secret',
    storedSettingsFile: '/tmp/settings.json',
    ...overrides,
  };
}

function makePlayback({
  id = 'track-1',
  isPlaying = true,
  progress = 12_000,
}: {
  id?: string;
  isPlaying?: boolean;
  progress?: number;
} = {}) {
  return {
    is_playing: isPlaying,
    progress_ms: progress,
    item: {
      id,
      name: `Track ${id}`,
      duration_ms: 180_000,
      track_number: 2,
      explicit: false,
      artists: [{ id: 'artist-1', name: 'Artist One' }],
      album: {
        id: 'album-1',
        name: 'Album One',
        images: [
          {
            width: 640,
            height: 640,
            url: 'https://example.com/art.jpg',
          },
        ],
        total_tracks: 10,
      },
    },
  };
}

function makeService({
  config = makeConfig(),
  refreshToken = '',
  now = () => 10_000,
  generateSecret = () => 'secret',
  spotify = {},
  storeSettings = async () => {},
}: {
  config?: AppConfig;
  refreshToken?: string;
  now?: () => number;
  generateSecret?: () => string;
  spotify?: Partial<SpotifyClient>;
  storeSettings?: (settings: { refreshToken: string }) => Promise<void>;
} = {}) {
  const client: SpotifyClient = {
    async fetchAccessToken() {
      throw new Error('Unexpected access-token exchange');
    },
    async fetchRefreshToken() {
      throw new Error('Unexpected refresh-token exchange');
    },
    async currentlyPlaying() {
      throw new Error('Unexpected playback request');
    },
    ...spotify,
  };

  return new SpotifyActivityService({
    config,
    initialSettings: { refreshToken },
    now,
    generateSecret,
    spotify: client,
    storeSettings,
    logger: {
      log() {},
      error() {},
    },
  });
}

function makeApp(
  config: AppConfig,
  service: SpotifyActivityService,
  streamOptions: {
    streamMaxAgeMs?: number;
    streamPingIntervalMs?: number;
  } = {},
) {
  return createApp({
    config,
    service,
    clientIpResolver: () => '127.0.0.1',
    ...streamOptions,
  });
}

async function readStreamUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expected: string,
  timeoutMs = 1_000,
): Promise<string> {
  const decoder = new TextDecoder();
  let contents = '';
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`Timed out waiting for ${expected}`)),
      timeoutMs,
    );
  });

  try {
    while (!contents.includes(expected)) {
      const result = await Promise.race([reader.read(), timeout]);

      if (result.done) {
        break;
      }

      contents += decoder.decode(result.value, { stream: true });
    }
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }

  return contents;
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const expiresAt = Date.now() + timeoutMs;

  while (!condition()) {
    if (Date.now() >= expiresAt) {
      throw new Error('Timed out waiting for condition');
    }

    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe('Hono app', () => {
  it('protects setup and redirects with the OAuth state cookie', async () => {
    const config = makeConfig({
      stateCookieSecure: true,
      appUrl: 'https://example.com/',
      redirectUri: 'https://example.com/return',
    });
    const generatedSecrets = ['setup-secret', 'oauth-state'];
    const service = makeService({
      config,
      generateSecret: () => generatedSecrets.shift() ?? 'unexpected',
    });
    const app = makeApp(config, service);

    const missingSecret = await app.request('/setup');
    assert.equal(missingSecret.status, 404);
    assert.equal(await missingSecret.text(), 'Not found');
    assert.match(
      missingSecret.headers.get('content-type') ?? '',
      /^text\/html/,
    );

    const response = await app.request('/setup?secret=setup-secret');

    assert.equal(response.status, 302);
    const location = new URL(assertNonNull(response.headers.get('location')));
    assert.equal(location.origin, 'https://accounts.spotify.com');
    assert.equal(location.searchParams.get('response_type'), 'code');
    assert.equal(location.searchParams.get('client_id'), 'client-id');
    assert.equal(
      location.searchParams.get('redirect_uri'),
      'https://example.com/return',
    );
    assert.equal(location.searchParams.get('state'), 'oauth-state');
    assert.equal(
      location.searchParams.get('scope'),
      'user-read-playback-state user-read-currently-playing',
    );

    const cookie = assertNonNull(response.headers.get('set-cookie'));
    assert.match(cookie, /^spotify_auth_state=oauth-state;/);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
  });

  it('validates the OAuth return and clears the state cookie', async () => {
    const config = makeConfig();

    for (const testCase of [
      {
        path: '/return?state=actual&code=code',
        cookie: 'spotify_auth_state=expected',
        body: 'State mismatch',
      },
      {
        path: '/return?state=expected',
        cookie: 'spotify_auth_state=expected',
        body: 'Missing code',
      },
    ]) {
      const app = makeApp(config, makeService({ config }));
      const response = await app.request(testCase.path, {
        headers: { Cookie: testCase.cookie },
      });

      assert.equal(response.status, 400);
      assert.equal(await response.text(), testCase.body);
      const clearCookie = assertNonNull(response.headers.get('set-cookie'));
      assert.match(clearCookie, /^spotify_auth_state=/);
      assert.match(clearCookie, /Path=\//);
      assert.match(clearCookie, /Max-Age=0/);
    }
  });

  it('handles failed and successful access-token exchanges', async () => {
    const config = makeConfig();
    const failedService = makeService({
      config,
      spotify: {
        async fetchAccessToken() {
          throw new Error('Spotify rejected the code');
        },
      },
    });
    const failedResponse = await makeApp(config, failedService).request(
      '/return?state=state&code=bad-code',
      {
        headers: { Cookie: 'spotify_auth_state=state' },
      },
    );

    assert.equal(failedResponse.status, 400);
    assert.equal(await failedResponse.text(), 'Failed to fetch access token');

    const storedTokens: string[] = [];
    const successfulService = makeService({
      config,
      spotify: {
        async fetchAccessToken(options) {
          assert.equal(options.code, 'good-code');
          return {
            access_token: 'access-token',
            expires_in: 3_600,
            refresh_token: 'refresh-token',
          };
        },
      },
      async storeSettings(settings) {
        storedTokens.push(settings.refreshToken);
      },
    });
    const app = makeApp(config, successfulService);
    const successfulResponse = await app.request(
      '/return?state=state&code=good-code',
      {
        headers: { Cookie: 'spotify_auth_state=state' },
      },
    );

    assert.equal(successfulResponse.status, 200);
    assert.equal(
      await successfulResponse.text(),
      'Authorisation successful! You can close this window now.',
    );
    assert.deepEqual(storedTokens, ['refresh-token']);

    const status = await app.request('/status');
    assert.deepEqual(await status.json(), {
      hasAccessToken: true,
      hasRefreshToken: true,
      expiresAt: 3_610_000,
      hasExpired: false,
      connections: 0,
    });

    const repeatedReturn = await app.request('/return');
    assert.equal(repeatedReturn.status, 404);
  });

  it('serves status, raw activity, and optional static files', async () => {
    const staticConfig = makeConfig({ allowStatic: true });
    const staticApp = makeApp(
      staticConfig,
      makeService({ config: staticConfig }),
    );
    const index = await staticApp.request('/');

    assert.equal(index.status, 200);
    assert.match(await index.text(), /Spotify Now Playing/);

    const config = makeConfig();
    const service = makeService({
      config,
      refreshToken: 'refresh-token',
      spotify: {
        async fetchRefreshToken() {
          return {
            access_token: 'access-token',
            expires_in: 60,
          };
        },
        async currentlyPlaying() {
          return makePlayback();
        },
      },
    });
    await service.checkActivity(true);

    const app = makeApp(config, service);
    const raw = await app.request('/raw');
    const activity = (await raw.json()) as {
      track: { id: string };
      progress_ms: number;
    };
    assert.equal(activity.track.id, 'track-1');
    assert.equal(activity.progress_ms, 12_000);

    const noStatic = await app.request('/');
    assert.equal(noStatic.status, 404);
  });

  it('validates SSE Accept and Origin headers', async () => {
    const config = makeConfig({
      sseAllowOrigin: 'https://allowed.example',
    });
    const app = makeApp(config, makeService({ config }));

    const invalidAccept = await app.request('/activity');
    assert.equal(invalidAccept.status, 400);
    assert.equal(await invalidAccept.text(), 'Invalid Accept header');

    const invalidOrigin = await app.request('/activity', {
      headers: {
        Accept: 'text/event-stream',
        Origin: 'https://denied.example',
      },
    });
    assert.equal(invalidOrigin.status, 403);
    assert.equal(await invalidOrigin.text(), 'Invalid Origin');
  });

  it('streams a fresh snapshot and cleans up an aborted client', async () => {
    const config = makeConfig();
    const service = makeService({
      config,
      refreshToken: 'refresh-token',
      spotify: {
        async fetchRefreshToken() {
          return {
            access_token: 'access-token',
            expires_in: 60,
          };
        },
        async currentlyPlaying() {
          return makePlayback();
        },
      },
    });
    await service.checkActivity(true);

    const response = await makeApp(config, service).request('/activity', {
      headers: { Accept: 'text/event-stream' },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.match(
      response.headers.get('content-type') ?? '',
      /^text\/event-stream/,
    );
    assert.equal(service.getStatus().connections, 1);

    const reader = assertNonNull(response.body).getReader();
    const contents = await readStreamUntil(
      reader,
      'event: progress\ndata: 12000\n\n',
    );

    assert.match(contents, /event: track\ndata: \{"id":"track-1"/);
    assert.match(contents, /event: state\ndata: "playing"\n\n/);

    await reader.cancel();
    await waitFor(() => service.getStatus().connections === 0);
  });

  it('forces a stale refresh and broadcasts null transitions', async () => {
    const config = makeConfig();
    let playback: unknown = makePlayback();
    const service = makeService({
      config,
      spotify: {
        async fetchAccessToken() {
          return {
            access_token: 'access-token',
            expires_in: 60,
            refresh_token: 'refresh-token',
          };
        },
        async currentlyPlaying() {
          return playback;
        },
      },
    });
    await service.completeAuthorisation('code');

    const response = await makeApp(config, service).request('/activity', {
      headers: {
        Accept: 'application/json, text/event-stream',
      },
    });
    const reader = assertNonNull(response.body).getReader();

    try {
      const initial = await readStreamUntil(
        reader,
        'event: progress\ndata: 12000\n\n',
      );
      assert.match(initial, /event: track/);

      await new Promise<void>((resolve) => setImmediate(resolve));
      playback = null;
      const clearActivity = service.checkActivity(true);
      const cleared = await readStreamUntil(
        reader,
        'event: progress\ndata: null\n\n',
      );
      await clearActivity;
      assert.match(cleared, /event: track\ndata: null\n\n/);
      assert.match(cleared, /event: state\ndata: null\n\n/);
    } finally {
      await reader.cancel();
      await waitFor(() => service.getStatus().connections === 0);
    }
  });

  it('writes comment pings and closes streams at maximum age', async () => {
    const config = makeConfig();
    const service = makeService({
      config,
      now: () => 0,
    });
    const app = makeApp(config, service, {
      streamPingIntervalMs: 5,
      streamMaxAgeMs: 30,
    });
    const response = await app.request('/activity', {
      headers: { Accept: 'text/event-stream' },
    });
    const reader = assertNonNull(response.body).getReader();

    const ping = await readStreamUntil(reader, ': \n\n');
    assert.match(ping, /: \n\n/);

    let reachedEnd = false;

    while (!reachedEnd) {
      const result = await reader.read();
      reachedEnd = result.done;
    }

    await waitFor(() => service.getStatus().connections === 0);
  });
});

function assertNonNull<T>(value: T | null): T {
  assert.notEqual(value, null);
  return value as T;
}
