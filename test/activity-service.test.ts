import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SpotifyActivityService,
  type ActivityEvent,
  type SpotifyClient,
} from '../activity-service.ts';
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
  explicit = false,
}: {
  id?: string;
  isPlaying?: boolean;
  progress?: number;
  explicit?: boolean;
} = {}) {
  return {
    is_playing: isPlaying,
    progress_ms: progress,
    item: {
      id,
      name: `Track ${id}`,
      duration_ms: 180_000,
      track_number: 2,
      explicit,
      artists: [{ id: 'artist-1', name: 'Artist One', ignored: true }],
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

function unusedSpotifyClient(
  overrides: Partial<SpotifyClient> = {},
): SpotifyClient {
  return {
    async fetchAccessToken() {
      throw new Error('Unexpected access-token exchange');
    },
    async fetchRefreshToken() {
      throw new Error('Unexpected refresh-token exchange');
    },
    async currentlyPlaying() {
      throw new Error('Unexpected playback request');
    },
    ...overrides,
  };
}

describe('SpotifyActivityService', () => {
  it('completes authorisation and reuses the access token', async () => {
    let now = 1_000;
    const storedRefreshTokens: string[] = [];
    let playbackRequests = 0;
    let refreshRequests = 0;

    const service = new SpotifyActivityService({
      config: makeConfig(),
      initialSettings: { refreshToken: '' },
      now: () => now,
      generateSecret: () => 'generated-secret',
      spotify: unusedSpotifyClient({
        async fetchAccessToken(options) {
          assert.equal(options.code, 'authorisation-code');
          assert.equal(options.clientId, 'client-id');
          return {
            access_token: 'access-token',
            expires_in: 60,
            refresh_token: 'refresh-token',
          };
        },
        async fetchRefreshToken() {
          refreshRequests += 1;
          return {
            access_token: 'unexpected',
            expires_in: 60,
          };
        },
        async currentlyPlaying() {
          playbackRequests += 1;
          return makePlayback();
        },
      }),
      async storeSettings(settings) {
        storedRefreshTokens.push(settings.refreshToken);
      },
    });

    assert.equal(service.getSetupSecret(), 'generated-secret');

    await service.completeAuthorisation('authorisation-code');

    assert.equal(service.getSetupSecret(), null);
    assert.deepEqual(storedRefreshTokens, ['refresh-token']);
    assert.deepEqual(service.getStatus(), {
      hasAccessToken: true,
      hasRefreshToken: true,
      expiresAt: 61_000,
      hasExpired: false,
      connections: 0,
    });

    const subscription = service.subscribe(() => {});
    await service.checkActivity();
    now += 1_000;
    await service.checkActivity();
    subscription.unsubscribe();

    assert.equal(refreshRequests, 0);
    assert.equal(playbackRequests, 2);
  });

  it('refreshes and persists a rotated token even while idle', async () => {
    const storedRefreshTokens: string[] = [];
    let playbackRequests = 0;

    const service = new SpotifyActivityService({
      config: makeConfig(),
      initialSettings: { refreshToken: 'old-refresh-token' },
      now: () => 10_000,
      spotify: unusedSpotifyClient({
        async fetchRefreshToken(options) {
          assert.equal(options.refreshToken, 'old-refresh-token');
          return {
            access_token: 'new-access-token',
            expires_in: 60,
            refresh_token: 'new-refresh-token',
          };
        },
        async currentlyPlaying() {
          playbackRequests += 1;
          return makePlayback();
        },
      }),
      async storeSettings(settings) {
        storedRefreshTokens.push(settings.refreshToken);
      },
    });

    await service.checkActivity();

    assert.deepEqual(storedRefreshTokens, ['new-refresh-token']);
    assert.equal(playbackRequests, 0);
    assert.equal(service.getStatus().hasAccessToken, true);
  });

  it('broadcasts changed events in order and emits null transitions', async () => {
    let playback: unknown = makePlayback();
    const events: ActivityEvent[] = [];

    const service = new SpotifyActivityService({
      config: makeConfig({ exposePausedPlayback: true }),
      initialSettings: { refreshToken: 'refresh-token' },
      now: () => 10_000,
      spotify: unusedSpotifyClient({
        async fetchRefreshToken() {
          return {
            access_token: 'access-token',
            expires_in: 60,
          };
        },
        async currentlyPlaying() {
          return playback;
        },
      }),
      async storeSettings() {},
    });

    const subscription = service.subscribe((event) => {
      events.push(event);
    });

    assert.equal(subscription.cacheIsStale, true);
    assert.equal(service.getStatus().connections, 1);

    await service.checkActivity();
    assert.deepEqual(
      events.map(({ event }) => event),
      ['track', 'state', 'progress'],
    );
    assert.equal(events[1]?.data, '"playing"');
    assert.equal(events[2]?.data, '12000');

    events.length = 0;
    playback = makePlayback({ progress: 13_000 });
    await service.checkActivity();
    assert.deepEqual(events, [{ event: 'progress', data: '13000' }]);

    events.length = 0;
    playback = null;
    await service.checkActivity();
    assert.deepEqual(events, [
      { event: 'track', data: 'null' },
      { event: 'state', data: 'null' },
      { event: 'progress', data: 'null' },
    ]);

    subscription.unsubscribe();
    assert.equal(service.getStatus().connections, 0);
  });

  it('filters paused and explicit playback according to config', async () => {
    for (const testCase of [
      {
        config: makeConfig(),
        playback: makePlayback({ isPlaying: false }),
      },
      {
        config: makeConfig({ hideExplicit: true }),
        playback: makePlayback({ explicit: true }),
      },
    ]) {
      const events: ActivityEvent[] = [];
      const service = new SpotifyActivityService({
        config: testCase.config,
        initialSettings: { refreshToken: 'refresh-token' },
        now: () => 10_000,
        spotify: unusedSpotifyClient({
          async fetchRefreshToken() {
            return {
              access_token: 'access-token',
              expires_in: 60,
            };
          },
          async currentlyPlaying() {
            return testCase.playback;
          },
        }),
        async storeSettings() {},
      });

      service.subscribe((event) => {
        events.push(event);
      });
      await service.checkActivity();

      assert.equal(service.getCurrentActivity(), null);
      assert.deepEqual(events, []);
    }
  });

  it('turns playback failures into null events and resets its check guard', async () => {
    let shouldFail = false;
    let playbackRequests = 0;
    const events: ActivityEvent[] = [];
    const loggedErrors: unknown[][] = [];

    const service = new SpotifyActivityService({
      config: makeConfig(),
      initialSettings: { refreshToken: 'refresh-token' },
      now: () => 10_000,
      logger: {
        log() {},
        error(...values) {
          loggedErrors.push(values);
        },
      },
      spotify: unusedSpotifyClient({
        async fetchRefreshToken() {
          return {
            access_token: 'access-token',
            expires_in: 60,
          };
        },
        async currentlyPlaying() {
          playbackRequests += 1;

          if (shouldFail) {
            throw new Error('Spotify unavailable');
          }

          return makePlayback();
        },
      }),
      async storeSettings() {},
    });

    service.subscribe((event) => {
      events.push(event);
    });
    await service.checkActivity();

    events.length = 0;
    shouldFail = true;
    await service.checkActivity();
    assert.deepEqual(
      events.map(({ data }) => data),
      ['null', 'null', 'null'],
    );
    assert.equal(loggedErrors.length, 1);

    shouldFail = false;
    await service.checkActivity();
    assert.equal(playbackRequests, 3);
    assert.notEqual(service.getCurrentActivity(), null);
  });

  it('does not overlap concurrent activity checks', async () => {
    let resolvePlayback!: (value: unknown) => void;
    const pendingPlayback = new Promise<unknown>((resolve) => {
      resolvePlayback = resolve;
    });
    let playbackRequests = 0;

    const service = new SpotifyActivityService({
      config: makeConfig(),
      initialSettings: { refreshToken: '' },
      now: () => 1_000,
      generateSecret: () => 'secret',
      spotify: unusedSpotifyClient({
        async fetchAccessToken() {
          return {
            access_token: 'access-token',
            expires_in: 60,
            refresh_token: 'refresh-token',
          };
        },
        async currentlyPlaying() {
          playbackRequests += 1;
          return pendingPlayback;
        },
      }),
      async storeSettings() {},
    });

    await service.completeAuthorisation('code');
    service.subscribe(() => {});

    const firstCheck = service.checkActivity();
    const secondCheck = service.checkActivity();

    await Promise.resolve();
    assert.equal(playbackRequests, 1);
    resolvePlayback(makePlayback());
    await Promise.all([firstCheck, secondCheck]);
    assert.equal(playbackRequests, 1);
  });
});
