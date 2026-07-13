jest.mock('webextension-polyfill', () => ({
  __esModule: true,
  default: { runtime: { sendMessage: jest.fn().mockResolvedValue(undefined) } }
}))
jest.mock('./show-response-ready-notification', () => ({
  show_response_ready_notification: jest.fn().mockResolvedValue(undefined)
}))

import {
  add_apply_response_button,
  invoke_native_copy_and_report,
  observe_for_responses
} from './add-apply-response-button'
import { import_response_button_title } from '../constants/dictionary'

const interaction = {
  interaction_id: 'ec20c80d-a1a4-4b6a-922c-e13a9c1052ec',
  browser_instance_id: 'f816afc4-76e7-48e4-b66f-4ebfad72f943',
  provider_id: 'open-webui',
  provider_url: 'http://localhost:3000/'
}

describe('single interaction response lifecycle', () => {
  it('labels the import action in Brazilian Portuguese', () => {
    const attributes = new Map<string, string>()
    const button = {
      ownerDocument: { getElementById: () => ({}) },
      innerHTML: '',
      title: '',
      type: 'submit',
      classList: { add: jest.fn() },
      setAttribute: (name: string, value: string) =>
        attributes.set(name, value),
      addEventListener: jest.fn(),
      focus: jest.fn()
    } as unknown as HTMLButtonElement
    ;(global as any).document = { createElement: () => button }
    const insert_button = jest.fn()

    add_apply_response_button({
      interaction,
      footer: { querySelector: () => null } as unknown as Element,
      get_chat_turn: () => ({}) as HTMLElement,
      perform_copy: () => true,
      insert_button
    })

    expect(import_response_button_title).toBe(
      'Copiar pelo controle do provedor e importar para o Doc2WebChat'
    )
    expect(button.title).toBe(import_response_button_title)
    expect(attributes.get('aria-label')).toBe(import_response_button_title)
    expect(insert_button).toHaveBeenCalledWith(expect.anything(), button)
  })

  it('reports native-copy success only after the provider control returns', async () => {
    const events: string[] = []
    const send = jest.fn(async (_identity, event) => {
      events.push(event.action)
      return event.action === 'import-started' ? true : undefined
    })
    await expect(
      invoke_native_copy_and_report(interaction, () => true, send)
    ).resolves.toBe(true)
    expect(events).toEqual(['import-started', 'import-response'])
  })

  it('does not invoke native Copy until the clipboard baseline is ready', async () => {
    let acknowledge: ((ready: boolean) => void) | undefined
    const baseline_ready = new Promise<boolean>((resolve) => {
      acknowledge = resolve
    })
    const perform_copy = jest.fn(() => true)
    const send = jest.fn(async (_identity, event) => {
      if (event.action === 'import-started') return baseline_ready
      return undefined
    })

    const importing = invoke_native_copy_and_report(
      interaction,
      perform_copy,
      send
    )
    await Promise.resolve()
    expect(perform_copy).not.toHaveBeenCalled()
    acknowledge?.(true)
    await expect(importing).resolves.toBe(true)
    expect(perform_copy).toHaveBeenCalledTimes(1)
  })

  it('reports native-copy failure without reporting an import response', async () => {
    const events: string[] = []
    const send = jest.fn(async (_identity, event) => {
      events.push(event.action)
      return event.action === 'import-started' ? true : undefined
    })
    await expect(
      invoke_native_copy_and_report(
        interaction,
        () => {
          throw new Error('missing native button')
        },
        send
      )
    ).resolves.toBe(false)
    expect(events).toEqual(['import-started', 'import-failed'])
  })

  it('does not invoke native Copy when the baseline is not acknowledged', async () => {
    const perform_copy = jest.fn(() => true)
    const send = jest.fn(async (_identity, event) =>
      event.action === 'import-started' ? undefined : true
    )
    await expect(
      invoke_native_copy_and_report(interaction, perform_copy, send)
    ).resolves.toBe(false)
    expect(perform_copy).not.toHaveBeenCalled()
    expect(send.mock.calls.map(([, event]) => event.action)).toEqual([
      'import-started',
      'import-failed'
    ])
  })

  it('baselines historical responses and retires after the next response', () => {
    const old_footer = {} as Element
    const next_footer = {} as Element
    let footers = [old_footer]
    let callback: () => void = () => undefined
    const disconnect = jest.fn()
    ;(global as any).document = {
      documentElement: {},
      querySelectorAll: () => footers
    }
    ;(global as any).MutationObserver = class {
      constructor(handler: () => void) {
        callback = handler
      }
      observe() {}
      disconnect = disconnect
    }
    const add_buttons = jest.fn()
    let generating = true
    observe_for_responses({
      interaction,
      chatbot_name: 'Fixture',
      is_generating: () => generating,
      footer_selector: '.assistant-footer',
      add_buttons
    })
    callback()
    generating = false
    footers = [old_footer, next_footer]
    callback()
    callback()
    expect(add_buttons).toHaveBeenCalledTimes(1)
    expect(add_buttons).toHaveBeenCalledWith(next_footer)
    expect(disconnect).toHaveBeenCalledTimes(1)
  })
})
