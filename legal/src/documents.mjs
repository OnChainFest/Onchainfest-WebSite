// ONCHAINFEST-LEGAL-01 · Corporate policies of OnChainFest LLC.
//
// Status model: a document is `draft` until the owner and counsel approve it. A draft has no
// effective date, a `-draft` version and is rendered with a "not in effect" banner. Approving it
// means setting `status: 'approved'`, a plain semver `version` and the real `effectiveDate`
// (YYYY-MM-DD) — and the build refuses that while any `{{review:…}}` marker remains.
//
// Inline syntax in paragraphs: [text](href), **bold**, {{company}}, {{contactEmail}},
// {{review:KEY}} (see REVIEW in site.mjs). An href starting with `~/` is a hub path in the
// current locale. A paragraph that is only a review marker renders as a callout.

export const DOCUMENTS = [
  {
    id: 'terms',
    path: '/terms',
    version: '0.1.0-draft',
    status: 'draft',
    effectiveDate: null,
    // The date this draft was written, not an approval date.
    draftPrepared: '2026-10-21',
    content: {
      en: {
        title: 'Corporate Terms of Use',
        summary:
          'The terms for using the corporate websites of OnChainFest LLC. Product-specific legal terms must be verified separately.',
        appliesTo: 'www.onchainfest.xyz and legal.onchainfest.xyz',
        sections: [
          {
            id: 'scope',
            heading: 'Scope',
            body: [
              'These Terms of Use apply to the corporate websites of {{company}}: www.onchainfest.xyz and legal.onchainfest.xyz (the “Corporate Sites”).',
              'They do not govern the use of any product. Products may have separate terms and privacy policies where published and applicable. See the [product legal directory](~/#products) for documents that have been individually verified; do not assume every product has published documents.',
              '{{review:PRECEDENCE}}',
            ],
          },
          {
            id: 'company',
            heading: 'Who we are',
            body: [
              'The Corporate Sites are operated by {{company}}.',
              'OnChainFest LLC was formed in Wyoming, United States, on July 18, 2025 (Wyoming Filing ID 2025-001725151). The original Articles named Registered Agents Inc as registered agent and listed 30 N Gould St, Ste R, Sheridan, WY 82801 as the original registered, mailing and principal address. These are historical formation facts, not confirmation of the current registered agent or a valid current notice address.',
              '{{review:ADDRESS}}',
            ],
          },
          {
            id: 'use',
            heading: 'Using the Corporate Sites',
            body: [
              'The Corporate Sites provide information about {{company}} and its products. When you use them, you agree not to:',
              {
                list: [
                  'disrupt, overload or attempt to gain unauthorized access to the Corporate Sites or the systems that serve them;',
                  'use the Corporate Sites in violation of applicable law;',
                  'misrepresent your identity or affiliation when you contact us.',
                ],
              },
            ],
          },
          {
            id: 'information',
            heading: 'Information on the Corporate Sites',
            body: [
              'Content on the Corporate Sites describes {{company}} and its products in general terms. Any applicable product-specific terms, where published, govern the product's own offering.',
              '{{review:DIGITAL_ASSETS}}',
            ],
          },
          {
            id: 'intellectual-property',
            heading: 'Intellectual property',
            body: [
              'The OnChainFest name and logo and the content of the Corporate Sites belong to {{company}} or its licensors. They may not be copied or reused without prior written permission, except as the law allows.',
            ],
          },
          {
            id: 'links',
            heading: 'Links to other websites',
            body: [
              'The Corporate Sites may link to product websites with separately published legal terms, and to websites operated by others. Websites operated by others are governed by their own terms and policies.',
            ],
          },
          {
            id: 'liability',
            heading: 'Disclaimers and liability',
            body: ['{{review:LIABILITY}}'],
          },
          {
            id: 'governing-law',
            heading: 'Governing law and disputes',
            body: ['{{review:GOVERNING_LAW}}'],
          },
          {
            id: 'changes',
            heading: 'Changes to these terms',
            body: [
              'We may update these terms. Every version shows its version number and effective date at the top of the page, and applies from its effective date.',
            ],
          },
          {
            id: 'contact',
            heading: 'Contact',
            body: [
              'Questions about these terms: [{{contactEmail}}](mailto:{{contactEmail}}).',
              '{{review:LEGAL_CONTACT}}',
            ],
          },
        ],
      },
      es: {
        title: 'Términos de uso corporativos',
        summary:
          'Las condiciones para usar los sitios web corporativos de OnChainFest LLC. Los términos legales de cada producto deben verificarse por separado.',
        appliesTo: 'www.onchainfest.xyz y legal.onchainfest.xyz',
        sections: [
          {
            id: 'scope',
            heading: 'Alcance',
            body: [
              'Estos Términos de uso aplican a los sitios web corporativos de {{company}}: www.onchainfest.xyz y legal.onchainfest.xyz (los «Sitios corporativos»).',
              'No rigen el uso de ningún producto. Los productos pueden tener términos y políticas de privacidad propios cuando se hayan publicado y resulten aplicables. Consulta el [directorio legal de productos](~/#products) para los documentos verificados individualmente; no asumas que todos los productos ya los tienen publicados.',
              '{{review:PRECEDENCE}}',
            ],
          },
          {
            id: 'company',
            heading: 'Quiénes somos',
            body: [
              'Los Sitios corporativos son operados por {{company}}.',
              'OnChainFest LLC fue constituida en Wyoming, Estados Unidos, el 18 de julio de 2025 (ID de registro de Wyoming 2025-001725151). Los artículos originales nombraban a Registered Agents Inc como agente registrado e indicaban 30 N Gould St, Ste R, Sheridan, WY 82801 como dirección registrada, postal y principal original. Estos son datos históricos de constitución, no una confirmación del agente registrado vigente ni de una dirección actual válida para notificaciones.',
              '{{review:ADDRESS}}',
            ],
          },
          {
            id: 'use',
            heading: 'Uso de los Sitios corporativos',
            body: [
              'Los Sitios corporativos ofrecen información sobre {{company}} y sus productos. Al usarlos, aceptas no:',
              {
                list: [
                  'interrumpir, sobrecargar ni intentar acceder sin autorización a los Sitios corporativos o a los sistemas que los sirven;',
                  'usar los Sitios corporativos en contra de la ley aplicable;',
                  'falsear tu identidad o tu afiliación cuando nos contactes.',
                ],
              },
            ],
          },
          {
            id: 'information',
            heading: 'Información de los Sitios corporativos',
            body: [
              'El contenido de los Sitios corporativos describe a {{company}} y sus productos en términos generales. Los términos particulares de cada producto, cuando existan y resulten aplicables, rigen su propia oferta.',
              '{{review:DIGITAL_ASSETS}}',
            ],
          },
          {
            id: 'intellectual-property',
            heading: 'Propiedad intelectual',
            body: [
              'El nombre y el logotipo de OnChainFest y el contenido de los Sitios corporativos pertenecen a {{company}} o a sus licenciantes. No pueden copiarse ni reutilizarse sin permiso previo por escrito, salvo en lo que permita la ley.',
            ],
          },
          {
            id: 'links',
            heading: 'Enlaces a otros sitios',
            body: [
              'Los Sitios corporativos pueden enlazar a sitios web de productos con documentos legales publicados por separado, y a sitios operados por terceros. Los sitios operados por terceros se rigen por sus propios términos y políticas.',
            ],
          },
          {
            id: 'liability',
            heading: 'Exclusiones y responsabilidad',
            body: ['{{review:LIABILITY}}'],
          },
          {
            id: 'governing-law',
            heading: 'Ley aplicable y disputas',
            body: ['{{review:GOVERNING_LAW}}'],
          },
          {
            id: 'changes',
            heading: 'Cambios a estos términos',
            body: [
              'Podemos actualizar estos términos. Cada versión muestra su número de versión y su fecha de vigencia al inicio de la página, y aplica desde esa fecha.',
            ],
          },
          {
            id: 'contact',
            heading: 'Contacto',
            body: [
              'Consultas sobre estos términos: [{{contactEmail}}](mailto:{{contactEmail}}).',
              '{{review:LEGAL_CONTACT}}',
            ],
          },
        ],
      },
    },
  },
  {
    id: 'privacy',
    path: '/privacy',
    version: '0.1.0-draft',
    status: 'draft',
    effectiveDate: null,
    draftPrepared: '2026-10-21',
    content: {
      en: {
        title: 'Corporate Privacy Policy',
        summary:
          'How OnChainFest LLC handles personal data on its corporate websites and in direct communications. Product privacy notices must be confirmed separately.',
        appliesTo: 'www.onchainfest.xyz, legal.onchainfest.xyz and direct communications',
        sections: [
          {
            id: 'scope',
            heading: 'Scope',
            body: [
              'This policy explains how {{company}} handles personal data on its corporate websites, www.onchainfest.xyz and legal.onchainfest.xyz (the “Corporate Sites”), and when you write to us directly.',
              'It does not cover the products operated by {{company}}. Where published and applicable, a product's own privacy policy may govern data processed in that product; see the [product legal directory](~/#products) for individually verified documents.',
              '{{review:PRECEDENCE}}',
            ],
          },
          {
            id: 'responsible',
            heading: 'Who is responsible',
            body: [
              '{{company}} is responsible for the processing described in this policy.',
              'OnChainFest LLC was formed in Wyoming, United States, on July 18, 2025 (Filing ID 2025-001725151). The original Articles named Registered Agents Inc and listed 30 N Gould St, Ste R, Sheridan, WY 82801; these details do not establish current registered-agent or legal-notice contact information.',
              '{{review:ADDRESS}}',
            ],
          },
          {
            id: 'data',
            heading: 'What we collect',
            body: [
              {
                list: [
                  '**Messages you send us.** The contact form on www.onchainfest.xyz does not send data to our servers: it opens your own email application with a message addressed to us. We receive what you choose to send — typically your name, email address, organization, the kind of activity you organize and your message.',
                  '**Technical data.** When you visit a Corporate Site, the hosting provider processes technical request data, such as your IP address, browser user agent and the page requested, to deliver the site and protect it from abuse.',
                  '**No cookies or analytics.** As of this version, the Corporate Sites set no cookies and load no analytics, advertising or tracking scripts.',
                ],
              },
            ],
          },
          {
            id: 'purposes',
            heading: 'Why we use it',
            body: [
              {
                list: [
                  'To reply to your message and continue the conversation you started.',
                  'To operate the Corporate Sites and keep them secure.',
                ],
              },
              '{{review:PRIVACY_REGIMES}}',
            ],
          },
          {
            id: 'providers',
            heading: 'Service providers',
            body: [
              'We use service providers to run the Corporate Sites and our email. At the time of this version they are Vercel (website hosting) and GoDaddy (domain name and email hosting).',
              '{{review:PROCESSORS}}',
              '{{review:TRANSFERS}}',
            ],
          },
          {
            id: 'retention',
            heading: 'How long we keep it',
            body: ['{{review:RETENTION}}'],
          },
          {
            id: 'rights',
            heading: 'Your rights',
            body: [
              'You can ask us to access, correct or delete the personal data we hold about you by writing to [{{contactEmail}}](mailto:{{contactEmail}}).',
              '{{review:RIGHTS}}',
            ],
          },
          {
            id: 'children',
            heading: 'Children',
            body: ['{{review:CHILDREN}}'],
          },
          {
            id: 'security',
            heading: 'Security',
            body: [
              'The Corporate Sites are served only over HTTPS and load no third-party scripts.',
            ],
          },
          {
            id: 'changes',
            heading: 'Changes to this policy',
            body: [
              'We may update this policy. Every version shows its version number and effective date at the top of the page, and applies from its effective date.',
            ],
          },
          {
            id: 'contact',
            heading: 'Contact',
            body: [
              'Privacy questions and requests: [{{contactEmail}}](mailto:{{contactEmail}}).',
              '{{review:LEGAL_CONTACT}}',
            ],
          },
        ],
      },
      es: {
        title: 'Política de privacidad corporativa',
        summary:
          'Cómo trata OnChainFest LLC los datos personales en sus sitios web corporativos y en las comunicaciones directas. Las políticas de privacidad de cada producto deben confirmarse por separado.',
        appliesTo: 'www.onchainfest.xyz, legal.onchainfest.xyz y comunicaciones directas',
        sections: [
          {
            id: 'scope',
            heading: 'Alcance',
            body: [
              'Esta política explica cómo trata {{company}} los datos personales en sus sitios web corporativos, www.onchainfest.xyz y legal.onchainfest.xyz (los «Sitios corporativos»), y cuando nos escribes directamente.',
              'No cubre los productos operados por {{company}}. Cuando se haya publicado y resulte aplicable, la política de privacidad de un producto puede regir los datos tratados en él; consulta el [directorio legal de productos](~/#products) para ver los documentos verificados individualmente.',
              '{{review:PRECEDENCE}}',
            ],
          },
          {
            id: 'responsible',
            heading: 'Quién es responsable',
            body: [
              '{{company}} es responsable del tratamiento descrito en esta política.',
              'OnChainFest LLC fue constituida en Wyoming, Estados Unidos, el 18 de julio de 2025 (ID de registro 2025-001725151). Los artículos originales nombraban a Registered Agents Inc e indicaban 30 N Gould St, Ste R, Sheridan, WY 82801; estos datos no acreditan el agente registrado ni el domicilio actual para notificaciones legales.',
              '{{review:ADDRESS}}',
            ],
          },
          {
            id: 'data',
            heading: 'Qué datos recopilamos',
            body: [
              {
                list: [
                  '**Mensajes que nos envías.** El formulario de contacto de www.onchainfest.xyz no envía datos a nuestros servidores: abre tu propia aplicación de correo con un mensaje dirigido a nosotros. Recibimos lo que decidas enviar; normalmente tu nombre, correo electrónico, organización, el tipo de actividad que organizas y tu mensaje.',
                  '**Datos técnicos.** Cuando visitas un Sitio corporativo, el proveedor de hosting trata datos técnicos de la solicitud, como tu dirección IP, el agente de usuario del navegador y la página solicitada, para servir el sitio y protegerlo contra abusos.',
                  '**Sin cookies ni analítica.** A la fecha de esta versión, los Sitios corporativos no instalan cookies ni cargan scripts de analítica, publicidad o seguimiento.',
                ],
              },
            ],
          },
          {
            id: 'purposes',
            heading: 'Para qué los usamos',
            body: [
              {
                list: [
                  'Para responder tu mensaje y continuar la conversación que iniciaste.',
                  'Para operar los Sitios corporativos y mantenerlos seguros.',
                ],
              },
              '{{review:PRIVACY_REGIMES}}',
            ],
          },
          {
            id: 'providers',
            heading: 'Proveedores de servicios',
            body: [
              'Usamos proveedores de servicios para operar los Sitios corporativos y nuestro correo. A la fecha de esta versión son Vercel (hosting del sitio web) y GoDaddy (dominio y hosting de correo).',
              '{{review:PROCESSORS}}',
              '{{review:TRANSFERS}}',
            ],
          },
          {
            id: 'retention',
            heading: 'Cuánto tiempo los conservamos',
            body: ['{{review:RETENTION}}'],
          },
          {
            id: 'rights',
            heading: 'Tus derechos',
            body: [
              'Puedes pedirnos acceder, corregir o eliminar los datos personales que tenemos sobre ti escribiendo a [{{contactEmail}}](mailto:{{contactEmail}}).',
              '{{review:RIGHTS}}',
            ],
          },
          {
            id: 'children',
            heading: 'Menores de edad',
            body: ['{{review:CHILDREN}}'],
          },
          {
            id: 'security',
            heading: 'Seguridad',
            body: [
              'Los Sitios corporativos se sirven solo por HTTPS y no cargan scripts de terceros.',
            ],
          },
          {
            id: 'changes',
            heading: 'Cambios a esta política',
            body: [
              'Podemos actualizar esta política. Cada versión muestra su número de versión y su fecha de vigencia al inicio de la página, y aplica desde esa fecha.',
            ],
          },
          {
            id: 'contact',
            heading: 'Contacto',
            body: [
              'Consultas y solicitudes de privacidad: [{{contactEmail}}](mailto:{{contactEmail}}).',
              '{{review:LEGAL_CONTACT}}',
            ],
          },
        ],
      },
    },
  },
];
