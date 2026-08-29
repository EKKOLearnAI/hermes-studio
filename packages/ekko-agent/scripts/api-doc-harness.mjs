import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const sourceRoot = resolve(root, 'src')
const documentPath = resolve(root, 'docs', 'API.md')
const beginMarker = '<!-- BEGIN GENERATED EKKO PUBLIC API -->'
const endMarker = '<!-- END GENERATED EKKO PUBLIC API -->'
const write = process.argv.includes('--write')

const inventory = buildInventory()
const document = readFileSync(documentPath, 'utf8')
const start = document.indexOf(beginMarker)
const end = document.indexOf(endMarker)

if (start < 0 || end < 0 || end < start) {
  fail(`API document must contain ${beginMarker} and ${endMarker}.`)
}

const generated = `${beginMarker}\n\n${inventory}\n\n${endMarker}`
const current = document.slice(start, end + endMarker.length)

if (current === generated) {
  process.stdout.write('Ekko public API documentation is current.\n')
  process.exit(0)
}

if (!write) {
  fail('Public methods, fields, parameters, or exports changed. Update docs/API.md, then run npm run api:docs:update.')
}

const next = `${document.slice(0, start)}${generated}${document.slice(end + endMarker.length)}`
writeFileSync(documentPath, next, 'utf8')
process.stdout.write('Updated the generated public API inventory in docs/API.md.\n')

function buildInventory() {
  const sections = []
  for (const file of sourceFiles(sourceRoot)) {
    const sourceText = readFileSync(file, 'utf8')
    const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true)
    const declarations = []
    for (const statement of source.statements) {
      const signature = publicDeclaration(statement, source)
      if (signature) declarations.push(signature)
    }
    if (!declarations.length) continue
    const path = relative(root, file).replaceAll('\\', '/')
    sections.push(`### \`${path}\`\n\n\`\`\`ts\n${declarations.join('\n\n')}\n\`\`\``)
  }
  return [
    '## Generated public API inventory',
    '',
    'This block is generated from every exported declaration under `src/`. It is the harness baseline for public modules, fields, methods, parameters, return types, constants, and barrel exports.',
    '',
    ...sections,
  ].join('\n')
}

function publicDeclaration(node, source) {
  if (ts.isExportDeclaration(node)) return compact(node.getText(source))
  if (!hasModifier(node, ts.SyntaxKind.ExportKeyword)) return ''
  if (ts.isClassDeclaration(node)) return classSignature(node, source)
  if (ts.isInterfaceDeclaration(node)) return interfaceSignature(node, source)
  if (ts.isFunctionDeclaration(node)) return functionSignature(node, source)
  if (ts.isEnumDeclaration(node)) {
    const members = node.members.map(member => `  ${compact(member.getText(source))}`)
    return `${declarationHeader(node, source)} {\n${members.join('\n')}\n}`
  }
  if (ts.isTypeAliasDeclaration(node)) return compact(node.getText(source))
  if (ts.isVariableStatement(node)) return compact(node.getText(source))
  return compact(node.getText(source))
}

function classSignature(node, source) {
  const header = declarationHeader(node, source)
  const members = node.members
    .filter(member => !hasModifier(member, ts.SyntaxKind.PrivateKeyword))
    .filter(member => !hasModifier(member, ts.SyntaxKind.ProtectedKeyword))
    .map(member => `  ${memberSignature(member, source)}`)
    .filter(Boolean)
  return `${header} {\n${members.join('\n')}\n}`
}

function interfaceSignature(node, source) {
  const header = declarationHeader(node, source)
  const members = node.members.map(member => `  ${compact(member.getText(source))}`)
  return `${header} {\n${members.join('\n')}\n}`
}

function declarationHeader(node, source) {
  const start = node.getStart(source)
  const body = node.members ? node.members.pos - 1 : node.end
  return compact(source.text.slice(start, body)).replace(/\s*\{$/, '')
}

function memberSignature(member, source) {
  if (ts.isConstructorDeclaration(member)) {
    return `${modifiers(member)}constructor(${parameters(member, source)})`
  }
  if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) {
    return `${modifiers(member)}${name(member, source)}${member.questionToken ? '?' : ''}${typeParameters(member, source)}(${parameters(member, source)})${returnType(member, source)}`
  }
  if (ts.isGetAccessorDeclaration(member)) {
    return `${modifiers(member)}get ${name(member, source)}()${returnType(member, source)}`
  }
  if (ts.isSetAccessorDeclaration(member)) {
    return `${modifiers(member)}set ${name(member, source)}(${parameters(member, source)})`
  }
  if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) {
    const declaredType = member.type ? `: ${compact(member.type.getText(source))}` : ''
    const initializer = !member.type && member.initializer
      ? ` = ${compact(member.initializer.getText(source))}`
      : ''
    return `${modifiers(member)}${name(member, source)}${member.questionToken ? '?' : member.exclamationToken ? '!' : ''}${declaredType}${initializer}`
  }
  return compact(member.getText(source))
}

function functionSignature(node, source) {
  const bodyStart = node.body?.getStart(source) ?? node.end
  return compact(source.text.slice(node.getStart(source), bodyStart)).replace(/\s*$/, '')
}

function modifiers(node) {
  return (node.modifiers || [])
    .filter(modifier => modifier.kind !== ts.SyntaxKind.PublicKeyword)
    .map(modifier => `${modifier.getText()} `)
    .join('')
}

function parameters(node, source) {
  return node.parameters.map(parameter => compact(parameter.getText(source))).join(', ')
}

function typeParameters(node, source) {
  return node.typeParameters?.length
    ? `<${node.typeParameters.map(parameter => compact(parameter.getText(source))).join(', ')}>`
    : ''
}

function returnType(node, source) {
  return node.type ? `: ${compact(node.type.getText(source))}` : ''
}

function name(node, source) {
  return node.name ? compact(node.name.getText(source)) : ''
}

function hasModifier(node, kind) {
  return Boolean(node.modifiers?.some(modifier => modifier.kind === kind))
}

function sourceFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path)
  }
  return files.sort()
}

function compact(value) {
  return value.replace(/\s+/g, ' ').trim()
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
