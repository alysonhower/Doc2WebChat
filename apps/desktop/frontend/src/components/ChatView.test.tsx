import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderDefinition, PyWebviewApi } from '../api/contracts'
import { ChatView } from './ChatView'

describe('ChatView', () => {
  it('renders only registry controls and translates them to the bridge setting keys', async () => {
    const user = userEvent.setup()
    const provider: ProviderDefinition = {
      id: 'ai-studio',
      label: 'AI Studio',
      canonicalUrl: 'https://aistudio.google.com/prompts/new_chat',
      controls: {
        model: {
          values: {
            flash: { label: 'Flash', reasoning_efforts: ['Low', 'High'] }
          }
        },
        temperature: true,
        top_p: true,
        thinking_budget: true,
        system_instructions: { default: 'Helpful document assistant.' },
        options: { grounding: 'Grounding' }
      }
    }
    const startInteraction = vi.fn(async () => ({
      ok: true as const,
      value: {
        interactionId: 'interaction-1',
        status: 'dispatched',
        promptBytes: 42
      }
    }))
    window.pywebview = {
      api: { start_interaction: startInteraction } as unknown as PyWebviewApi
    }
    const refresh = vi.fn(async () => undefined)
    render(
      <ChatView
        documents={[]}
        providers={[provider]}
        browsers={[
          {
            browserInstanceId: 'browser-1',
            version: '1',
            userAgent: 'Chrome/126'
          }
        ]}
        history={[]}
        prompts={[]}
        onRefreshHistory={refresh}
      />
    )

    await user.selectOptions(screen.getByLabelText('Model'), 'flash')
    await user.type(screen.getByLabelText('Temperature'), '0.4')
    await user.type(screen.getByLabelText('Top P'), '0.8')
    await user.selectOptions(screen.getByLabelText('Reasoning effort'), 'High')
    await user.type(screen.getByLabelText('Thinking budget'), '256')
    await user.click(screen.getByLabelText('Grounding'))
    const send = screen.getByRole('button', { name: /open in browser/i })
    await waitFor(() => expect(send).toBeEnabled())
    await user.click(send)

    expect(startInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'ai-studio',
        browserInstanceId: 'browser-1',
        reuseTab: true,
        settings: {
          model: 'flash',
          temperature: 0.4,
          top_p: 0.8,
          reasoning_effort: 'High',
          thinking_budget: 256,
          system_instructions: 'Helpful document assistant.',
          options: ['grounding']
        }
      })
    )
    expect(refresh).toHaveBeenCalled()
    expect(screen.queryByLabelText(/api key/i)).not.toBeInTheDocument()
  }, 15_000)
})
