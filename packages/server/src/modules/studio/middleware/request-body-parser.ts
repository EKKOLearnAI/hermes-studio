import bodyParser from '@koa/bodyparser'

/**
 * Parse every request shape used by the local APIs. `text` is required by the
 * Hermes Studio command-provider bridge, which posts the TTS input file as
 * `text/plain`.
 */
export function createRequestBodyParser() {
  return bodyParser({
    encoding: 'utf-8',
    enableTypes: ['json', 'form', 'text'],
    jsonLimit: '20mb',
    formLimit: '20mb',
    textLimit: '20mb',
    parsedMethods: ['POST', 'PUT', 'PATCH', 'DELETE'],
  })
}
