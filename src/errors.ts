const messages = {
  url: 'Provide a valid HTTP(S) endpoint.',
  transport:
    'Use HTTPS or loopback HTTP; remote HTTP requires --allow-http (allowHttp in the library). URL credentials and fragments are forbidden.',
  timeout: 'timeoutMs must be a whole number between 100 and 120000.',
  tolerance: 'maxDeliveryLagMs must be a whole number between 1 and 30000.',
  token:
    'Token must contain 32–512 RFC 6750 bearer-token characters; use a random deployment secret.',
  config:
    'Invalid diagnostic configuration. Check scenario, count, interval, idle, and heartbeat settings.',
  duration: 'The configured emission schedule must not exceed 60000 ms.',
  report:
    'Invalid or unsupported report. Use schemaVersion 1 with valid bounded diagnostic evidence.',
} as const;

/** Only enumerated, locally authored messages may cross the CLI error boundary. */
export class InputError extends TypeError {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = 'InputError';
  }
}
