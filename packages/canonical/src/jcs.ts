/**
 * RFC 8785 JSON Canonicalization Scheme serializer, restricted to the value space that
 * BR-JSON v1 normalization can produce (no floating point numbers, no null).
 *
 * - object members sorted by UTF-16 code units (RFC 8785 §3.2.3);
 * - strings escaped exactly as ECMAScript JSON.stringify does (RFC 8785 §3.2.2.2), implemented
 *   explicitly here rather than delegated, so the canonical algorithm does not depend on it;
 * - numbers are safe integers only, rendered in plain decimal; -0 renders as 0.
 */
export type CanonicalValue =
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export function serializeJcs(value: CanonicalValue): string {
  if (typeof value === 'string') return serializeString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`JCS serializer received a non-safe-integer number: ${String(value)}`);
    }
    return value === 0 ? '0' : String(value);
  }
  if (Array.isArray(value)) {
    return `[${(value as readonly CanonicalValue[]).map(serializeJcs).join(',')}]`;
  }
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`JCS serializer received an unsupported value: ${String(value)}`);
  }
  const obj = value as { readonly [key: string]: CanonicalValue };
  const keys = Object.keys(obj).sort(compareUtf16);
  return `{${keys.map((k) => `${serializeString(k)}:${serializeJcs(obj[k] as CanonicalValue)}`).join(',')}}`;
}

/** Lexicographic comparison of UTF-16 code unit sequences. */
export function compareUtf16(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

const SHORT_ESCAPES: Record<number, string> = {
  0x08: '\\b',
  0x09: '\\t',
  0x0a: '\\n',
  0x0c: '\\f',
  0x0d: '\\r',
  0x22: '\\"',
  0x5c: '\\\\',
};

function serializeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const short = SHORT_ESCAPES[c];
    if (short !== undefined) out += short;
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, '0')}`;
    else out += s[i];
  }
  return `${out}"`;
}

export function canonicalBytes(value: CanonicalValue): Uint8Array {
  return new TextEncoder().encode(serializeJcs(value));
}
