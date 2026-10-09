// Test-only typing for the one react-dom/server function the web tests use (react-dom ships no types
// and @types/react-dom is not a dependency). Pages never import react-dom/server.
declare module 'react-dom/server' {
  import type { ReactNode } from 'react';
  export function renderToStaticMarkup(node: ReactNode): string;
}
