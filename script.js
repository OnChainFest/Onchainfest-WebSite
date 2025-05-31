
document.getElementById("hamburger").addEventListener("click", () => {
    const menu = document.getElementById("mobile-menu");
    menu.classList.toggle("show");
});


// Cerrar menú hamburguesa automáticamente al seleccionar una sección
document.querySelectorAll("#mobile-menu a").forEach(link => {
    link.addEventListener("click", () => {
        document.getElementById("mobile-menu").classList.remove("show");
    });
});
