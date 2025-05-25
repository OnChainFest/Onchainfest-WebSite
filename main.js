const translations = {
    en: {
        title: "Welcome to OnChainFest",
        description: "A Web3 solution for your events."
    },
    es: {
        title: "Bienvenido a OnChainFest",
        description: "Una solución Web3 para tus eventos."
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
