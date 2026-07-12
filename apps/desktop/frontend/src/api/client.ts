import type { BridgeError, BridgeResult, PyWebviewApi } from './contracts'

export class AppBridgeError extends Error {
  readonly code: string
  readonly field?: string
  readonly file?: string

  constructor(error: BridgeError) {
    super(error.message)
    this.name = 'AppBridgeError'
    this.code = error.code
    this.field = error.field
    this.file = error.file
  }
}

const unavailable: BridgeError = {
  code: 'bridge_unavailable',
  message: 'The desktop service is not available.'
}

export async function waitForBridge(timeoutMs = 10_000): Promise<PyWebviewApi> {
  if (window.pywebview?.api) return window.pywebview.api
  return new Promise((resolve, reject) => {
    const ready = () => {
      window.clearTimeout(timeout)
      window.removeEventListener('pywebviewready', ready)
      const api = window.pywebview?.api
      if (api) resolve(api)
      else reject(new AppBridgeError(unavailable))
    }
    const timeout = window.setTimeout(() => {
      window.removeEventListener('pywebviewready', ready)
      reject(new AppBridgeError(unavailable))
    }, timeoutMs)
    window.addEventListener('pywebviewready', ready, { once: true })
  })
}

export function unwrap<T>(result: BridgeResult<T>): T {
  if (!result.ok) throw new AppBridgeError(result.error)
  return result.value
}

export async function invoke<T>(
  method: (api: PyWebviewApi) => Promise<BridgeResult<T>>
): Promise<T> {
  const api = await waitForBridge()
  return unwrap(await method(api))
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'Something went wrong.'
}
