import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  InteractionRow,
  PromptRow,
  ProviderDefinition,
  PyWebviewApi
} from '../api/contracts'
import { emptyStructuredPrompt } from '../structured/model'
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
        options: { search: 'Search' }
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

    await user.click(
      screen.getByText('Configurações avançadas do provedor', {
        selector: 'span'
      })
    )
    await user.selectOptions(screen.getByLabelText('Modelo'), 'flash')
    await user.type(screen.getByLabelText('Temperatura'), '0.4')
    await user.type(screen.getByLabelText('Top P'), '0.8')
    await user.selectOptions(
      screen.getByLabelText('Nível de raciocínio'),
      'High'
    )
    await user.type(screen.getByLabelText('Limite de raciocínio'), '256')
    await user.click(screen.getByLabelText('Pesquisa'))
    expect(screen.getByText('6 alterações')).toBeInTheDocument()
    const send = screen.getByRole('button', { name: /abrir no navegador/i })
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
          options: ['search']
        }
      })
    )
    expect(refresh).toHaveBeenCalled()
    expect(screen.queryByLabelText(/api key/i)).not.toBeInTheDocument()
  }, 15_000)

  it('confirms before replacing edited instructions with a saved prompt', async () => {
    const user = userEvent.setup()
    const first: PromptRow = {
      id: 1,
      name: 'First prompt',
      document: {
        ...emptyStructuredPrompt(),
        root: { version: 1, nodes: [{ type: 'text', text: 'First' }] }
      }
    }
    const second: PromptRow = {
      id: 2,
      name: 'Second prompt',
      document: {
        ...emptyStructuredPrompt(),
        root: { version: 1, nodes: [{ type: 'text', text: 'Second' }] }
      }
    }
    const loadPrompt = vi.fn(async ({ promptId }: { promptId: number }) => ({
      ok: true as const,
      value: { prompt: promptId === first.id ? first : second }
    }))
    window.pywebview = {
      api: { load_prompt: loadPrompt } as unknown as PyWebviewApi
    }
    render(
      <ChatView
        documents={[]}
        providers={[]}
        browsers={[]}
        history={[]}
        prompts={[first, second]}
        onRefreshHistory={vi.fn(async () => undefined)}
      />
    )

    const savedPrompt = screen.getByLabelText('Prompt salvo')
    await user.selectOptions(savedPrompt, '1')
    const editor = screen.getByLabelText('Instruções')
    await waitFor(() => expect(editor).toHaveTextContent('First'))
    await user.type(editor, ' edited')
    await user.selectOptions(savedPrompt, '2')

    expect(loadPrompt).toHaveBeenCalledTimes(1)
    expect(
      screen.getByRole('dialog', { name: 'Substituir instruções editadas?' })
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(savedPrompt).toHaveValue('1')

    await user.selectOptions(savedPrompt, '2')
    await user.click(
      screen.getByRole('button', { name: 'Carregar prompt salvo' })
    )
    await waitFor(() => expect(loadPrompt).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(editor).toHaveTextContent('Second'))
  })

  it('shows only the exact dispatched interaction while its history row is pending', async () => {
    const user = userEvent.setup()
    const oldInteraction: InteractionRow = {
      interactionId: 'old-interaction',
      providerId: 'provider',
      providerLabel: 'Provider',
      status: 'completed',
      createdAt: '2025-01-01T00:00:00Z',
      messages: [
        {
          id: 1,
          role: 'assistant',
          content: 'Unrelated historical response',
          createdAt: '2025-01-01T00:01:00Z'
        }
      ]
    }
    window.pywebview = {
      api: {
        start_interaction: vi.fn(async () => ({
          ok: true as const,
          value: {
            interactionId: 'new-interaction',
            status: 'dispatched',
            promptBytes: 23
          }
        }))
      } as unknown as PyWebviewApi
    }
    render(
      <ChatView
        documents={[]}
        providers={[
          {
            id: 'provider',
            label: 'Provider',
            canonicalUrl: 'https://example.com',
            controls: {}
          }
        ]}
        browsers={[{ browserInstanceId: 'browser-1', label: 'Chrome' }]}
        history={[oldInteraction]}
        prompts={[]}
        onRefreshHistory={vi.fn(async () => undefined)}
      />
    )

    expect(
      screen.getByText('Unrelated historical response')
    ).toBeInTheDocument()
    await user.click(
      screen.getByRole('button', { name: /abrir no navegador/i })
    )

    await waitFor(() =>
      expect(
        screen.queryByText('Unrelated historical response')
      ).not.toBeInTheDocument()
    )
    expect(screen.getAllByText('Abrindo provedor')).not.toHaveLength(0)
    expect(
      screen.getAllByText('Preparando o prompt para abri-lo no navegador.')
    ).not.toHaveLength(0)
  })

  it('explains zero, one, and multiple connected browser states', () => {
    const baseProps = {
      documents: [],
      providers: [],
      history: [],
      prompts: [],
      onRefreshHistory: vi.fn(async () => undefined)
    }
    const { rerender } = render(
      <ChatView key="none" {...baseProps} browsers={[]} />
    )
    expect(screen.getByText(/Extensão offline/)).toBeInTheDocument()

    rerender(
      <ChatView
        key="one"
        {...baseProps}
        browsers={[{ browserInstanceId: 'one', label: 'Firefox' }]}
      />
    )
    expect(
      screen.getByText('Usando Firefox automaticamente.')
    ).toBeInTheDocument()

    rerender(
      <ChatView
        key="many"
        {...baseProps}
        browsers={[
          { browserInstanceId: 'one', label: 'Firefox' },
          { browserInstanceId: 'two', label: 'Chrome' }
        ]}
      />
    )
    expect(
      screen.getByText('Selecione um dos 2 navegadores conectados.')
    ).toBeInTheDocument()
  })
})
