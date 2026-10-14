import { type ZodError } from 'zod';

/**
 * Turns a ZodError into a flat list of `path: message` strings.
 *
 * Only the path and the validator's message are emitted — never the offending
 * value, which for configuration would mean printing secrets into the logs.
 */
export function formatZodError(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}
