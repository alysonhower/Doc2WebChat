import browser from 'webextension-polyfill'
import {
  BrowserToBridgeMessage,
  HandoffPayload,
  HealthResponse,
  is_browser_to_bridge_message,
  parse_bridge_frame,
  parse_handoff_payload,
  parse_health_response
} from '@shared/types/websocket-message'
import { BRIDGE_HTTP_ORIGIN, BRIDGE_WS_URL } from '@shared/constants/websocket'
import { handle_bridge_message } from './message-handler'

const BROWSER_INSTANCE_KEY = 'doc2webchat:browser-instance-id'
const RECONNECT_DELAY_MS = 5_000
const STALE_AFTER_MS = 45_000
const HANDOFF_CREDENTIAL_WAIT_MS = 5_000

let websocket: WebSocket | null = null
let reconnect_timer: ReturnType<typeof setTimeout> | undefined
let connecting = false
let last_server_message_at = 0
let health: HealthResponse | null = null
let handoff_token: string | null = null
const handoff_token_waiters = new Set<(token: string | null) => void>()
const outbox: BrowserToBridgeMessage[] = []

const make_uuid = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (part) => {
    const random = crypto.getRandomValues(new Uint8Array(1))[0] & 15
    const value = part === 'x' ? random : (random & 3) | 8
    return value.toString(16)
  })
}

const publish_handoff_token = (token: string | null) => {
  handoff_token = token
  for (const resolve of handoff_token_waiters) resolve(token)
  handoff_token_waiters.clear()
}

const wait_for_handoff_token = (): Promise<string | null> => {
  if (handoff_token) return Promise.resolve(handoff_token)
  return new Promise((resolve) => {
    const finish = (token: string | null) => {
      clearTimeout(timeout)
      handoff_token_waiters.delete(finish)
      resolve(token)
    }
    const timeout = setTimeout(() => finish(null), HANDOFF_CREDENTIAL_WAIT_MS)
    handoff_token_waiters.add(finish)
  })
}

export const get_browser_instance_id = async (): Promise<string> => {
  const stored = await browser.storage.local.get(BROWSER_INSTANCE_KEY)
  const current = stored[BROWSER_INSTANCE_KEY]
  if (typeof current === 'string') return current
  const created = make_uuid()
  await browser.storage.local.set({ [BROWSER_INSTANCE_KEY]: created })
  return created
}

export const check_server_health = async (): Promise<HealthResponse | null> => {
  try {
    const response = await fetch(`${BRIDGE_HTTP_ORIGIN}/health`, {
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    })
    if (!response.ok) return null
    const parsed = parse_health_response(await response.json())
    if (parsed) health = parsed
    return parsed
  } catch {
    return null
  }
}

const schedule_reconnect = () => {
  if (reconnect_timer !== undefined) return
  reconnect_timer = setTimeout(() => {
    reconnect_timer = undefined
    void connect_websocket()
  }, RECONNECT_DELAY_MS)
}

export const check_and_recover_connection = () => {
  if (
    websocket?.readyState === WebSocket.OPEN &&
    Date.now() - last_server_message_at > STALE_AFTER_MS
  ) {
    websocket.close(4000, 'stale bridge connection')
    return
  }
  if (!connecting && websocket?.readyState !== WebSocket.OPEN) {
    void connect_websocket()
  }
}

