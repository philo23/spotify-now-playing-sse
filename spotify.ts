export function authoriseUrl({
  clientId,
  state,
  redirectUri,
}: {
  clientId: string;
  state: string;
  redirectUri: string;
}): string {
  const url = new URL('https://accounts.spotify.com/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set(
    'scope',
    ['user-read-playback-state', 'user-read-currently-playing'].join(' '),
  );
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);

  return url.toString();
}

interface AccessTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
}
interface RefreshTokenResponse {
  access_token: string;
  expires_in: number;
}

export async function fetchAccessToken({
  clientId,
  clientSecret,
  code,
  redirectUri,
}: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<AccessTokenResponse> {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: basicAuth(clientId, clientSecret),
    },
    body: new URLSearchParams({
      code: code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (res.status != 200) {
    throw new Error(
      `Failed to generate OAuth token status=${res.status} ${await res.text()}`,
    );
  }

  return (await res.json()) as AccessTokenResponse;
}

export async function fetchRefreshToken({
  clientId,
  clientSecret,
  refreshToken,
}: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<RefreshTokenResponse> {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: basicAuth(clientId, clientSecret),
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });

  if (res.status != 200) {
    throw new Error(
      `Failed to refresh OAuth token status=${res.status} ${await res.text()}`,
    );
  }

  return (await res.json()) as RefreshTokenResponse;
}

export async function currentlyPlaying({
  accessToken,
}: {
  accessToken: string;
}): Promise<any> {
  const res = await fetch('https://api.spotify.com/v1/me/player?market=GB', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (res.status == 200) {
    return await res.json();
  } else if (res.status == 204) {
    return null;
  }

  throw new Error(
    `Failed to fetch currently playing track data ${res.status} ${await res.text()}`,
  );
}

function basicAuth(username: string, password: string) {
  return `Basic ${btoa(username + ':' + password)}`;
}
