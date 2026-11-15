import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { describe, it } from 'node:test';
import { createClientIpResolver } from '../client-ip.ts';

function makeRequest(
  remoteAddress: string,
  forwardedFor?: string,
): IncomingMessage {
  return {
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
    socket: { remoteAddress },
  } as IncomingMessage;
}

describe('createClientIpResolver', () => {
  it('uses the direct socket address by default', () => {
    const resolve = createClientIpResolver(false);
    const request = makeRequest('127.0.0.1', '203.0.113.10, 10.0.0.1');

    assert.equal(resolve(request), '127.0.0.1');
  });

  it('uses the furthest address when every proxy is trusted', () => {
    const resolve = createClientIpResolver(true);
    const request = makeRequest('127.0.0.1', '203.0.113.10, 10.0.0.1');

    assert.equal(resolve(request), '203.0.113.10');
  });

  it('supports comma-separated named ranges and CIDRs', () => {
    const resolveNamed = createClientIpResolver('loopback, uniquelocal');
    assert.equal(
      resolveNamed(makeRequest('127.0.0.1', '203.0.113.10, 10.0.0.1')),
      '203.0.113.10',
    );

    const resolveCidr = createClientIpResolver('10.0.0.0/8');
    assert.equal(
      resolveCidr(makeRequest('10.0.0.2', '198.51.100.7')),
      '198.51.100.7',
    );
  });
});
