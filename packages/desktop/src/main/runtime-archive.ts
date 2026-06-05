import * as tar from 'tar'

export async function extractTarGzipArchive(archive: string, targetRoot: string): Promise<void> {
  await tar.x({
    file: archive,
    cwd: targetRoot,
    preserveOwner: false,
    unlink: true,
  })
}
