/** OnChainFest wordmark. The public marketing site is a separate deployment (ADR-0052). */
export const MARKETING_URL = process.env.NEXT_PUBLIC_MARKETING_URL ?? 'https://www.onchainfest.xyz';

export function Brand({ href = MARKETING_URL }: { href?: string }) {
  return (
    <a className="brand" href={href} aria-label="OnChainFest">
      <span className="brand-dot" aria-hidden="true" />
      OnChainFest
    </a>
  );
}
