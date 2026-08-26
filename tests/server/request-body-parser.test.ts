import type { AddressInfo } from 'node:net'
import Koa from 'koa'
import { afterEach, describe, expect, it } from 'vitest'
import { createRequestBodyParser } from '../../packages/server/src/modules/studio/middleware/request-body-parser'

let server: ReturnType<Koa['listen']> | null = null

afterEach(async () => {
  if (!server) return
  await new Promise<void>((resolve, reject) => {
    server?.close(error => error ? reject(error) : resolve())
  })
  server = null
})

describe('request body parser', () => {
  it('parses the text/plain file body sent by the Hermes Studio curl command', async () => {
    const app = new Koa()
    app.use(createRequestBodyParser())
    app.use(ctx => {
      ctx.body = {
        body: ctx.request.body,
        rawBody: ctx.request.rawBody,
      }
    })
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    const port = (server.address() as AddressInfo).port

    const response = await fetch(`http://127.0.0.1:${port}/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: '来自 Hermes 输入文件的文本',
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      body: '来自 Hermes 输入文件的文本',
      rawBody: '来自 Hermes 输入文件的文本',
    })
  })
})
