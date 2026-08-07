<template>
    <svg viewBox="0 0 24 24" aria-hidden="true">
        <path class="robot-antenna" d="M12 3v4" />
        <circle class="robot-antenna-tip" cx="12" cy="3" r="1.5" />
        <path class="robot-ear" d="M4.5 10.5H3v5h1.5M19.5 10.5H21v5h-1.5" />
        <rect class="robot-head" x="5" y="7" width="14" height="11" rx="3" />
        <circle class="robot-eye robot-eye-left" cx="9.5" cy="12" r="1.35" />
        <circle class="robot-eye robot-eye-right" cx="14.5" cy="12" r="1.35" />
        <path class="robot-mouth" d="M9 15.5h6" />
    </svg>
</template>

<style scoped>
svg {
    display: block;
    overflow: visible;
}

.robot-head {
    fill: #6c63ff;
    stroke: #4338ca;
    stroke-width: 1.25;
}

.robot-antenna {
    fill: none;
    stroke: #ff8a4c;
    stroke-width: 1.7;
    stroke-linecap: round;
}

.robot-antenna-tip {
    fill: #ffb020;
}

.robot-ear {
    fill: none;
    stroke: #19c6b3;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
}

.robot-eye {
    fill: #ffffff;
}

.robot-eye-left {
    filter: drop-shadow(0 0 1px rgba(58, 231, 255, 0.9));
}

.robot-eye-right {
    filter: drop-shadow(0 0 1px rgba(255, 222, 89, 0.9));
}

.robot-mouth {
    fill: none;
    stroke: #b9f6ff;
    stroke-width: 1.4;
    stroke-linecap: round;
}
</style>
