A very simple (and very naive) Spotify now playing broadcasting SSE server.

Simply add setup your .env with your Spotify API credentials and start the server.

Three SSE events are emitted:

- track: when the song changes (JSON blob of track data)
- state: when playing/pausing is detected (either "playing" or "paused")
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
