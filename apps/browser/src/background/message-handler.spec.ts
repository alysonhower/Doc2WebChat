const storage_get = jest.fn()
const storage_set = jest.fn()
const storage_remove = jest.fn()
const tabs_create = jest.fn()
const tabs_get = jest.fn()
const tabs_update = jest.fn()
const tabs_send_message = jest.fn()
const runtime_add_listener = jest.fn()

jest.mock('webextension-polyfill', () => ({
  __esModule: true,
  default: {
    storage: {
      local: { get: storage_get, set: storage_set, remove: storage_remove }
    },
    tabs: {
      create: tabs_create,
      get: tabs_get,
      update: tabs_update,
      sendMessage: tabs_send_message
    },
    runtime: { onMessage: { addListener: runtime_add_listener } }
  }
}))
jest.mock('./websocket', () => ({
  fetch_handoff: jest.fn(),
  get_browser_instance_id: jest
    .fn()
    .mockResolvedValue('f816afc4-76e7-48e4-b66f-4ebfad72f943'),
  send_message_to_server: jest.fn()
}))

import {
  __reset_message_handler_for_tests,
  handle_bridge_message,
  setup_message_listeners,
  sweep_expired_handoffs
} from './message-handler'
import { fetch_handoff, send_message_to_server } from './websocket'

