import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const tempDirs: string[] = []

function createFakeSitePackages(): string {
  const root = mkdtempSync(join(tmpdir(), 'hermes-parent-path-patch-'))
  tempDirs.push(root)
  const envDir = join(root, 'tools', 'environments')
  mkdirSync(envDir, { recursive: true })
  writeFileSync(join(envDir, 'local.py'), [
    '    def _run_bash(self, cmd_string, *, login=False, timeout=120, stdin_data=None):',
    '        args = [bash, "-l", "-c", cmd_string] if login else [bash, "-c", cmd_string]',
    '        run_env = _make_run_env(self.env)',
    '',
    '        # Recover when the cwd has been deleted',
    '        safe_cwd = _resolve_safe_cwd(self.cwd)',
    '',
  ].join('\n'))
  writeFileSync(join(envDir, 'base.py'), [
    '    def init_session(self):',
    '        _snap_tmp = shlex.quote(self._snapshot_path + ".tmp.") + "$BASHPID"',
    '        bootstrap = (',
    '            f"export -p > {_snap_tmp}\\n"',
    '            f"alias -p >> {_snap_tmp}\\n"',
    '        )',
    '',
  ].join('\n'))

  const adapterDir = join(root, 'plugins', 'platforms', 'dingtalk')
  mkdirSync(adapterDir, { recursive: true })
  writeFileSync(join(adapterDir, 'adapter.py'), [
    '# patch:dt-card-tpl-env',
    '# patch:dt-card-before-webhook',
    '# patch:dt-card-before-webhook-gate',
    '# patch:dt-dm-robot-code',
    '# patch:dt-card-autolayout',
  ].join('\n'))
  writeFileSync(join(root, 'sitecustomize.py'), '')
  return root
}

function runPatch(sitePackages: string): string {
  return execFileSync('node', [join(process.cwd(), 'packages/desktop/scripts/apply-hermes-patches.mjs')], {
    env: {
      ...process.env,
      HERMES_AGENT_SITE_PACKAGES: sitePackages,
      TARGET_OS: 'linux',
      TARGET_ARCH: 'x64',
    },
    encoding: 'utf8',
    timeout: 15_000,
  })
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('desktop Hermes parent PATH patch', () => {
  it('applies a paired idempotent patch that merges parent-only PATH entries before snapshot export', () => {
    const sitePackages = createFakeSitePackages()

    runPatch(sitePackages)

    const local = readFileSync(join(sitePackages, 'tools', 'environments', 'local.py'), 'utf8')
    const base = readFileSync(join(sitePackages, 'tools', 'environments', 'base.py'), 'utf8')
    expect(local).toContain('# patch:local-parent-path-preserve')
    expect(local).toContain('if login:')
    expect(local).toContain('run_env["HERMES_INIT_PARENT_PATH"]')
    expect(base).toContain('# patch:base-merge-parent-path')
    expect(base).toContain('if [ -n "${{HERMES_INIT_PARENT_PATH:-}}" ]')
    expect(base).toContain('for __hermes_path_entry')
    expect(base).toContain('PATH="${{PATH:+$PATH:}}$__hermes_path_entry"')
    expect(base.indexOf('# patch:base-merge-parent-path')).toBeLessThan(base.indexOf('export -p >'))
    expect(base).toContain('unset HERMES_INIT_PARENT_PATH')

    const firstLocal = local
    const firstBase = base
    const secondOutput = runPatch(sitePackages)
    expect(secondOutput).toContain('local-parent-path-preserve  (already applied)')
    expect(secondOutput).toContain('base-merge-parent-path  (already applied)')
    expect(readFileSync(join(sitePackages, 'tools', 'environments', 'local.py'), 'utf8')).toBe(firstLocal)
    expect(readFileSync(join(sitePackages, 'tools', 'environments', 'base.py'), 'utf8')).toBe(firstBase)
  })

  it('does not leave a half-applied patch when either upstream anchor changes', () => {
    const sitePackages = createFakeSitePackages()
    const localPath = join(sitePackages, 'tools', 'environments', 'local.py')
    const basePath = join(sitePackages, 'tools', 'environments', 'base.py')
    const originalLocal = readFileSync(localPath, 'utf8')
    writeFileSync(basePath, readFileSync(basePath, 'utf8').replace('export -p >', 'export --changed >'))

    expect(() => runPatch(sitePackages)).toThrow()
    expect(readFileSync(localPath, 'utf8')).toBe(originalLocal)
  })

  it('fails closed when the Hermes environment modules are missing', () => {
    const sitePackages = createFakeSitePackages()
    rmSync(join(sitePackages, 'tools', 'environments'), { recursive: true, force: true })

    expect(() => runPatch(sitePackages)).toThrow()
  })
})
