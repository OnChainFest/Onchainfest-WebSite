/** True if `text` contains C0 control characters or DEL (newline optionally allowed). */
export function hasControlCharacters(
  text: string,
  options: { allowNewline?: boolean } = {},
): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x0a && options.allowNewline === true) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
