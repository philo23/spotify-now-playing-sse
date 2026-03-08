import { createServer } from 'node:http';
import express, { type Response } from 'express';
import cookieParser from 'cookie-parser';
import { redis } from 'bun';
import { randomUUID } from 'node:crypto';
import { config, STATE_COOKIE_NAME } from './config.ts';
import {
  authoriseUrl,
  currentlyPlaying,
  fetchAccessToken,
  fetchRefreshToken,
} from './spotify.ts';

let accessToken = '';
let expiresAt = 0;

let currentActivity = null as any;
let lastActivityRefreshAt = 0;
let isCheckingActivity = false;

const app = express();
app.disable('x-powered-by');

const connections = new Set<Response>();

const frontEnd = express.Router();
if (config.allowStatic) {
  frontEnd.use(express.static('public'));
}
frontEnd.use(cookieParser());

frontEnd.get('/authorise', (req, res) => {
  if (req.query.secret !== config.authoriseSecret) {
    res.status(401).send('Unauthorized');
    return;
  }

  const state = randomUUID();
  res.cookie(STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure: config.stateCookieSecure,
    sameSite: 'lax',
  });
  res.redirect(
    authoriseUrl({
      clientId: config.spotifyClientId,
      state,
      redirectUri: config.redirectUri,
    }),
  );
});

frontEnd.get('/return', async (req, res) => {
  const expectedState = req.cookies[STATE_COOKIE_NAME];
  const actualState = req.query.state;

  res.clearCookie(STATE_COOKIE_NAME);

  if (expectedState !== actualState) {
    res
      .status(400)
      .send(`State mismatch expected ${expectedState} got ${actualState}`);
    return;
  }

  const code = req.query.code as string;

  try {
    const result = await fetchAccessToken({
      clientId: config.spotifyClientId,
      clientSecret: config.spotifyClientSecret,
      code,
      redirectUri: config.redirectUri,
    });

    await redis.set('spotify_refresh_token', result.refresh_token);

    accessToken = result.access_token;
    expiresAt = Date.now() + result.expires_in * 1000;
  } catch (err) {
    res.status(400).send(`Failed to fetch access token: ${err}`);
    return;
  }

  await checkActivity();

  res.send('Authorisation successful! You can close this window now.');
});

frontEnd.get('/status', async (req, res) => {
  const refreshTokenExists = await redis.exists('spotify_refresh_token');

  res.json({
    hasAccessToken: accessToken.length > 0,
    hasRefreshToken: refreshTokenExists,
    expiresAt: expiresAt,
    hasExpired: Date.now() >= expiresAt,
    connections: connections.size,
  });
});

app.use(frontEnd);

app.get('/raw', async (req, res) => {
  res.json(currentActivity);
});

app.get('/activity', (req, res) => {
  if (
    !req.headers.accept ||
    !req.headers.accept.includes('text/event-stream')
  ) {
    res.status(400).send('Invalid Accept header');
    return;
  }

  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Access-Control-Allow-Origin', config.sseAllowOrigin);
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const cacheIsStale = isActivityCacheStale();

  connections.add(res);

  const pingTimer = setInterval(() => {
    res.write(`: ping ${Date.now()}\n\n`);
  }, 5000);

  req.on('close', () => {
    clearInterval(pingTimer);
    connections.delete(res);
    res.end();
  });

  if (!cacheIsStale && currentActivity) {
    res.write(
      `event: track\ndata: ${JSON.stringify(currentActivity.track)}\n\n`,
    );
    res.write(
      `event: state\ndata: ${JSON.stringify(currentActivity.is_playing ? 'playing' : 'paused')}\n\n`,
    );
    res.write(`event: progress\ndata: ${currentActivity.progress_ms}\n\n`);
  }

  if (cacheIsStale) {
    void checkActivity(true);
  }
});

const server = createServer(app);
server.listen(config.port, () => {
  console.log('Server started on:', config.port);
});

async function checkActivity(force = false) {
  if (isCheckingActivity) {
    return;
  }

  isCheckingActivity = true;

  try {
    const accessToken = await getAccessToken();
    if (!accessToken) {
      return;
    }

    if (!force && connections.size === 0) {
      return;
    }

    const data = await currentlyPlaying({ accessToken });
    const previousActivity = currentActivity;
    currentActivity = formatActivity(data);
    lastActivityRefreshAt = Date.now();

    let trackPayload = null;
    let statePayload = null;
    let progressPayload = null;

    if (!currentActivity && previousActivity) {
      trackPayload = 'event: track\ndata: null\n\n';
    } else if (currentActivity.track.id != previousActivity?.track?.id) {
      trackPayload = `event: track\ndata: ${JSON.stringify(currentActivity.track)}\n\n`;
    }

    if (!currentActivity && previousActivity) {
      statePayload = 'event: state\ndata: null\n\n';
    } else if (currentActivity.is_playing != previousActivity?.is_playing) {
      statePayload = `event: state\ndata: ${JSON.stringify(currentActivity.is_playing ? 'playing' : 'paused')}\n\n`;
    }

    if (!currentActivity && previousActivity) {
      progressPayload = 'event: progress\ndata: null\n\n';
    } else if (
      currentActivity &&
      currentActivity.progress_ms != previousActivity?.progress_ms
    ) {
      progressPayload = `event: progress\ndata: ${currentActivity.progress_ms}\n\n`;
    }

    if (!trackPayload && !statePayload && !progressPayload) {
      return;
    }

    for (const res of connections) {
      if (trackPayload) res.write(trackPayload);
      if (statePayload) res.write(statePayload);
      if (progressPayload) res.write(progressPayload);
    }
  } catch (error) {
    console.error('Failed to fetch currently playing track', error);
  } finally {
    isCheckingActivity = false;
  }
}

async function pollActivity() {
  await checkActivity();
  setTimeout(pollActivity, 1000);
}

void pollActivity();

function isActivityCacheStale() {
  return Date.now() - lastActivityRefreshAt > 5000;
}

async function getAccessToken() {
  if (Date.now() < expiresAt) {
    return accessToken;
  }

  const refreshToken = await redis.get('spotify_refresh_token');
  if (!refreshToken) {
    throw new Error('No refresh token available');
  }

  const result = await fetchRefreshToken({
    clientId: config.spotifyClientId,
    clientSecret: config.spotifyClientSecret,
    refreshToken,
  });

  accessToken = result.access_token;
  expiresAt = Date.now() + result.expires_in * 1000;

  return accessToken;
}

function formatActivity(data: any) {
  if (!data) {
    return null;
  } else if (!config.exposePausedPlayback && !data.is_playing) {
    return null;
  } else if (config.hideExplicit && data.item.explicit) {
    return null;
  }

  return {
    is_playing: data.is_playing,
    progress_ms: data.progress_ms,
    track: {
      id: data.item.id,
      name: data.item.name,
      duration_ms: data.item.duration_ms,
      track_number: data.item.track_number,
      explicit: data.item.explicit,
      artists: data.item.artists.map(
        ({ id, name }: { id: string; name: string }) => ({ id, name }),
      ),
      album: {
        id: data.item.album.id,
        name: data.item.album.name,
        images: data.item.album.images,
        total_tracks: data.item.album.total_tracks,
      },
    },
  };
}
