import { CanonicalError, CanonicalErrorCode } from './errors';

/**
 * Strict JSON (RFC 8259) parser for BR-JSON inputs.
 *
 * Differences from JSON.parse, all required by BR-JSON v1 §2.2a:
 *  - duplicate member names are rejected (rule 1) instead of "last one wins";
 *  - numbers are decided exactly from their token: only integral values within ±(2^53−1) are
 *    accepted (rule 5); `1.0` and `1e0` are the integer 1, `1.5` is rejected;
 *  - the result contains only plain objects, arrays, strings, safe integers, booleans and null
 *    (null is rejected later by normalization with its own rule id).
 */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_EXPONENT_MAGNITUDE = 400;

export function parseStrictJson(text: string): JsonValue {
  const parser = new Parser(text);
  parser.skipWhitespace();
  const value = parser.parseValue('');
  parser.skipWhitespace();
  if (!parser.atEnd()) parser.fail('', 'unexpected trailing characters');
  return value;
}

class Parser {
  private pos = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  atEnd(): boolean {
    return this.pos >= this.text.length;
  }

  fail(path: string, message: string): never {
    throw new CanonicalError(
      CanonicalErrorCode.JSON_SYNTAX,
      path,
      `${message} (offset ${this.pos})`,
    );
  }

  skipWhitespace(): void {
    while (this.pos < this.text.length) {
      const c = this.text.charCodeAt(this.pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.pos++;
      else break;
    }
  }

  parseValue(path: string): JsonValue {
    const c = this.text[this.pos];
    if (c === '{') return this.parseObject(path);
    if (c === '[') return this.parseArray(path);
    if (c === '"') return this.parseString(path);
    if (c === 't') return this.literal('true', true, path);
    if (c === 'f') return this.literal('false', false, path);
    if (c === 'n') return this.literal('null', null, path);
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return this.parseNumber(path);
    return this.fail(path, 'unexpected character');
  }

  private literal<T extends JsonValue>(word: string, value: T, path: string): T {
    if (this.text.startsWith(word, this.pos)) {
      this.pos += word.length;
      return value;
    }
    return this.fail(path, `expected ${word}`);
  }

  private parseObject(path: string): { [key: string]: JsonValue } {
    this.pos++; // {
    const result: { [key: string]: JsonValue } = Object.create(null) as {
      [key: string]: JsonValue;
    };
    const seen = new Set<string>();
    this.skipWhitespace();
    if (this.text[this.pos] === '}') {
      this.pos++;
      return { ...result };
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.pos] !== '"') this.fail(path, 'expected member name');
      const key = this.parseString(path);
      const memberPath = `${path}/${escapePointer(key)}`;
      if (seen.has(key)) {
        throw new CanonicalError(
          CanonicalErrorCode.DUPLICATE_KEY,
          memberPath,
          `duplicate member name ${JSON.stringify(key)}`,
        );
      }
      seen.add(key);
      this.skipWhitespace();
      if (this.text[this.pos] !== ':') this.fail(memberPath, 'expected ":"');
      this.pos++;
      this.skipWhitespace();
      result[key] = this.parseValue(memberPath);
      this.skipWhitespace();
      const sep = this.text[this.pos];
      if (sep === ',') {
        this.pos++;
        continue;
      }
      if (sep === '}') {
        this.pos++;
        return { ...result };
      }
      this.fail(path, 'expected "," or "}"');
    }
  }

  private parseArray(path: string): JsonValue[] {
    this.pos++; // [
    const result: JsonValue[] = [];
    this.skipWhitespace();
    if (this.text[this.pos] === ']') {
      this.pos++;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      result.push(this.parseValue(`${path}/${result.length}`));
      this.skipWhitespace();
      const sep = this.text[this.pos];
      if (sep === ',') {
        this.pos++;
        continue;
      }
      if (sep === ']') {
        this.pos++;
        return result;
      }
      this.fail(path, 'expected "," or "]"');
    }
  }

  private parseString(path: string): string {
    this.pos++; // opening quote
    let out = '';
    for (;;) {
      if (this.pos >= this.text.length) this.fail(path, 'unterminated string');
      const ch = this.text[this.pos] as string;
      const code = ch.charCodeAt(0);
      if (ch === '"') {
        this.pos++;
        return out;
      }
      if (code < 0x20) this.fail(path, 'raw control character in string');
      if (ch !== '\\') {
        out += ch;
        this.pos++;
        continue;
      }
      const esc = this.text[this.pos + 1];
      this.pos += 2;
      switch (esc) {
        case '"':
          out += '"';
          break;
        case '\\':
          out += '\\';
          break;
        case '/':
          out += '/';
          break;
        case 'b':
          out += '\b';
          break;
        case 'f':
          out += '\f';
          break;
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 't':
          out += '\t';
          break;
        case 'u': {
          const hex = this.text.slice(this.pos, this.pos + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail(path, 'invalid \\u escape');
          out += String.fromCharCode(parseInt(hex, 16));
          this.pos += 4;
          break;
        }
        default:
          this.fail(path, 'invalid escape');
      }
    }
  }

  private parseNumber(path: string): number {
    const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?/.exec(
      this.text.slice(this.pos),
    );
    if (match === null) return this.fail(path, 'invalid number');
    this.pos += match[0].length;
    const negative = match[1] === '-';
    const intDigits = match[2] ?? '0';
    const fracDigits = match[3] ?? '';
    const exponent = match[4] === undefined ? 0 : Number(match[4]);
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_EXPONENT_MAGNITUDE) {
      throw new CanonicalError(
        CanonicalErrorCode.INTEGER_RANGE,
        path,
        `number ${match[0]} is out of range`,
      );
    }
    // value = (intDigits.fracDigits) * 10^exponent, decided exactly.
    const digits = (intDigits + fracDigits).replace(/^0+(?=.)/, '');
    const scale = exponent - fracDigits.length; // value = digits * 10^scale
    let magnitude: bigint;
    if (scale >= 0) {
      magnitude = BigInt(digits) * 10n ** BigInt(scale);
    } else {
      const cut = -scale;
      const padded = digits.padStart(cut + 1, '0');
      const whole = padded.slice(0, padded.length - cut);
      const fraction = padded.slice(padded.length - cut);
      if (/[1-9]/.test(fraction)) {
        throw new CanonicalError(
          CanonicalErrorCode.NON_INTEGER_NUMBER,
          path,
          `number ${match[0]} is not an integer; decimals must be encoded as strings`,
        );
      }
      magnitude = BigInt(whole);
    }
    if (magnitude > MAX_SAFE) {
      throw new CanonicalError(
        CanonicalErrorCode.INTEGER_RANGE,
        path,
        `integer ${match[0]} exceeds ±(2^53−1)`,
      );
    }
    const value = Number(magnitude);
    return negative && value !== 0 ? -value : value; // -0 collapses to 0
  }
}

export function escapePointer(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}
