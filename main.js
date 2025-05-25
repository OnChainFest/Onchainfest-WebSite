
const checkbox = document.getElementById('languageToggle');

checkbox.addEventListener('change', () => {
  const lang = checkbox.checked ? 'es' : 'en';
  console.log('Language changed to', lang);
});
