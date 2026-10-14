/** An inclusive byte range, as HTTP and Node's `createReadStream` both express it. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Interprets a `Range` request header against an object of `size` bytes.
 *
 * Returns `null` when the whole object should be sent (no header, or one this
 * server chooses to ignore, which RFC 9110 permits), and `'unsatisfiable'` when
 * the range lies entirely outside the object (answer 416).
 *
 * Only a single `bytes=` range is honoured. That covers what browsers send for
 * media: Safari will not play a `<video>` at all unless `bytes=0-1` is answered
 * with a 206, and seeking issues `bytes=N-`.
 */
export function parseByteRange(
  header: string | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null; // multiple ranges or another unit: send everything

  const [, rawStart = '', rawEnd = ''] = match;
  if (rawStart === '' && rawEnd === '') return null;
  if (size === 0) return 'unsatisfiable';

  if (rawStart === '') {
    // Suffix form `bytes=-N`: the last N bytes.
    const length = Number(rawEnd);
    if (length === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - length), end: size - 1 };
  }

  const start = Number(rawStart);
  if (start >= size) return 'unsatisfiable';
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return null; // malformed; ignoring it is allowed
  return { start, end };
}
