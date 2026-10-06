export function isSafeContinuationRoute(value: string | null | undefined): value is string {
  return Boolean(value && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\"));
}
