import browser from 'webextension-polyfill'
import {
  BridgeFailureMessage,
  BridgeToBrowserMessage,
  InitializeInteractionMessage,
  is_interaction_identity
} from '@shared/types/websocket-message'
import {
  ContentInteractionMessage,
  ContentToBackgroundMessage,
  HandoffResponse
} from '@/types/messages'
import {
  fetch_handoff,
  get_browser_instance_id,
  send_message_to_server
} from './websocket'

const HANDOFF_PREFIX = 'doc2webchat:handoff:'
const FIREFOX_CONTAINER_KEY = 'doc2webchat:selected-firefox-container'
const INITIALIZATION_TIMEOUT_MS = 30_000
const IMPORT_READY_TIMEOUT_MS = 5_000

type HandoffMetadata = {
  handoff_id: string
  interaction_id: string
  provider_id: string
  tab_id?: number
  expires_at: number
}

type QueueItem = {
  message: InitializeInteractionMessage
  timeout?: ReturnType<typeof setTimeout>
}

const queue: QueueItem[] = []
const interaction_tabs = new Map<string, number>()
const import_ready_waiters = new Map<
  string,
  { resolve: (ready: boolean) => void; timeout: ReturnType<typeof setTimeout> }
>()
let processing = false
let last_opened_tab_id: number | undefined
let last_tab_response_finished = false

const metadata_key = (handoff_id: string) => `${HANDOFF_PREFIX}${handoff_id}`

const find_metadata_for_interaction = async (interaction_id: string) => {
  const all = await browser.storage.local.get()
  for (const [key, value] of Object.entries(all)) {
    const metadata = value as HandoffMetadata | undefined
    if (
      key.startsWith(HANDOFF_PREFIX) &&
      metadata?.interaction_id === interaction_id
    ) {
      return { key, metadata }
    }
  }
  return undefined
}

const target_url_for = (message: InitializeInteractionMessage) => {
  const url = new URL(message.provider_url)
  if (message.provider_id === 'openrouter' && message.settings.model) {
    url.searchParams.set('models', message.settings.model)
  }
  url.hash = `doc2webchat-${message.handoff_id}`
  return url.toString()
}

const finish_current = async (interaction_id: string) => {
  if (queue[0]?.message.interaction_id !== interaction_id) return
  if (queue[0].timeout) clearTimeout(queue[0].timeout)
  queue.shift()
  processing = false
  await process_next()
}

const fail_prefill = async (
  message: InitializeInteractionMessage,
  code: string
) => {
  const failure: BridgeFailureMessage = {
    action: 'prefill-failed',
    interaction_id: message.interaction_id,
    browser_instance_id: message.browser_instance_id,
    provider_id: message.provider_id,
    provider_url: message.provider_url,
    code
  }
  send_message_to_server(failure)
  await finish_current(message.interaction_id)
}

const process_next = async (): Promise<void> => {
  if (processing || queue.length === 0) return
  processing = true
  const item = queue[0]
  const message = item.message

  if (message.expires_at <= Date.now()) {
    await finish_current(message.interaction_id)
    return
  }

  const metadata: HandoffMetadata = {
    handoff_id: message.handoff_id,
    interaction_id: message.interaction_id,
    provider_id: message.provider_id,
    expires_at: message.expires_at
  }
  try {
    await browser.storage.local.set({
      [metadata_key(message.handoff_id)]: metadata
    })
  } catch {
    await fail_prefill(message, 'HANDOFF_STORAGE_FAILED')
    return
  }

  const target_url = target_url_for(message)
  let tab_id: number | undefined
  if (
    message.settings.reuse_last_tab &&
    last_tab_response_finished &&
    last_opened_tab_id !== undefined
  ) {
    try {
      await browser.tabs.get(last_opened_tab_id)
      const updated = await browser.tabs.update(last_opened_tab_id, {
        active: true,
        url: target_url
      })
      tab_id = updated.id ?? last_opened_tab_id
    } catch {
      last_opened_tab_id = undefined
    }
  }

  if (tab_id === undefined) {
    try {
      const selected = await browser.storage.local.get(FIREFOX_CONTAINER_KEY)
      const create_options: browser.Tabs.CreateCreatePropertiesType = {
        active: true,
        url: target_url
      }
      const container_id = selected[FIREFOX_CONTAINER_KEY]
      if (typeof container_id === 'string' && container_id) {
        ;(
          create_options as browser.Tabs.CreateCreatePropertiesType & {
            cookieStoreId: string
          }
        ).cookieStoreId = container_id
      }
      const created = await browser.tabs.create(create_options)
      tab_id = created.id
    } catch {
      await fail_prefill(message, 'TAB_OPEN_FAILED')
      return
    }
  }

  if (tab_id !== undefined) {
    last_opened_tab_id = tab_id
    last_tab_response_finished = false
    interaction_tabs.set(message.interaction_id, tab_id)
    if (queue[0]?.message.interaction_id === message.interaction_id) {
      try {
        await browser.storage.local.set({
          [metadata_key(message.handoff_id)]: { ...metadata, tab_id }
        })
      } catch {
        await fail_prefill(message, 'HANDOFF_STORAGE_FAILED')
        return
      }
    }
  }

  if (queue[0]?.message.interaction_id !== message.interaction_id) {
    await browser.storage.local.remove(metadata_key(message.handoff_id))
    return
  }
  item.timeout = setTimeout(() => {
    void fail_prefill(message, 'PREFILL_TIMEOUT')
  }, INITIALIZATION_TIMEOUT_MS)
}

