import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';

/**
 * Raised when a webhook destination violates the egress policy
 * (docs/EGRESS-POLICY.md § Webhook destinations). Deliveries that fail with
 * this error are dead-lettered immediately and never retried.
 */
export class EgressPolicyViolation extends Error {
  readonly code = 'EGRESS_POLICY_VIOLATION';
  constructor(message: string) {
    super(message);
    this.name = 'EgressPolicyViolation';
  }
}

/** @deprecated use EgressPolicyViolation */
export { EgressPolicyViolation as WebhookEgressPolicyError };

/**
 * Machine-readable webhook egress rules. scripts/check-egress-policy.mjs
 * verifies docs/EGRESS-POLICY.md stays in sync with these values.
 */
export const WEBHOOK_EGRESS_RULES = {
  allowedProtocols: ['https:'],
  allowedPorts: ['443'],
  blockedHostnameSuffixes: ['localhost', '.localhost', '.local', '.internal'],
  blockedIpv4Cidrs: [
    '0.0.0.0/8',
    '10.0.0.0/8',
    '100.64.0.0/10',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.0.0.0/24',
    '192.0.2.0/24',
    '192.88.99.0/24',
    '192.168.0.0/16',
    '198.18.0.0/15',
    '198.51.100.0/24',
    '203.0.113.0/24',
    '224.0.0.0/4',
    '240.0.0.0/4',
  ],
  allowlistEnvVar: 'WEBHOOK_EGRESS_ALLOWLIST',
} as const;

/**
 * Optional destination allowlist from WEBHOOK_EGRESS_ALLOWLIST: comma-separated
 * hostnames, with `*.example.com` matching any subdomain of example.com.
 * Empty / unset means any public HTTPS host is allowed.
 */
export function getWebhookEgressAllowlist(): string[] {
  return (process.env[WEBHOOK_EGRESS_RULES.allowlistEnvVar] ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function isHostAllowlisted(hostname: string, allowlist = getWebhookEgressAllowlist()): boolean {
  if (allowlist.length === 0) return true;
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return allowlist.some((pattern) =>
    pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1 : host === pattern,
  );
}

function ipv4ToNumber(address: string): number {
  return address.split('.').reduce((value, octet) => (value * 256 + Number(octet)) >>> 0, 0);
}

function isPublicIpv4(address: string): boolean {
  const value = ipv4ToNumber(address);
  const blockedRanges: Array<[number, number]> = WEBHOOK_EGRESS_RULES.blockedIpv4Cidrs.map((cidr) => {
    const [network, prefix] = cidr.split('/');
    return [ipv4ToNumber(network!), Number(prefix)];
  });

  return !blockedRanges.some(([network, prefix]) => {
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    return ((value & mask) >>> 0) === network;
  });
}

function ipv6ToBigInt(address: string): bigint {
  const halves = address.toLowerCase().split('::');
  if (halves.length > 2) {
    throw new EgressPolicyViolation('Invalid IPv6 address');
  }

  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups =
    halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;

  if (groups.length !== 8 || groups.some((group) => !/^[\da-f]{1,4}$/.test(group))) {
    throw new EgressPolicyViolation('Invalid IPv6 address');
  }

  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function isPublicIpv6(address: string): boolean {
  const value = ipv6ToBigInt(address);
  const globalUnicastPrefix = value >> 125n;
  const documentationPrefix = BigInt('0x20010db8') << 96n;
  const documentationMask = ((1n << 32n) - 1n) << 96n;
  const documentationRangePrefix = BigInt('0x3fff') << 112n;
  const documentationRangeMask = ((1n << 20n) - 1n) << 108n;
  const transitionPrefix = BigInt('0x20010000') << 96n;
  const transitionMask = ((1n << 23n) - 1n) << 96n;

  return (
    globalUnicastPrefix === 1n &&
    (value & documentationMask) !== documentationPrefix &&
    (value & documentationRangeMask) !== documentationRangePrefix &&
    (value & transitionMask) !== transitionPrefix &&
    (value >> 112n) !== 0x2002n
  );
}

function isPublicAddress(address: string): boolean {
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) must be checked as IPv4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicIpv4(mapped[1]!);
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function parseWebhookUrl(callbackUrl: string): URL {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    throw new EgressPolicyViolation('callbackUrl must be a valid URL');
  }

  if (
    url.protocol !== 'https:' ||
    (url.port !== '' && url.port !== '443') ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new EgressPolicyViolation(
      'callbackUrl must use HTTPS on port 443 without credentials or a fragment',
    );
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new EgressPolicyViolation('callbackUrl hostname is not allowed');
  }

  if (!isHostAllowlisted(hostname)) {
    throw new EgressPolicyViolation('callbackUrl hostname is not on the webhook egress allowlist');
  }

  return url;
}

async function resolvePublicAddresses(hostname: string): Promise<Array<{ address: string; family: number }>> {
  const literalFamily = isIP(hostname);
  // DNS failures propagate as ordinary (retryable) errors, not policy violations.
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname, { all: true, verbatim: true });

  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new EgressPolicyViolation(
      'callbackUrl must resolve exclusively to globally routable IP addresses',
    );
  }

  return addresses;
}

export async function validateWebhookUrl(callbackUrl: string): Promise<void> {
  const url = parseWebhookUrl(callbackUrl);
  await resolvePublicAddresses(url.hostname.replace(/^\[|\]$/g, ''));
}

export interface WebhookHttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
}

export async function sendWebhookRequest(
  callbackUrl: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<WebhookHttpResponse> {
  const url = parseWebhookUrl(callbackUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await resolvePublicAddresses(hostname);
  const destination = addresses[0];

  if (!destination) {
    throw new EgressPolicyViolation('callbackUrl did not resolve to an address');
  }

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: destination.address,
        family: destination.family,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        agent: false,
        servername: isIP(hostname) ? undefined : hostname,
        headers: {
          ...headers,
          host: url.host,
        },
      },
      (response) => {
        response.resume();
        response.once('end', () => {
          clearTimeout(timeoutHandle);
          const status = response.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            statusText: response.statusMessage ?? '',
          });
        });
      },
    );

    const timeoutHandle = setTimeout(() => {
      request.destroy(new Error(`Webhook request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeoutHandle.unref?.();
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Webhook request timed out after ${timeoutMs}ms`));
    });
    request.once('error', (error) => {
      clearTimeout(timeoutHandle);
      reject(error);
    });
    request.end(body);
  });
}
