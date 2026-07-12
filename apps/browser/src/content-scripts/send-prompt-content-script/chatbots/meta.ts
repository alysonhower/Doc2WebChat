import { Chatbot } from '../types/chatbot'
import {
  add_apply_response_button,
  observe_for_responses
} from '../utils/add-apply-response-button'
import { report_initialization_error } from '../utils/report-initialization-error'
import { prefill_message } from '../utils/prefill-message'

export const meta: Chatbot = {
  wait_until_ready: async () => {
    await new Promise((resolve) => {
      const check_for_element = () => {
        if (
          document.querySelector(
            'div[contenteditable="true"][data-testid="composer-input"]'
          )
        ) {
          resolve(null)
        } else {
          setTimeout(check_for_element, 100)
        }
      }
      check_for_element()
    })
    await new Promise((resolve) => setTimeout(resolve, 500))
  },
  enter_message: async (params) => {
    const input_element = document.querySelector(
      'div[contenteditable="true"][data-testid="composer-input"]'
    ) as HTMLElement

    if (!input_element) {
      report_initialization_error({
        function_name: 'meta.enter_message',
        log_message: 'Message input element not found'
      })
      return
    }

    prefill_message(input_element, params.message, 'textContent')
  },
  setup_observer: (params) => {
    const add_buttons = (footer: Element) => {
      add_apply_response_button({
        interaction: params.interaction,
        footer,
        get_chat_turn: (f) =>
          f.closest('div[data-testid="assistant-message"]') as HTMLElement,
        perform_copy: (f) => {
          const copy_button = f.querySelector(
            'div:nth-child(3) > button'
          ) as HTMLElement
          if (!copy_button) {
            report_initialization_error({
              function_name: 'meta.perform_copy',
              log_message: 'Copy button not found'
            })
            return
          }
          copy_button.click()
        },
        insert_button: (f, b) =>
          f.insertBefore(b, f.children[f.children.length])
      })
    }

    observe_for_responses({
      interaction: params.interaction,
      chatbot_name: 'Meta',
      is_generating: () =>
        !!document.querySelector('button[data-testid="composer-stop-button"]'),
      footer_selector:
        'div[data-testid="assistant-message"] > div + div > div > div:last-child > div > div',
      add_buttons: params.inject_button ? add_buttons : undefined
    })
  }
}
