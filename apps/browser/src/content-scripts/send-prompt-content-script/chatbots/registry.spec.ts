jest.mock('webextension-polyfill', () => ({
  __esModule: true,
  default: { runtime: { sendMessage: jest.fn().mockResolvedValue(undefined) } }
}))
const mock_add_apply_response_button = jest.fn()
const mock_observe_for_responses = jest.fn()
jest.mock('../utils/add-apply-response-button', () => ({
  add_apply_response_button: mock_add_apply_response_button,
  observe_for_responses: mock_observe_for_responses
}))
jest.mock('../utils/show-response-ready-notification', () => ({
  show_response_ready_notification: jest.fn()
}))

import { PROVIDER_REGISTRY } from '@shared/types/provider-registry'
import { CHATBOT_ADAPTERS } from './registry'

const MESSAGE_SELECTORS: Record<string, string> = {
  ai_studio: 'textarea[formcontrolname="promptText"]',
  arena: 'textarea',
  chatgpt: 'div#prompt-textarea',
  claude: 'div[contenteditable=true]',
  copilot: 'textarea',
  deepseek: 'textarea',
  doubao: 'textarea',
  gemini: 'div[contenteditable="true"]',
  github_copilot: 'textarea',
  grok: 'div[contenteditable="true"]',
  hugging_chat: 'textarea',
  kimi: 'div[contenteditable=true]',
  meta: 'div[contenteditable="true"][data-testid="composer-input"]',
  mistral: 'div[contenteditable="true"]',
  open_webui: '#chat-input',
  openrouter: 'textarea',
  qwen: 'textarea',
  together: 'textarea',
  yuanbao: 'div[contenteditable="true"]',
  z_ai: 'textarea'
}

const COPY_SELECTORS: Record<string, string> = {
  arena:
    'button:has([d="M15 9V4.6C15 4.26863 14.7314 4 14.4 4H4.6C4.26863 4 4 4.26863 4 4.6V14.4C4 14.7314 4.26863 15 4.6 15H9"])',
  chatgpt: 'button[data-testid="copy-turn-action-button"]',
  claude: 'button[data-testid="action-bar-copy"]',
  copilot: 'button[data-testid="copy-message-button"]',
  deepseek: 'div[role="button"]',
  doubao: 'button[data-testid="message_action_copy"]',
  gemini: 'copy-button button',
  github_copilot: 'button:nth-child(5)',
  grok: 'button:nth-child(4)',
  hugging_chat: 'button:nth-of-type(2)',
  kimi: '.segment-assistant-actions-content > div:first-child',
  meta: 'div:nth-child(3) > button',
  mistral: 'button:last-child',
  open_webui: 'button.copy-response-button',
  qwen: 'div.qwen-chat-package-comp-new-action-control-container-copy',
  together: 'button:first-child',
  yuanbao: '.agent-chat__toolbar__copy',
  z_ai: 'button.copy-response-button'
}

const OPENROUTER_COPY_PATH =
  'M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184'

const native_copy_fixture = () => {
  const queries: string[] = []
  const click = jest.fn()
  const node: any = {
    textContent: 'markdown_copy Copy thumb_up',
    title: 'Copy',
    dataset: {},
    style: {},
    children: [] as any[],
    click,
    insertBefore: jest.fn(),
    getAttribute: jest.fn((name: string) =>
      name === 'd' ? OPENROUTER_COPY_PATH : 'Copy'
    )
  }
  node.children = Array.from({ length: 10 }, () => node)
  node.firstChild = node
  node.lastElementChild = node
  node.parentElement = node
  node.closest = jest.fn((selector: string) => {
    queries.push(selector)
    return node
  })
  node.querySelector = jest.fn((selector: string) => {
    queries.push(selector)
    return node
  })
  node.querySelectorAll = jest.fn((selector: string) => {
    queries.push(selector)
    return [node]
  })
  return { node, click, queries }
}

