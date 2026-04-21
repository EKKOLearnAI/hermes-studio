/// <reference types="../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/template-helpers.d.ts" />
/// <reference types="../../../../../../../.npm/_npx/2db181330ea4b15b/node_modules/@vue/language-core/types/props-fallback.d.ts" />
import { ref, onMounted, onUnmounted, computed } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { getApiKey, getBaseUrlValue } from "@/api/client";
import { NButton, NPopconfirm, NTooltip, NSelect, useMessage } from "naive-ui";
import { useI18n } from "vue-i18n";
const { t } = useI18n();
const message = useMessage();
// ─── Terminal themes ────────────────────────────────────────────
const TERMINAL_THEMES = {
    default: {
        label: "Default",
        theme: {
            background: "#1a1a2e",
            foreground: "#e0e0e0",
            cursor: "#4cc9f0",
            cursorAccent: "#1a1a2e",
            selectionBackground: "rgba(76, 201, 240, 0.3)",
            black: "#000000", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
            blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf",
            brightBlack: "#5c6370", brightRed: "#e06c75", brightGreen: "#98c379",
            brightYellow: "#e5c07b", brightBlue: "#61afef", brightMagenta: "#c678dd",
            brightCyan: "#56b6c2", brightWhite: "#ffffff",
        },
    },
    "solarized-dark": {
        label: "Solarized Dark",
        theme: {
            background: "#002b36", foreground: "#839496",
            cursor: "#93a1a1", cursorAccent: "#002b36",
            selectionBackground: "rgba(147, 161, 161, 0.3)",
            black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
            blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
            brightBlack: "#002b36", brightRed: "#cb4b16", brightGreen: "#586e75",
            brightYellow: "#657b83", brightBlue: "#839496", brightMagenta: "#6c71c4",
            brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
        },
    },
    "solarized-light": {
        label: "Solarized Light",
        theme: {
            background: "#fdf6e3", foreground: "#657b83",
            cursor: "#586e75", cursorAccent: "#fdf6e3",
            selectionBackground: "rgba(88, 110, 117, 0.3)",
            black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
            blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
            brightBlack: "#002b36", brightRed: "#cb4b16", brightGreen: "#586e75",
            brightYellow: "#657b83", brightBlue: "#839496", brightMagenta: "#6c71c4",
            brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
        },
    },
    monokai: {
        label: "Monokai",
        theme: {
            background: "#272822", foreground: "#f8f8f2",
            cursor: "#f8f8f0", cursorAccent: "#272822",
            selectionBackground: "rgba(248, 248, 242, 0.2)",
            black: "#272822", red: "#f92672", green: "#a6e22e", yellow: "#f4bf75",
            blue: "#66d9ef", magenta: "#ae81ff", cyan: "#a1efe4", white: "#f8f8f2",
            brightBlack: "#75715e", brightRed: "#fd971f", brightGreen: "#a6e22e",
            brightYellow: "#e6db74", brightBlue: "#66d9ef", brightMagenta: "#ae81ff",
            brightCyan: "#a1efe4", brightWhite: "#f9f8f5",
        },
    },
    dracula: {
        label: "Dracula",
        theme: {
            background: "#282a36", foreground: "#f8f8f2",
            cursor: "#f8f8f2", cursorAccent: "#282a36",
            selectionBackground: "rgba(248, 248, 242, 0.2)",
            black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c",
            blue: "#bd93f9", magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2",
            brightBlack: "#6272a4", brightRed: "#ff6e6e", brightGreen: "#69ff94",
            brightYellow: "#ffffa5", brightBlue: "#d6acff", brightMagenta: "#ff92df",
            brightCyan: "#a4ffff", brightWhite: "#ffffff",
        },
    },
    nord: {
        label: "Nord",
        theme: {
            background: "#2e3440", foreground: "#d8dee9",
            cursor: "#d8dee9", cursorAccent: "#2e3440",
            selectionBackground: "rgba(216, 222, 233, 0.2)",
            black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b",
            blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0",
            brightBlack: "#4c566a", brightRed: "#bf616a", brightGreen: "#a3be8c",
            brightYellow: "#ebcb8b", brightBlue: "#81a1c1", brightMagenta: "#b48ead",
            brightCyan: "#8fbcbb", brightWhite: "#eceff4",
        },
    },
    "one-dark": {
        label: "One Dark",
        theme: {
            background: "#282c34", foreground: "#abb2bf",
            cursor: "#528bff", cursorAccent: "#282c34",
            selectionBackground: "rgba(82, 139, 255, 0.25)",
            black: "#282c34", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
            blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf",
            brightBlack: "#5c6370", brightRed: "#e06c75", brightGreen: "#98c379",
            brightYellow: "#e5c07b", brightBlue: "#61afef", brightMagenta: "#c678dd",
            brightCyan: "#56b6c2", brightWhite: "#ffffff",
        },
    },
    "github-dark": {
        label: "GitHub Dark",
        theme: {
            background: "#0d1117", foreground: "#c9d1d9",
            cursor: "#58a6ff", cursorAccent: "#0d1117",
            selectionBackground: "rgba(88, 166, 255, 0.25)",
            black: "#484f58", red: "#ff7b72", green: "#7ee787", yellow: "#ffa657",
            blue: "#79c0ff", magenta: "#d2a8ff", cyan: "#a5d6ff", white: "#c9d1d9",
            brightBlack: "#6e7681", brightRed: "#ffa198", brightGreen: "#56d364",
            brightYellow: "#e3b341", brightBlue: "#58a6ff", brightMagenta: "#bc8cff",
            brightCyan: "#79c0ff", brightWhite: "#f0f6fc",
        },
    },
    "tokyo-night": {
        label: "Tokyo Night",
        theme: {
            background: "#1a1b26", foreground: "#a9b1d6",
            cursor: "#c0caf5", cursorAccent: "#1a1b26",
            selectionBackground: "rgba(192, 202, 245, 0.2)",
            black: "#15161e", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68",
            blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
            brightBlack: "#414868", brightRed: "#f7768e", brightGreen: "#9ece6a",
            brightYellow: "#e0af68", brightBlue: "#7aa2f7", brightMagenta: "#bb9af7",
            brightCyan: "#7dcfff", brightWhite: "#c0caf5",
        },
    },
    "github-light": {
        label: "GitHub Light",
        theme: {
            background: "#ffffff", foreground: "#24292f",
            cursor: "#0969da", cursorAccent: "#ffffff",
            selectionBackground: "rgba(9, 105, 218, 0.2)",
            black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#4d2d00",
            blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#57606a",
            brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37",
            brightYellow: "#633c01", brightBlue: "#218bff", brightMagenta: "#a475f4",
            brightCyan: "#3192aa", brightWhite: "#8c959f",
        },
    },
    "catppuccin-latte": {
        label: "Catppuccin Latte",
        theme: {
            background: "#eff1f5", foreground: "#4c4f69",
            cursor: "#dc8a78", cursorAccent: "#eff1f5",
            selectionBackground: "rgba(220, 138, 120, 0.2)",
            black: "#5c5f77", red: "#d20f39", green: "#40a02b", yellow: "#df8e1d",
            blue: "#1e66f5", magenta: "#ea76cb", cyan: "#179299", white: "#4c4f69",
            brightBlack: "#6c6f85", brightRed: "#d20f39", brightGreen: "#40a02b",
            brightYellow: "#df8e1d", brightBlue: "#1e66f5", brightMagenta: "#ea76cb",
            brightCyan: "#179299", brightWhite: "#bcc0cc",
        },
    },
    "alabaster-light": {
        label: "Alabaster",
        theme: {
            background: "#f7f7f7", foreground: "#434343",
            cursor: "#528bff", cursorAccent: "#f7f7f7",
            selectionBackground: "rgba(82, 139, 255, 0.2)",
            black: "#000000", red: "#aa3731", green: "#448c27", yellow: "#cb9000",
            blue: "#325cc0", magenta: "#7a3e9d", cyan: "#0083b2", white: "#434343",
            brightBlack: "#777777", brightRed: "#f05050", brightGreen: "#60cb00",
            brightYellow: "#ffbc5d", brightBlue: "#0070ea", brightMagenta: "#ca64e2",
            brightCyan: "#00aacb", brightWhite: "#999999",
        },
    },
    "xterm-light": {
        label: "XTerm Light",
        theme: {
            background: "#fafafa", foreground: "#383a42",
            cursor: "#526fff", cursorAccent: "#fafafa",
            selectionBackground: "rgba(82, 111, 255, 0.2)",
            black: "#383a42", red: "#e45649", green: "#50a14f", yellow: "#c18401",
            blue: "#4078f2", magenta: "#a626a4", cyan: "#0184bc", white: "#a0a1a7",
            brightBlack: "#4f525e", brightRed: "#e06c75", brightGreen: "#98c379",
            brightYellow: "#e5c07b", brightBlue: "#61afef", brightMagenta: "#c678dd",
            brightCyan: "#56b6c2", brightWhite: "#ffffff",
        },
    },
    "one-light": {
        label: "One Light",
        theme: {
            background: "#fafafa", foreground: "#383a42",
            cursor: "#526eff", cursorAccent: "#fafafa",
            selectionBackground: "rgba(82, 110, 255, 0.2)",
            black: "#383a42", red: "#e45649", green: "#50a14f", yellow: "#c18401",
            blue: "#4078f2", magenta: "#a626a4", cyan: "#0184bc", white: "#a0a1a7",
            brightBlack: "#4f525e", brightRed: "#e06c75", brightGreen: "#98c379",
            brightYellow: "#e5c07b", brightBlue: "#61afef", brightMagenta: "#c678dd",
            brightCyan: "#56b6c2", brightWhite: "#ffffff",
        },
    },
    "gruvbox-light": {
        label: "Gruvbox Light",
        theme: {
            background: "#fbf1c7", foreground: "#3c3836",
            cursor: "#9d0006", cursorAccent: "#fbf1c7",
            selectionBackground: "rgba(157, 0, 6, 0.15)",
            black: "#fbf1c7", red: "#cc241d", green: "#98971a", yellow: "#d79921",
            blue: "#458588", magenta: "#b16286", cyan: "#689d6a", white: "#504945",
            brightBlack: "#928374", brightRed: "#9d0006", brightGreen: "#79740e",
            brightYellow: "#b57614", brightBlue: "#076678", brightMagenta: "#8f3f71",
            brightCyan: "#427b58", brightWhite: "#3c3836",
        },
    },
};
const STORAGE_KEY_THEME = "hermes_terminal_theme";
// ─── State ──────────────────────────────────────────────────────
const terminalRef = ref(null);
const showSessions = ref(true);
const sessions = ref([]);
const activeSessionId = ref(null);
const selectedTheme = ref(localStorage.getItem(STORAGE_KEY_THEME) || "default");
let ws = null;
// Keep all terminal instances alive, only dispose on close
const termMap = new Map();
let activeTerm = null;
let activeFitAddon = null;
let resizeObserver = null;
let mobileQuery = null;
// ─── Computed ──────────────────────────────────────────────────
const activeSession = computed(() => sessions.value.find((s) => s.id === activeSessionId.value) || null);
const themeOptions = computed(() => Object.entries(TERMINAL_THEMES).map(([key, val]) => ({
    label: val.label,
    value: key,
})));
const terminalBg = computed(() => TERMINAL_THEMES[selectedTheme.value]?.theme.background ?? "#1a1a2e");
// ─── WebSocket ──────────────────────────────────────────────────
function buildWsUrl() {
    const token = getApiKey();
    const base = getBaseUrlValue();
    const wsProtocol = base
        ? base.startsWith("https")
            ? "wss:"
            : "ws:"
        : location.protocol === "https:"
            ? "wss:"
            : "ws:";
    if (base) {
        return `${wsProtocol}//${new URL(base).host}/api/hermes/terminal${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    }
    // Dev mode: connect directly to backend port; Production: same host
    const host = import.meta.env.DEV
        ? `${location.hostname}:8648`
        : location.host;
    return `${wsProtocol}//${host}/api/hermes/terminal${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}
function connect() {
    const url = buildWsUrl();
    ws = new WebSocket(url);
    ws.onopen = () => {
        // Server auto-creates the first session and sends 'created'
    };
    ws.onmessage = (event) => {
        const data = typeof event.data === "string" ? event.data : "";
        if (data.charCodeAt(0) === 0x7b) {
            try {
                handleControl(JSON.parse(data));
            }
            catch { }
        }
        else {
            activeTerm?.write(data);
        }
    };
    // On reconnect, recreate all terminals for existing sessions
    ws.onopen = () => {
        // Server will auto-create the first session again
    };
    ws.onclose = () => {
        // Reconnect after delay
        setTimeout(connect, 3000);
    };
    ws.onerror = () => {
        // let onclose handle reconnect
    };
}
function send(data) {
    if (!ws || ws.readyState !== WebSocket.OPEN)
        return;
    ws.send(typeof data === "string" ? data : JSON.stringify(data));
}
// ─── Control message handlers ──────────────────────────────────
function handleControl(msg) {
    switch (msg.type) {
        case "created":
            sessions.value.push({
                id: msg.id,
                shell: msg.shell,
                pid: msg.pid,
                title: `${msg.shell} #${sessions.value.length + 1}`,
                createdAt: Date.now(),
                exited: false,
            });
            switchSession(msg.id);
            break;
        case "switched":
            // Server confirmed switch — frontend already mounted in switchSession()
            break;
        case "exited": {
            const s = sessions.value.find((s) => s.id === msg.id);
            if (s) {
                s.exited = true;
                if (activeSessionId.value === msg.id) {
                    activeTerm?.write(`\r\n\x1b[90m[${t("terminal.processExited", { code: msg.exitCode })}]\x1b[0m\r\n`);
                }
            }
            break;
        }
        case "error":
            message.error(msg.message);
            break;
    }
}
// ─── Session actions ────────────────────────────────────────────
function createSession() {
    send({ type: "create" });
}
function getOrCreateTerm(id) {
    let entry = termMap.get(id);
    if (!entry) {
        const term = new Terminal({
            cursorBlink: true,
            fontSize: 14,
            fontFamily: 'Menlo, Monaco, "Courier New", monospace',
            theme: { ...TERMINAL_THEMES[selectedTheme.value].theme },
        });
        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.loadAddon(new WebLinksAddon());
        term.onData((data) => {
            if (ws?.readyState === WebSocket.OPEN) {
                ws.send(data);
            }
        });
        entry = { term, fitAddon, opened: false };
        termMap.set(id, entry);
    }
    return entry;
}
function switchSession(id) {
    if (activeSessionId.value === id)
        return;
    activeSessionId.value = id;
    const entry = getOrCreateTerm(id);
    activeTerm = entry.term;
    activeFitAddon = entry.fitAddon;
    mountActiveTerminal();
    send({ type: "switch", sessionId: id });
    if (mobileQuery?.matches)
        showSessions.value = false;
}
function closeSession(id) {
    send({ type: "close", sessionId: id });
    sessions.value = sessions.value.filter((s) => s.id !== id);
    // Dispose terminal instance
    const entry = termMap.get(id);
    if (entry) {
        entry.term.dispose();
        termMap.delete(id);
    }
    if (activeSessionId.value === id) {
        activeSessionId.value =
            sessions.value.length > 0 ? sessions.value[0].id : null;
        activeTerm = null;
        activeFitAddon = null;
        if (activeSessionId.value) {
            switchSession(activeSessionId.value);
        }
        else {
            unmountActiveTerminal();
            createSession();
        }
    }
}
// ─── Terminal mount/unmount ─────────────────────────────────────
function mountActiveTerminal() {
    if (!terminalRef.value)
        return;
    const container = terminalRef.value;
    // Remove old terminal DOM from container
    while (container.firstChild)
        container.removeChild(container.firstChild);
    const entry = termMap.get(activeSessionId.value);
    if (!entry)
        return;
    if (!entry.opened) {
        // First time: call open()
        entry.term.open(container);
        entry.opened = true;
    }
    else {
        // Already opened: move the existing DOM element
        const termEl = entry.term.element;
        if (termEl) {
            container.appendChild(termEl);
        }
    }
    // Resize observer
    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver(() => {
        tryFit();
        sendResize();
    });
    resizeObserver.observe(terminalRef.value);
    // Fit after DOM is ready
    setTimeout(() => tryFit(), 50);
    setTimeout(() => tryFit(), 200);
}
function unmountActiveTerminal() {
    if (!terminalRef.value)
        return;
    const container = terminalRef.value;
    while (container.firstChild)
        container.removeChild(container.firstChild);
}
function tryFit() {
    if (!activeFitAddon)
        return;
    try {
        activeFitAddon.fit();
    }
    catch { }
}
function sendResize() {
    if (!activeTerm || !ws || ws.readyState !== WebSocket.OPEN)
        return;
    try {
        send({
            type: "resize",
            cols: activeTerm.cols,
            rows: activeTerm.rows,
        });
    }
    catch { }
}
// ─── Theme ───────────────────────────────────────────────────────
function applyTheme(themeName) {
    selectedTheme.value = themeName;
    localStorage.setItem(STORAGE_KEY_THEME, themeName);
    const themeObj = TERMINAL_THEMES[themeName]?.theme;
    if (!themeObj)
        return;
    for (const entry of termMap.values()) {
        entry.term.options.theme = { ...themeObj };
    }
}
// ─── Helpers ────────────────────────────────────────────────────
function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function handleMobileChange(e) {
    if (e.matches && showSessions.value)
        showSessions.value = false;
}
// ─── Lifecycle ──────────────────────────────────────────────────
onMounted(() => {
    mobileQuery = window.matchMedia("(max-width: 768px)");
    handleMobileChange(mobileQuery);
    mobileQuery.addEventListener("change", handleMobileChange);
    connect();
});
onUnmounted(() => {
    mobileQuery?.removeEventListener("change", handleMobileChange);
    unmountActiveTerminal();
    // Dispose all terminal instances
    for (const entry of termMap.values()) {
        entry.term.dispose();
    }
    termMap.clear();
    activeTerm = null;
    activeFitAddon = null;
    ws?.close();
    ws = null;
});
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['collapsed']} */ ;
/** @type {__VLS_StyleScopedClasses['session-item-delete']} */ ;
/** @type {__VLS_StyleScopedClasses['xterm-viewport']} */ ;
/** @type {__VLS_StyleScopedClasses['xterm-scrollable-element']} */ ;
/** @type {__VLS_StyleScopedClasses['session-close-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
/** @type {__VLS_StyleScopedClasses['terminal-header']} */ ;
/** @type {__VLS_StyleScopedClasses['terminal-container']} */ ;
/** @type {__VLS_StyleScopedClasses['terminal-xterm']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "terminal-panel" },
});
/** @type {__VLS_StyleScopedClasses['terminal-panel']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.showSessions = false;
            // @ts-ignore
            [showSessions,];
        } },
    ...{ class: "session-backdrop" },
    ...{ class: ({ active: __VLS_ctx.showSessions }) },
});
/** @type {__VLS_StyleScopedClasses['session-backdrop']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.aside, __VLS_intrinsics.aside)({
    ...{ class: "session-list" },
    ...{ class: ({ collapsed: !__VLS_ctx.showSessions }) },
});
/** @type {__VLS_StyleScopedClasses['session-list']} */ ;
/** @type {__VLS_StyleScopedClasses['collapsed']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "session-list-header" },
});
/** @type {__VLS_StyleScopedClasses['session-list-header']} */ ;
if (__VLS_ctx.showSessions) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "session-list-title" },
    });
    /** @type {__VLS_StyleScopedClasses['session-list-title']} */ ;
    (__VLS_ctx.t("terminal.sessions"));
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "session-list-actions" },
});
/** @type {__VLS_StyleScopedClasses['session-list-actions']} */ ;
let __VLS_0;
/** @ts-ignore @type {typeof __VLS_components.NTooltip | typeof __VLS_components.NTooltip} */
NTooltip;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
    trigger: "hover",
}));
const __VLS_2 = __VLS_1({
    trigger: "hover",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
const { default: __VLS_5 } = __VLS_3.slots;
{
    const { trigger: __VLS_6 } = __VLS_3.slots;
    let __VLS_7;
    /** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
    NButton;
    // @ts-ignore
    const __VLS_8 = __VLS_asFunctionalComponent1(__VLS_7, new __VLS_7({
        ...{ 'onClick': {} },
        quaternary: true,
        size: "tiny",
        circle: true,
    }));
    const __VLS_9 = __VLS_8({
        ...{ 'onClick': {} },
        quaternary: true,
        size: "tiny",
        circle: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_8));
    let __VLS_12;
    const __VLS_13 = ({ click: {} },
        { onClick: (__VLS_ctx.createSession) });
    const { default: __VLS_14 } = __VLS_10.slots;
    {
        const { icon: __VLS_15 } = __VLS_10.slots;
        __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
            width: "14",
            height: "14",
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            'stroke-width': "2",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.line)({
            x1: "12",
            y1: "5",
            x2: "12",
            y2: "19",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.line)({
            x1: "5",
            y1: "12",
            x2: "19",
            y2: "12",
        });
        // @ts-ignore
        [showSessions, showSessions, showSessions, t, createSession,];
    }
    // @ts-ignore
    [];
    var __VLS_10;
    var __VLS_11;
    // @ts-ignore
    [];
}
(__VLS_ctx.t("terminal.newTab"));
// @ts-ignore
[t,];
var __VLS_3;
if (__VLS_ctx.showSessions) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "session-items" },
    });
    /** @type {__VLS_StyleScopedClasses['session-items']} */ ;
    if (__VLS_ctx.sessions.length === 0) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "session-empty" },
        });
        /** @type {__VLS_StyleScopedClasses['session-empty']} */ ;
        (__VLS_ctx.t("common.loading"));
    }
    for (const [s] of __VLS_vFor((__VLS_ctx.sessions))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.showSessions))
                        return;
                    __VLS_ctx.switchSession(s.id);
                    // @ts-ignore
                    [showSessions, t, sessions, sessions, switchSession,];
                } },
            key: (s.id),
            ...{ class: "session-item" },
            ...{ class: ({ active: s.id === __VLS_ctx.activeSessionId, exited: s.exited }) },
        });
        /** @type {__VLS_StyleScopedClasses['session-item']} */ ;
        /** @type {__VLS_StyleScopedClasses['active']} */ ;
        /** @type {__VLS_StyleScopedClasses['exited']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "session-item-content" },
        });
        /** @type {__VLS_StyleScopedClasses['session-item-content']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "session-item-title" },
        });
        /** @type {__VLS_StyleScopedClasses['session-item-title']} */ ;
        (s.title);
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "session-item-meta" },
        });
        /** @type {__VLS_StyleScopedClasses['session-item-meta']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "session-item-shell" },
        });
        /** @type {__VLS_StyleScopedClasses['session-item-shell']} */ ;
        (s.shell);
        if (s.exited) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "session-item-status" },
            });
            /** @type {__VLS_StyleScopedClasses['session-item-status']} */ ;
            (__VLS_ctx.t("terminal.sessionExited"));
        }
        else {
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "session-item-time" },
            });
            /** @type {__VLS_StyleScopedClasses['session-item-time']} */ ;
            (__VLS_ctx.formatTime(s.createdAt));
        }
        if (__VLS_ctx.sessions.length > 1) {
            let __VLS_16;
            /** @ts-ignore @type {typeof __VLS_components.NPopconfirm | typeof __VLS_components.NPopconfirm} */
            NPopconfirm;
            // @ts-ignore
            const __VLS_17 = __VLS_asFunctionalComponent1(__VLS_16, new __VLS_16({
                ...{ 'onPositiveClick': {} },
            }));
            const __VLS_18 = __VLS_17({
                ...{ 'onPositiveClick': {} },
            }, ...__VLS_functionalComponentArgsRest(__VLS_17));
            let __VLS_21;
            const __VLS_22 = ({ positiveClick: {} },
                { onPositiveClick: (...[$event]) => {
                        if (!(__VLS_ctx.showSessions))
                            return;
                        if (!(__VLS_ctx.sessions.length > 1))
                            return;
                        __VLS_ctx.closeSession(s.id);
                        // @ts-ignore
                        [t, sessions, activeSessionId, formatTime, closeSession,];
                    } });
            const { default: __VLS_23 } = __VLS_19.slots;
            {
                const { trigger: __VLS_24 } = __VLS_19.slots;
                __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                    ...{ onClick: () => { } },
                    ...{ class: "session-item-delete" },
                });
                /** @type {__VLS_StyleScopedClasses['session-item-delete']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
                    width: "12",
                    height: "12",
                    viewBox: "0 0 24 24",
                    fill: "none",
                    stroke: "currentColor",
                    'stroke-width': "2",
                });
                __VLS_asFunctionalElement1(__VLS_intrinsics.line)({
                    x1: "18",
                    y1: "6",
                    x2: "6",
                    y2: "18",
                });
                __VLS_asFunctionalElement1(__VLS_intrinsics.line)({
                    x1: "6",
                    y1: "6",
                    x2: "18",
                    y2: "18",
                });
                // @ts-ignore
                [];
            }
            (__VLS_ctx.t("terminal.closeSession"));
            // @ts-ignore
            [t,];
            var __VLS_19;
            var __VLS_20;
        }
        // @ts-ignore
        [];
    }
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "terminal-main" },
});
/** @type {__VLS_StyleScopedClasses['terminal-main']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.header, __VLS_intrinsics.header)({
    ...{ class: "terminal-header" },
});
/** @type {__VLS_StyleScopedClasses['terminal-header']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "header-left" },
});
/** @type {__VLS_StyleScopedClasses['header-left']} */ ;
let __VLS_25;
/** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
NButton;
// @ts-ignore
const __VLS_26 = __VLS_asFunctionalComponent1(__VLS_25, new __VLS_25({
    ...{ 'onClick': {} },
    quaternary: true,
    size: "small",
    circle: true,
}));
const __VLS_27 = __VLS_26({
    ...{ 'onClick': {} },
    quaternary: true,
    size: "small",
    circle: true,
}, ...__VLS_functionalComponentArgsRest(__VLS_26));
let __VLS_30;
const __VLS_31 = ({ click: {} },
    { onClick: (...[$event]) => {
            __VLS_ctx.showSessions = !__VLS_ctx.showSessions;
            // @ts-ignore
            [showSessions, showSessions,];
        } });
const { default: __VLS_32 } = __VLS_28.slots;
{
    const { icon: __VLS_33 } = __VLS_28.slots;
    __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
        width: "16",
        height: "16",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        'stroke-width': "1.5",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.rect)({
        x: "3",
        y: "3",
        width: "7",
        height: "7",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.rect)({
        x: "14",
        y: "3",
        width: "7",
        height: "7",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.rect)({
        x: "3",
        y: "14",
        width: "7",
        height: "7",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.rect)({
        x: "14",
        y: "14",
        width: "7",
        height: "7",
    });
    // @ts-ignore
    [];
}
// @ts-ignore
[];
var __VLS_28;
var __VLS_29;
if (__VLS_ctx.activeSession) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "header-session-title" },
    });
    /** @type {__VLS_StyleScopedClasses['header-session-title']} */ ;
    (__VLS_ctx.activeSession.title);
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "header-actions" },
});
/** @type {__VLS_StyleScopedClasses['header-actions']} */ ;
let __VLS_34;
/** @ts-ignore @type {typeof __VLS_components.NSelect} */
NSelect;
// @ts-ignore
const __VLS_35 = __VLS_asFunctionalComponent1(__VLS_34, new __VLS_34({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.selectedTheme),
    options: (__VLS_ctx.themeOptions),
    size: "small",
    consistentMenuWidth: (false),
    ...{ class: "theme-select" },
}));
const __VLS_36 = __VLS_35({
    ...{ 'onUpdate:value': {} },
    value: (__VLS_ctx.selectedTheme),
    options: (__VLS_ctx.themeOptions),
    size: "small",
    consistentMenuWidth: (false),
    ...{ class: "theme-select" },
}, ...__VLS_functionalComponentArgsRest(__VLS_35));
let __VLS_39;
const __VLS_40 = ({ 'update:value': {} },
    { 'onUpdate:value': (__VLS_ctx.applyTheme) });
