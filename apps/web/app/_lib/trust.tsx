import type { ReactNode } from 'react';
import type { Provenance, Section } from './api';

/** Plain-language trust labels. Nothing here may read as "verified" unless the source says so. */
const LABELS: Record<Provenance, { text: string; tone: string }> = {
  SELF_DECLARED: { text: 'Self-declared', tone: '#6b7280' },
  ACCOUNT_VERIFIED: { text: 'Account-verified', tone: '#2563eb' },
  ORGANIZATION_CONFIRMED: { text: 'Confirmed by organization', tone: '#0f766e' },
  PROOF_OF_CONTROL: { text: 'Wallet control proven', tone: '#0f766e' },
  TEST_PROOF: { text: 'Test proof — not a real verification', tone: '#b45309' },
  AUTHORITY_VERIFIED: { text: 'Verified by recognized authority', tone: '#15803d' },
  SYSTEM_DERIVED: { text: 'System-derived', tone: '#6b7280' },
};

export function TrustBadge({ provenance }: { provenance: Provenance }) {
  const l = LABELS[provenance];
  return (
    <span
      title={provenance}
      style={{
        border: `1px solid ${l.tone}`,
        color: l.tone,
        borderRadius: 999,
        padding: '0 0.5rem',
        fontSize: '0.75rem',
        marginLeft: '0.5rem',
        whiteSpace: 'nowrap',
      }}
    >
      {l.text}
    </span>
  );
}

/** Renders a section honestly: NOT_AVAILABLE ≠ empty. */
export function SectionBlock<T>({
  title,
  section,
  empty,
  render,
}: {
  title: string;
  section: Section<T>;
  empty: string;
  render: (item: T, i: number) => ReactNode;
}) {
  return (
    <section style={{ marginTop: '1.5rem' }}>
      <h2 style={{ fontSize: '1.1rem' }}>{title}</h2>
      {section.status === 'NOT_AVAILABLE' ? (
        <p style={{ color: '#6b7280' }}>
          <em>Not available yet.</em> This information has no source in the platform yet — nothing
          is shown rather than something unverified.
        </p>
      ) : section.items.length === 0 ? (
        <p style={{ color: '#6b7280' }}>{empty}</p>
      ) : (
        <ul>{section.items.map(render)}</ul>
      )}
    </section>
  );
}

export function Unavailable() {
  return (
    <main>
      <h1>Temporarily unavailable</h1>
      <p>The Bragging Rights API could not be reached. Please try again later.</p>
    </main>
  );
}
