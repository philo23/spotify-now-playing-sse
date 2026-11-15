import { fileURLToPath } from 'node:url';
import type { HttpBindings } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import type { SpotifyActivityService } from './activity-service.ts';
import type { ClientIpResolver } from './client-ip.ts';
import { STATE_COOKIE_NAME, type AppConfig } from './config.ts';
import { authoriseUrl } from './spotify.ts';

export interface CreateAppOptions {
  config: AppConfig;
  service: SpotifyActivityService;
  clientIpResolver: ClientIpResolver;
  streamMaxAgeMs?: number;
  streamPingIntervalMs?: number;
}

const PUBLIC_DIRECTORY = fileURLToPath(new URL('./public', import.meta.url));
const STREAM_MAX_AGE_MS = 15 * 60 * 1000;
const STREAM_PING_INTERVAL_MS = 30 * 1000;

export function createApp({
  config,
  service,
  clientIpResolver,
  streamMaxAgeMs = STREAM_MAX_AGE_MS,
  streamPingIntervalMs = STREAM_PING_INTERVAL_MS,
}: CreateAppOptions) {
  const app = new Hono<{ Bindings: HttpBindings }>();
  let lastStreamConnectionId = 0;

  if (config.allowStatic) {
    app.use('*', serveStatic({ root: PUBLIC_DIRECTORY }));
  }

  app.get('/setup', (context) => {
    const secret = context.req.query('secret');

    if (!service.getSetupSecret() || secret !== service.getSetupSecret()) {
      return context.html('Not found', 404);
    }

    const state = service.createOAuthState();
    setCookie(context, STATE_COOKIE_NAME, state, {
      httpOnly: true,
      secure: config.stateCookieSecure,
      sameSite: 'Lax',
      path: '/',
    });

    return context.redirect(
      authoriseUrl({
        clientId: config.spotifyClientId,
        state,
        redirectUri: config.redirectUri,
      }),
    );
  });

  app.get('/return', async (context) => {
    if (!service.getSetupSecret()) {
      return context.html('Not found', 404);
    }

    const expectedState = getCookie(context, STATE_COOKIE_NAME);
    const actualState = context.req.query('state');

    deleteCookie(context, STATE_COOKIE_NAME, { path: '/' });

    if (!expectedState || !actualState || expectedState !== actualState) {
      return context.html('State mismatch', 400);
    }

    const code = context.req.query('code');

    if (!code) {
      return context.html('Missing code', 400);
    }

    try {
      await service.completeAuthorisation(code);
    } catch {
      return context.html('Failed to fetch access token', 400);
    }

    await service.checkActivity();

    return context.html(
      'Authorisation successful! You can close this window now.',
    );
  });

  app.get('/status', (context) => context.json(service.getStatus()));

  app.get('/raw', (context) => context.json(service.getCurrentActivity()));

  app.get('/activity', (context) => {
    const accept = context.req.header('Accept');

    if (!accept || !accept.includes('text/event-stream')) {
      return context.html('Invalid Accept header', 400);
    }

    const origin = context.req.header('Origin');

    if (
      origin &&
      config.sseAllowOrigin !== '*' &&
      origin !== config.sseAllowOrigin
    ) {
      return context.html('Invalid Origin', 403);
    }

    context.header('Cache-Control', 'no-cache');
    context.header('Access-Control-Allow-Origin', config.sseAllowOrigin);
    context.header('Connection', 'keep-alive');

    const streamConnectionId = lastStreamConnectionId++;
    const incomingRequest = context.env?.incoming;
    const clientIp = incomingRequest
      ? clientIpResolver(incomingRequest)
      : undefined;

    console.log(
      'Activity stream started for',
      streamConnectionId,
      'from',
      clientIp,
    );

    return streamSSE(context, async (stream) => {
      let closeStream: () => void = () => {};
      const streamClosed = new Promise<void>((resolve) => {
        let closed = false;

        closeStream = () => {
          if (!closed) {
            closed = true;
            resolve();
          }
        };
      });

      stream.onAbort(closeStream);

      const subscription = service.subscribe((event) => stream.writeSSE(event));

      const maxAgeTimeout = setTimeout(() => {
        console.log('Activity stream timeout for', streamConnectionId);
        closeStream();
      }, streamMaxAgeMs);

      const pingTimer = setInterval(() => {
        void stream.write(': \n\n').catch(closeStream);
      }, streamPingIntervalMs);

      try {
        for (const event of subscription.initialEvents) {
          await stream.writeSSE(event);
        }

        if (subscription.cacheIsStale) {
          void service.checkActivity(true);
        }

        await streamClosed;
      } finally {
        clearTimeout(maxAgeTimeout);
        clearInterval(pingTimer);
        subscription.unsubscribe();

        console.log('Activity stream closed for', streamConnectionId);
      }
    });
  });

  return app;
}
