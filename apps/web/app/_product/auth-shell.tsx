import type { ReactNode } from 'react';
import { Brand } from './brand';

/** Split-screen auth frame: a strong headline stage and a focused form panel. */
export function AuthShell({
  eyebrow,
  title,
  outline,
  lede,
  kicker,
  heading,
  children,
}: {
  eyebrow: string;
  title: string;
  outline?: string;
  lede?: string;
  kicker: string;
  heading: string;
  children: ReactNode;
}) {
  return (
    <div className="oc oc-auth">
      <section className="stage" aria-label="OnChainFest">
        <Brand />
        <div>
          <p className="eyebrow mono">{eyebrow}</p>
          <h1 className="headline">
            {title}
            {outline !== undefined ? <span className="outline">{outline}</span> : null}
          </h1>
          {lede !== undefined ? <p className="lede">{lede}</p> : null}
        </div>
        <div className="stage-foot mono">
          <span>Organizers</span>
          <span>Athletes</span>
          <span>Results</span>
        </div>
      </section>
      <main className="panel">
        <div className="panel-inner">
          <span className="panel-kicker mono">{kicker}</span>
          <h2 className="panel-title">{heading}</h2>
          {children}
        </div>
      </main>
    </div>
  );
}
