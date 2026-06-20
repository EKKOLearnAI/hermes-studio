<template>
  <!-- Style 1: chip badge
  <svg class="settings-circuit-badge settings-circuit-badge--chip" viewBox="0 0 34 22" fill="none" aria-hidden="true">
    <rect class="settings-circuit-badge-shell" x="4.5" y="3.5" width="25" height="15" rx="4" />
    <path class="settings-circuit-pin" d="M2.5 7h3M2.5 11h3M2.5 15h3M28.5 7h3M28.5 11h3M28.5 15h3" />
    <path class="settings-circuit-pin" d="M11 1.8v2M17 1.8v2M23 1.8v2M11 18.2v2M17 18.2v2M23 18.2v2" />
    <rect class="settings-circuit-chip" x="12" y="6" width="10" height="10" rx="2" />
    <path class="settings-circuit-track" d="M17 11H7" />
    <path class="settings-circuit-track" d="M17 11h10" />
    <path class="settings-circuit-track" d="M17 11V5" />
    <path class="settings-circuit-track" d="M17 11v6" />
    <path class="settings-circuit-track" d="M14 8h-4V6H7" />
    <path class="settings-circuit-track" d="M20 8h4V6h3" />
    <path class="settings-circuit-track" d="M14 14h-4v2H7" />
    <path class="settings-circuit-track" d="M20 14h4v2h3" />
    <path class="settings-circuit-pulse settings-circuit-pulse-main" d="M17 11H7" pathLength="1" />
    <path class="settings-circuit-pulse settings-circuit-pulse-main settings-circuit-pulse-late" d="M17 11h10" pathLength="1" />
    <path class="settings-circuit-pulse settings-circuit-pulse-branch" d="M17 11V5" pathLength="1" />
    <path class="settings-circuit-pulse settings-circuit-pulse-branch settings-circuit-pulse-late" d="M17 11v6" pathLength="1" />
    <path class="settings-circuit-pulse settings-circuit-pulse-branch" d="M14 8h-4V6H7" pathLength="1" />
    <path class="settings-circuit-pulse settings-circuit-pulse-branch settings-circuit-pulse-late" d="M20 14h4v2h3" pathLength="1" />
    <circle class="settings-circuit-core" cx="17" cy="11" r="1.35" />
    <circle class="settings-circuit-node" cx="7" cy="6" r="0.9" />
    <circle class="settings-circuit-node" cx="27" cy="6" r="0.9" />
    <circle class="settings-circuit-node" cx="7" cy="16" r="0.9" />
    <circle class="settings-circuit-node" cx="27" cy="16" r="0.9" />
  </svg>
  -->
  <svg class="settings-circuit-badge settings-circuit-badge--pcb" viewBox="0 0 36 22" fill="none" aria-hidden="true">
    <rect class="settings-pcb-board" x="3" y="3" width="30" height="16" rx="3" />
    <path class="settings-pcb-copper" d="M7 7h6v4h7v-3h9" />
    <path class="settings-pcb-copper" d="M7 15h5v-3h5v4h12" />
    <path class="settings-pcb-copper" d="M12 7v-2h8" />
    <path class="settings-pcb-copper" d="M24 15v2h5" />
    <path class="settings-pcb-current settings-pcb-current-main" d="M7 7h6v4h7v-3h9" pathLength="1" />
    <path class="settings-pcb-current settings-pcb-current-main settings-pcb-current-late" d="M7 15h5v-3h5v4h12" pathLength="1" />
    <path class="settings-pcb-current settings-pcb-current-branch" d="M12 7v-2h8" pathLength="1" />
    <path class="settings-pcb-current settings-pcb-current-branch settings-pcb-current-late" d="M24 15v2h5" pathLength="1" />
    <circle class="settings-pcb-pad settings-pcb-pad-live" cx="7" cy="7" r="1.2" />
    <circle class="settings-pcb-pad" cx="13" cy="11" r="1" />
    <circle class="settings-pcb-pad settings-pcb-pad-live" cx="20" cy="11" r="1.2" />
    <circle class="settings-pcb-pad" cx="29" cy="8" r="1" />
    <circle class="settings-pcb-pad settings-pcb-pad-live settings-pcb-pad-late" cx="17" cy="12" r="1.2" />
    <circle class="settings-pcb-pad" cx="29" cy="15" r="1" />
    <circle class="settings-pcb-via" cx="20" cy="5" r="0.8" />
    <circle class="settings-pcb-via" cx="29" cy="17" r="0.8" />
  </svg>
  <!-- Style 3: current scan line
  <svg class="settings-circuit-badge settings-circuit-badge--scan" viewBox="0 0 36 20" fill="none" aria-hidden="true">
    <path class="settings-scan-track" d="M3 10h6l3-5h7l3 10h5l3-5h3" />
    <path class="settings-scan-track settings-scan-branch" d="M12 5V3h6" />
    <path class="settings-scan-track settings-scan-branch" d="M22 15v2h7" />
    <path class="settings-scan-glow" d="M3 10h6l3-5h7l3 10h5l3-5h3" pathLength="1" />
    <path class="settings-scan-glow settings-scan-glow-branch" d="M12 5V3h6" pathLength="1" />
    <path class="settings-scan-glow settings-scan-glow-branch settings-scan-glow-late" d="M22 15v2h7" pathLength="1" />
    <circle class="settings-scan-node settings-scan-node-live" cx="12" cy="5" r="1.2" />
    <circle class="settings-scan-node" cx="19" cy="5" r="0.9" />
    <circle class="settings-scan-node settings-scan-node-live settings-scan-node-late" cx="22" cy="15" r="1.2" />
    <circle class="settings-scan-node" cx="30" cy="10" r="0.9" />
  </svg>
  -->
