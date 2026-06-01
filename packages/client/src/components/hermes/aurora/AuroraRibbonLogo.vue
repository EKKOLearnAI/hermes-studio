<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 120 120"
    class="aurora-ribbon-logo w-16 h-16 drop-shadow-2xl hover:scale-105 transition-transform duration-500"
  >
    <defs>
      <linearGradient id="auroraGrad1" x1="0%" y1="100%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#38bdf8" />
        <stop offset="50%" stop-color="#3b82f6" />
        <stop offset="100%" stop-color="#a855f7" />
      </linearGradient>

      <linearGradient id="auroraGrad2" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#67e8f9" />
        <stop offset="100%" stop-color="#3b82f6" stop-opacity="0.8" />
      </linearGradient>

      <linearGradient id="auroraGrad3" x1="100%" y1="100%" x2="0%" y2="0%">
        <stop offset="0%" stop-color="#c084fc" />
        <stop offset="100%" stop-color="#8b5cf6" stop-opacity="0.3" />
      </linearGradient>
    </defs>

    <g transform="translate(10, 15)">
      <path d="M45,15 C55,40 70,60 85,75 C95,85 85,95 75,90 C50,75 40,40 30,20 Z" fill="url(#auroraGrad3)" style="mix-blend-mode: multiply;" />

      <path d="M50,5 C40,20 15,65 5,85 C-5,100 15,95 25,85 C45,60 55,25 60,10 C62,5 55,-5 50,5 Z" fill="url(#auroraGrad1)" />

      <path d="M20,60 C40,50 65,65 80,85 C85,95 100,90 95,80 C80,50 45,35 25,50 Z" fill="url(#auroraGrad2)" style="mix-blend-mode: screen;" />
    </g>

    <path d="M90,15 C92,23 98,29 106,31 C98,33 92,39 90,47 C88,39 82,33 74,31 C82,29 88,23 90,15 Z" fill="#60a5fa" class="animate-pulse" />
  </svg>
</template>

<style scoped>
.aurora-ribbon-logo {
  width: 64px;
  height: 64px;
  flex: 0 0 auto;
  overflow: visible;
  filter: drop-shadow(0 18px 30px rgba(99, 102, 241, 0.28));
  transform-origin: center;
  transition: transform 0.5s cubic-bezier(0.4, 0, 0.2, 1), filter 0.5s cubic-bezier(0.4, 0, 0.2, 1);
}

.aurora-ribbon-logo:hover {
  filter: drop-shadow(0 22px 34px rgba(139, 92, 246, 0.34));
  transform: scale(1.05);
}

.animate-pulse {
  animation: aurora-logo-pulse 2.8s ease-in-out infinite;
}

@keyframes aurora-logo-pulse {
  0%,
  100% {
    opacity: 0.62;
    transform: scale(0.96);
    transform-origin: 90px 31px;
  }

  50% {
    opacity: 1;
    transform: scale(1.06);
    transform-origin: 90px 31px;
  }
}
</style>
