const storage_get = jest.fn()
const storage_set = jest.fn()

jest.mock('webextension-polyfill', () => ({
  __esModule: true,
  default: {
    storage: { local: { get: storage_get, set: storage_set } },
    runtime: { getManifest: () => ({ version: '1.2.3' }) }
  }
}))
jest.mock('./message-handler', () => ({
  handle_bridge_message: jest.fn()
}))

import {
  __reset_connection_for_tests,
  check_and_recover_connection,
  check_server_health,
  connect_websocket,
  fetch_handoff
} from './websocket'

const browser_id = 'f816afc4-76e7-48e4-b66f-4ebfad72f943'
const interaction_id = 'ec20c80d-a1a4-4b6a-922c-e13a9c1052ec'
const handoff_token = 'handoff-credential-0123456789abcdef'

class FakeWebSocket {
  static OPEN = 1
  static CONNECTING = 0
  static instances: FakeWebSocket[] = []
  readyState = FakeWebSocket.CONNECTING
  sent: string[] = []
  onopen?: () => void
  onmessage?: (event: { data: unknown }) => void
  onclose?: () => void
  onerror?: () => void

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(value: string) {
    this.sent.push(value)
  }

  close() {
    this.readyState = 3
  }
}

describe('loopback WebSocket bridge', () => {
  beforeEach(() => {
    __reset_connection_for_tests()
    FakeWebSocket.instances = []
    ;(global as any).WebSocket = FakeWebSocket
    ;(global as any).navigator = { userAgent: 'Fixture Browser' }
    storage_get.mockResolvedValue({
      'doc2webchat:browser-instance-id': browser_id
    })
  })

  it('accepts only the identified health service with no-store fetch', async () => {
    const fetch_mock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        service: 'doc2webchat',
        protocol_version: 1,
        session_token: '0123456789abcdef0123456789abcdef'
      })
    })
    ;(global as any).fetch = fetch_mock
    await expect(check_server_health()).resolves.not.toBeNull()
    expect(fetch_mock).toHaveBeenCalledWith(
      'http://127.0.0.1:55155/health',
      expect.objectContaining({ cache: 'no-store' })
    )
  })

  it('authenticates, identifies the browser, and registers after opening', async () => {
    ;(global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        service: 'doc2webchat',
        protocol_version: 1,
        session_token: '0123456789abcdef0123456789abcdef'
      })
    })
    await connect_websocket()
    const socket = FakeWebSocket.instances[0]
    expect(socket.url).toContain('ws://127.0.0.1:55155/bridge?')
    expect(socket.url).toContain('role=browser-extension')
    socket.readyState = FakeWebSocket.OPEN
    socket.onopen?.()
    expect(JSON.parse(socket.sent[0])).toEqual({
      action: 'register-browser',
      browser_instance_id: browser_id,
      version: '1.2.3',
      user_agent: 'Fixture Browser'
    })
  })

  it('fetches a leased prompt without writing it to extension storage', async () => {
    const payload = {
      interaction_id,
      browser_instance_id: browser_id,
      provider_id: 'open-webui',
      provider_url: 'http://localhost:3000/',
      handoff_id: 'opaque_handoff_id_123456',
      expires_at: Date.now() + 60_000,
      settings: {},
      prompt: 'private full prompt'
    }
    const fetch_mock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          service: 'doc2webchat',
          protocol_version: 1,
          session_token: '0123456789abcdef0123456789abcdef'
        })
      })
      .mockResolvedValueOnce({ ok: true, json: async () => payload })
    ;(global as any).fetch = fetch_mock
    await connect_websocket()
    const socket = FakeWebSocket.instances[0]
    socket.readyState = FakeWebSocket.OPEN
    socket.onopen?.()
    socket.onmessage?.({
      data: JSON.stringify({
        action: 'browser-registered',
        browser_instance_id: browser_id,
        handoff_token
      })
    })
    await expect(fetch_handoff(payload.handoff_id)).resolves.toEqual(payload)
    expect(fetch_mock.mock.calls[1][1].headers.Authorization).toMatch(
      /^Bearer /
    )
    expect(fetch_mock.mock.calls[1][1].headers).toEqual(
      expect.objectContaining({
        'X-Doc2WebChat-Browser-Instance-Id': browser_id,
        'X-Doc2WebChat-Handoff-Token': handoff_token
      })
    )
    expect(storage_set).not.toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.anything() })
    )
  })

  it('waits for registration before fetching a handoff after worker startup', async () => {
    const payload = {
      interaction_id,
      browser_instance_id: browser_id,
      provider_id: 'open-webui',
      provider_url: 'http://localhost:3000/',
      handoff_id: 'worker_restart_handoff_123456',
      expires_at: Date.now() + 60_000,
      settings: {},
      prompt: 'restart-safe prompt'
    }
    const fetch_mock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          service: 'doc2webchat',
          protocol_version: 1,
          session_token: '0123456789abcdef0123456789abcdef'
        })
      })
      .mockResolvedValueOnce({ ok: true, json: async () => payload })
    ;(global as any).fetch = fetch_mock
    await connect_websocket()
    const socket = FakeWebSocket.instances[0]
    socket.readyState = FakeWebSocket.OPEN
    socket.onopen?.()

    const pending = fetch_handoff(payload.handoff_id)
    await Promise.resolve()
    expect(fetch_mock).toHaveBeenCalledTimes(1)
    socket.onmessage?.({
      data: JSON.stringify({
        action: 'browser-registered',
        browser_instance_id: browser_id,
        handoff_token
      })
    })

    await expect(pending).resolves.toEqual(payload)
    expect(fetch_mock).toHaveBeenCalledTimes(2)
  })

  it('closes a stale socket and reconnects a closed one', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000)
    ;(global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        service: 'doc2webchat',
        protocol_version: 1,
        session_token: '0123456789abcdef0123456789abcdef'
      })
    })
    await connect_websocket()
    const first = FakeWebSocket.instances[0]
    first.readyState = FakeWebSocket.OPEN
    first.onopen?.()
    now.mockReturnValue(47_000)
    check_and_recover_connection()
    expect(first.readyState).toBe(3)

    check_and_recover_connection()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(FakeWebSocket.instances).toHaveLength(2)
    now.mockRestore()
  })
})
