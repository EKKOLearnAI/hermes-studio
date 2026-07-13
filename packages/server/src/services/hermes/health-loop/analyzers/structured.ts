import { isProxy } from 'node:util/types'
import {
  finalizeHealthAnalysis, HealthAnalysisError, HealthAnalysisRequest, HealthAnalysisResult,
} from '../analysis'

export type StructuredHealthFormat = 'json' | 'csv' | 'report_text'

export interface StructuredHealthAnalysisInput {
  request: HealthAnalysisRequest
  format: StructuredHealthFormat
  content: unknown
}

export interface StructuredHealthAnalyzerOptions {
  maxInputBytes?: number
  maxRows?: number
  maxColumns?: number
}

export interface StructuredHealthAnalyzer {
  analyze(input: StructuredHealthAnalysisInput): Promise<HealthAnalysisResult>
}

const POISON_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function invalid(): never { throw new HealthAnalysisError('HEALTH_ANALYSIS_INVALID_INPUT') }

function safeGraph(value: unknown, maxBytes: number): void {
  const seen = new Set<object>(); let nodes = 0; let bytes = 0
  const visit = (item: unknown, depth: number): void => {
    nodes += 1
    if (nodes > 2048 || depth > 10) invalid()
    if (item === null || typeof item === 'boolean') return
    if (typeof item === 'number') { if (!Number.isFinite(item)) invalid(); return }
    if (typeof item === 'string') { bytes += Buffer.byteLength(item); if (bytes > maxBytes) invalid(); return }
    if (!item || typeof item !== 'object' || isProxy(item) || seen.has(item)) invalid()
    const prototype = Object.getPrototypeOf(item)
    if (Array.isArray(item)) { if (prototype !== Array.prototype || item.length > 512) invalid() }
    else if (prototype !== Object.prototype && prototype !== null) invalid()
    seen.add(item)
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item)
      if (Array.isArray(item)) {
        const keys = Reflect.ownKeys(descriptors)
        if (keys.length !== item.length + 1 || !Object.hasOwn(descriptors, 'length')) invalid()
        for (let index = 0; index < item.length; index += 1) {
          const descriptor = descriptors[String(index)]
          if (!descriptor?.enumerable || !('value' in descriptor)) invalid()
        }
      }
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string' || POISON_KEYS.has(key) || !('value' in descriptors[key])) invalid()
        if (key !== 'length') visit(descriptors[key].value, depth + 1)
      }
    } catch (error) {
      if (error instanceof HealthAnalysisError) throw error
      invalid()
    } finally { seen.delete(item) }
  }
  visit(value, 0)
}

function textContent(value: unknown, maxBytes: number): string {
  let bytes: Uint8Array
  if (typeof value === 'string') bytes = Buffer.from(value, 'utf8')
  else if (value instanceof Uint8Array) bytes = value
  else invalid()
  if (bytes.byteLength < 1 || bytes.byteLength > maxBytes) invalid()
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (text.includes('\u0000')) invalid()
    return text
  } catch { return invalid() }
}

function parseCsvLine(line: string, maxColumns: number): string[] {
  const values: string[] = []; let value = ''; let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') { value += '"'; index += 1 } else quoted = false
      } else value += char
    } else if (char === ',') { values.push(value); value = '' }
    else if (char === '"' && value.length === 0) quoted = true
    else if (char === '"') invalid()
    else value += char
  }
  if (quoted) invalid()
  values.push(value)
  if (values.length > maxColumns) invalid()
  return values
}

function strictNumeric(value: string): number {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) invalid()
  const result = Number(value)
  if (!Number.isFinite(result)) invalid()
  return result
}

