import { CanonicalError, CanonicalErrorCode } from './errors';

/** Rule 6: maximum significant digits for decimals. */
export const MAX_DECIMAL_DIGITS = 38;

const DECIMAL_INPUT = /^([+-])?([0-9]+)(?:\.([0-9]+))?$/;

interface DecimalParts {
  negative: boolean;
  intPart: string; // no leading zeros except a single "0"
  fracPart: string; // raw fraction digits
}

function parseDecimalInput(input: string, path: string): DecimalParts {
  if (/[eE]/.test(input)) {
    throw new CanonicalError(
      CanonicalErrorCode.DECIMAL_EXPONENT,
      path,
      `exponent notation is not allowed: ${JSON.stringify(input)}`,
    );
  }
  const m = DECIMAL_INPUT.exec(input);
  if (m === null) {
    throw new CanonicalError(
      CanonicalErrorCode.DECIMAL_SYNTAX,
      path,
      `not a decimal: ${JSON.stringify(input)}`,
    );
  }
  return {
    negative: m[1] === '-',
    intPart: (m[2] ?? '0').replace(/^0+(?=.)/, ''),
    fracPart: m[3] ?? '',
  };
}

function assertDigitBudget(intPart: string, fracPart: string, path: string): void {
  const significant = (intPart + fracPart).replace(/^0+/, '');
  if (significant.length > MAX_DECIMAL_DIGITS) {
    throw new CanonicalError(
      CanonicalErrorCode.DECIMAL_TOO_LONG,
      path,
      `more than ${MAX_DECIMAL_DIGITS} significant digits`,
    );
  }
}

/**
 * Rule 6: canonical decimal. No exponent, no "+", no leading zeros, no trailing fractional
 * zeros, zero is always "0" (never "-0").
 */
export function normalizeDecimal(input: string, path: string): string {
  const { negative, intPart, fracPart } = parseDecimalInput(input, path);
  const frac = fracPart.replace(/0+$/, '');
  assertDigitBudget(intPart, frac, path);
  const isZero = intPart === '0' && frac === '';
  const body = frac === '' ? intPart : `${intPart}.${frac}`;
  return negative && !isZero ? `-${body}` : body;
}

/**
 * Rule 7: Mark.value carries exactly `precision` fraction digits. No rounding, no padding.
 * Equivalent sign/leading-zero spellings are normalized; zero is never negative.
 */
export function normalizeMarkValue(input: string, precision: number, path: string): string {
  const { negative, intPart, fracPart } = parseDecimalInput(input, path);
  if (fracPart.length !== precision) {
    throw new CanonicalError(
      CanonicalErrorCode.MARK_PRECISION,
      path,
      `expected exactly ${precision} fraction digit(s), got ${fracPart.length} in ${JSON.stringify(input)}`,
    );
  }
  assertDigitBudget(intPart, fracPart, path);
  const isZero = intPart === '0' && /^0*$/.test(fracPart);
  const body = precision === 0 ? intPart : `${intPart}.${fracPart}`;
  return negative && !isZero ? `-${body}` : body;
}

const TIMESTAMP_INPUT =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?([Zz]|[+-][0-9]{2}:[0-9]{2})$/;

function daysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

function validateCalendar(
  year: number,
  month: number,
  day: number,
  path: string,
  code: CanonicalErrorCode,
): void {
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new CanonicalError(code, path, 'invalid calendar date');
  }
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/**
 * Rule 8: RFC 3339 → canonical `YYYY-MM-DDTHH:MM:SS.sssZ` (UTC, exactly 3 fraction digits).
 * Offsets are converted to UTC; digits beyond milliseconds must be zero; leap seconds rejected.
 */
