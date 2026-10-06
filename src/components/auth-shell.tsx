import Link from "next/link";

export function ProductNav() {
  return (
    <nav className="product-nav">
      <Link className="wordmark" href="/"><span className="wordmark-dot" />OnChainFest</Link>
      <div className="nav-actions">
        <Link className="muted" href="/pricing">Organization pricing</Link>
        <Link className="muted" href="/signin">Sign in</Link>
        <Link className="button" href="/signup">Sign up</Link>
      </div>
    </nav>
  );
}

export function AuthShell({
  eyebrow,
  title,
  outline,
  lede,
  children,
}: {
  eyebrow: string;
  title: string;
  outline?: string;
  lede: string;
  children: React.ReactNode;
}) {
  return (
    <main className="auth-page">
      <ProductNav />
      <section className="auth-shell">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h1 className="auth-title">{title}{outline ? <span className="outline">{outline}</span> : null}</h1>
          <p className="auth-lede">{lede}</p>
        </div>
        <div>{children}</div>
      </section>
    </main>
  );
}
