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

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const TARGET_OS = process.env.TARGET_OS || osPlatform()
const TARGET_ARCH = process.env.TARGET_ARCH || osArch()
const OS_LABEL = TARGET_OS === 'win32' ? 'win' : TARGET_OS === 'darwin' ? 'mac' : TARGET_OS
const PY_DIR = resolve(ROOT, 'resources', 'python', `${OS_LABEL}-${TARGET_ARCH}`)

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

const sitecustomize = existsSync(sitecustomizePath) ? readFileSync(sitecustomizePath, 'utf-8') : ''
if (sitecustomize.includes(brotlicffiCompatMarker)) {
  console.log('  · brotlicffi-error-compat  (already applied)')
  skipped++
} else {
  const nextSitecustomize = `${sitecustomize.replace(/\s*$/, '')}\n${brotlicffiCompat.trim()}\n`
  writeFileSync(sitecustomizePath, nextSitecustomize)
  console.log('  ✓ brotlicffi-error-compat')
  applied++
}

console.log(`Done. Applied ${applied}, skipped ${skipped}.`)
