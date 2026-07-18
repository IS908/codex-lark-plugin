const PRIVATE_KEY_BLOCK = /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi;

export function redactContinuationText(value: string): string {
  return value
    .replace(PRIVATE_KEY_BLOCK, '[redacted-private-key]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted]')
    .replace(/\bxapp-[A-Za-z0-9-]{20,}\b/g, '[redacted]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, '[redacted]')
    .replace(/\bsk-proj-[A-Za-z0-9_-]{20,}\b/g, '[redacted]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[redacted]')
    .replace(/\b(?:sk|pk|api|token|secret)[-_][a-zA-Z0-9]{12,}\b/gi, '[redacted]')
    .replace(/\b(Bearer|Basic)\s+[a-zA-Z0-9._~+/-]+=*/gi, '$1 [redacted]')
    .replace(/((?:app|tenant)_access_token|aws_secret_access_key|aws_session_token|authorization|password|secret|token|api[_-]?key)\s*[:=]\s*["']?[^"'\s,;]+/gi, '$1=[redacted]');
}
