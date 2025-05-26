function setupCarousel(id, imageList) {
  const container = document.getElementById(id);
  if (container) {
    imageList.forEach(src => {
      const img = document.createElement('img');
      img.src = src;
      img.className = "carousel-img";
      container.appendChild(img);
    });
  }
}

setupCarousel('carousel-sports', ['img/deporte1.png', 'img/deporte2.png', 'img/deporte3.png']);
setupCarousel('carousel-music', ['img/musica1.png', 'img/musica2.png', 'img/musica3.png']);
setupCarousel('carousel-raffles', ['img/rifas1.png', 'img/rifas2.png', 'img/rifas3.png']);
setupCarousel('carousel-brts', ['img/brag1.png', 'img/brag2.png', 'img/brag3.png']);
