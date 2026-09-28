import type { ReactNode } from 'react';

export const metadata = {
  title: 'Bragging Rights',
  description: 'Foundation build',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: '3rem' }}>{children}</body>
    </html>
  );
}
