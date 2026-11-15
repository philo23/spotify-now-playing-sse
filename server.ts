import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { SpotifyActivityService } from './activity-service.ts';
import { createClientIpResolver } from './client-ip.ts';
import { loadConfig } from './config.ts';
import { readSettings, storeSettings } from './settings.ts';
import {
  currentlyPlaying,
  fetchAccessToken,
  fetchRefreshToken,
} from './spotify.ts';

const config = loadConfig(process.env);
const settings = await readSettings(config.storedSettingsFile);

const service = new SpotifyActivityService({
  config,
  initialSettings: settings,
  spotify: {
    currentlyPlaying,
    fetchAccessToken,
    fetchRefreshToken,
  },
  storeSettings: (nextSettings) =>
    storeSettings(config.storedSettingsFile, nextSettings),
});

const app = createApp({
  config,
  service,
  clientIpResolver: createClientIpResolver(config.trustProxy),
});

service.start();

serve(
  {
    fetch: app.fetch,
    port: config.port,
  },
  (info) => {
    console.log('Server started on:', info.port);

    const setupSecret = service.getSetupSecret();

    if (setupSecret) {
      const setupUrl = new URL('setup', config.appUrl);
      setupUrl.searchParams.set('secret', setupSecret);
      console.log(
        'Authorise your Spotify account to get started:',
        setupUrl.toString(),
      );
    }
  },
);
