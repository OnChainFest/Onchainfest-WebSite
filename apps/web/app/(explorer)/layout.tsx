import type { ReactNode } from 'react';

/** Public read pages (passport, organizations, competitions, rankings…): unchanged presentation. */
export default function ExplorerLayout({ children }: { children: ReactNode }) {
  return <div style={{ fontFamily: 'system-ui, sans-serif', margin: '3rem' }}>{children}</div>;
}
