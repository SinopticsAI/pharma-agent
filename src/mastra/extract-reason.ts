/** Short reason written to the item webhook when /extract fails after the item is found. */

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
