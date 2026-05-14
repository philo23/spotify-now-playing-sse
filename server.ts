import { createServer } from 'node:http';
import express, { type Response } from 'express';
import cookieParser from 'cookie-parser';
import { randomBytes } from 'node:crypto';
import { config, STATE_COOKIE_NAME } from './config.ts';
import {
  authoriseUrl,
  currentlyPlaying,
  fetchAccessToken,
  fetchRefreshToken,
} from './spotify.ts';
import { readSettings, storeSettings } from './settings.ts';

const settings = await readSettings();
let setupSecret =
  settings.refreshToken.length > 0 ? null : randomBytes(32).toString('hex');

let accessToken = '';
let expiresAt = 0;
let refreshToken = settings.refreshToken;

let currentActivity = null as any;
let lastActivityRefreshAt = 0;
let isCheckingActivity = false;

let lastStreamConnectionId = 0;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.expressTrustProxy);

const connections = new Set<Response>();

setInterval(() => {
  if (connections.size == 0) {
    return;
  }

  console.log('Total activity stream connections:', connections.size);
}, 60 * 1000);

const frontEnd = express.Router();
if (config.allowStatic) {
  frontEnd.use(express.static('public'));
}
frontEnd.use(cookieParser());

frontEnd.get('/setup', (req, res) => {
  const secret =
    typeof req.query.secret === 'string' ? req.query.secret : undefined;
  if (!setupSecret || secret !== setupSecret) {
    res.status(404).send('Not found');
    return;
  }

  const state = randomBytes(32).toString('hex');
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
  if (!setupSecret) {
    res.status(404).send('Not found');
    return;
  }

  const expectedState = req.cookies[STATE_COOKIE_NAME];
  const actualState =
    typeof req.query.state === 'string' ? req.query.state : undefined;

  res.clearCookie(STATE_COOKIE_NAME);

  if (!expectedState || !actualState || expectedState !== actualState) {
    res
      .status(400)
      .send(`State mismatch`);
    return;
  }

  const code = typeof req.query.code === 'string' ? req.query.code : undefined;
  if (!code) {
    res.status(400).send('Missing code');
    return;
  }

  try {
    const result = await fetchAccessToken({
      clientId: config.spotifyClientId,
      clientSecret: config.spotifyClientSecret,
      code,
      redirectUri: config.redirectUri,
    });

    setupSecret = null;
    accessToken = result.access_token;
    expiresAt = Date.now() + result.expires_in * 1000;
    refreshToken = result.refresh_token;

    await storeSettings({
      refreshToken,
    });
  } catch (err) {
    res.status(400).send(`Failed to fetch access token`);
    return;
  }

  await checkActivity();

  res.send('Authorisation successful! You can close this window now.');
});

frontEnd.get('/status', async (req, res) => {
  res.json({
    hasAccessToken: accessToken.length > 0,
    hasRefreshToken: refreshToken.length > 0,
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

  if (req.headers.origin && config.sseAllowOrigin != '*' && req.headers.origin != config.sseAllowOrigin) {
    res.status(403).send('Invalid Origin');
    return;
  }

  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Access-Control-Allow-Origin', config.sseAllowOrigin);
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const streamConnectionId = lastStreamConnectionId++;

  console.log('Activity stream started for', streamConnectionId, 'from', req.ip);

  const cacheIsStale = isActivityCacheStale();

  connections.add(res);

  const maxAgeTimeout = setTimeout(() => {
    console.log('Activity stream timeout for', streamConnectionId);

    res.end();
  }, 15 * 60 * 1000);

  const pingTimer = setInterval(() => {
    res.write(`: ping ${Date.now()}\n\n`);
  }, 5000);

  req.on('close', () => {
    console.log('Activity stream closed for', streamConnectionId);

    clearTimeout(maxAgeTimeout);
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

  if (setupSecret) {
    const setupUrl = new URL('setup', config.appUrl);
    setupUrl.searchParams.set('secret', setupSecret);
    console.log(
      'Authorise your Spotify account to get started:',
      setupUrl.toString(),
    );
  }
});

async function checkActivity(force = false) {
  if (isCheckingActivity) {
    return;
  }

  isCheckingActivity = true;

  try {
    accessToken = await getAccessToken();
  } catch (error) {
    console.log('Failed to fetch access token', error);
  }

  if (!accessToken) {
    isCheckingActivity = false;
    return;
  }

  if (!force && connections.size === 0) {
    isCheckingActivity = false;
    return;
  }

  const previousActivity = currentActivity;

  try {
    const data = await currentlyPlaying({accessToken});
    currentActivity = formatActivity(data);
    lastActivityRefreshAt = Date.now();
  } catch (error) {
    console.error('Failed to fetch currently playing track', error);
    currentActivity = null;
  }

  let trackPayload = null;
  let statePayload = null;
  let progressPayload = null;

  if (!currentActivity && previousActivity) {
    trackPayload = 'event: track\ndata: null\n\n';
  } else if (
    currentActivity &&
    currentActivity.track.id != previousActivity?.track?.id
  ) {
    trackPayload = `event: track\ndata: ${JSON.stringify(currentActivity.track)}\n\n`;
  }

  if (!currentActivity && previousActivity) {
    statePayload = 'event: state\ndata: null\n\n';
  } else if (
    currentActivity &&
    currentActivity.is_playing != previousActivity?.is_playing
  ) {
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

  if (trackPayload || statePayload || progressPayload) {
    for (const res of connections) {
      if (trackPayload) res.write(trackPayload);
      if (statePayload) res.write(statePayload);
      if (progressPayload) res.write(progressPayload);
    }
  }

  isCheckingActivity = false;
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

  if (!refreshToken) {
    return '';
  }

  const result = await fetchRefreshToken({
    clientId: config.spotifyClientId,
    clientSecret: config.spotifyClientSecret,
    refreshToken,
  });

  accessToken = result.access_token;
  expiresAt = Date.now() + result.expires_in * 1000;
  refreshToken = result.refresh_token ?? refreshToken;

  await storeSettings({
    refreshToken,
  });

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