const enqueue_interaction = async (message: InitializeInteractionMessage) => {
  if (
    queue.some((item) => item.message.interaction_id === message.interaction_id)
  ) {
    return
  }
  const key = metadata_key(message.handoff_id)
  const stored = await browser.storage.local.get(key)
  const metadata = stored[key] as HandoffMetadata | undefined
  if (
    metadata?.interaction_id === message.interaction_id &&
    metadata.expires_at > Date.now() &&
    metadata.tab_id !== undefined
  ) {
    try {
      await browser.tabs.get(metadata.tab_id)
      interaction_tabs.set(message.interaction_id, metadata.tab_id)
      return
    } catch {
      await browser.storage.local.remove(key)
    }
  }
  queue.push({ message })
  void process_next()
}

const handle_handoff_request = async (
  handoff_id: string,
  sender: browser.Runtime.MessageSender
): Promise<HandoffResponse> => {
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(handoff_id)) {
    return { ok: false, code: 'INVALID_HANDOFF_ID' }
  }
  const storage_key = metadata_key(handoff_id)
  const stored = await browser.storage.local.get(storage_key)
  const metadata = stored[storage_key] as HandoffMetadata | undefined
  if (!metadata) return { ok: false, code: 'HANDOFF_NOT_FOUND' }
  if (metadata.expires_at <= Date.now()) {
    await browser.storage.local.remove(storage_key)
    return { ok: false, code: 'HANDOFF_EXPIRED' }
  }
  if (metadata.tab_id !== undefined && sender.tab?.id !== metadata.tab_id) {
    return { ok: false, code: 'TAB_MISMATCH' }
  }

  const payload = await fetch_handoff(handoff_id)
  if (!payload) return { ok: false, code: 'HANDOFF_UNAVAILABLE' }
  if (
    payload.handoff_id !== metadata.handoff_id ||
    payload.interaction_id !== metadata.interaction_id ||
    payload.provider_id !== metadata.provider_id ||
    payload.expires_at !== metadata.expires_at
  ) {
    return { ok: false, code: 'HANDOFF_MISMATCH' }
  }
  const browser_instance_id = await get_browser_instance_id()
  if (payload.browser_instance_id !== browser_instance_id) {
    return { ok: false, code: 'BROWSER_MISMATCH' }
  }
  if (sender.tab?.id !== undefined) {
    interaction_tabs.set(payload.interaction_id, sender.tab.id)
  }
  return { ok: true, payload }
}

