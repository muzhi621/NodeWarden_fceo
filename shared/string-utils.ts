// Small string helpers used on request-controlled values.
//
// A regex such as /^\/+|\/+$/g or /\/+$/ is flagged as polynomial ReDoS when
// the input comes from a URL, a backup file name or an endpoint setting: the
// engine may backtrack over long runs of the repeated character. These helpers
// do the same job with a linear scan and no backtracking.

/** Remove leading and trailing '/' characters without a regular expression. */
export function stripSurroundingSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '/') start += 1;
  while (end > start && value[end - 1] === '/') end -= 1;
  return value.slice(start, end);
}

/** Remove trailing '/' characters without a regular expression. */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

/** Remove trailing occurrences of a single character (e.g. base64url '='). */
export function stripTrailingChar(value: string, char: string): string {
  if (char.length !== 1) throw new Error('stripTrailingChar expects one character');
  let end = value.length;
  while (end > 0 && value[end - 1] === char) end -= 1;
  return value.slice(0, end);
}