function csvOutput(text: string, maxRows: number, maxColumns: number): unknown {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length < 2 || lines.length - 1 > maxRows) invalid()
  const rows = lines.map(line => parseCsvLine(line, maxColumns))
  const header = ['field', 'value', 'unit', 'confidence', 'artifact_id', 'region', 'page']
  if (rows[0].length !== header.length || rows[0].some((value, index) => value !== header[index])) invalid()
  return {
    schemaVersion: 'health-analyzer-output/v1', modelVersion: 'structured', parserVersion: 'structured-csv-v1', overallConfidence: 1,
    captureQuality: { score: 1, reasons: [] },
    fields: rows.slice(1).map(row => {
      if (row.length !== header.length || !row[0] || !row[1] || !row[3] || !row[4]) invalid()
      return {
        field: row[0], value: strictNumeric(row[1]), ...(row[2] ? { unit: row[2] } : {}), confidence: strictNumeric(row[3]),
        evidence: { artifactId: row[4], ...(row[5] ? { region: row[5] } : {}), ...(row[6] ? { page: strictNumeric(row[6]) } : {}) },
      }
    }),
  }
}

function reportOutput(text: string, maxRows: number): unknown {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter(line => line.length > 0)
  if (lines.length < 1 || lines.length > maxRows) invalid()
  const markers = lines.map(line => {
    const columns = line.split('\t')
    if (columns.length !== 8 || columns[0] !== 'marker' || columns.slice(1).some(value => !value)) invalid()
    const page = strictNumeric(columns[6]); if (!Number.isSafeInteger(page)) invalid()
    return {
      marker: { key: columns[1], value: strictNumeric(columns[2]), unit: columns[3], evidence: { page, region: columns[7] } },
      confidence: strictNumeric(columns[4]), artifactId: columns[5], page, region: columns[7],
    }
  })
  if (new Set(markers.map(marker => marker.artifactId)).size !== 1) invalid()
  const confidence = markers.reduce((sum, marker) => sum + marker.confidence, 0) / markers.length
  return {
    schemaVersion: 'health-analyzer-output/v1', modelVersion: 'structured', parserVersion: 'structured-report-text-v1', overallConfidence: confidence,
    captureQuality: { score: 1, reasons: [] }, fields: [{ field: 'markers', value: markers.map(item => item.marker), confidence,
      evidence: { artifactId: markers[0].artifactId, page: markers[0].page, region: markers[0].region } }],
  }
}

export function createStructuredHealthAnalyzer(options: StructuredHealthAnalyzerOptions = {}): StructuredHealthAnalyzer {
  const maxInputBytes = options.maxInputBytes ?? 1024 * 1024
  const maxRows = options.maxRows ?? 256
  const maxColumns = options.maxColumns ?? 16
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 128 || maxInputBytes > 10 * 1024 * 1024
    || !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 10_000
    || !Number.isSafeInteger(maxColumns) || maxColumns < 1 || maxColumns > 64) invalid()

  return {
    async analyze(input): Promise<HealthAnalysisResult> {
      try {
        if (!input || typeof input !== 'object' || Array.isArray(input) || isProxy(input)) invalid()
        const descriptors = Object.getOwnPropertyDescriptors(input)
        if (Object.keys(descriptors).length !== 3 || !descriptors.request || !descriptors.format || !descriptors.content
          || Object.values(descriptors).some(descriptor => !('value' in descriptor))) invalid()
        const request = descriptors.request.value as HealthAnalysisRequest
        const format = descriptors.format.value
        let output: unknown
        if (format === 'json') {
          const content = descriptors.content.value
          if (typeof content === 'string' || content instanceof Uint8Array) {
            const text = textContent(content, maxInputBytes)
            try { output = JSON.parse(text) } catch { invalid() }
          } else {
            safeGraph(content, maxInputBytes)
            output = content
          }
        } else if (format === 'csv') output = csvOutput(textContent(descriptors.content.value, maxInputBytes), maxRows, maxColumns)
        else if (format === 'report_text') output = reportOutput(textContent(descriptors.content.value, maxInputBytes), maxRows)
        else invalid()
        safeGraph(output, maxInputBytes)
        return finalizeHealthAnalysis(request, output, { processor: `structured:${format}`, locality: 'local' })
      } catch (error) {
        if (error instanceof HealthAnalysisError && error.code === 'HEALTH_ANALYSIS_INVALID_INPUT') throw error
        throw new HealthAnalysisError('HEALTH_ANALYSIS_INVALID_INPUT')
      }
    },
  }
}
