import browser from 'webextension-polyfill'
import { InteractionIdentity } from '@shared/types/websocket-message'
import { ContentInteractionMessage } from '@/types/messages'
import { Logger } from '@/utils/logger'
import { import_response_icon } from '../constants/import-response-icon'
import { import_response_button_title } from '../constants/dictionary'
import {
  apply_chat_response_button_style,
  set_button_disabled_state
} from './apply-response-styles'
import { show_response_ready_notification } from './show-response-ready-notification'

const send_interaction_event = (
  interaction: InteractionIdentity,
  event: Omit<ContentInteractionMessage, keyof InteractionIdentity>
) => browser.runtime.sendMessage({ ...interaction, ...event })

export const invoke_native_copy_and_report = async (
  interaction: InteractionIdentity,
  perform_copy: () => boolean | void | Promise<boolean | void>,
  send: typeof send_interaction_event = send_interaction_event
) => {
  try {
    const ready = await send(interaction, { action: 'import-started' })
    if (ready !== true)
      throw new Error('clipboard baseline was not acknowledged')
    const invoked = await perform_copy()
    if (invoked === false) throw new Error('native copy rejected')
    await send(interaction, { action: 'import-response' })
    return true
  } catch {
    try {
      await send(interaction, {
        action: 'import-failed',
        code: 'NATIVE_COPY_FAILED'
      })
    } catch {
      // The bridge may have disconnected while preparing the clipboard import.
    }
    return false
  }
}

export function add_apply_response_button(params: {
  interaction: InteractionIdentity
  footer: Element
  get_chat_turn: (footer: Element) => HTMLElement | null
  perform_copy: (footer: Element) => boolean | void | Promise<boolean | void>
  insert_button: (footer: Element, button: HTMLButtonElement) => void
  customize_button?: (button: HTMLButtonElement) => void
}) {
  const existing = params.footer.querySelector(
    '.doc2webchat-import-response-button'
  )
  if (existing) return

  const chat_turn = params.get_chat_turn(params.footer)
  if (!chat_turn) {
    Logger.error({
      function_name: 'add_apply_response_button',
      message: 'Chat turn container not found'
    })
    return
  }

  const button = document.createElement('button')
  button.innerHTML = import_response_icon
  button.classList.add('doc2webchat-import-response-button')
  button.title = import_response_button_title
  apply_chat_response_button_style(button)
  params.customize_button?.(button)

  button.addEventListener('click', async () => {
    set_button_disabled_state(button)
    await invoke_native_copy_and_report(params.interaction, () =>
      params.perform_copy(params.footer)
    )
  })

  params.insert_button(params.footer, button)
  button.focus({ preventScroll: true })
}

export function observe_for_responses(params: {
  interaction: InteractionIdentity
  chatbot_name: string
  is_generating: () => boolean
  footer_selector: string
  add_buttons?: (footer: Element) => void
}) {
  const baseline = new Set(
    Array.from(document.querySelectorAll(params.footer_selector))
  )
  let completed = false
  let saw_generation = params.is_generating()

  const observer = new MutationObserver(() => {
    if (completed) return
    if (params.is_generating()) {
      saw_generation = true
      return
    }
    if (!saw_generation) return
    const candidates = Array.from(
      document.querySelectorAll(params.footer_selector)
    ).filter((footer) => !baseline.has(footer))
    const footer = candidates.at(-1)
    if (!footer) return

    completed = true
    params.add_buttons?.(footer)
    void send_interaction_event(params.interaction, {
      action: 'response-finished'
    })
    void show_response_ready_notification({ chatbot_name: params.chatbot_name })
    observer.disconnect()
  })

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  })

  return () => observer.disconnect()
}
