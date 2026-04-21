import hljs from 'highlight.js';
const LANGUAGE_ALIASES = {
    shellscript: 'bash',
    sh: 'bash',
    zsh: 'bash',
    yml: 'yaml',
    vue: 'xml',
};
function escapeHtml(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}
function sanitizeLanguageClass(value) {
    return value.replace(/[^a-z0-9_-]/gi, '-') || 'plain';
}
export function normalizeHighlightLanguage(lang) {
    const normalized = lang?.trim().toLowerCase() || '';
    return LANGUAGE_ALIASES[normalized] || normalized;
}
export function inferStructuredLanguage(content) {
    try {
        JSON.parse(content);
        return 'json';
    }
    catch {
        return undefined;
    }
}
export function renderHighlightedCodeBlock(content, lang, copyLabel, options = {}) {
    const requestedLanguage = lang?.trim().toLowerCase() || '';
    const normalizedLanguage = normalizeHighlightLanguage(requestedLanguage);
    const highlightLimit = options.maxHighlightLength ?? Number.POSITIVE_INFINITY;
    let highlighted = '';
    let codeClassLanguage = normalizedLanguage || requestedLanguage || 'plain';
    let labelLanguage = requestedLanguage;
    try {
        if (normalizedLanguage && hljs.getLanguage(normalizedLanguage) && content.length <= highlightLimit) {
            highlighted = hljs.highlight(content, {
                language: normalizedLanguage,
                ignoreIllegals: true,
            }).value;
            codeClassLanguage = normalizedLanguage;
        }
        else {
            highlighted = escapeHtml(content);
            if (!labelLanguage) {
                labelLanguage = 'text';
            }
        }
    }
    catch {
        highlighted = escapeHtml(content);
        if (!labelLanguage) {
            labelLanguage = 'text';
        }
    }
    const languageLabelHtml = labelLanguage
        ? `<span class="code-lang">${escapeHtml(labelLanguage)}</span>`
        : '';
    return `<pre class="hljs-code-block"><div class="code-header">${languageLabelHtml}<button type="button" class="copy-btn" data-copy-code="true">${escapeHtml(copyLabel)}</button></div><code class="hljs language-${sanitizeLanguageClass(codeClassLanguage)}">${highlighted}</code></pre>`;
}
export async function copyTextToClipboard(text) {
    try {
        await navigator.clipboard?.writeText?.(text);
    }
    catch {
        // Ignore clipboard failures; the code block still renders safely.
    }
}
export async function handleCodeBlockCopyClick(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement))
        return;
    const button = target.closest('[data-copy-code="true"]');
    if (!button)
        return;
    event.preventDefault();
    const block = button.closest('.hljs-code-block');
    const code = block?.querySelector('code');
    const text = code?.textContent ?? '';
    if (!text)
        return;
    await copyTextToClipboard(text);
}
