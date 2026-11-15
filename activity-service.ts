import { randomBytes } from 'node:crypto';
import type { AppConfig } from './config.ts';
import type { StoredSettings } from './settings.ts';
import type { AccessTokenResponse, RefreshTokenResponse } from './spotify.ts';

export interface Artist {
  id: string;
  name: string;
}

export interface AlbumArt {
  width: number;
  height: number;
  url: string;
}

export interface Album {
  id: string;
  name: string;
  images: AlbumArt[];
  total_tracks: number;
}

export interface Track {
  id: string;
  name: string;
  duration_ms: number;
  track_number: number;
  explicit: boolean;
  artists: Artist[];
  album: Album;
}

export interface Activity {
  is_playing: boolean;
  progress_ms: number;
  track: Track;
}

export interface ActivityEvent {
  event: 'track' | 'state' | 'progress';
  data: string;
}

export interface ActivityStatus {
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  expiresAt: number;
  hasExpired: boolean;
  connections: number;
}

export interface SpotifyClient {
  fetchAccessToken(options: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
  }): Promise<AccessTokenResponse>;
  fetchRefreshToken(options: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }): Promise<RefreshTokenResponse>;
  currentlyPlaying(options: { accessToken: string }): Promise<unknown>;
}

export type ActivitySubscriber = (event: ActivityEvent) => Promise<void> | void;

export interface ActivitySubscription {
  cacheIsStale: boolean;
  initialEvents: ActivityEvent[];
  unsubscribe(): void;
}

interface ServiceLogger {
  log(...values: unknown[]): void;
  error(...values: unknown[]): void;
}

export interface SpotifyActivityServiceOptions {
  config: AppConfig;
  initialSettings: StoredSettings;
  spotify: SpotifyClient;
  storeSettings(settings: StoredSettings): Promise<void>;
  now?: () => number;
  generateSecret?: () => string;
  logger?: ServiceLogger;
}

const ACTIVITY_CACHE_MAX_AGE_MS = 5_000;
const ACTIVITY_POLL_INTERVAL_MS = 1_000;
const CONNECTION_LOG_INTERVAL_MS = 60_000;

export class SpotifyActivityService {
  private readonly config: AppConfig;
  private readonly spotify: SpotifyClient;
  private readonly storeSettings: (settings: StoredSettings) => Promise<void>;
  private readonly now: () => number;
  private readonly generateSecret: () => string;
  private readonly logger: ServiceLogger;

  private setupSecret: string | null;
  private accessToken = '';
  private expiresAt = 0;
  private refreshToken: string;
  private currentActivity: Activity | null = null;
  private lastActivityRefreshAt = 0;
  private isCheckingActivity = false;
  private readonly subscribers = new Set<ActivitySubscriber>();

  private isRunning = false;
  private pollTimeout: ReturnType<typeof setTimeout> | undefined;
  private connectionLogInterval: ReturnType<typeof setInterval> | undefined;

  constructor(options: SpotifyActivityServiceOptions) {
    this.config = options.config;
    this.spotify = options.spotify;
    this.storeSettings = options.storeSettings;
    this.now = options.now ?? Date.now;
    this.generateSecret =
      options.generateSecret ?? (() => randomBytes(32).toString('hex'));
    this.logger = options.logger ?? console;
    this.refreshToken = options.initialSettings.refreshToken;
    this.setupSecret =
      this.refreshToken.length > 0 ? null : this.generateSecret();
  }

  getSetupSecret(): string | null {
    return this.setupSecret;
  }

  createOAuthState(): string {
    return this.generateSecret();
  }

  getStatus(): ActivityStatus {
    return {
      hasAccessToken: this.accessToken.length > 0,
      hasRefreshToken: this.refreshToken.length > 0,
      expiresAt: this.expiresAt,
      hasExpired: this.now() >= this.expiresAt,
      connections: this.subscribers.size,
    };
  }

  getCurrentActivity(): Activity | null {
    return this.currentActivity;
  }

  async completeAuthorisation(code: string): Promise<void> {
    const result = await this.spotify.fetchAccessToken({
      clientId: this.config.spotifyClientId,
      clientSecret: this.config.spotifyClientSecret,
      code,
      redirectUri: this.config.redirectUri,
    });

    this.setupSecret = null;
    this.accessToken = result.access_token;
    this.expiresAt = this.now() + result.expires_in * 1000;
    this.refreshToken = result.refresh_token;

    await this.storeSettings({
      refreshToken: this.refreshToken,
    });
  }

  subscribe(subscriber: ActivitySubscriber): ActivitySubscription {
    const cacheIsStale = this.isActivityCacheStale();
    const initialEvents =
      !cacheIsStale && this.currentActivity
        ? allActivityEvents(this.currentActivity)
        : [];

    this.subscribers.add(subscriber);

    return {
      cacheIsStale,
      initialEvents,
      unsubscribe: () => {
        this.subscribers.delete(subscriber);
      },
    };
  }

