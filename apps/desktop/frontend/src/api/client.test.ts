import { describe, expect, it, vi } from 'vitest'
import type { PyWebviewApi } from './contracts'
import { waitForBridge } from './client'

describe('waitForBridge', () => {
  it('waits for pywebview readiness on window', async () => {
    const api = {} as PyWebviewApi
    const pending = waitForBridge(50)

    window.pywebview = { api }
    window.dispatchEvent(new CustomEvent('pywebviewready'))

    await expect(pending).resolves.toBe(api)
    vi.clearAllTimers()
  })
})
