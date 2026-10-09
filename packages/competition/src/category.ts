/**
 * Event category (BRT-01 §5.2): structured, extensible, sport-neutral. BRT-05 stores categories
 * as declared labels only. It never infers or verifies sex/gender, age, weight, nationality,
 * licence or ranking from identity data (and never reads the PII vault). Eligibility is either
 * DECLARED by the entrant or ORGANIZER_ACCEPTED on confirmation; neither is a verified fact.
 */
export interface EventCategory {
  readonly genderCategory?: 'OPEN' | 'MEN' | 'WOMEN' | 'MIXED';
  readonly ageCategory?: {
    readonly label: string;
    readonly minAge?: number;
    readonly maxAge?: number;
  };
  readonly skillClass?: string;
  readonly weightClass?: string;
  readonly division?: string;
  readonly classification?: string;
  readonly customLabels?: readonly string[];
}

export const EligibilityBasis = {
  /** The entrant declared they meet the category (not checked by the platform). */
  DECLARED: 'DECLARED',
  /** An organizer accepted the entry on confirmation (operational acceptance, not verification). */
  ORGANIZER_ACCEPTED: 'ORGANIZER_ACCEPTED',
} as const;
export type EligibilityBasis = (typeof EligibilityBasis)[keyof typeof EligibilityBasis];

const LABEL = /^[\p{L}\p{N}][\p{L}\p{N} .+\-/()&']{0,39}$/u;
const CATEGORY_KEYS = [
  'genderCategory',
  'ageCategory',
  'skillClass',
  'weightClass',
  'division',
  'classification',
  'customLabels',
];

export function validateCategory(category: unknown): string[] {
  const issues: string[] = [];
  if (typeof category !== 'object' || category === null || Array.isArray(category))
    return ['category must be an object'];
  const c = category as Record<string, unknown>;
  for (const k of Object.keys(c))
    if (!CATEGORY_KEYS.includes(k)) issues.push(`unknown category field ${k}`);
  if (
    c.genderCategory !== undefined &&
    !['OPEN', 'MEN', 'WOMEN', 'MIXED'].includes(c.genderCategory as string)
  )
    issues.push('invalid genderCategory');
  if (c.ageCategory !== undefined) {
    const a = c.ageCategory as Record<string, unknown>;
    if (typeof a !== 'object' || a === null) issues.push('invalid ageCategory');
    else {
      for (const k of Object.keys(a))
        if (!['label', 'minAge', 'maxAge'].includes(k))
          issues.push(`unknown ageCategory field ${k}`);
      if (typeof a.label !== 'string' || !LABEL.test(a.label))
        issues.push('invalid ageCategory.label');
      for (const k of ['minAge', 'maxAge'] as const)
        if (
          a[k] !== undefined &&
          (!Number.isInteger(a[k]) || (a[k] as number) < 0 || (a[k] as number) > 120)
        )
          issues.push(`invalid ageCategory.${k}`);
      if (typeof a.minAge === 'number' && typeof a.maxAge === 'number' && a.minAge > a.maxAge)
        issues.push('ageCategory.minAge > maxAge');
    }
  }
  for (const k of ['skillClass', 'weightClass', 'division', 'classification'] as const)
    if (c[k] !== undefined && (typeof c[k] !== 'string' || !LABEL.test(c[k] as string)))
      issues.push(`invalid ${k}`);
  if (c.customLabels !== undefined) {
    const l = c.customLabels;
    if (
      !Array.isArray(l) ||
      l.length > 8 ||
      new Set(l).size !== l.length ||
      !l.every((x) => typeof x === 'string' && LABEL.test(x))
    )
      issues.push('customLabels must be at most 8 unique short labels');
  }
  return issues;
}
