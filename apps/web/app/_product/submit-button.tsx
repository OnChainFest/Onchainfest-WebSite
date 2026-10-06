'use client';

import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

/** Submit button with a pending state. Presentation only — authorization is always server-side. */
export function SubmitButton({
  children,
  pending: pendingLabel,
  className = 'btn btn-cyan btn-full',
}: {
  children: ReactNode;
  pending: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button className={className} type="submit" disabled={pending} aria-disabled={pending}>
      {pending ? (
        <>
          <span className="spinner" aria-hidden="true" />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </button>
  );
}
