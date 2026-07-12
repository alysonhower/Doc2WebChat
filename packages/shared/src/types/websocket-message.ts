import { get_provider, is_allowed_provider_url } from './provider-registry'

export const BRIDGE_PROTOCOL_VERSION = 1 as const
export const BRIDGE_SERVICE = 'doc2webchat' as const
export const MAX_CONTROL_FRAME_BYTES = 64 * 1024
export const MAX_PROMPT_BYTES = 64 * 1024 * 1024

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{16,256}$/

export type ProviderSettings = {
  model?: string
  temperature?: number
  thinking_budget?: number
  reasoning_effort?: string
  top_p?: number
  system_instructions?: string
  options?: string[]
  reuse_last_tab?: boolean
}

// Kept as the adapter-facing name; it no longer contains URL or editor metadata.
export type Chat = ProviderSettings

export type InteractionIdentity = {
  interaction_id: string
  browser_instance_id: string
  provider_id: string
  provider_url: string
}

export type HealthResponse = {
  service: typeof BRIDGE_SERVICE
  protocol_version: typeof BRIDGE_PROTOCOL_VERSION
  session_token: string
}

export type RegisterBrowserMessage = {
  action: 'register-browser'
  browser_instance_id: string
  version: string
  user_agent: string
}

export type PongMessage = {
  action: 'pong'
  browser_instance_id: string
  nonce: string
}

type InteractionEvent<Action extends string> = InteractionIdentity & {
  action: Action
  tab_id?: number
}

export type PrefillCompletedMessage = InteractionEvent<'prefill-completed'> & {
  tab_id: number
}
export type ResponseFinishedMessage = InteractionEvent<'response-finished'> & {
  tab_id: number
}
export type ImportStartedMessage = InteractionEvent<'import-started'> & {
  tab_id: number
}
export type ImportResponseMessage = InteractionEvent<'import-response'> & {
  tab_id: number
}
export type BridgeFailureMessage = InteractionEvent<
  'prefill-failed' | 'import-failed'
> & {
  code: string
  message?: string
}

export type BrowserToBridgeMessage =
  | RegisterBrowserMessage
  | PongMessage
  | PrefillCompletedMessage
  | BridgeFailureMessage
  | ResponseFinishedMessage
  | ImportStartedMessage
  | ImportResponseMessage

export type BrowserRegisteredMessage = {
  action: 'browser-registered'
  browser_instance_id: string
  handoff_token: string
}

export type PingMessage = {
  action: 'ping'
  nonce: string
}

export type InitializeInteractionMessage = InteractionIdentity & {
  action: 'initialize-interaction'
  handoff_id: string
  expires_at: number
  settings: ProviderSettings
}

export type ImportResultMessage = InteractionIdentity & {
  action: 'import-result'
  status: 'ready' | 'accepted' | 'duplicate' | 'failed'
  code?: string
}

export type BridgeToBrowserMessage =
  | BrowserRegisteredMessage
  | PingMessage
  | InitializeInteractionMessage
  | ImportResultMessage

export type HandoffPayload = Omit<InitializeInteractionMessage, 'action'> & {
  prompt: string
}

const is_record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const is_short_string = (value: unknown, max = 4096): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max

const is_uuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID_PATTERN.test(value)

const is_tab_id = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0

const is_settings = (value: unknown): value is ProviderSettings => {
  if (!is_record(value)) return false
  const strings = ['model', 'reasoning_effort', 'system_instructions'] as const
  for (const key of strings) {
    const current = value[key]
    if (
      current !== undefined &&
      !is_short_string(current, key === 'system_instructions' ? 32768 : 1024)
    ) {
      return false
    }
  }
  for (const key of ['temperature', 'thinking_budget', 'top_p'] as const) {
    const current = value[key]
    if (
      current !== undefined &&
      (typeof current !== 'number' || !Number.isFinite(current))
    ) {
      return false
    }
  }
  if (
    value.reuse_last_tab !== undefined &&
    typeof value.reuse_last_tab !== 'boolean'
  ) {
    return false
  }
  if (
    value.options !== undefined &&
    (!Array.isArray(value.options) ||
      value.options.length > 64 ||
      value.options.some((option) => !is_short_string(option, 256)))
  ) {
    return false
  }
  return true
}

const settings_match_provider = (
  provider_id: string,
  settings: ProviderSettings
) => {
  const provider = get_provider(provider_id)
  if (!provider) return false
  const controls = provider.controls
  if (settings.model !== undefined && controls.model === undefined) return false
  if (
    settings.model !== undefined &&
    controls.model?.values !== undefined &&
    !(settings.model in controls.model.values)
  ) {
    return false
  }
  if (settings.temperature !== undefined && controls.temperature !== true) {
    return false
  }
  if (settings.top_p !== undefined && controls.top_p !== true) return false
  if (
    settings.system_instructions !== undefined &&
    controls.system_instructions === undefined
  ) {
    return false
  }
  if (
    settings.thinking_budget !== undefined &&
    controls.thinking_budget !== true
  ) {
    return false
  }
  if (settings.reasoning_effort !== undefined) {
    const allowed =
      controls.reasoning_effort?.values ??
      controls.model?.values?.[settings.model ?? '']?.reasoning_efforts
    if (!allowed?.includes(settings.reasoning_effort)) return false
  }
  if (
    settings.options?.some(
      (option) =>
        controls.options === undefined || !(option in controls.options)
    )
  ) {
    return false
  }
  return true
}

