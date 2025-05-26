
function setupCarousel(id, imagePaths) {
  const container = document.getElementById(id);
  imagePaths.forEach((path) => {
    const img = document.createElement('img');
    img.src = path;
    img.alt = 'Carousel image';
    img.classList.add('carousel-img');
    container.appendChild(img);
  });
}

setupCarousel('carousel-sports', ['img/deporte1.png', 'img/deporte2.png', 'img/deporte3.png']);
setupCarousel('carousel-music', ['img/musica1.png', 'img/musica2.png', 'img/musica3.png']);
setupCarousel('carousel-raffles', ['img/rifas1.png', 'img/rifas2.png', 'img/rifas3.png']);
setupCarousel('carousel-brts', ['img/brag1.png', 'img/brag2.png', 'img/brag3.png']);