describe('provider DOM adapters', () => {
  beforeEach(() => {
    mock_add_apply_response_button.mockReset()
    mock_observe_for_responses.mockReset()
  })
  it('keeps one message/response/native-copy adapter for all 20 providers', () => {
    expect(Object.keys(CHATBOT_ADAPTERS)).toHaveLength(20)
    for (const provider of PROVIDER_REGISTRY.providers) {
      const adapter = CHATBOT_ADAPTERS[provider.adapter_key]
      expect(adapter).toBeDefined()
      expect(adapter.enter_message).toEqual(expect.any(Function))
      expect(adapter.setup_observer).toEqual(expect.any(Function))
      if (provider.dom_controls.includes('wait_until_ready')) {
        expect(adapter.wait_until_ready).toEqual(expect.any(Function))
      }
      expect(provider.dom_controls).toContain('native_copy')
    }
  })

  it.each(PROVIDER_REGISTRY.providers)(
    'prefills and focuses $label without submitting',
    async (provider) => {
      const prompt = 'Full prompt\n<files>São Paulo &amp; 東京</files>'
      const input = {
        value: '',
        innerText: '',
        textContent: '',
        dispatchEvent: jest.fn(),
        focus: jest.fn(),
        click: jest.fn()
      }
      const document_dispatch = jest.fn()
      ;(global as any).requestAnimationFrame = (
        callback: FrameRequestCallback
      ) => {
        callback(0)
        return 1
      }
      ;(global as any).window = { innerWidth: 1200 }
      ;(global as any).sessionStorage = {
        getItem: jest.fn(() => null)
      }
      ;(global as any).document = {
        dispatchEvent: document_dispatch,
        querySelector: jest.fn((selector: string) =>
          selector === 'span.v3-token-count-value'
            ? { textContent: '1 token' }
            : selector === MESSAGE_SELECTORS[provider.adapter_key]
              ? input
              : null
        )
      }

      const adapter = CHATBOT_ADAPTERS[provider.adapter_key]
      await adapter.enter_message!({ message: prompt })

      expect([input.value, input.innerText, input.textContent]).toContain(
        prompt
      )
      expect(
        input.dispatchEvent.mock.calls.map(([event]) => event.type)
      ).toEqual(['input', 'change'])
      expect(input.focus).toHaveBeenCalledTimes(1)
      expect(input.click).not.toHaveBeenCalled()
      expect(document_dispatch).not.toHaveBeenCalled()
    }
  )

  it.each(PROVIDER_REGISTRY.providers)(
    'reports an observable $label prefill failure when its input is unavailable',
    async (provider) => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined)
      ;(global as any).document = { querySelector: jest.fn(() => null) }
      const adapter = CHATBOT_ADAPTERS[provider.adapter_key]
      await expect(
        adapter.enter_message!({ message: 'prompt' })
      ).rejects.toThrow('PROVIDER_CONTROL_UNAVAILABLE')
    }
  )

  it('does not synthesize a send click or Enter key for an Open WebUI fixture', async () => {
    const input = {
      innerText: '',
      dispatchEvent: jest.fn(),
      focus: jest.fn(),
      click: jest.fn()
    }
    ;(global as any).document = {
      dispatchEvent: jest.fn(),
      querySelector: jest.fn((selector: string) =>
        selector === '#chat-input' ? input : null
      )
    }
    const prompt = 'Full prompt\n<files>São Paulo &amp; 東京</files>'
    await CHATBOT_ADAPTERS.open_webui.enter_message!({ message: prompt })
    expect(input.innerText).toBe(prompt)
    expect(input.dispatchEvent.mock.calls.map(([event]) => event.type)).toEqual(
      ['input', 'change']
    )
    expect(input.focus).toHaveBeenCalledTimes(1)
    expect(input.click).not.toHaveBeenCalled()
    expect((global as any).document.dispatchEvent).not.toHaveBeenCalled()
  })

  it.each(
    PROVIDER_REGISTRY.providers.filter(
      (provider) => provider.adapter_key !== 'ai_studio'
    )
  )('invokes the $label native Copy control', (provider) => {
    const fixture = native_copy_fixture()
    ;(global as any).document = {
      documentElement: fixture.node,
      querySelector: fixture.node.querySelector,
      querySelectorAll: fixture.node.querySelectorAll
    }
    const adapter = CHATBOT_ADAPTERS[provider.adapter_key]
    adapter.setup_observer!({
      interaction: {
        interaction_id: 'ec20c80d-a1a4-4b6a-922c-e13a9c1052ec',
        browser_instance_id: 'f816afc4-76e7-48e4-b66f-4ebfad72f943',
        provider_id: provider.id,
        provider_url: provider.canonical_url
      },
      inject_button: true
    })
    const observer_parameters =
      mock_observe_for_responses.mock.calls.at(-1)?.[0]
    expect(observer_parameters).toEqual(
      expect.objectContaining({
        footer_selector: expect.any(String),
        is_generating: expect.any(Function),
        add_buttons: expect.any(Function)
      })
    )
    observer_parameters.add_buttons(fixture.node)
    const button_parameters =
      mock_add_apply_response_button.mock.calls.at(-1)?.[0]
    expect(button_parameters.perform_copy).toEqual(expect.any(Function))
    button_parameters.perform_copy(fixture.node)
    expect(fixture.click).toHaveBeenCalled()
    const expected = COPY_SELECTORS[provider.adapter_key]
    if (expected) expect(fixture.queries).toContain(expected)
    if (provider.adapter_key === 'openrouter') {
      expect(fixture.queries).toContain('button')
      expect(fixture.queries).toContain('path')
    }
  })

  it('invokes the AI Studio native markdown Copy control', () => {
    jest.useFakeTimers()
    const fixture = native_copy_fixture()
    let mutation_callback: () => void = () => undefined
    ;(global as any).MutationObserver = class {
      constructor(callback: () => void) {
        mutation_callback = callback
      }
      observe() {}
      disconnect() {}
    }
    let footers: any[] = []
    ;(global as any).document = {
      documentElement: fixture.node,
      querySelector: fixture.node.querySelector,
      querySelectorAll: jest.fn((selector: string) => {
        fixture.queries.push(selector)
        return selector === 'button' ? [fixture.node] : footers
      })
    }
    CHATBOT_ADAPTERS.ai_studio.setup_observer!({
      interaction: {
        interaction_id: 'ec20c80d-a1a4-4b6a-922c-e13a9c1052ec',
        browser_instance_id: 'f816afc4-76e7-48e4-b66f-4ebfad72f943',
        provider_id: 'ai-studio',
        provider_url: 'https://aistudio.google.com/prompts/new_chat'
      },
      inject_button: true
    })
    footers = [fixture.node]
    mutation_callback()
    jest.runOnlyPendingTimers()
    const button_parameters =
      mock_add_apply_response_button.mock.calls.at(-1)?.[0]
    expect(button_parameters.perform_copy).toEqual(expect.any(Function))
    button_parameters.perform_copy(fixture.node)
    expect(fixture.queries).toContain('ms-chat-turn-options > div > button')
    expect(fixture.click).toHaveBeenCalledTimes(2)
    jest.useRealTimers()
  })
})