export function normalizeTimestamp(input: string, path: string): string {
  const m = TIMESTAMP_INPUT.exec(input);
  if (m === null) {
    throw new CanonicalError(
      CanonicalErrorCode.TIMESTAMP_SYNTAX,
      path,
      `not an RFC 3339 timestamp: ${JSON.stringify(input)}`,
    );
  }
  const [, ys, mos, ds, hs, mis, ss, fraction = '', offset = 'Z'] = m;
  const year = Number(ys);
  const month = Number(mos);
  const day = Number(ds);
  const hour = Number(hs);
  const minute = Number(mis);
  const second = Number(ss);
  validateCalendar(year, month, day, path, CanonicalErrorCode.TIMESTAMP_SYNTAX);
  if (second === 60) {
    throw new CanonicalError(
      CanonicalErrorCode.TIMESTAMP_LEAP_SECOND,
      path,
      'leap seconds are not representable',
    );
  }
  if (hour > 23 || minute > 59 || second > 59) {
    throw new CanonicalError(CanonicalErrorCode.TIMESTAMP_SYNTAX, path, 'invalid time of day');
  }
  if (fraction.length > 3 && /[1-9]/.test(fraction.slice(3))) {
    throw new CanonicalError(
      CanonicalErrorCode.TIMESTAMP_PRECISION,
      path,
      'sub-millisecond digits must be zero (no truncation or rounding)',
    );
  }
  const millis = Number(fraction.slice(0, 3).padEnd(3, '0'));
  let offsetMinutes = 0;
  if (offset !== 'Z' && offset !== 'z') {
    const sign = offset.startsWith('-') ? -1 : 1;
    const oh = Number(offset.slice(1, 3));
    const om = Number(offset.slice(4, 6));
    if (oh > 23 || om > 59)
      throw new CanonicalError(CanonicalErrorCode.TIMESTAMP_SYNTAX, path, 'invalid UTC offset');
    offsetMinutes = sign * (oh * 60 + om);
  }
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, minute, second, millis);
  const utc = new Date(d.getTime() - offsetMinutes * 60_000);
  const uy = utc.getUTCFullYear();
  if (uy < 1 || uy > 9999) {
    throw new CanonicalError(
      CanonicalErrorCode.TIMESTAMP_RANGE,
      path,
      'year outside 0001–9999 after UTC conversion',
    );
  }
  return (
    `${pad(uy, 4)}-${pad(utc.getUTCMonth() + 1, 2)}-${pad(utc.getUTCDate(), 2)}` +
    `T${pad(utc.getUTCHours(), 2)}:${pad(utc.getUTCMinutes(), 2)}:${pad(utc.getUTCSeconds(), 2)}` +
    `.${pad(utc.getUTCMilliseconds(), 3)}Z`
  );
}

/** Rule 8: dates are `YYYY-MM-DD`. */
export function normalizeDate(input: string, path: string): string {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(input);
  if (m === null)
    throw new CanonicalError(
      CanonicalErrorCode.DATE_SYNTAX,
      path,
      `not a date: ${JSON.stringify(input)}`,
    );
  validateCalendar(Number(m[1]), Number(m[2]), Number(m[3]), path, CanonicalErrorCode.DATE_SYNTAX);
  return input;
}

/** Rule 9: lowercase hyphenated 8-4-4-4-12; uppercase input is lowercased; other forms rejected. */
export function normalizeUuid(input: string, path: string): string {
  if (
    !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(input)
  ) {
    throw new CanonicalError(
      CanonicalErrorCode.UUID_SYNTAX,
      path,
      `not a canonical UUID: ${JSON.stringify(input)}`,
    );
  }
  return input.toLowerCase();
}

/** Content hashes inside content: `sha256:<64 lowercase hex>`. */
export function normalizeHashRef(input: string, path: string): string {
  if (!/^sha256:[0-9a-fA-F]{64}$/.test(input)) {
    throw new CanonicalError(
      CanonicalErrorCode.HASH_SYNTAX,
      path,
      `not a sha256 content hash: ${JSON.stringify(input)}`,
    );
  }
  return `sha256:${input.slice(7).toLowerCase()}`;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Rule 10: NFC for every string; lone surrogates rejected; C0 controls rejected except TAB and
 * LF in schema-designated free-text fields.
 */
export function normalizeText(input: string, path: string, freeText: boolean): string {
  if (LONE_SURROGATE.test(input)) {
    throw new CanonicalError(CanonicalErrorCode.LONE_SURROGATE, path, 'lone surrogate code unit');
  }
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c < 0x20 && !(freeText && (c === 0x09 || c === 0x0a))) {
      throw new CanonicalError(
        CanonicalErrorCode.CONTROL_CHARACTER,
        path,
        `control character U+${c.toString(16).toUpperCase().padStart(4, '0')} not allowed`,
      );
    }
  }
  return input.normalize('NFC');
}
