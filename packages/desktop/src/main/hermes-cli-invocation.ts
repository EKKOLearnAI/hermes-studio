export interface DesktopHermesCliInvocation {
  command: string
  argsPrefix: string[]
}

export function resolveDesktopHermesCliInvocation(
  platform: NodeJS.Platform,
  hermesBin: string,
  python: string,
): DesktopHermesCliInvocation {
  if (platform === 'win32') {
    return { command: python, argsPrefix: ['-m', 'hermes_cli.main'] }
  }
  return { command: hermesBin, argsPrefix: [] }
}
