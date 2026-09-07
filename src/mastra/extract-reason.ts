/** Short reason written to the item webhook when /extract fails after the item is found. */

/**
 * Who has to act next. `unreadable` means the scan is the problem and a better
 * photo helps; `service` means reading broke on our side and asking for another
 * photo only sends the person round in circles with a perfectly good licence.
 */
export type ExtractFailure = 'service' | 'unreadable';

/** The person can fix these by sending a different file. Everything else is ours. */
const USER_FIXABLE = new Set(['too_large', 'wrong_format']);

export function extractFailureReason(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') {
    return 'vision_timeout: model did not answer in time';
  }
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code?: unknown }).code ?? '');
    const message =
      error instanceof Error
        ? error.message
        : String((error as { message?: unknown }).message ?? '');
    if (code === 'too_large') return 'file too large; send a photo under 4 MB';
    if (code) return `${code}: ${message}`.slice(0, 240);
  }
  if (error instanceof Error && error.message) return error.message.slice(0, 240);
  return 'extract failed';
}

export function extractFailureKind(error: unknown): ExtractFailure {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code?: unknown }).code ?? '');
    if (USER_FIXABLE.has(code)) return 'unreadable';
  }
  return 'service';
}