const forward_content_event = async (
  message: ContentInteractionMessage,
  sender: browser.Runtime.MessageSender
) => {
  if (!is_interaction_identity(message)) return
  if (message.browser_instance_id !== (await get_browser_instance_id())) return
  const tab_id = sender.tab?.id
  if (tab_id === undefined) return
  const expected_tab = interaction_tabs.get(message.interaction_id)
  if (expected_tab !== undefined && expected_tab !== tab_id) return
  if (expected_tab === undefined)
    interaction_tabs.set(message.interaction_id, tab_id)

  const outgoing = { ...message, tab_id }
  if (message.action === 'prefill-completed') {
    const active = queue[0]?.message
    const recovered =
      active?.interaction_id === message.interaction_id
        ? {
            key: metadata_key(active.handoff_id),
            metadata: {
              handoff_id: active.handoff_id,
              interaction_id: active.interaction_id,
              provider_id: active.provider_id,
              expires_at: active.expires_at
            }
          }
        : await find_metadata_for_interaction(message.interaction_id)
    if (!recovered) return
    if (
      recovered.metadata.provider_id !== message.provider_id ||
      (recovered.metadata.tab_id !== undefined &&
        recovered.metadata.tab_id !== tab_id)
    ) {
      return
    }
    await browser.storage.local.remove(recovered.key)
    send_message_to_server({ ...outgoing, action: 'prefill-completed' })
    if (active?.interaction_id === message.interaction_id) {
      await finish_current(message.interaction_id)
    }
    return
  }
  if (message.action === 'prefill-failed') {
    if (!message.code) return
    send_message_to_server({
      ...outgoing,
      action: 'prefill-failed',
      code: message.code,
      message: message.message
    })
    await finish_current(message.interaction_id)
    return
  }
  if (message.action === 'response-finished') {
    if (tab_id === last_opened_tab_id) last_tab_response_finished = true
    send_message_to_server({ ...outgoing, action: 'response-finished' })
    return
  }
  if (message.action === 'import-started') {
    const previous = import_ready_waiters.get(message.interaction_id)
    if (previous) {
      clearTimeout(previous.timeout)
      previous.resolve(false)
      import_ready_waiters.delete(message.interaction_id)
    }
    const ready = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        import_ready_waiters.delete(message.interaction_id)
        resolve(false)
      }, IMPORT_READY_TIMEOUT_MS)
      import_ready_waiters.set(message.interaction_id, { resolve, timeout })
    })
    send_message_to_server({ ...outgoing, action: 'import-started' })
    return await ready
  }
  if (message.action === 'import-response') {
    send_message_to_server({ ...outgoing, action: 'import-response' })
    return
  }
  if (message.action === 'import-failed' && message.code) {
    send_message_to_server({
      ...outgoing,
      action: 'import-failed',
      code: message.code,
      message: message.message
    })
  }
}

export const handle_bridge_message = async (
  message: BridgeToBrowserMessage
) => {
  if (message.action === 'initialize-interaction') {
    await enqueue_interaction(message)
    return
  }
  if (message.action === 'import-result') {
    if (message.status === 'ready') {
      const waiter = import_ready_waiters.get(message.interaction_id)
      if (waiter) {
        clearTimeout(waiter.timeout)
        import_ready_waiters.delete(message.interaction_id)
        waiter.resolve(true)
      }
      return
    }
    const waiter = import_ready_waiters.get(message.interaction_id)
    if (waiter) {
      clearTimeout(waiter.timeout)
      import_ready_waiters.delete(message.interaction_id)
      waiter.resolve(false)
    }
    const tab_id = interaction_tabs.get(message.interaction_id)
    if (tab_id !== undefined) {
      try {
        await browser.tabs.sendMessage(tab_id, message)
      } catch {
        // The provider page may have closed after requesting the import.
      }
      interaction_tabs.delete(message.interaction_id)
    }
  }
}

export const sweep_expired_handoffs = async () => {
  const all = await browser.storage.local.get()
  const now = Date.now()
  const expired = Object.entries(all)
    .filter(
      ([key, value]) =>
        key.startsWith(HANDOFF_PREFIX) &&
        typeof (value as HandoffMetadata | undefined)?.expires_at ===
          'number' &&
        (value as HandoffMetadata).expires_at <= now
    )
    .map(([key]) => key)
  if (expired.length > 0) await browser.storage.local.remove(expired)
}

export const setup_message_listeners = () => {
  browser.runtime.onMessage.addListener(
    (raw: unknown, sender: browser.Runtime.MessageSender) => {
      const message = raw as ContentToBackgroundMessage
      if (message?.action === 'request-handoff') {
        return handle_handoff_request(message.handoff_id, sender)
      }
      return forward_content_event(message as ContentInteractionMessage, sender)
    }
  )
}

export const __reset_message_handler_for_tests = () => {
  for (const item of queue) if (item.timeout) clearTimeout(item.timeout)
  queue.splice(0)
  interaction_tabs.clear()
  for (const waiter of import_ready_waiters.values()) {
    clearTimeout(waiter.timeout)
    waiter.resolve(false)
  }
  import_ready_waiters.clear()
  processing = false
  last_opened_tab_id = undefined
  last_tab_response_finished = false
}
