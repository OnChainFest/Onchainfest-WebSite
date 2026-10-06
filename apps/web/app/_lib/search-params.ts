export type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** First value of a query parameter, or undefined. */
export function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
