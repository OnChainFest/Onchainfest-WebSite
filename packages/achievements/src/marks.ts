import type { ComparatorOrder, MetricValueType } from '@br/competition';

/**
 * Exact metric arithmetic over canonical decimal strings (BR-JSON rule 6/7). There is NO floating
 * point anywhere: values are parsed into (sign, digits, scale) and compared as scaled BigInts.
 * Canonical storage is never rounded or unit-converted; formatting belongs to read layers.
 */
const DECIMAL = /^(-)?(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

interface Scaled {
  readonly value: bigint;
  readonly scale: number;
}

function scaled(text: string): Scaled {
  const m = DECIMAL.exec(text);
  if (m === null) throw new TypeError(`not a canonical decimal: ${JSON.stringify(text)}`);
  const frac = m[3] ?? '';
  const digits = BigInt(`${m[2] ?? '0'}${frac}`);
  return { value: m[1] === '-' ? -digits : digits, scale: frac.length };
}

/** -1 / 0 / 1 — exact comparison of two canonical decimal strings (any scales). */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const x = scaled(a);
  const y = scaled(b);
  const scale = Math.max(x.scale, y.scale);
  const xv = x.value * 10n ** BigInt(scale - x.scale);
  const yv = y.value * 10n ** BigInt(scale - y.scale);
  return xv < yv ? -1 : xv > yv ? 1 : 0;
}

export type ThresholdOperator = 'GTE' | 'GT' | 'LTE' | 'LT' | 'EQ';

export function satisfiesThreshold(
  value: string,
  op: ThresholdOperator,
  threshold: string,
): boolean {
  const c = compareDecimal(value, threshold);
  switch (op) {
    case 'GTE':
      return c >= 0;
    case 'GT':
      return c > 0;
    case 'LTE':
      return c <= 0;
    case 'LT':
      return c < 0;
    case 'EQ':
      return c === 0;
  }
}

/**
 * Is `a` strictly better than `b` under the DisciplineVersion comparator order? ORDINAL (placement,
 * 1 is best) and LOWER_IS_BETTER (e.g. elapsed time) prefer smaller values; never "higher = better"
 * by assumption.
 */
export function strictlyBetter(a: string, b: string, order: ComparatorOrder): boolean {
  const c = compareDecimal(a, b);
  return order === 'HIGHER_IS_BETTER' ? c > 0 : c < 0;
}

/** Whether a Mark's canonical precision is admissible for a catalog value type. */
export function precisionFits(valueType: MetricValueType, precision: number): boolean {
  return valueType === 'DECIMAL' ? precision >= 0 && precision <= 9 : precision === 0;
}

/** Whether a canonical decimal is admissible as a threshold for a value type. */
export function thresholdFits(valueType: MetricValueType, threshold: string): boolean {
  if (!DECIMAL.test(threshold)) return false;
  if (valueType === 'DECIMAL') return true;
  if (threshold.includes('.')) return false;
  return valueType === 'INTEGER' || !threshold.startsWith('-');
}

/** Operators coherent with a known comparator order (unknown order: any bounded operator). */
export function operatorFitsOrder(
  op: ThresholdOperator,
  order: ComparatorOrder | undefined,
): boolean {
  if (order === undefined || op === 'EQ') return true;
  return order === 'HIGHER_IS_BETTER' ? op === 'GTE' || op === 'GT' : op === 'LTE' || op === 'LT';
}
