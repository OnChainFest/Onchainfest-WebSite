
document.addEventListener("DOMContentLoaded", function () {
  // Only apply if screen is mobile size
  if (window.innerWidth <= 768) {
    // Replace long descriptions with shorter ones
    const textMap = {
      "sports": "OnChainFest automates sports tournaments using Web3. Signups, payments, and prize payouts handled via smart contracts.",
      "music": "We issue NFT tickets to reduce fraud and cost. Artists sell directly and split revenue automatically.",
      "raffles": "100% fair raffles on-chain. Results and prizes are automatic and transparent.",
      "brts": "NFT trophies for champions. Trade, showcase, or collect BRTs as digital legacy.",
      "about": "We automate events with Web3 from LATAM. Real demos, smart contracts, global growth."
    };

    for (const id in textMap) {
      const section = document.getElementById(id);
      if (section) {
        const paragraphs = section.querySelectorAll("p");
        if (paragraphs.length) {
          paragraphs[0].textContent = textMap[id];
        }
      }
    }

    // Swap carousels for static images
    const imageMap = {
      "sports": "img/sports1.png",
      "music": "img/music2.png",
      "raffles": "img/raffle3.png",
      "brts": "img/brts3.png"
    };

    for (const id in imageMap) {
      const carousel = document.getElementById("carousel-" + id);
      if (carousel) {
        carousel.innerHTML = "";
        const img = document.createElement("img");
        img.src = imageMap[id];
        img.alt = id + " image";
        img.style.width = "100%";
        img.style.height = "auto";
        carousel.appendChild(img);
      }
    }
  }
});
