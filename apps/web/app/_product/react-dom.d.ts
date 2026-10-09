// Typing for the one react-dom client hook the product UI uses (react-dom ships no types and
// @types/react-dom is not a dependency; see app/_tests/react-dom-server.d.ts).
declare module 'react-dom' {
  export function useFormStatus(): {
    pending: boolean;
    data: FormData | null;
    method: string | null;
    action: string | ((formData: FormData) => void | Promise<void>) | null;
  };
}
