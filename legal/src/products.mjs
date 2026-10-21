// ONCHAINFEST-LEGAL-01 · Product legal directory.
//
// Each product keeps its own Terms and privacy policy on its own site; that copy is canonical.
// The hub only links to it — it never mirrors a product's documents, so they cannot drift.
// To add a product, append an entry: the build creates /products/<slug> in every locale and
// lists it in the directory.

export const PRODUCTS = [
  {
    slug: 'listalaboda',
    name: 'ListaLaBoda',
    website: 'https://listalaboda.com',
    // Verified: src/lib/legal/links.ts in listalaboda.com (SUPPORT_EMAIL).
    supportEmail: 'soporte@listalaboda.com',
    // The language the product's own documents are written in.
    documentsLanguage: { en: 'Spanish', es: 'Español' },
    summary: {
      en: 'Wedding-planning platform for couples and wedding planners.',
      es: 'Plataforma para organizar bodas, para parejas y wedding planners.',
    },
    // Verified: "listalaboda.com es operado por OnChainFest LLC." in the product's Terms and privacy policy.
    operator: 'OnChainFest LLC',
    documents: [
      {
        kind: 'terms',
        href: 'https://listalaboda.com/terminos',
        title: { en: 'Terms and Conditions', es: 'Términos y condiciones' },
      },
      {
        kind: 'privacy',
        href: 'https://listalaboda.com/privacidad',
        title: { en: 'Privacy Policy', es: 'Política de privacidad' },
      },
      {
        kind: 'refunds',
        // Section of the Terms (REFUNDS_SECTION_ID in the product).
        href: 'https://listalaboda.com/terminos#reembolsos-y-cancelaciones',
        title: { en: 'Refunds and cancellations', es: 'Reembolsos y cancelaciones' },
      },
    ],
  },
];
