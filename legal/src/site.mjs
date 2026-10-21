// ONCHAINFEST-LEGAL-01 · Facts the legal hub states about OnChainFest LLC.
//
// Only verified facts live here. Anything a lawyer or the owner still has to supply is a review
// marker (REVIEW below), never a guess: the pages render it as a visible "pending legal review"
// callout, and a production build refuses to publish while any marker remains.

export const SITE_ORIGIN = 'https://legal.onchainfest.xyz';
export const CORPORATE_SITE = 'https://www.onchainfest.xyz/';
export const COPYRIGHT_YEAR = 2026;

/** English is the default locale (served at the root); every other locale lives under /<locale>. */
export const LOCALES = ['en', 'es'];
export const DEFAULT_LOCALE = 'en';

export const COMPANY = {
  // Verified: listalaboda.com's Terms and privacy policy name OnChainFest LLC as the operator.
  legalName: 'OnChainFest LLC',
  // Verified: the published contact address on www.onchainfest.xyz (footer, contact page, JSON-LD).
  contactEmail: 'vicvalch@onchainfest.xyz',
  // Not yet supplied: rendered as the REGISTRATION / ADDRESS review markers while null.
  registration: null,
  address: null,
};

/** Review markers still open in the company information block. */
export const companyOpenMarkers = () => [
  ...(COMPANY.registration ? [] : ['REGISTRATION']),
  ...(COMPANY.address ? [] : ['ADDRESS']),
];

/**
 * Open legal facts. Content references them as `{{review:KEY}}`. Each label says what is missing,
 * never what the answer might be.
 */
export const REVIEW = {
  REGISTRATION: {
    en: 'State or country of formation and registration number of OnChainFest LLC',
    es: 'Estado o país de constitución y número de registro de OnChainFest LLC',
  },
  ADDRESS: {
    en: 'Registered address and address for legal notices',
    es: 'Domicilio registrado y dirección para notificaciones legales',
  },
  LEGAL_CONTACT: {
    en: 'Official contact address for legal and privacy requests',
    es: 'Dirección de contacto oficial para asuntos legales y de privacidad',
  },
  PRECEDENCE: {
    en: 'How these corporate documents relate to, and rank against, product-specific documents',
    es: 'Cómo se relacionan y qué prelación tienen estos documentos corporativos frente a los de cada producto',
  },
  DIGITAL_ASSETS: {
    en: 'Disclosures required for the ecosystem token ($BRT) referenced on www.onchainfest.xyz',
    es: 'Avisos requeridos sobre el token del ecosistema ($BRT) mencionado en www.onchainfest.xyz',
  },
  LIABILITY: {
    en: 'Warranty disclaimers and limitation of liability',
    es: 'Exclusión de garantías y limitación de responsabilidad',
  },
  GOVERNING_LAW: {
    en: 'Governing law, competent courts and any dispute-resolution or arbitration mechanism',
    es: 'Ley aplicable, tribunales competentes y cualquier mecanismo de resolución de disputas o arbitraje',
  },
  PRIVACY_REGIMES: {
    en: 'Which data-protection laws apply (for example Costa Rica Law 8968, GDPR, CCPA) and the legal bases for processing',
    es: 'Qué leyes de protección de datos aplican (por ejemplo, Ley 8968 de Costa Rica, RGPD, CCPA) y las bases legales del tratamiento',
  },
  PROCESSORS: {
    en: 'Confirmed list of service providers that process personal data, and their roles',
    es: 'Lista confirmada de proveedores que tratan datos personales y su rol',
  },
  TRANSFERS: {
    en: 'International data transfers and the safeguards that apply',
    es: 'Transferencias internacionales de datos y las garantías aplicables',
  },
  RETENTION: {
    en: 'Retention periods for messages and technical data',
    es: 'Plazos de conservación de mensajes y datos técnicos',
  },
  RIGHTS: {
    en: 'Data-subject rights by jurisdiction, response times and the supervisory authority',
    es: 'Derechos de las personas titulares por jurisdicción, plazos de respuesta y autoridad de control',
  },
  CHILDREN: {
    en: 'Minimum age and handling of minors’ data',
    es: 'Edad mínima y tratamiento de datos de menores',
  },
};

export const reviewLabel = (key, locale) => {
  const entry = REVIEW[key];
  if (!entry) throw new Error(`Unknown review marker: ${key}`);
  return entry[locale];
};
