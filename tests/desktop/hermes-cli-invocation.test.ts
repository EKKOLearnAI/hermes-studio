import { describe, expect, it } from 'vitest'
import { resolveDesktopHermesCliInvocation } from '../../packages/desktop/src/main/hermes-cli-invocation'

describe('desktop Hermes CLI invocation', () => {
  it('bypasses the uv hermes.exe trampoline on Windows', () => {
    expect(resolveDesktopHermesCliInvocation(
      'win32',
      'C:\\Users\\Administrator\\.hermes-web-ui\\desktop-runtime\\hermes\\0.15.2\\win-x64\\python\\Scripts\\hermes.exe',
      'C:\\Users\\Administrator\\.hermes-web-ui\\desktop-runtime\\hermes\\0.15.2\\win-x64\\python\\python.exe',
    )).toEqual({
      command: 'C:\\Users\\Administrator\\.hermes-web-ui\\desktop-runtime\\hermes\\0.15.2\\win-x64\\python\\python.exe',
      argsPrefix: ['-m', 'hermes_cli.main'],
    })
  })

  it('keeps normal launcher execution on non-Windows platforms', () => {
    expect(resolveDesktopHermesCliInvocation(
      'darwin',
      '/Users/example/.hermes-web-ui/desktop-runtime/hermes/0.15.2/mac-arm64/python/bin/hermes',
      '/Users/example/.hermes-web-ui/desktop-runtime/hermes/0.15.2/mac-arm64/python/bin/python3',
    )).toEqual({
      command: '/Users/example/.hermes-web-ui/desktop-runtime/hermes/0.15.2/mac-arm64/python/bin/hermes',
      argsPrefix: [],
    })
  })
})
