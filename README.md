A very simple (and very naive) Spotify now playing broadcasting SSE server.

Set up your `.env` with your Spotify API credentials and start the server.

The server now validates its runtime configuration at startup through `config.ts`.
The main settings are:

- `PORT`: HTTP port to listen on. Defaults to `3000`.
- `PUBLIC_URL`: Base public URL for the app. Defaults to `http://127.0.0.1:${PORT}/`.
- `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`: required.
- `STORED_SETTINGS_FILE`: required path to the JSON file where settings are stored.
- `SSE_ALLOW_ORIGIN`: `Access-Control-Allow-Origin` value for `/activity`. Defaults to `*`.
- `STATE_COOKIE_SECURE`: optional override for the OAuth state cookie. If omitted, it follows the `PUBLIC_URL` scheme.
- `TRUST_PROXY`: optional proxy addresses or named ranges to trust when resolving
  the client IP written to connection logs. Boolean values are also supported.
  `EXPRESS_TRUST_PROXY` remains available as a legacy fallback.
- `ALLOW_STATIC`, `HIDE_EXPLICIT`, `EXPOSE_PAUSED_PLAYBACK`: optional behavior flags.

While the stored settings file is missing or has no refresh token, a one-time setup link is printed in the console to authorise your Spotify account.

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

## Run with Docker

Create `.env` from `.env.example` and fill in your Spotify credentials. Use
unquoted values with Docker's `--env-file` and keep `PORT=3000` for this example.

```sh
docker build -t spotify-now-playing .
docker run -d --init --name spotify-now-playing \
  --env-file .env \
  -e STORED_SETTINGS_FILE=/data/settings.json \
  -p 3000:3000 \
  -v spotify-now-playing-data:/data \
  spotify-now-playing
docker logs spotify-now-playing
```

Register `http://127.0.0.1:3000/return` in your Spotify app settings. For a remote
deployment, set `PUBLIC_URL` to your public HTTPS base URL and register its
`/return` callback. [Spotify redirect URI requirements](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri)

Open the setup link from the container logs to authorise Spotify. The named
volume keeps the refresh token when you replace the container.

## Pull the image from GitHub Container Registry

The [publish workflow](.github/workflows/publish-image.yml) builds a Linux
`amd64` image on every push to `master` and tags it with the commit SHA and
`latest`. GitHub creates new packages as private. To pull a private image,
sign in to GHCR using a personal access token (classic) with `read:packages`.
[GitHub Container Registry authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-with-a-personal-access-token-classic)

```sh
docker pull ghcr.io/philo23/spotify-now-playing-sse:latest
```

Use `ghcr.io/philo23/spotify-now-playing-sse:latest` as the image name in the
`docker run` command above.
