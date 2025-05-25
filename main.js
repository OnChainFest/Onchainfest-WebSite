
const translations = {
  en: {
    sport_title: "Sport Events",
    sport_desc: "OnChainFest revolutionizes sports event management with a Web3-powered solution that automates the entire flow—from player registration to prize distribution. Participants register through forms connected to smart wallets, enabling automatic validation and fee collection. Payments can be made in fiat or stablecoins. Re-entry logic is governed by smart contracts that enforce limits, pricing, and conditions. Results can be integrated through sports oracles, and prizes are distributed automatically to winners, clubs, and sponsors. Everything is logged on-chain, ensuring full transparency, cutting operational costs, and eliminating unnecessary intermediaries.",
    music_title: "Music Events",
    music_desc: "Our platform is ideal for music festivals and concerts, offering secure ticketing and fan engagement tools using NFTs and smart contracts.",
    raffles_title: "Raffles",
    raffles_desc: "Easily manage raffles through smart contracts, ensuring provable fairness and automated prize distribution.",
    brt_title: "$BRT's",
    brt_desc: "Bragging Rights Tokens are unique NFTs awarded to champions of verified events, serving as proof of achievement and fan collectibles.",
    about_title: "About Us",
    about_desc: "OnChainFest is a blockchain-based platform for organizing sports tournaments, concerts, and raffles with transparency and automation."
  },
  es: {
    sport_title: "Eventos Deportivos",
    sport_desc: "OnChainFest revoluciona la gestión de eventos deportivos con una solución basada en Web3 que automatiza todo el proceso—desde el registro de jugadores hasta la distribución de premios. Los participantes se registran mediante formularios conectados a billeteras inteligentes, lo que permite validación automática y cobro de comisiones. Los pagos pueden realizarse en fiat o stablecoins. La lógica de reingreso está gobernada por contratos inteligentes que aplican límites, precios y condiciones. Los resultados se integran mediante oráculos deportivos, y los premios se distribuyen automáticamente a ganadores, clubes y patrocinadores. Todo queda registrado on-chain, asegurando transparencia total, reducción de costos y eliminación de intermediarios innecesarios.",
    music_title: "Eventos Musicales",
    music_desc: "Nuestra plataforma es ideal para festivales y conciertos, ofreciendo boletería segura y herramientas de participación con NFTs y contratos inteligentes.",
    raffles_title: "Rifas",
    raffles_desc: "Gestioná rifas fácilmente mediante contratos inteligentes, asegurando equidad comprobable y distribución automática de premios.",
    brt_title: "Tokens BRT",
    brt_desc: "Los Bragging Rights Tokens son NFTs únicos otorgados a campeones de eventos verificados, como prueba de logro y coleccionables para fans.",
    about_title: "Sobre Nosotros",
    about_desc: "OnChainFest es una plataforma basada en blockchain para organizar torneos, conciertos y rifas con transparencia y automatización."
  }
};

let currentLang = 'en';

document.getElementById('languageToggle').addEventListener('click', () => {
  currentLang = currentLang === 'en' ? 'es' : 'en';
  document.querySelectorAll('[data-translate]').forEach(el => {
    const key = el.getAttribute('data-translate');
    el.textContent = translations[currentLang][key];
  });
});
