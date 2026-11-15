import type { IncomingMessage } from 'node:http';
import proxyAddr from 'proxy-addr';

export type ClientIpResolver = (request: IncomingMessage) => string | undefined;

export function createClientIpResolver(
  trustProxy: string | boolean,
): ClientIpResolver {
  if (trustProxy === false) {
    return (request) => request.socket.remoteAddress;
  }

  const trust =
    trustProxy === true
      ? () => true
      : proxyAddr.compile(
          trustProxy
            .split(',')
            .map((address) => address.trim())
            .filter(Boolean),
        );

  return (request) => proxyAddr(request, trust);
}
