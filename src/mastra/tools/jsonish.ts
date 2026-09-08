/**
 * Qwen's OpenAI-compatible contour sends nested tool arguments as JSON
 * strings: an array arrives as `"[{...}]"`, an object as `"{...}"`, a
 * boolean as `"false"` or `"False"`. Zod then rejects the call, the card
 * never writes, and the cabinet maps `fields` as if it were an array.
 *
 * Parse the string when it is JSON; leave anything else for the inner
 * schema so a garbage value stays a Zod error, not a silent empty list.
 */

import { z, type ZodTypeAny } from 'zod';

function parseJsonString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

export function jsonish<T extends ZodTypeAny>(schema: T) {
  return z.preprocess(parseJsonString, schema);
}

export function boolish(schema: z.ZodBoolean = z.boolean()) {
  return z.preprocess((value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const folded = value.trim().toLowerCase();
      if (folded === 'true') return true;
      if (folded === 'false') return false;
    }
    return parseJsonString(value);
  }, schema);
}
