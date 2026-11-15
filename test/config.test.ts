import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../config.ts';

const requiredEnvironment: NodeJS.ProcessEnv = {
  SPOTIFY_CLIENT_ID: 'client-id',
  SPOTIFY_CLIENT_SECRET: 'client-secret',
  STORED_SETTINGS_FILE: '/tmp/spotify-now-playing-settings.json',
};

describe('loadConfig', () => {
  it('loads defaults and derives URLs and cookie security', () => {
    const config = loadConfig({ ...requiredEnvironment });

    assert.equal(config.port, 3000);
    assert.equal(config.appUrl, 'http://127.0.0.1:3000/');
    assert.equal(config.redirectUri, 'http://127.0.0.1:3000/return');
    assert.equal(config.stateCookieSecure, false);
    assert.equal(config.trustProxy, false);
    assert.equal(config.sseAllowOrigin, '*');
  });

  it('uses the public HTTPS URL for redirects and secure cookies', () => {
    const config = loadConfig({
      ...requiredEnvironment,
      PORT: '4321',
      PUBLIC_URL: 'https://example.com/now-playing/',
    });

    assert.equal(config.port, 4321);
    assert.equal(config.appUrl, 'https://example.com/now-playing/');
    assert.equal(config.redirectUri, 'https://example.com/now-playing/return');
    assert.equal(config.stateCookieSecure, true);
  });

  it('prefers TRUST_PROXY and supports the legacy fallback', () => {
    assert.equal(
      loadConfig({
        ...requiredEnvironment,
        TRUST_PROXY: 'loopback, uniquelocal',
        EXPRESS_TRUST_PROXY: 'false',
      }).trustProxy,
      'loopback, uniquelocal',
    );

    assert.equal(
      loadConfig({
        ...requiredEnvironment,
        EXPRESS_TRUST_PROXY: 'true',
      }).trustProxy,
      true,
    );

    assert.equal(
      loadConfig({
        ...requiredEnvironment,
        TRUST_PROXY: 'false',
      }).trustProxy,
      false,
    );
  });

  it('normalizes a configured SSE origin', () => {
    assert.equal(
      loadConfig({
        ...requiredEnvironment,
        SSE_ALLOW_ORIGIN: 'https://example.com/path',
      }).sseAllowOrigin,
      'https://example.com',
    );
  });

  it('validates required values and formatted options', () => {
    assert.throws(
      () =>
        loadConfig({
          ...requiredEnvironment,
          SPOTIFY_CLIENT_ID: '',
        }),
      /Missing required environment variable SPOTIFY_CLIENT_ID/,
    );
    assert.throws(
      () => loadConfig({ ...requiredEnvironment, PORT: '70000' }),
      /Invalid PORT/,
    );
    assert.throws(
      () =>
        loadConfig({
          ...requiredEnvironment,
          ALLOW_STATIC: 'yes',
        }),
      /Invalid boolean value/,
    );
    assert.throws(
      () =>
        loadConfig({
          ...requiredEnvironment,
          PUBLIC_URL: 'not a URL',
        }),
      /Invalid PUBLIC_URL/,
    );
    assert.throws(
      () =>
        loadConfig({
          ...requiredEnvironment,
          SSE_ALLOW_ORIGIN: 'not an origin',
        }),
      /Invalid SSE_ALLOW_ORIGIN/,
    );
  });
});
