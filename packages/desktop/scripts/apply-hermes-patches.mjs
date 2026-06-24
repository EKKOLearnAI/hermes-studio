#!/usr/bin/env node
// Apply locally-curated patches to hermes-agent inside the bundled venv.
// Each patch is idempotent: a marker string is searched for first, and the
// edit is skipped if the patch is already in place.
//
// Run after `install-hermes.mjs`. Designed to be safe to re-run.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platform as osPlatform, arch as osArch } from 'node:os'
import { execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const TARGET_OS = process.env.TARGET_OS || osPlatform()
const TARGET_ARCH = process.env.TARGET_ARCH || osArch()
const OS_LABEL = TARGET_OS === 'win32' ? 'win' : TARGET_OS === 'darwin' ? 'mac' : TARGET_OS
const PY_DIR = resolve(ROOT, 'resources', 'python', `${OS_LABEL}-${TARGET_ARCH}`)
const pyBin = TARGET_OS === 'win32' ? join(PY_DIR, 'python.exe') : join(PY_DIR, 'bin', 'python3')

// Allow the CI sanity-check path to point at a temp install dir without
// the full bundled-Python layout (e.g. `pip install --target /tmp/foo`).
const sitePkgs = process.env.HERMES_AGENT_SITE_PACKAGES ?? (
  TARGET_OS === 'win32'
    ? join(PY_DIR, 'Lib', 'site-packages')
    : (() => {
        const libDir = join(PY_DIR, 'lib')
        if (!existsSync(libDir)) throw new Error(`No lib dir at ${libDir}`)
        const py = readdirSync(libDir).find(n => /^python\d+\.\d+$/.test(n))
        if (!py) throw new Error(`Could not locate pythonX.Y under ${libDir}`)
        return join(libDir, py, 'site-packages')
      })()
)

const dtPath = join(sitePkgs, 'gateway', 'platforms', 'dingtalk.py')
const browserToolPath = join(sitePkgs, 'tools', 'browser_tool.py')
const sitecustomizePath = join(sitePkgs, 'sitecustomize.py')
if (!existsSync(dtPath)) {
  console.error(`dingtalk.py not found at ${dtPath} — is hermes-agent installed?`)
  process.exit(1)
}

let src = readFileSync(dtPath, 'utf-8')
const before = src
let applied = 0
let skipped = 0

function patch(id, marker, find, replace) {
  if (src.includes(marker)) {
    console.log(`  · ${id}  (already applied)`)
    skipped++
    return
  }
  if (!src.includes(find)) {
    console.log(`  ✗ ${id}  (anchor not found — upstream changed?)`)
    return
  }
  src = src.replace(find, replace)
  console.log(`  ✓ ${id}`)
  applied++
}

function patchText(text, id, marker, find, replace) {
  if (text.includes(marker)) {
    console.log(`  · ${id}  (already applied)`)
    skipped++
    return text
  }
  if (!text.includes(find)) {
    console.log(`  ✗ ${id}  (anchor not found — upstream changed?)`)
    return text
  }
  applied++
  console.log(`  ✓ ${id}`)
  return text.replace(find, replace)
}

function failPatchValidation(message) {
  console.error(`  ✗ ${message}`)
  process.exit(1)
}

function validateDingtalkPatches(text) {
  const beforeWebhook = text.includes('# patch:dt-card-before-webhook')
  const webhookGate = text.includes('# patch:dt-card-before-webhook-gate')
  if (beforeWebhook !== webhookGate) {
    failPatchValidation(
      'dingtalk AI Card webhook patches are incomplete: dt-card-before-webhook and dt-card-before-webhook-gate must be applied together',
    )
  }
}

function validateSitecustomizePatches(text) {
  if (text.includes('# patch:brotlicffi-error-compat') && !text.includes('_hermes_brotlicffi.error')) {
    failPatchValidation('sitecustomize brotlicffi compatibility patch marker exists but error alias assignment is missing')
  }
  if (
    text.includes('# patch:desktop-hidden-subprocess-defaults')
    && !text.includes('_hermes_apply_hidden_process_options')
  ) {
    failPatchValidation('sitecustomize hidden subprocess patch marker exists but hook implementation is missing')
  }
}

function compilePatchedPython(files) {
  const existingFiles = files.filter(file => existsSync(file))
  if (!existingFiles.length) return
  if (!existsSync(pyBin)) {
    console.log(`  · python compile check skipped (python not found at ${pyBin})`)
    return
  }
  try {
    execFileSync(pyBin, ['-m', 'py_compile', ...existingFiles], { stdio: 'inherit' })
    console.log('  ✓ python compile check')
  } catch (err) {
    failPatchValidation(`python compile check failed: ${err?.message || err}`)
  }
}

console.log(`Patching ${dtPath}`)

// NOTE: the former `dt-pre-start` patch was retired — hermes-agent now ships
// `_IncomingHandler.pre_start()` natively (present in 0.15.x and on main), so
// re-adding it just injected a duplicate method.

// ── dt-card-tpl-env ─────────────────────────────────────────────
// Fall back to DINGTALK_CARD_TEMPLATE_ID env var.
patch(
  'dt-card-tpl-env',
  '# patch:dt-card-tpl-env',
  `        self._card_template_id: Optional[str] = extra.get("card_template_id")`,
  `        # patch:dt-card-tpl-env — env var fallback
        self._card_template_id: Optional[str] = (
            extra.get("card_template_id") or os.getenv("DINGTALK_CARD_TEMPLATE_ID")
        )`,
)

// ── dt-card-before-webhook ──────────────────────────────────────
// Try AI Card *before* validating session_webhook — Card SDK does not need
// a webhook URL. Move the lookup of `current_message` and the AI Card block
// up before the webhook gate.
patch(
  'dt-card-before-webhook',
  '# patch:dt-card-before-webhook',
  `        # Check metadata first (for direct webhook sends)
        session_webhook = metadata.get("session_webhook")
        if not session_webhook:
            webhook_info = self._get_valid_webhook(chat_id)
            if not webhook_info:
                logger.warning(
                    "[%s] No valid session_webhook for chat_id=%s",
                    self.name, chat_id,
                )
                return SendResult(
                    success=False,
                    error="No valid session_webhook available. Reply must follow an incoming message.",
                )
            session_webhook, _ = webhook_info

        if not self._http_client:
            return SendResult(success=False, error="HTTP client not initialized")

        # Look up the inbound message for this chat (for AI Card routing)
        current_message = self._message_contexts.get(chat_id)`,
  `        # patch:dt-card-before-webhook — try AI Card first; webhook gate moved below.
        if not self._http_client:
            return SendResult(success=False, error="HTTP client not initialized")

        # Look up the inbound message for this chat (for AI Card routing)
        current_message = self._message_contexts.get(chat_id)
        session_webhook = metadata.get("session_webhook")`,
)

// The above leaves the existing AI Card block intact; we still need to add
// the deferred webhook gate AFTER the AI Card attempt. The original code
// had `logger.debug("[%s] Sending via webhook", self.name)` immediately
// after the AI Card fallback log. Insert the gate right before that.
patch(
  'dt-card-before-webhook-gate',
  '# patch:dt-card-before-webhook-gate',
  `            logger.warning("[%s] AI Card send failed, falling back to webhook", self.name)

        logger.debug("[%s] Sending via webhook", self.name)`,
  `            logger.warning("[%s] AI Card send failed, falling back to webhook", self.name)

        # patch:dt-card-before-webhook-gate — webhook required only for fallback path
        if not session_webhook:
            webhook_info = self._get_valid_webhook(chat_id)
            if not webhook_info:
                logger.warning(
                    "[%s] No valid session_webhook for chat_id=%s",
                    self.name, chat_id,
                )
                return SendResult(
                    success=False,
                    error="No valid session_webhook available. Reply must follow an incoming message.",
                )
            session_webhook, _ = webhook_info

        logger.debug("[%s] Sending via webhook", self.name)`,
)

// ── dt-dm-robot-code ────────────────────────────────────────────
patch(
  'dt-dm-robot-code',
  '# patch:dt-dm-robot-code',
  `                    im_robot_open_deliver_model=(
                        dingtalk_card_models.DeliverCardRequestImRobotOpenDeliverModel(
                            space_type="IM_ROBOT",
                        )
                    ),`,
  `                    im_robot_open_deliver_model=(
                        dingtalk_card_models.DeliverCardRequestImRobotOpenDeliverModel(
                            space_type="IM_ROBOT",
                            robot_code=self._robot_code,  # patch:dt-dm-robot-code
                        )
                    ),`,
)

// ── dt-card-autolayout ──────────────────────────────────────────
patch(
  'dt-card-autolayout',
  '# patch:dt-card-autolayout',
  `                card_data=dingtalk_card_models.CreateCardRequestCardData(
                    card_param_map={"content": ""},
                ),`,
  `                card_data=dingtalk_card_models.CreateCardRequestCardData(
                    # patch:dt-card-autolayout — wide-screen via sys_full_json_obj
                    card_param_map={
                        "content": "",
                        "sys_full_json_obj": json.dumps({"config": {"autoLayout": True}}),
                    },
                ),`,
)

if (src !== before) {
  writeFileSync(dtPath, src)
}
validateDingtalkPatches(src)

if (existsSync(browserToolPath)) {
  console.log(`Patching ${browserToolPath}`)
  let browserSrc = readFileSync(browserToolPath, 'utf-8')
  const browserBefore = browserSrc

  browserSrc = patchText(
    browserSrc,
    'browser-stdout-decode-fallback',
    '# patch:browser-stdout-decode-fallback',
    `from pathlib import Path\n`,
    `from pathlib import Path

# patch:browser-stdout-decode-fallback
def _hermes_read_browser_output(path: str) -> str:
    data = Path(path).read_bytes()
    for encoding in ("utf-8", "gb18030"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            pass
    return data.decode("utf-8", errors="replace")
`,
  )

  for (const [id, find, replace] of [
    [
      'browser-fallback-stdout-read',
      `            with open(stdout_path, "r", encoding="utf-8") as f:
                stdout = f.read().strip()`,
      `            # patch:browser-fallback-stdout-read
            stdout = _hermes_read_browser_output(stdout_path).strip()`,
    ],
    [
      'browser-command-stdout-read',
      `            with open(stdout_path, "r", encoding="utf-8") as f:
                stdout = f.read()
            with open(stderr_path, "r", encoding="utf-8") as f:
                stderr = f.read()`,
      `            # patch:browser-command-stdout-read
            stdout = _hermes_read_browser_output(stdout_path)
            stderr = _hermes_read_browser_output(stderr_path)`,
    ],
  ]) {
    browserSrc = patchText(
      browserSrc,
      id,
      `# patch:${id}`,
      find,
      replace,
    )
  }

  const readsBrowserOutput = browserSrc.includes('_hermes_read_browser_output(')
  const definesBrowserOutputReader = browserSrc.includes('def _hermes_read_browser_output')
  if (readsBrowserOutput && !definesBrowserOutputReader) {
    console.error(
      '  ✗ browser stdout decode fallback is incomplete: browser_tool.py calls _hermes_read_browser_output but does not define it',
    )
    process.exit(1)
  }

  if (browserSrc !== browserBefore) {
    writeFileSync(browserToolPath, browserSrc)
  }
}

const brotlicffiCompatMarker = '# patch:brotlicffi-error-compat'
const brotlicffiCompat = `
${brotlicffiCompatMarker}
try:
    import brotlicffi as _hermes_brotlicffi
    if not hasattr(_hermes_brotlicffi, "error"):
        _hermes_brotlicffi.error = (
            getattr(_hermes_brotlicffi, "Error", None)
            or getattr(_hermes_brotlicffi, "BrotliError", None)
            or Exception
        )
except Exception:
    pass
`

const desktopHiddenSubprocessMarker = '# patch:desktop-hidden-subprocess-defaults'
const desktopHiddenSubprocessDefaults = `
${desktopHiddenSubprocessMarker}
try:
    import os as _hermes_os
    if _hermes_os.name == "nt" and _hermes_os.environ.get("HERMES_DESKTOP", "").strip().lower() == "true":
        import asyncio as _hermes_asyncio
        import subprocess as _hermes_subprocess
        if not getattr(_hermes_subprocess, "_hermes_desktop_hidden_defaults_installed", False):
            _hermes_create_no_window = getattr(_hermes_subprocess, "CREATE_NO_WINDOW", 0) or 0x08000000

            def _hermes_apply_hidden_process_options(kwargs):
                flags = kwargs.get("creationflags", 0) or 0
                try:
                    kwargs["creationflags"] = int(flags) | _hermes_create_no_window
                except Exception:
                    kwargs["creationflags"] = _hermes_create_no_window

                startupinfo = kwargs.get("startupinfo")
                if startupinfo is None:
                    try:
                        startupinfo = _hermes_subprocess.STARTUPINFO()
                    except Exception:
                        return
                    kwargs["startupinfo"] = startupinfo
                try:
                    startupinfo.dwFlags |= getattr(_hermes_subprocess, "STARTF_USESHOWWINDOW", 1)
                    startupinfo.wShowWindow = getattr(_hermes_subprocess, "SW_HIDE", 0)
                except Exception:
                    pass

            _hermes_original_popen = _hermes_subprocess.Popen
            _hermes_original_create_subprocess_exec = _hermes_asyncio.create_subprocess_exec
            _hermes_original_create_subprocess_shell = _hermes_asyncio.create_subprocess_shell

            class _HermesHiddenPopen(_hermes_original_popen):
                def __init__(self, *args, **kwargs):
                    _hermes_apply_hidden_process_options(kwargs)
                    super().__init__(*args, **kwargs)

            async def _hermes_hidden_create_subprocess_exec(*args, **kwargs):
                _hermes_apply_hidden_process_options(kwargs)
                return await _hermes_original_create_subprocess_exec(*args, **kwargs)

            async def _hermes_hidden_create_subprocess_shell(*args, **kwargs):
                _hermes_apply_hidden_process_options(kwargs)
                return await _hermes_original_create_subprocess_shell(*args, **kwargs)

            _hermes_subprocess.Popen = _HermesHiddenPopen
            _hermes_asyncio.create_subprocess_exec = _hermes_hidden_create_subprocess_exec
            _hermes_asyncio.create_subprocess_shell = _hermes_hidden_create_subprocess_shell
            _hermes_subprocess._hermes_desktop_hidden_defaults_installed = True
except Exception:
    pass
`

function appendSitecustomizePatch(id, marker, body) {
  const sitecustomize = existsSync(sitecustomizePath) ? readFileSync(sitecustomizePath, 'utf-8') : ''
  if (sitecustomize.includes(marker)) {
    console.log(`  · ${id}  (already applied)`)
    skipped++
    return
  }
  const nextSitecustomize = `${sitecustomize.replace(/\s*$/, '')}\n${body.trim()}\n`
  writeFileSync(sitecustomizePath, nextSitecustomize)
  console.log(`  ✓ ${id}`)
  applied++
}

appendSitecustomizePatch('brotlicffi-error-compat', brotlicffiCompatMarker, brotlicffiCompat)
appendSitecustomizePatch('desktop-hidden-subprocess-defaults', desktopHiddenSubprocessMarker, desktopHiddenSubprocessDefaults)

if (existsSync(sitecustomizePath)) {
  validateSitecustomizePatches(readFileSync(sitecustomizePath, 'utf-8'))
}
compilePatchedPython([dtPath, browserToolPath, sitecustomizePath])

console.log(`Done. Applied ${applied}, skipped ${skipped}.`)
