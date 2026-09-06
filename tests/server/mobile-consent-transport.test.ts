import { readFileSync } from 'node:fs'
import { request as httpRequest, createServer } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'

it('keeps a distinct HTTP deadline and returns the business expiry without retrying', async () => {
  const source = readFileSync('bin/hermes-studio-mcp.mjs', 'utf8')
  const fn = source.slice(source.indexOf('async function fetchMobileConsent('), source.indexOf('async function requestEnvelope('))
  let budget = 0
  const fetchConsent = runInNewContext(`${fn}; fetchMobileConsent`, {
    httpRequest, httpsRequest, URL, Headers, Buffer, Error,
    setTimeout: (callback: () => void, ms: number) => { budget = ms; return setTimeout(callback, ms) }, clearTimeout,
  })
  let calls = 0
  const server = createServer((_req, res) => {
    calls++
    setTimeout(() => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ status: 'error', error: { code: 'calendar_failed' } })) }, 30)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = (server.address() as { port: number }).port
    const result = await fetchConsent(`http://127.0.0.1:${port}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(budget).toBe(330000)
    expect(result.status).toBe(200)
    expect(JSON.parse(await result.text())).toEqual({ status: 'error', error: { code: 'calendar_failed' } })
    expect(calls).toBe(1)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
