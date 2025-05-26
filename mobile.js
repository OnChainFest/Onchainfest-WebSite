
function toggleMenu() {
  const menu = document.getElementById('mobileMenu');
  menu.style.display = (menu.style.display === 'flex') ? 'none' : 'flex';
}

function closeMenu() {
  const menu = document.getElementById('mobileMenu');
  menu.style.display = 'none';
}