/** @type {__VLS_StyleScopedClasses['theme-select']} */ ;
var __VLS_37;
var __VLS_38;
let __VLS_41;
/** @ts-ignore @type {typeof __VLS_components.NButton | typeof __VLS_components.NButton} */
NButton;
// @ts-ignore
const __VLS_42 = __VLS_asFunctionalComponent1(__VLS_41, new __VLS_41({
    ...{ 'onClick': {} },
    size: "small",
}));
const __VLS_43 = __VLS_42({
    ...{ 'onClick': {} },
    size: "small",
}, ...__VLS_functionalComponentArgsRest(__VLS_42));
let __VLS_46;
const __VLS_47 = ({ click: {} },
    { onClick: (__VLS_ctx.createSession) });
const { default: __VLS_48 } = __VLS_44.slots;
{
    const { icon: __VLS_49 } = __VLS_44.slots;
    __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
        width: "14",
        height: "14",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        'stroke-width': "2",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.line)({
        x1: "12",
        y1: "5",
        x2: "12",
        y2: "19",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.line)({
        x1: "5",
        y1: "12",
        x2: "19",
        y2: "12",
    });
    // @ts-ignore
    [createSession, activeSession, activeSession, selectedTheme, themeOptions, applyTheme,];
}
(__VLS_ctx.t("terminal.newTab"));
// @ts-ignore
[t,];
var __VLS_44;
var __VLS_45;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "terminal-container" },
});
/** @type {__VLS_StyleScopedClasses['terminal-container']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div)({
    ref: "terminalRef",
    ...{ class: "terminal-xterm" },
    ...{ style: ({ backgroundColor: __VLS_ctx.terminalBg }) },
});
/** @type {__VLS_StyleScopedClasses['terminal-xterm']} */ ;
// @ts-ignore
[terminalBg,];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
