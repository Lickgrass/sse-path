import { InputError } from './errors.js';
import { LIMITS, validatePolicy, validateToken } from './limits.js';
import type { ProbeOptions, Report } from './types.js';

/** Side-effect-free validation, reusable before reserving CLI output. */
export function validateProbeInput(
  address: string,
  options: ProbeOptions = {},
): { url: URL; policy: Report['policy'] } {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new InputError('url');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol === 'http:' && !loopback && !options.allowHttp)
  )
    throw new InputError('transport');
  const policy = validatePolicy(
    options.timeoutMs ?? LIMITS.timeoutMs.default,
    options.maxDeliveryLagMs ?? LIMITS.maxDeliveryLagMs.default,
  );
  if (options.token !== undefined) validateToken(options.token);
  return { url, policy };
}
