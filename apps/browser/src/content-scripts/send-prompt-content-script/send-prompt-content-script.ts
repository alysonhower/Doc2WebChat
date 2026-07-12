import browser from 'webextension-polyfill'
import {
  HandoffPayload,
  InteractionIdentity
} from '@shared/types/websocket-message'
import { find_provider_for_page } from '@shared/types/provider-registry'
import {
  BackgroundToContentMessage,
  ContentInteractionMessage,
  HandoffResponse
} from '@/types/messages'
import { Chatbot } from './types/chatbot'
import { CHATBOT_ADAPTERS } from './chatbots/registry'

const HASH_PREFIX = '#doc2webchat-'
let active_interaction: InteractionIdentity | undefined

const provider = find_provider_for_page(window.location.href, document.title)
const chatbot: Chatbot | undefined = provider
  ? CHATBOT_ADAPTERS[provider.adapter_key]
  : undefined

const identity_from = (payload: HandoffPayload): InteractionIdentity => ({
  interaction_id: payload.interaction_id,
  browser_instance_id: payload.browser_instance_id,
  provider_id: payload.provider_id,
  provider_url: payload.provider_url
})

const notify = async (
  identity: InteractionIdentity,
  event: Omit<ContentInteractionMessage, keyof InteractionIdentity>
) => {
  await browser.runtime.sendMessage({ ...identity, ...event })
}

const prefill = async (payload: HandoffPayload) => {
  if (!chatbot || !provider || provider.id !== payload.provider_id) {
    throw new Error('PROVIDER_MISMATCH')
  }
  const settings = payload.settings
  if (chatbot.wait_until_ready) await chatbot.wait_until_ready()
  if (chatbot.set_model) await chatbot.set_model(settings)
  if (chatbot.enter_system_instructions) {
    await chatbot.enter_system_instructions(settings)
  }
  if (chatbot.set_temperature) await chatbot.set_temperature(settings)
  if (chatbot.set_top_p) await chatbot.set_top_p(settings)
  if (chatbot.set_thinking_budget) {
    await chatbot.set_thinking_budget(settings)
  }
  if (chatbot.set_reasoning_effort) {
    await chatbot.set_reasoning_effort(settings)
  }
  if (chatbot.set_options) await chatbot.set_options(settings)
  if (!chatbot.enter_message) throw new Error('MESSAGE_CONTROL_UNAVAILABLE')
  await chatbot.enter_message({ message: payload.prompt })

  // Set the response baseline only after the prompt has been completely
  // entered. The user remains in control of submission.
  if (chatbot.setup_observer) {
    chatbot.setup_observer({
      interaction: identity_from(payload),
      inject_button: true
    })
  }
}

const initialize_from_hash = async () => {
  const hash = window.location.hash
  if (!hash.startsWith(HASH_PREFIX)) return
  const handoff_id = hash.slice(HASH_PREFIX.length)
  history.replaceState(
    null,
    '',
    window.location.pathname + window.location.search
  )

  const response = (await browser.runtime.sendMessage({
    action: 'request-handoff',
    handoff_id
  })) as HandoffResponse
  if (!response?.ok) {
    console.warn(
      `[Doc2WebChat] Handoff unavailable: ${response?.code ?? 'UNKNOWN'}`
    )
    return
  }

  const identity = identity_from(response.payload)
  active_interaction = identity
  try {
    await prefill(response.payload)
    await notify(identity, { action: 'prefill-completed' })
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
        ? error.message
        : 'PREFILL_FAILED'
    await notify(identity, { action: 'prefill-failed', code })
    active_interaction = undefined
  }
}

browser.runtime.onMessage.addListener((raw: unknown) => {
  const message = raw as BackgroundToContentMessage
  if (
    message?.action !== 'import-result' ||
    message.interaction_id !== active_interaction?.interaction_id ||
    message.browser_instance_id !== active_interaction.browser_instance_id
  ) {
    return false
  }
  const button = document.querySelector(
    '.doc2webchat-import-response-button'
  ) as HTMLButtonElement | null
  if (message.status === 'accepted' || message.status === 'duplicate') {
    button?.remove()
  } else if (button) {
    button.title =
      'Import failed; click to retry with the provider Copy control'
  }
  return false
})

window.addEventListener('hashchange', () => {
  void initialize_from_hash()
})

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    void initialize_from_hash()
  })
} else {
  void initialize_from_hash()
}
