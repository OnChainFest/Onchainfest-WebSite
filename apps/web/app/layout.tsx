import type { ReactNode } from 'react';

export const metadata = {
  title: 'OnChainFest',
  description: 'Tournament operations for organizers. A lasting sporting record for athletes.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
