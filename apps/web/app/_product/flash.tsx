import { errorMessage, noticeMessage } from '../_lib/auth/messages';

/** Renders a fixed-vocabulary error or notice code from the URL (never raw text). */
export function Flash({ error, notice }: { error?: unknown; notice?: unknown }) {
  const e = errorMessage(error);
  if (e !== null)
    return (
      <p className="flash" role="alert">
        {e}
      </p>
    );
  const n = noticeMessage(notice);
  if (n !== null)
    return (
      <p className="flash ok" role="status">
        {n}
      </p>
    );
  return null;
}
