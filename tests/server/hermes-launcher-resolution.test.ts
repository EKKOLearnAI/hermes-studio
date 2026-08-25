import { describe, expect, it } from 'vitest'
import { delimiter, join } from 'path'
import { findHermesLauncher } from '../../packages/server/src/services/hermes/hermes-process'

/** Treat only the listed paths as present on disk. */
function existsIn(paths: string[]) {
    const present = new Set(paths)
    return (path: string) => present.has(path)
}

describe('findHermesLauncher', () => {
    it('honours an explicit HERMES_BIN over everything else', () => {
        const resolved = findHermesLauncher(
            { HERMES_BIN: '/custom/hermes', PATH: '/usr/bin' },
            existsIn(['/usr/bin/hermes', '/opt/hermes/.venv/bin/hermes']),
            false,
        )
        expect(resolved).toBe('/custom/hermes')
    })

    it('uses the bare name when PATH resolves it, so operator installs win', () => {
        const resolved = findHermesLauncher(
            { PATH: ['/usr/local/bin', '/usr/bin'].join(delimiter) },
            existsIn(['/usr/bin/hermes', '/opt/hermes/.venv/bin/hermes']),
            false,
        )
        expect(resolved).toBe('hermes')
    })

    it('falls back to the Docker venv when PATH has no hermes', () => {
        // This is the case that used to fail every CLI call with a bare ENOENT:
        // the container ships the launcher in a venv that is not on the PATH.
        const resolved = findHermesLauncher(
            { PATH: ['/usr/local/bin', '/usr/bin'].join(delimiter), HOME: '/opt/data' },
            existsIn(['/opt/hermes/.venv/bin/hermes']),
            false,
        )
        expect(resolved).toBe('/opt/hermes/.venv/bin/hermes')
    })

    it('prefers HERMES_INSTALL_DIR over the well-known locations', () => {
        const installDir = '/srv/hermes'
        const resolved = findHermesLauncher(
            { PATH: '/usr/bin', HERMES_INSTALL_DIR: installDir },
            existsIn([join(installDir, '.venv/bin/hermes'), '/opt/hermes/.venv/bin/hermes']),
            false,
        )
        expect(resolved).toBe(join(installDir, '.venv/bin/hermes'))
    })

    it('finds a managed install under HOME', () => {
        const home = '/home/dev'
        const resolved = findHermesLauncher(
            { PATH: '/usr/bin', HOME: home },
            existsIn([join(home, '.hermes/hermes-agent/venv/bin/hermes')]),
            false,
        )
        expect(resolved).toBe(join(home, '.hermes/hermes-agent/venv/bin/hermes'))
    })

    it('returns the bare name when nothing is found, so the error names the command', () => {
        expect(findHermesLauncher({ PATH: '/usr/bin' }, existsIn([]), false)).toBe('hermes')
    })

    it('looks for hermes.exe on Windows', () => {
        const resolved = findHermesLauncher(
            { PATH: 'C:\\tools' },
            existsIn([join('C:\\tools', 'hermes.exe')]),
            true,
        )
        expect(resolved).toBe('hermes.exe')
    })

    it('tolerates a missing PATH', () => {
        expect(findHermesLauncher({}, existsIn(['/opt/hermes/.venv/bin/hermes']), false))
            .toBe('/opt/hermes/.venv/bin/hermes')
    })
})
