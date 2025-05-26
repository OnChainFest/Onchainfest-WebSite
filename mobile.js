function toggleMenu() {
  const menu = document.getElementById('mobileMenu');
  menu.classList.toggle('show');
}

function closeMenu() {
  document.getElementById('mobileMenu').classList.remove('show');
}