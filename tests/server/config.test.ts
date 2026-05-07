import { describe, expect, it } from 'vitest'
import { getListenHost } from '../../packages/server/src/config'

describe('server config', () => {
  it('does not force an IPv4 bind host by default', () => {
    expect(getListenHost({})).toBeUndefined()
  })

  it('uses BIND_HOST when provided', () => {
    expect(getListenHost({ BIND_HOST: ' :: ' })).toBe('::')
  })

  it('ignores blank BIND_HOST values', () => {
    expect(getListenHost({ BIND_HOST: ' ' })).toBeUndefined()
  })
})