</template>

<style scoped lang="scss">
.settings-circuit-badge {
  flex: 0 0 auto;
  width: 34px;
  height: 20px;
  margin-left: auto;
  color: #d6a019;
  overflow: visible;
  filter: drop-shadow(0 0 4px rgba(214, 160, 25, 0.45));
}

.settings-circuit-badge--scan {
  height: 18px;
  color: #d6a019;
  filter:
    drop-shadow(0 0 3px rgba(214, 160, 25, 0.55))
    drop-shadow(0 0 8px rgba(214, 160, 25, 0.22));
}

.settings-scan-track,
.settings-scan-glow {
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.settings-scan-track {
  stroke-width: 1.25;
  opacity: 0.24;
}

.settings-scan-branch {
  opacity: 0.18;
}

.settings-scan-glow {
  stroke-width: 1.85;
  stroke-dasharray: 0.12 0.88;
  animation: settings-circuit-flow 1.05s linear infinite;
}

.settings-scan-glow-branch {
  stroke-width: 1.55;
  animation-duration: 1.65s;
}

.settings-scan-glow-late {
  animation-delay: -0.55s;
}

.settings-scan-node {
  fill: rgba(214, 160, 25, 0.38);
  stroke: currentColor;
  stroke-width: 0.8;
}

.settings-scan-node-live {
  fill: currentColor;
  animation: settings-circuit-node 1.05s ease-in-out infinite;
}

.settings-scan-node-late {
  animation-delay: -0.55s;
}

.settings-pcb-board {
  fill: rgba(86, 72, 28, 0.32);
  stroke: rgba(214, 160, 25, 0.58);
  stroke-width: 1;
}

.settings-pcb-copper,
.settings-pcb-current {
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.settings-pcb-copper {
  stroke-width: 1.15;
  opacity: 0.32;
}

.settings-pcb-current {
  stroke-width: 1.75;
  stroke-dasharray: 0.18 0.82;
  /* animation: settings-circuit-flow 1.35s linear infinite; */
}

.settings-pcb-current-branch {
  /* animation-duration: 1.8s; */
}

.settings-pcb-current-late {
  /* animation-delay: -0.65s; */
}

.settings-pcb-pad,
.settings-pcb-via {
  fill: rgba(214, 160, 25, 0.34);
  stroke: currentColor;
  stroke-width: 0.9;
}

.settings-pcb-via {
  opacity: 0.55;
}

.settings-pcb-pad-live {
  fill: currentColor;
  /* animation: settings-circuit-node 1.35s ease-in-out infinite; */
}

.settings-pcb-pad-late {
  /* animation-delay: -0.65s; */
}

.settings-circuit-badge-shell {
  fill: rgba(214, 160, 25, 0.1);
  stroke: rgba(214, 160, 25, 0.55);
  stroke-width: 1;
}

.settings-circuit-chip {
  fill: rgba(214, 160, 25, 0.18);
  stroke: rgba(255, 220, 125, 0.75);
  stroke-width: 1;
}

.settings-circuit-pin,
.settings-circuit-track,
.settings-circuit-pulse {
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.settings-circuit-pin {
  stroke-width: 1.1;
  opacity: 0.48;
}

.settings-circuit-track {
  stroke-width: 1;
  opacity: 0.32;
}

.settings-circuit-pulse {
  stroke-width: 1.6;
  stroke-dasharray: 0.2 0.8;
  animation: settings-circuit-flow 1.2s linear infinite;
}

.settings-circuit-pulse-branch {
  animation-duration: 1.9s;
}

.settings-circuit-pulse-late {
  animation-delay: -0.65s;
}

.settings-circuit-core,
.settings-circuit-node {
  fill: currentColor;
  opacity: 0.9;
  animation: settings-circuit-node 1.45s ease-in-out infinite;
}

.settings-circuit-core {
  filter: drop-shadow(0 0 4px rgba(255, 220, 125, 0.9));
}

@keyframes settings-circuit-flow {
  to {
    stroke-dashoffset: -1;
  }
}

@keyframes settings-circuit-node {
  0%,
  100% {
    opacity: 0.45;
  }

  50% {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .settings-scan-glow,
  .settings-scan-node-live,
  .settings-pcb-current,
  .settings-pcb-pad-live,
  .settings-circuit-pulse,
  .settings-circuit-node {
    animation: none;
  }
}
</style>