export const connect_websocket = async (): Promise<void> => {
  if (
    connecting ||
    websocket?.readyState === WebSocket.OPEN ||
    websocket?.readyState === WebSocket.CONNECTING
  ) {
    return
  }
  connecting = true

  try {
    const current_health = await check_server_health()
    if (!current_health) {
      connecting = false
      schedule_reconnect()
      return
    }

    const browser_instance_id = await get_browser_instance_id()
    const query = new URLSearchParams({
      token: current_health.session_token,
      role: 'browser-extension'
    })
    const socket = new WebSocket(`${BRIDGE_WS_URL}?${query.toString()}`)
    websocket = socket

    socket.onopen = () => {
      connecting = false
      last_server_message_at = Date.now()
      const manifest = browser.runtime.getManifest()
      send_message_to_server({
        action: 'register-browser',
        browser_instance_id,
        version: manifest.version,
        user_agent: navigator.userAgent
      })
      for (const pending of outbox.splice(0)) {
        socket.send(JSON.stringify(pending))
      }
      console.info('[Doc2WebChat] Browser bridge connected')
    }

    socket.onmessage = (event) => {
      last_server_message_at = Date.now()
      const message = parse_bridge_frame(event.data)
      if (!message) {
        console.warn('[Doc2WebChat] Ignored invalid bridge frame')
        return
      }
      if (message.action === 'ping') {
        send_message_to_server({
          action: 'pong',
          browser_instance_id,
          nonce: message.nonce
        })
        return
      }
      if (message.action === 'browser-registered') {
        publish_handoff_token(message.handoff_token)
      }
      if (
        'browser_instance_id' in message &&
        message.browser_instance_id !== browser_instance_id
      ) {
        console.warn('[Doc2WebChat] Ignored message for another browser')
        return
      }
      void handle_bridge_message(message)
    }

    socket.onclose = () => {
      if (websocket === socket) websocket = null
      connecting = false
      console.info('[Doc2WebChat] Browser bridge disconnected')
      schedule_reconnect()
    }
    socket.onerror = () => {
      if (websocket === socket) websocket = null
      connecting = false
      socket.close()
      schedule_reconnect()
    }
  } catch {
    connecting = false
    websocket = null
    schedule_reconnect()
  }
}

export const send_message_to_server = (
  message: BrowserToBridgeMessage
): boolean => {
  if (!is_browser_to_bridge_message(message)) {
    console.warn('[Doc2WebChat] Refused invalid outgoing bridge message')
    return false
  }
  if (websocket?.readyState !== WebSocket.OPEN) {
    if (message.action !== 'pong' && message.action !== 'register-browser') {
      const duplicate = outbox.some(
        (pending) =>
          'interaction_id' in pending &&
          'interaction_id' in message &&
          pending.interaction_id === message.interaction_id &&
          pending.action === message.action
      )
      if (!duplicate && outbox.length < 256) outbox.push(message)
      void connect_websocket()
    }
    return false
  }
  websocket.send(JSON.stringify(message))
  return true
}

const fetch_handoff_once = async (
  handoff_id: string,
  allow_token_refresh: boolean
): Promise<HandoffPayload | null> => {
  const current_health = health ?? (await check_server_health())
  const current_handoff_token =
    handoff_token ?? (await wait_for_handoff_token())
  if (!current_health || !current_handoff_token) return null
  try {
    const browser_instance_id = await get_browser_instance_id()
    const response = await fetch(
      `${BRIDGE_HTTP_ORIGIN}/handoff/${encodeURIComponent(handoff_id)}`,
      {
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${current_health.session_token}`,
          'X-Doc2WebChat-Browser-Instance-Id': browser_instance_id,
          'X-Doc2WebChat-Handoff-Token': current_handoff_token
        }
      }
    )
    if (response.status === 401 || response.status === 403) {
      health = null
      if (allow_token_refresh && (await check_server_health())) {
        return fetch_handoff_once(handoff_id, false)
      }
    }
    if (!response.ok) return null
    return parse_handoff_payload(await response.json())
  } catch {
    return null
  }
}

export const fetch_handoff = (handoff_id: string) =>
  fetch_handoff_once(handoff_id, true)

export const __reset_connection_for_tests = () => {
  if (reconnect_timer !== undefined) clearTimeout(reconnect_timer)
  reconnect_timer = undefined
  websocket = null
  connecting = false
  last_server_message_at = 0
  health = null
  publish_handoff_token(null)
  outbox.splice(0)
}
