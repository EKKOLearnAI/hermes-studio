/**
 * Durable storage for omp tool-produced images. Image tools (e.g.
 * `generate_image`) write bytes to an ephemeral temp file (`/tmp/omp-image-*`)
 * and list it in the tool result. That path renders live but is reaped before a
 * page reload, so referencing it directly leaves a broken `<img>` after refresh.
 *
 * This copies each image into the profile upload directory — which the download
 * endpoint serves through the local provider for any backend — and returns the
 * durable absolute paths. Bytes are copied from the temp file when it still
 * exists, falling back to the base64 payload omp echoes in `details.images`.
 * On any failure the original path is returned so behavior never regresses.
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { extname, join } from 'path'
import { getProfileUploadDir } from '../upload-paths'
import { ompToolResultImagePaths, ompToolResultImages, type OmpToolImage } from './omp-transforms'

const OMP_IMAGE_SUBDIR = 'omp-images'

const MIME_EXTENSION: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
}

function uniqueImageName(ext: string): string {
  return `omp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${ext}`
}

function destExtension(srcPath: string, fallback?: OmpToolImage): string {
  const fromPath = extname(srcPath)
  if (fromPath) return fromPath
  if (fallback) return MIME_EXTENSION[fallback.mimeType.toLowerCase()] || '.png'
  return '.png'
}

/**
 * Persist every image in an omp tool result to the profile upload directory.
 * Returns one durable absolute path per `imagePaths` entry (in order), falling
 * back to the original path for any image that could not be copied.
 */
export function persistOmpToolImages(result: unknown, profile: string): string[] {
  const srcPaths = ompToolResultImagePaths(result)
  if (srcPaths.length === 0) return []

  const images = ompToolResultImages(result)
  let destDir: string
  try {
    destDir = join(getProfileUploadDir(profile), OMP_IMAGE_SUBDIR)
  } catch {
    // No resolvable durable dir (e.g. an unexpected profile name) — fall back to
    // the original paths so the caller still injects + persists the markdown.
    return srcPaths
  }
  let dirReady = false

  return srcPaths.map((srcPath, index) => {
    try {
      const hasFile = existsSync(srcPath)
      const base64 = hasFile ? undefined : images[index]
      if (!hasFile && !base64) return srcPath

      if (!dirReady) {
        mkdirSync(destDir, { recursive: true })
        dirReady = true
      }
      const dest = join(destDir, uniqueImageName(destExtension(srcPath, base64)))
      if (hasFile) {
        copyFileSync(srcPath, dest)
      } else if (base64) {
        writeFileSync(dest, Buffer.from(base64.data, 'base64'))
      }
      return dest
    } catch {
      return srcPath
    }
  })
}
