
document.getElementById('languageToggle').addEventListener('change', function() {
  const lang = this.checked ? 'es' : 'en';
  console.log("Language set to", lang);
});