export const is_interaction_identity = (
  value: unknown
): value is InteractionIdentity => {
  if (!is_record(value)) return false
  if (!is_uuid(value.interaction_id) || !is_uuid(value.browser_instance_id)) {
    return false
  }
  if (
    !is_short_string(value.provider_id, 64) ||
    !is_short_string(value.provider_url, 4096)
  ) {
    return false
  }
  const provider = get_provider(value.provider_id)
  return (
    provider !== undefined &&
    is_allowed_provider_url(provider, value.provider_url)
  )
}

export const parse_health_response = (
  value: unknown
): HealthResponse | null => {
  if (!is_record(value)) return null
  if (
    value.service !== BRIDGE_SERVICE ||
    value.protocol_version !== BRIDGE_PROTOCOL_VERSION ||
    !is_short_string(value.session_token, 512) ||
    value.session_token.length < 16
  ) {
    return null
  }
  return value as HealthResponse
}

export const parse_bridge_frame = (
  frame: unknown
): BridgeToBrowserMessage | null => {
  if (typeof frame !== 'string') return null
  if (new TextEncoder().encode(frame).byteLength > MAX_CONTROL_FRAME_BYTES)
    return null

  let value: unknown
  try {
    value = JSON.parse(frame)
  } catch {
    return null
  }
  if (!is_record(value) || !is_short_string(value.action, 64)) return null

  if (value.action === 'ping') {
    return is_short_string(value.nonce, 128) ? (value as PingMessage) : null
  }
  if (value.action === 'browser-registered') {
    return is_uuid(value.browser_instance_id) &&
      is_short_string(value.handoff_token, 512) &&
      value.handoff_token.length >= 16
      ? (value as BrowserRegisteredMessage)
      : null
  }
  if (!is_interaction_identity(value)) return null
  const interaction = value as InteractionIdentity & Record<string, unknown>

  if (interaction.action === 'initialize-interaction') {
    return OPAQUE_ID_PATTERN.test(String(interaction.handoff_id)) &&
      typeof interaction.expires_at === 'number' &&
      Number.isFinite(interaction.expires_at) &&
      is_settings(interaction.settings) &&
      settings_match_provider(interaction.provider_id, interaction.settings)
      ? (interaction as InitializeInteractionMessage)
      : null
  }
  if (interaction.action === 'import-result') {
    const valid_status = ['ready', 'accepted', 'duplicate', 'failed'].includes(
      String(interaction.status)
    )
    const valid_code =
      interaction.code === undefined || is_short_string(interaction.code, 128)
    return valid_status && valid_code
      ? (interaction as ImportResultMessage)
      : null
  }
  return null
}

export const parse_handoff_payload = (
  value: unknown
): HandoffPayload | null => {
  if (!is_record(value) || !is_interaction_identity(value)) return null
  const handoff = value as InteractionIdentity & Record<string, unknown>
  if (
    !OPAQUE_ID_PATTERN.test(String(handoff.handoff_id)) ||
    typeof handoff.expires_at !== 'number' ||
    !Number.isFinite(handoff.expires_at) ||
    !is_settings(handoff.settings) ||
    !settings_match_provider(handoff.provider_id, handoff.settings) ||
    typeof handoff.prompt !== 'string' ||
    new TextEncoder().encode(handoff.prompt).byteLength > MAX_PROMPT_BYTES
  ) {
    return null
  }
  return handoff as HandoffPayload
}

export const is_browser_to_bridge_message = (
  value: unknown
): value is BrowserToBridgeMessage => {
  if (!is_record(value) || !is_short_string(value.action, 64)) return false
  if (value.action === 'register-browser') {
    return (
      is_uuid(value.browser_instance_id) &&
      is_short_string(value.version, 64) &&
      is_short_string(value.user_agent, 1024)
    )
  }
  if (value.action === 'pong') {
    return (
      is_uuid(value.browser_instance_id) && is_short_string(value.nonce, 128)
    )
  }
  if (!is_interaction_identity(value)) return false
  const interaction = value as InteractionIdentity & Record<string, unknown>
  if (
    [
      'prefill-completed',
      'response-finished',
      'import-started',
      'import-response'
    ].includes(String(interaction.action))
  ) {
    return is_tab_id(interaction.tab_id)
  }
  if (
    interaction.action === 'prefill-failed' ||
    interaction.action === 'import-failed'
  ) {
    return (
      is_short_string(interaction.code, 128) &&
      (interaction.message === undefined ||
        is_short_string(interaction.message, 1024)) &&
      (interaction.tab_id === undefined || is_tab_id(interaction.tab_id))
    )
  }
  return false
}
