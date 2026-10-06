export type AccountType = "athlete" | "organization";

export function parseAccountType(value: unknown): AccountType | null {
  return value === "athlete" || value === "organization" ? value : null;
}

export function onboardingRoute(type: AccountType) {
  return type === "organization" ? "/onboarding/organization" : "/onboarding/athlete";
}
