import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

export type CodeLanguageStatus = 'detected' | 'not_detected' | 'partial'

export type CodeLanguageSummary = {
  files: number
  lines: number
  status: CodeLanguageStatus
}

export type CodeManifestSummary = {
  name: string
  path: string
}

export type CodeCapabilitySummary = {
  status: CodeLanguageStatus
  reason: string
}

export type CodeIntelligenceSummary = {
  root: string
  languages: Record<string, CodeLanguageSummary>
  manifests: CodeManifestSummary[]
  capabilities: Record<string, CodeCapabilitySummary>
  recommendedSkills: string[]
  generatedAt: string
}

const SKIPPED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.cache',
  '.runtime',
  'coverage',
  'venv',
  '.venv',
  '__pycache__',
])

const MANIFEST_NAMES = new Set([
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'CMakeLists.txt',
  'compile_commands.json',
  'Dockerfile',
  'docker-compose.yml',
])

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.vue': 'Vue',
  '.py': 'Python',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.md': 'Markdown',
  '.json': 'JSON',
  '.sh': 'Shell',
  '.bash': 'Shell',
  '.zsh': 'Shell',
  '.c': 'C/C++',
  '.cc': 'C/C++',
  '.cpp': 'C/C++',
  '.cxx': 'C/C++',
  '.h': 'C/C++',
  '.hh': 'C/C++',
  '.hpp': 'C/C++',
  '.hxx': 'C/C++',
}

const BASE_LANGUAGES = [
  'TypeScript',
  'Vue',
  'Python',
  'JavaScript',
  'Markdown',
  'JSON',
  'Shell',
  'C/C++',
]

function createEmptyLanguage(): CodeLanguageSummary {
  return { files: 0, lines: 0, status: 'not_detected' }
}

function extensionFor(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  return name.slice(dot).toLowerCase()
}

async function countLines(path: string): Promise<number> {
  try {
    const content = await readFile(path, 'utf8')
    if (!content) return 0
    return content.split('\n').length - (content.endsWith('\n') ? 1 : 0)
  } catch {
    return 0
  }
}

function addRecommendedSkill(skills: Set<string>, skill: string) {
  skills.add(skill)
}

async function walk(
  root: string,
  current: string,
  languages: Record<string, CodeLanguageSummary>,
  manifests: CodeManifestSummary[],
) {
  const entries = await readdir(current, { withFileTypes: true })

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue
      await walk(root, join(current, entry.name), languages, manifests)
      continue
    }

    if (!entry.isFile()) continue

    const absolutePath = join(current, entry.name)
    const relPath = relative(root, absolutePath) || entry.name

    if (MANIFEST_NAMES.has(entry.name)) {
      manifests.push({ name: entry.name, path: relPath })
    }

    const language = LANGUAGE_BY_EXTENSION[extensionFor(entry.name)]
    if (!language) continue

    if (!languages[language]) {
      languages[language] = createEmptyLanguage()
    }
    languages[language].files += 1
    languages[language].lines += await countLines(absolutePath)
  }
}

function finalizeLanguageStatuses(languages: Record<string, CodeLanguageSummary>) {
  for (const language of Object.values(languages)) {
    language.status = language.files > 0 ? 'detected' : 'not_detected'
  }
}

function detectCppCapability(languages: Record<string, CodeLanguageSummary>, manifests: CodeManifestSummary[]): CodeCapabilitySummary {
  const cppManifest = manifests.find((manifest) =>
    ['CMakeLists.txt', 'compile_commands.json'].includes(manifest.name)
    || manifest.name.endsWith('.sln')
    || manifest.name.endsWith('.vcxproj'),
  )

  if (cppManifest) {
    return { status: 'detected', reason: `${cppManifest.name} detected` }
  }

  if (languages['C/C++']?.files > 0) {
    return { status: 'detected', reason: 'C/C++ source files detected' }
  }

  return { status: 'not_detected', reason: 'No C/C++ source files or build manifests detected' }
}

function detectPythonCapability(languages: Record<string, CodeLanguageSummary>, manifests: CodeManifestSummary[]): CodeCapabilitySummary {
  const pythonManifest = manifests.find((manifest) => ['pyproject.toml', 'requirements.txt'].includes(manifest.name))
  if (pythonManifest) {
    return { status: 'detected', reason: `${pythonManifest.name} detected` }
  }
  if (languages.Python?.files > 0) {
    return { status: 'partial', reason: 'Python files detected without Python project manifest' }
  }
  return { status: 'not_detected', reason: 'No Python files or manifests detected' }
}

function detectWebUiCapability(languages: Record<string, CodeLanguageSummary>, manifests: CodeManifestSummary[]): CodeCapabilitySummary {
  const hasPackageJson = manifests.some((manifest) => manifest.name === 'package.json')
  const hasWebCode = languages.TypeScript.files > 0 || languages.Vue.files > 0 || languages.JavaScript.files > 0
  if (hasPackageJson && hasWebCode) {
    return { status: 'detected', reason: 'package.json and web source files detected' }
  }
  if (hasPackageJson || hasWebCode) {
    return { status: 'partial', reason: 'Partial web UI signals detected' }
  }
  return { status: 'not_detected', reason: 'No web UI manifest or source files detected' }
}

export async function scanCodeIntelligence(root: string): Promise<CodeIntelligenceSummary> {
  await stat(root)

  const languages = Object.fromEntries(BASE_LANGUAGES.map((language) => [language, createEmptyLanguage()])) as Record<string, CodeLanguageSummary>
  const manifests: CodeManifestSummary[] = []

  await walk(root, root, languages, manifests)
  finalizeLanguageStatuses(languages)
  manifests.sort((a, b) => a.path.localeCompare(b.path))

  const capabilities = {
    webUi: detectWebUiCapability(languages, manifests),
    python: detectPythonCapability(languages, manifests),
    cpp: detectCppCapability(languages, manifests),
  }

  const skills = new Set<string>()
  addRecommendedSkill(skills, 'codebase-inspection')
  addRecommendedSkill(skills, 'hermes-agent')

  if (languages.TypeScript.files > 0 || languages.Vue.files > 0) {
    addRecommendedSkill(skills, 'test-driven-development')
    addRecommendedSkill(skills, 'github-pr-workflow')
  }
  if (languages.Python.files > 0) {
    addRecommendedSkill(skills, 'systematic-debugging')
  }
  if (capabilities.cpp.status === 'detected') {
    addRecommendedSkill(skills, 'llama-cpp')
  }

  return {
    root,
    languages,
    manifests,
    capabilities,
    recommendedSkills: Array.from(skills),
    generatedAt: new Date().toISOString(),
  }
}
