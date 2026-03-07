A very simple (and very naive) Spotify now playing broadcasting SSE server.

Set up your `.env` with your Spotify API credentials and start the server.

The server now validates its runtime configuration at startup through `config.ts`.
The main settings are:

- `PORT`: HTTP port to listen on. Defaults to `3000`.
- `PUBLIC_URL`: Base public URL for the app. Defaults to `http://127.0.0.1:${PORT}/`.
- `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`: required.
- `SSE_ALLOW_ORIGIN`: `Access-Control-Allow-Origin` value for `/activity`. Defaults to `*`.
- `STATE_COOKIE_SECURE`: optional override for the OAuth state cookie. If omitted, it follows the `PUBLIC_URL` scheme.
- `ALLOW_STATIC`, `HIDE_EXPLICIT`, `EXPOSE_PAUSED_PLAYBACK`, `AUTHORISE_SECRET`: optional behavior flags.

Three SSE events are emitted:

- track: when the song changes (JSON blob of track data)
- state: when playback state changes. By default only `"playing"` is exposed; set `EXPOSE_PAUSED_PLAYBACK=true` to also emit `"paused"`.
- progress: when playback through the song is updated (current progress in milliseconds)

# Track data format

```ts
interface Artist {
  id: string;
  name: string;
}

interface AlbumArt {
  width: number;
  height: number;
  url: string;
}

interface Album {
  id: string;
  name: string;
  images: AlbumArt[];
  total_tracks: number;
}

interface Track {
  id: string;
  name: string;
  duration_ms: number;
  track_number: number;
  explicit: boolean;
  artists: Artist[];
  album: Album;
}

interface TrackState {
  is_playing: boolean;
  progress_ms: number;
  track: Track;
}
```
