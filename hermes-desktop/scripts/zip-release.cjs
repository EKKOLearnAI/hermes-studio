const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const root = path.join(__dirname, '..')
const outDir = path.join(root, 'release')

if (!fs.existsSync(outDir)) {
  console.error('Release directory does not exist:', outDir)
  console.error('Run a dist:pack script first.')
  process.exit(1)
}

// Discover all packaged folders matching "Hermes Web UI-<platform>-<arch>"
const pattern = /^Hermes Web UI-(.+)$/
const entries = fs.readdirSync(outDir, { withFileTypes: true })
const folders = entries
  .filter((e) => e.isDirectory() && pattern.test(e.name))
  .map((e) => e.name)

if (folders.length === 0) {
  console.error('No packaged folders found in', outDir)
  console.error('Run a dist:pack script first.')
  process.exit(1)
}

let created = 0

for (const folder of folders) {
  const tag = folder.replace('Hermes Web UI-', '')
  const zipName = `Hermes-Web-UI-${tag}.zip`
  const src = path.join(outDir, folder)
  const dest = path.join(outDir, zipName)

  if (fs.existsSync(dest)) fs.unlinkSync(dest)

  console.log(`Zipping ${folder} -> ${zipName}`)

  try {
    execSync(`tar -a -c -f "${dest}" -C "${src}" .`, {
      stdio: 'inherit',
      cwd: root,
      shell: true,
    })
  } catch (_) {
    if (process.platform === 'win32') {
      const psSrc = src.replace(/'/g, "''")
      const psDest = dest.replace(/'/g, "''")
      execSync(
        `powershell -NoProfile -Command "Compress-Archive -LiteralPath (Join-Path '${psSrc}' '*') -DestinationPath '${psDest}' -Force"`,
        { stdio: 'inherit' },
      )
    } else {
      // On macOS / Linux, fall back to zip command
      execSync(`cd "${src}" && zip -r "${dest}" .`, {
        stdio: 'inherit',
        shell: true,
      })
    }
  }

  console.log('Created:', dest)
  created++
}

console.log(`\nDone. ${created} archive(s) created.`)
