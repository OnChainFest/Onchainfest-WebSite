import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OnChainFest",
  description: "Tournament operations and athlete identity.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
