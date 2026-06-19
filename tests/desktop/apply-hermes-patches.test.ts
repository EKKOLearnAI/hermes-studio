import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-apply-patches-'))
  tempDirs.push(dir)
  return dir
}

// Minimal fake site-packages layout with the two target files
function createFakeSitePackages(root: string) {
  const envDir = join(root, 'tools', 'environments')
  mkdirSync(envDir, { recursive: true })

  // local.py — snippet around _run_bash's run_env assignment
  writeFileSync(join(envDir, 'local.py'), [
    'def _run_bash(self, cmd_string, *, login=False, timeout=120, stdin_data=None):',
    '    args = [bash, "-l", "-c", cmd_string] if login else [bash, "-c", cmd_string]',
    '    run_env = _make_run_env(self.env)',
    '',
    '    # Recover when the cwd has been deleted',
    '    safe_cwd = _resolve_safe_cwd(self.cwd)',
    '',
  ].join('\n'))

  // base.py — snippet around init_session's bootstrap
  writeFileSync(join(envDir, 'base.py'), [
    '    def init_session(self):',
    '        _quoted_snap = shlex.quote(self._snapshot_path)',
    '        _quoted_cwd_file = shlex.quote(self._cwd_file)',
    '        bootstrap = (',
    '            f"export -p > {_quoted_snap}\\n"',
    '            f"declare -f | grep -vE \'^_[^_]\' >> {_quoted_snap}\\n"',
    '        )',
    '',
  ].join('\n'))

  // dingtalk.py (needed as a gate — patch script checks it exists)
  const gatewayDir = join(root, 'gateway', 'platforms')
  mkdirSync(gatewayDir, { recursive: true })
  writeFileSync(join(gatewayDir, 'dingtalk.py'), [
    '        self._card_template_id: Optional[str] = extra.get("card_template_id")',
    '        # Check metadata first (for direct webhook sends)',
    '        session_webhook = metadata.get("session_webhook")',
    '        if not session_webhook:',
    '            webhook_info = self._get_valid_webhook(chat_id)',
    '            if not webhook_info:',
    '                logger.warning(',
    '                    "[%s] No valid session_webhook for chat_id=%s",',
    '                    self.name, chat_id,',
    '                )',
    '                return SendResult(',
    '                    success=False,',
    '                    error="No valid session_webhook available."',
    '                )',
    '            session_webhook, _ = webhook_info',
    '',
    '        if not self._http_client:',
    '            return SendResult(success=False, error="HTTP client not initialized")',
    '',
    '        # Look up the inbound message for this chat (for AI Card routing)',
    '        current_message = self._message_contexts.get(chat_id)',
    '        logger.debug("[%s] Sending via webhook", self.name)',
    '',
    '                    im_robot_open_deliver_model=(',
    '                        dingtalk_card_models.DeliverCardRequestImRobotOpenDeliverModel(',
    '                            space_type="IM_ROBOT",',
    '                        )',
    '                    ),',
    '',
    '                card_data=dingtalk_card_models.CreateCardRequestCardData(',
    '                    card_param_map={"content": ""},',
    '                ),',
    '',
    '            logger.warning("[%s] AI Card send failed, falling back to webhook", self.name)',
    '',
    '        logger.debug("[%s] Sending via webhook", self.name)',
  ].join('\n'))

  // sitecustomize.py (empty)
  writeFileSync(join(root, 'sitecustomize.py'), '')
}

describe('apply-hermes-patches - PATH snapshot fix', () => {
  let sitePkgs: string

  beforeEach(() => {
    sitePkgs = tempDir()
    createFakeSitePackages(sitePkgs)
  })

  afterEach(() => {
    for (const d of tempDirs) {
      rmSync(d, { recursive: true, force: true })
    }
    tempDirs.length = 0
  })

  it('patches local.py to stash parent PATH in HERMES_INIT_PARENT_PATH', async () => {
    const { execFileSync } = await import('node:child_process')
    const scriptPath = join(process.cwd(), 'packages/desktop/scripts/apply-hermes-patches.mjs')

    const result = execFileSync('node', [scriptPath], {
      env: {
        ...process.env,
        HERMES_AGENT_SITE_PACKAGES: sitePkgs,
        TARGET_OS: 'linux',
        TARGET_ARCH: 'x64',
      },
      encoding: 'utf-8',
      timeout: 15_000,
    })

    // Verify local.py was patched
    const localSrc = readFileSync(join(sitePkgs, 'tools', 'environments', 'local.py'), 'utf-8')
    expect(localSrc).toContain('# patch:local-parent-path-preserve')
    expect(localSrc).toContain('HERMES_INIT_PARENT_PATH')
    expect(localSrc).toContain('_path_env_key(run_env)')
    // Verify the anchor is still present (not destroyed)
    expect(localSrc).toContain('run_env = _make_run_env(self.env)')
    expect(localSrc).toContain('# Recover when the cwd has been deleted')
  })

  it('patches base.py to restore parent PATH before export -p', async () => {
    const { execFileSync } = await import('node:child_process')
    const scriptPath = join(process.cwd(), 'packages/desktop/scripts/apply-hermes-patches.mjs')

    execFileSync('node', [scriptPath], {
      env: {
        ...process.env,
        HERMES_AGENT_SITE_PACKAGES: sitePkgs,
        TARGET_OS: 'linux',
        TARGET_ARCH: 'x64',
      },
      encoding: 'utf-8',
      timeout: 15_000,
    })

    // Verify base.py was patched
    const baseSrc = readFileSync(join(sitePkgs, 'tools', 'environments', 'base.py'), 'utf-8')
    expect(baseSrc).toContain('# patch:base-restore-parent-path')
    expect(baseSrc).toContain('HERMES_INIT_PARENT_PATH')
    expect(baseSrc).toContain('unset HERMES_INIT_PARENT_PATH')
    // Verify export -p is still present (not destroyed)
    expect(baseSrc).toContain('export -p >')
  })

  it('is idempotent - re-running skips already-applied patches', async () => {
    const { execFileSync } = await import('node:child_process')
    const scriptPath = join(process.cwd(), 'packages/desktop/scripts/apply-hermes-patches.mjs')

    const env = {
      ...process.env,
      HERMES_AGENT_SITE_PACKAGES: sitePkgs,
      TARGET_OS: 'linux',
      TARGET_ARCH: 'x64',
    }

    // First run
    execFileSync('node', [scriptPath], { env, encoding: 'utf-8', timeout: 15_000 })

    // Second run - should say "already applied"
    const out2 = execFileSync('node', [scriptPath], { env, encoding: 'utf-8', timeout: 15_000 })

    expect(out2).toContain('local-parent-path-preserve')
    expect(out2).toContain('already applied')
    expect(out2).toContain('base-restore-parent-path')

    // Files should be unchanged after second run
    const localSrc = readFileSync(join(sitePkgs, 'tools', 'environments', 'local.py'), 'utf-8')
    const baseSrc = readFileSync(join(sitePkgs, 'tools', 'environments', 'base.py'), 'utf-8')
    expect(localSrc).toContain('# patch:local-parent-path-preserve')
    expect(baseSrc).toContain('# patch:base-restore-parent-path')
  })
})
