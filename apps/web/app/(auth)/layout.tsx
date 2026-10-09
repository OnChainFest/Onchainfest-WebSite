import type { ReactNode } from 'react';
import '../_product/product.css';

export const metadata = { robots: { index: false } };

export default function AuthLayout({ children }: { children: ReactNode }) {
  return children;
}
