/**
 * Error classes for Wanderlog CLI
 * All errors have exitCode property and redacted toString()
 */

export class WanderlogError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WanderlogError';
    this.exitCode = 1;
  }

  toString() {
    return redact(this.message);
  }
}

export class CLIError extends WanderlogError {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'CLIError';
    this.exitCode = exitCode;
  }
}

export class AuthRequiredError extends WanderlogError {
  constructor(message = 'Authentication required. Run: wlog auth login') {
    super(message);
    this.name = 'AuthRequiredError';
    this.exitCode = 3;
  }
}

export class AuthExpiredError extends WanderlogError {
  constructor(message = 'Auth token expired. Run: wlog auth login') {
    super(message);
    this.name = 'AuthExpiredError';
    this.exitCode = 3;
  }
}

export class NotFoundError extends WanderlogError {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.exitCode = 4;
  }
}

export class ConfirmationRequiredError extends WanderlogError {
  constructor(message) {
    super(message);
    this.name = 'ConfirmationRequiredError';
    this.exitCode = 5;
  }
}

export class ConfirmRequiredError extends ConfirmationRequiredError {
  constructor(message) {
    super(message);
    this.name = 'ConfirmRequiredError';
  }
}

export class UsageError extends WanderlogError {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = 2;
  }
}

export class ValidationError extends WanderlogError {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.exitCode = 1;
  }
}

export class TokenCorruptError extends WanderlogError {
  constructor(message = 'Stored Wanderlog token is corrupt. Run: wlog auth login') {
    super(message);
    this.name = 'TokenCorruptError';
    this.exitCode = 1;
  }
}

export class BrowserUnavailableError extends WanderlogError {
  constructor(message = 'Browser cookie export unavailable. Log in to Wanderlog in Chrome or pass --cookie') {
    super(message);
    this.name = 'BrowserUnavailableError';
    this.exitCode = 1;
  }
}

export class ApiError extends WanderlogError {
  constructor(message, status = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.exitCode = 1;
  }
}

export class NetworkError extends WanderlogError {
  constructor(message = 'Network error while contacting Wanderlog') {
    super(message);
    this.name = 'NetworkError';
    this.exitCode = 1;
  }
}

/**
 * Redact sensitive fields from messages/logs
 * Never expose: cookie, token, password, secret, auth, connect.sid
 */
export function redact(value, key = '') {
  if (typeof value !== 'string') return value;

  const sensitivePatterns = [
    /connect\.sid=([^\s;]+)/gi,
    /WANDERLOG_COOKIE=([^\s;]+)/gi,
    /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
    /token['\"]?\s*[:=]\s*['\"]?[A-Za-z0-9\-._~+/]+=*['\"]?/gi,
    /password['\"]?\s*[:=]\s*['\"]?[^'\"]*/gi,
  ];

  let redacted = value;
  sensitivePatterns.forEach(pattern => {
    redacted = redacted.replace(pattern, '[REDACTED]');
  });

  // Check key name without hiding safe status/path fields.
  const lowerKey = key.toLowerCase();
  const safeKeys = new Set(['authenticated', 'tokenpath', 'configdir']);
  if (!safeKeys.has(lowerKey) && (
    lowerKey === 'value' ||
    lowerKey === 'cookie' ||
    lowerKey === 'cookies' ||
    lowerKey === 'token' ||
    lowerKey === 'password' ||
    lowerKey === 'secret' ||
    lowerKey === 'auth' ||
    lowerKey === 'authorization' ||
    lowerKey.endsWith('cookie') ||
    lowerKey.endsWith('token') ||
    lowerKey.endsWith('password') ||
    lowerKey.endsWith('secret')
  )) {
    return '[REDACTED]';
  }

  return redacted;
}

export function getExitCode(error) {
  if (error instanceof WanderlogError) {
    return error.exitCode;
  }
  return 1;
}
