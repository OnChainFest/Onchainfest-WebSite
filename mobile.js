
document.addEventListener("DOMContentLoaded", function () {
  // Only run on mobile
  if (window.innerWidth <= 768) {
    // 1. Insert hamburger menu
    const header = document.querySelector("header");
    const hamburger = document.createElement("span");
    hamburger.innerText = "☰";
    hamburger.id = "hamburgerToggle";
    hamburger.className = "mobile-hamburger";
    header.insertBefore(hamburger, header.firstChild);

    const mobileNav = document.createElement("div");
    mobileNav.id = "mobileNav";
    mobileNav.className = "mobile-nav";
    mobileNav.innerHTML = `
      <a href="#sports">Sport Events</a>
      <a href="#music">Music Events</a>
      <a href="#raffles">Raffles</a>
      <a href="#brts">$BRT's</a>
      <a href="#about">About Us</a>
      <a href="contact.html">Contact</a>
    `;
    header.parentNode.insertBefore(mobileNav, header.nextSibling);

    document.getElementById("hamburgerToggle").addEventListener("click", () => {
      mobileNav.style.display = mobileNav.style.display === "flex" ? "none" : "flex";
    });

    document.querySelectorAll("#mobileNav a").forEach(link => {
      link.addEventListener("click", () => {
        mobileNav.style.display = "none";
      });
    });

    // 2. Reduce long section texts
    const textMap = {
      "sports": "OnChainFest automates sports tournaments using Web3. Registration, payments, and prizes via smart contracts.",
      "music": "NFT tickets eliminate fraud and reduce costs. Artists sell directly and split revenue easily.",
      "raffles": "Fair, transparent raffles on-chain. Public draws, automatic prize delivery.",
      "brts": "Digital trophies (BRTs) for champions. Fans and players collect and trade wins.",
      "about": "We automate events with Web3 from LATAM. Real demos, global expansion."
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

    // 3. Replace carousel with static image
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
