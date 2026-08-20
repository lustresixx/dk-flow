import { describe, expect, it } from 'vitest'
import { stepSignalWithTimeout } from '../src/service.js'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('stepSignalWithTimeout', () => {
  it('aborts on the wall-clock timeout and reports timedOut', async () => {
    const { signal, timedOut, dispose } = stepSignalWithTimeout(new AbortController().signal, 30)
    expect(timedOut()).toBe(false)
    expect(signal.aborted).toBe(false)
    await sleep(60)
    expect(timedOut()).toBe(true)
    expect(signal.aborted).toBe(true)
    dispose()
  })

  it('follows caller aborts without reporting a timeout', async () => {
    const caller = new AbortController()
    const { signal, timedOut, dispose } = stepSignalWithTimeout(caller.signal, 60_000)
    caller.abort()
    expect(signal.aborted).toBe(true)
    expect(timedOut()).toBe(false)
    dispose()
  })

  it('dispose clears the timer so no late abort fires', async () => {
    const { signal, timedOut, dispose } = stepSignalWithTimeout(new AbortController().signal, 40)
    dispose()
    await sleep(80)
    expect(signal.aborted).toBe(false)
    expect(timedOut()).toBe(false)
  })
})
