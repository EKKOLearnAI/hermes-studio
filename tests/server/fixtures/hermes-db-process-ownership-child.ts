import { getDb, closeDb, getStoragePath } from '../../../packages/server/src/db/index'
import { initAllStores } from '../../../packages/server/src/db/hermes/init'

type ChildStatus =
  | { status: 'ready'; path: string }
  | { status: 'acquired'; path: string }
  | { status: 'closed' }
  | { status: 'crashing' }

function writeStatus(status: ChildStatus): void {
  process.stdout.write(`${JSON.stringify(status)}\n`)
}

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

function initializeDb(): void {
  const db = getDb()
  if (!db) {
    throw new Error('sqlite backend is unavailable')
  }
  initAllStores()
}

function holdOwnership(): void {
  initializeDb()
  writeStatus({ status: 'ready', path: getStoragePath() })
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    const command = chunk.trim()
    if (command === 'close') {
      closeDb()
      writeStatus({ status: 'closed' })
      process.exit(0)
      return
    }
    if (command === 'crash') {
      writeStatus({ status: 'crashing' })
      process.exit(17)
    }
  })
}

function probeOwnership(): void {
  initializeDb()
  writeStatus({ status: 'acquired', path: getStoragePath() })
  closeDb()
  process.exit(0)
}

try {
  const mode = process.argv[2]
  if (mode === 'hold') {
    holdOwnership()
  } else if (mode === 'probe') {
    probeOwnership()
  } else {
    throw new Error(`unknown mode: ${mode}`)
  }
} catch (error) {
  fail(error)
}