const initialization = {
  action: 'initialize-interaction' as const,
  interaction_id: 'ec20c80d-a1a4-4b6a-922c-e13a9c1052ec',
  browser_instance_id: 'f816afc4-76e7-48e4-b66f-4ebfad72f943',
  provider_id: 'open-webui',
  provider_url: 'http://localhost:3000/',
  handoff_id: 'opaque_handoff_id_123456',
  expires_at: Date.now() + 60_000,
  settings: { model: 'fixture', reuse_last_tab: false }
}
const second_initialization = {
  ...initialization,
  interaction_id: 'd9ab028d-47fd-41f2-b33b-20aa96e7f3d9',
  handoff_id: 'second_opaque_handoff_123456',
  settings: { model: 'fixture', reuse_last_tab: true }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('background handoff metadata', () => {
  beforeEach(() => {
    __reset_message_handler_for_tests()
    storage_get.mockResolvedValue({})
    storage_set.mockResolvedValue(undefined)
    storage_remove.mockResolvedValue(undefined)
    tabs_create.mockResolvedValue({ id: 7 })
    tabs_get.mockResolvedValue({ id: 7 })
    tabs_update.mockResolvedValue({ id: 7 })
    runtime_add_listener.mockClear()
    ;(send_message_to_server as jest.Mock).mockClear()
    ;(fetch_handoff as jest.Mock).mockReset()
  })

  afterEach(() => __reset_message_handler_for_tests())

  it('stores only opaque/correlation/tab/expiry metadata', async () => {
    await handle_bridge_message(initialization)
    await settle()
    await settle()
    const writes = storage_set.mock.calls.map(([value]) => value)
    const metadata = Object.values(writes.at(-1))[0] as Record<string, unknown>
    expect(metadata).toEqual({
      handoff_id: initialization.handoff_id,
      interaction_id: initialization.interaction_id,
      provider_id: initialization.provider_id,
      tab_id: 7,
      expires_at: initialization.expires_at
    })
    expect(JSON.stringify(writes)).not.toContain('fixture')
    expect(JSON.stringify(writes)).not.toContain(initialization.provider_url)
    expect(JSON.stringify(writes)).not.toContain('prompt')
  })

  it('sweeps expired handoffs while retaining unexpired leases', async () => {
    storage_get.mockResolvedValue({
      'doc2webchat:handoff:expired': {
        handoff_id: 'expired',
        interaction_id: initialization.interaction_id,
        provider_id: 'open-webui',
        expires_at: Date.now() - 1
      },
      'doc2webchat:handoff:live': {
        handoff_id: 'live',
        interaction_id: initialization.interaction_id,
        provider_id: 'open-webui',
        expires_at: Date.now() + 60_000
      },
      'doc2webchat:browser-instance-id': initialization.browser_instance_id
    })
    await sweep_expired_handoffs()
    expect(storage_remove).toHaveBeenCalledWith(['doc2webchat:handoff:expired'])
  })

  it('waits for the Python clipboard baseline before allowing native Copy', async () => {
    await handle_bridge_message(initialization)
    await settle()
    setup_message_listeners()
    const listener = runtime_add_listener.mock.calls.at(-1)?.[0]
    expect(listener).toBeDefined()

    let settled = false
    const ready = Promise.resolve(
      listener(
        {
          action: 'import-started',
          interaction_id: initialization.interaction_id,
          browser_instance_id: initialization.browser_instance_id,
          provider_id: initialization.provider_id,
          provider_url: initialization.provider_url
        },
        { tab: { id: 7 } }
      )
    ).then((value) => {
      settled = true
      return value
    })
    await settle()
    expect(settled).toBe(false)
    expect(send_message_to_server).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'import-started', tab_id: 7 })
    )

    await handle_bridge_message({
      action: 'import-result',
      interaction_id: initialization.interaction_id,
      browser_instance_id: initialization.browser_instance_id,
      provider_id: initialization.provider_id,
      provider_url: initialization.provider_url,
      status: 'ready'
    })
    await expect(ready).resolves.toBe(true)
  })

  it('rehydrates a leased tab after a service-worker restart', async () => {
    const metadata = {
      handoff_id: initialization.handoff_id,
      interaction_id: initialization.interaction_id,
      provider_id: initialization.provider_id,
      tab_id: 7,
      expires_at: initialization.expires_at
    }
    storage_get.mockImplementation(async (key?: string) =>
      key
        ? { [key]: metadata }
        : { ['doc2webchat:handoff:' + initialization.handoff_id]: metadata }
    )

    await handle_bridge_message(initialization)
    expect(tabs_create).not.toHaveBeenCalled()
    setup_message_listeners()
    const listener = runtime_add_listener.mock.calls.at(-1)?.[0]
    await listener(
      {
        action: 'prefill-completed',
        interaction_id: initialization.interaction_id,
        browser_instance_id: initialization.browser_instance_id,
        provider_id: initialization.provider_id,
        provider_url: initialization.provider_url
      },
      { tab: { id: 7 } }
    )
    expect(send_message_to_server).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'prefill-completed', tab_id: 7 })
    )
    expect(storage_remove).toHaveBeenCalledWith(
      'doc2webchat:handoff:' + initialization.handoff_id
    )
  })

  it('rejects interaction events from a different tab', async () => {
    await handle_bridge_message(initialization)
    await settle()
    setup_message_listeners()
    const listener = runtime_add_listener.mock.calls.at(-1)?.[0]
    await listener(
      {
        action: 'prefill-completed',
        interaction_id: initialization.interaction_id,
        browser_instance_id: initialization.browser_instance_id,
        provider_id: initialization.provider_id,
        provider_url: initialization.provider_url
      },
      { tab: { id: 8 } }
    )
    expect(send_message_to_server).not.toHaveBeenCalled()
  })

  it('reuses only the last tab whose correlated response finished', async () => {
    await handle_bridge_message(initialization)
    await settle()
    setup_message_listeners()
    const listener = runtime_add_listener.mock.calls.at(-1)?.[0]
    const identity = {
      interaction_id: initialization.interaction_id,
      browser_instance_id: initialization.browser_instance_id,
      provider_id: initialization.provider_id,
      provider_url: initialization.provider_url
    }
    await listener(
      { action: 'prefill-completed', ...identity },
      { tab: { id: 7 } }
    )
    await listener(
      { action: 'response-finished', ...identity },
      { tab: { id: 7 } }
    )

    await handle_bridge_message(second_initialization)
    await settle()
    expect(tabs_create).toHaveBeenCalledTimes(1)
    expect(tabs_update).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        active: true,
        url: expect.stringContaining(second_initialization.handoff_id)
      })
    )
  })

  it('rejects an expired handoff without fetching its prompt', async () => {
    const expired = {
      handoff_id: initialization.handoff_id,
      interaction_id: initialization.interaction_id,
      provider_id: initialization.provider_id,
      tab_id: 7,
      expires_at: Date.now() - 1
    }
    storage_get.mockResolvedValue({
      ['doc2webchat:handoff:' + initialization.handoff_id]: expired
    })
    setup_message_listeners()
    const listener = runtime_add_listener.mock.calls.at(-1)?.[0]
    await expect(
      listener(
        { action: 'request-handoff', handoff_id: initialization.handoff_id },
        { tab: { id: 7 } }
      )
    ).resolves.toEqual({ ok: false, code: 'HANDOFF_EXPIRED' })
    expect(fetch_handoff).not.toHaveBeenCalled()
  })
})
