(() => {
  if (!window.location.hash && "scrollRestoration" in window.history) {
    window.history.scrollRestoration = "manual";
    window.scrollTo(0, 0);
    window.requestAnimationFrame(() => window.scrollTo(0, 0));
  }

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const mobileQuery = window.matchMedia("(max-width: 767px)");
  const stage = document.querySelector("[data-orbit-stage]");
  const orbitItems = stage ? [...stage.querySelectorAll(".orbit-device")] : [];
  const colorChoices = [...document.querySelectorAll("[data-color-choice]")];
  const statusLabel = document.querySelector("[data-status-label]");
  const statusSwatch = document.querySelector("[data-status-swatch]");
  const menuToggle = document.querySelector(".menu-toggle");
  const mobileNav = document.querySelector(".mobile-nav");
  const revealItems = [...document.querySelectorAll(".reveal")];

  const colorMeta = {
    pink: { label: "玫瑰粉", value: "#ee7695" },
    green: { label: "薄荷绿", value: "#78df8d" },
    red: { label: "深莓红", value: "#b62e45" },
    white: { label: "暖瓷白", value: "#e7e7cf" },
    blue: { label: "天空蓝", value: "#79b7e8" },
    orange: { label: "杏橙", value: "#eca36b" },
    black: { label: "石墨黑", value: "#343838" },
  };

  let activeIndex = 0;
  let rotationOffset = Math.PI / 2;
  let displayedColor = "";
  let animationFrame = 0;
  let lastFrame = 0;
  let paused = false;
  let visible = true;
  let cycleStart = performance.now();

  const updateStatus = (color) => {
    if (!color || color === displayedColor) return;
    const meta = colorMeta[color];
    if (!meta || !statusLabel || !statusSwatch) return;
    displayedColor = color;
    statusLabel.textContent = meta.label;
    statusSwatch.style.background = meta.value;
  };

  const setSelectedColor = (color) => {
    const index = orbitItems.findIndex((item) => item.dataset.color === color);
    if (index < 0) return;
    activeIndex = index;
    rotationOffset = Math.PI / 2 - activeIndex * ((Math.PI * 2) / orbitItems.length);
    cycleStart = performance.now();
    colorChoices.forEach((choice) => {
      const selected = choice.dataset.colorChoice === color;
      choice.classList.toggle("is-selected", selected);
      choice.setAttribute("aria-pressed", String(selected));
    });
    updateStatus(color);
    updateOrbit(cycleStart, true);
  };

  const updateOrbit = (time, snapToActive = false) => {
    if (!stage || !orbitItems.length) return;
    const elapsed = paused || !visible || reducedMotion.matches || snapToActive
      ? 0
      : (time - cycleStart) / 18000;
    const rotation = snapToActive
      ? Math.PI / 2 - activeIndex * ((Math.PI * 2) / orbitItems.length)
      : rotationOffset + elapsed * Math.PI * 2;
    const isMobile = mobileQuery.matches;
    const radiusX = isMobile ? 0 : Math.min(stage.clientWidth * 0.32, 260);
    const radiusY = isMobile ? 0 : Math.min(stage.clientHeight * 0.18, 120);
    let frontIndex = activeIndex;
    let frontDepth = -1;
    const mobileIndex = snapToActive
      ? activeIndex
      : (activeIndex + Math.floor(elapsed * orbitItems.length)) % orbitItems.length;

    orbitItems.forEach((item, index) => {
      if (isMobile) {
        const isActive = index === mobileIndex;
        item.style.opacity = isActive ? "1" : "0";
        item.style.pointerEvents = isActive ? "auto" : "none";
        item.style.transform = "translate3d(-50%, -50%, 0) scale(1)";
        item.style.zIndex = isActive ? "2" : "0";
        return;
      }

      const angle = rotation + index * ((Math.PI * 2) / orbitItems.length);
      const depth = (Math.sin(angle) + 1) / 2;
      const x = Math.cos(angle) * radiusX;
      const y = Math.sin(angle) * radiusY;
      const scale = 0.62 + depth * 0.38;
      const opacity = 0.44 + depth * 0.56;
      if (depth > frontDepth) {
        frontDepth = depth;
        frontIndex = index;
      }
      item.style.transform = `translate3d(calc(-50% + ${x.toFixed(2)}px), calc(-50% + ${y.toFixed(2)}px), 0) scale(${scale.toFixed(3)})`;
      item.style.opacity = opacity.toFixed(3);
      item.style.zIndex = String(Math.round(depth * 10));
    });

    updateStatus(orbitItems[isMobile ? mobileIndex : frontIndex]?.dataset.color);
  };

  const animateOrbit = (time) => {
    if (time - lastFrame > 16) {
      updateOrbit(time);
      lastFrame = time;
    }
    animationFrame = window.requestAnimationFrame(animateOrbit);
  };

  if (stage && orbitItems.length) {
    setSelectedColor("pink");
    if (!reducedMotion.matches) {
      animationFrame = window.requestAnimationFrame(animateOrbit);
    }

    stage.addEventListener("focusin", () => { paused = true; });
    stage.addEventListener("focusout", () => { paused = false; cycleStart = performance.now(); });
  }

  colorChoices.forEach((choice) => {
    choice.addEventListener("click", () => setSelectedColor(choice.dataset.colorChoice));
  });

  if (stage) {
    const visibilityObserver = new IntersectionObserver((entries) => {
      visible = entries[0]?.isIntersecting ?? true;
    }, { threshold: 0.08 });
    visibilityObserver.observe(stage);
  }

  const handleResize = () => {
    if (stage) updateOrbit(performance.now(), mobileQuery.matches);
  };
  mobileQuery.addEventListener?.("change", handleResize);
  window.addEventListener("resize", handleResize, { passive: true });

  if (menuToggle && mobileNav) {
    menuToggle.addEventListener("click", () => {
      const isOpen = menuToggle.classList.toggle("is-open");
      mobileNav.classList.toggle("is-open", isOpen);
      menuToggle.setAttribute("aria-expanded", String(isOpen));
    });
    mobileNav.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => {
        menuToggle.classList.remove("is-open");
        mobileNav.classList.remove("is-open");
        menuToggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  if (reducedMotion.matches) {
    updateOrbit(performance.now(), true);
  }

  reducedMotion.addEventListener?.("change", () => {
    if (reducedMotion.matches) {
      window.cancelAnimationFrame(animationFrame);
      updateOrbit(performance.now(), true);
    } else if (stage) {
      cycleStart = performance.now();
      animationFrame = window.requestAnimationFrame(animateOrbit);
    }
  });

  if ("IntersectionObserver" in window) {
    const revealObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.14 });
    revealItems.forEach((item) => revealObserver.observe(item));
  } else {
    revealItems.forEach((item) => item.classList.add("is-visible"));
  }
})();