  async checkActivity(force = false): Promise<void> {
    if (this.isCheckingActivity) {
      return;
    }

    this.isCheckingActivity = true;

    try {
      try {
        this.accessToken = await this.getAccessToken();
      } catch (error) {
        this.logger.log('Failed to fetch access token', error);
      }

      if (!this.accessToken) {
        return;
      }

      if (!force && this.subscribers.size === 0) {
        return;
      }

      const previousActivity = this.currentActivity;

      try {
        const data = await this.spotify.currentlyPlaying({
          accessToken: this.accessToken,
        });
        this.currentActivity = formatActivity(data, this.config);
        this.lastActivityRefreshAt = this.now();
      } catch (error) {
        this.logger.error('Failed to fetch currently playing track', error);
        this.currentActivity = null;
      }

      await this.broadcast(
        changedActivityEvents(previousActivity, this.currentActivity),
      );
    } finally {
      this.isCheckingActivity = false;
    }
  }

  start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    const poll = async () => {
      await this.checkActivity();

      if (this.isRunning) {
        this.pollTimeout = setTimeout(
          () => void poll(),
          ACTIVITY_POLL_INTERVAL_MS,
        );
      }
    };

    void poll();

    this.connectionLogInterval = setInterval(() => {
      if (this.subscribers.size > 0) {
        this.logger.log(
          'Total activity stream connections:',
          this.subscribers.size,
        );
      }
    }, CONNECTION_LOG_INTERVAL_MS);
  }

  stop(): void {
    this.isRunning = false;

    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = undefined;
    }

    if (this.connectionLogInterval) {
      clearInterval(this.connectionLogInterval);
      this.connectionLogInterval = undefined;
    }
  }

  private isActivityCacheStale(): boolean {
    return this.now() - this.lastActivityRefreshAt > ACTIVITY_CACHE_MAX_AGE_MS;
  }

  private async getAccessToken(): Promise<string> {
    if (this.now() < this.expiresAt) {
      return this.accessToken;
    }

    if (!this.refreshToken) {
      return '';
    }

    const result = await this.spotify.fetchRefreshToken({
      clientId: this.config.spotifyClientId,
      clientSecret: this.config.spotifyClientSecret,
      refreshToken: this.refreshToken,
    });

    this.accessToken = result.access_token;
    this.expiresAt = this.now() + result.expires_in * 1000;
    this.refreshToken = result.refresh_token ?? this.refreshToken;

    await this.storeSettings({
      refreshToken: this.refreshToken,
    });

    return this.accessToken;
  }

  private async broadcast(events: ActivityEvent[]): Promise<void> {
    if (events.length === 0 || this.subscribers.size === 0) {
      return;
    }

    await Promise.all(
      [...this.subscribers].map(async (subscriber) => {
        try {
          for (const event of events) {
            await subscriber(event);
          }
        } catch {
          this.subscribers.delete(subscriber);
        }
      }),
    );
  }
}

function allActivityEvents(activity: Activity): ActivityEvent[] {
  return [
    {
      event: 'track',
      data: JSON.stringify(activity.track),
    },
    {
      event: 'state',
      data: JSON.stringify(activity.is_playing ? 'playing' : 'paused'),
    },
    {
      event: 'progress',
      data: String(activity.progress_ms),
    },
  ];
}

function changedActivityEvents(
  previousActivity: Activity | null,
  currentActivity: Activity | null,
): ActivityEvent[] {
  if (!currentActivity && previousActivity) {
    return [
      { event: 'track', data: 'null' },
      { event: 'state', data: 'null' },
      { event: 'progress', data: 'null' },
    ];
  }

  if (!currentActivity) {
    return [];
  }

  const events: ActivityEvent[] = [];

  if (currentActivity.track.id !== previousActivity?.track.id) {
    events.push({
      event: 'track',
      data: JSON.stringify(currentActivity.track),
    });
  }

  if (currentActivity.is_playing !== previousActivity?.is_playing) {
    events.push({
      event: 'state',
      data: JSON.stringify(currentActivity.is_playing ? 'playing' : 'paused'),
    });
  }

  if (currentActivity.progress_ms !== previousActivity?.progress_ms) {
    events.push({
      event: 'progress',
      data: String(currentActivity.progress_ms),
    });
  }

  return events;
}

function formatActivity(data: unknown, config: AppConfig): Activity | null {
  if (!data) {
    return null;
  }

  const playback = data as any;

  if (!config.exposePausedPlayback && !playback.is_playing) {
    return null;
  }

  if (config.hideExplicit && playback.item.explicit) {
    return null;
  }

  return {
    is_playing: playback.is_playing,
    progress_ms: playback.progress_ms,
    track: {
      id: playback.item.id,
      name: playback.item.name,
      duration_ms: playback.item.duration_ms,
      track_number: playback.item.track_number,
      explicit: playback.item.explicit,
      artists: playback.item.artists.map(
        ({ id, name }: { id: string; name: string }) => ({
          id,
          name,
        }),
      ),
      album: {
        id: playback.item.album.id,
        name: playback.item.album.name,
        images: playback.item.album.images,
        total_tracks: playback.item.album.total_tracks,
      },
    },
  };
}
