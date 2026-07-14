import {
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { BootstrapState, PyWebviewApi } from './api/contracts'
import App from './App'

describe('App', () => {
  const emptyBootstrap: BootstrapState = {
    documents: [],
    prompts: [],
    browsers: [],
    providers: [],
    history: [],
    preferences: {},
    activeJob: null
  }

  function installDesktopApi(bootstrap: BootstrapState = emptyBootstrap) {
    window.pywebview = {
      api: {
        get_bootstrap_state: vi.fn(async () => ({
          ok: true as const,
          value: bootstrap
        })),
        poll_events: vi.fn(() => new Promise<never>(() => undefined))
      } as unknown as PyWebviewApi
    }
  }

  it('bootstraps through pywebview and applies sequenced OCR polling events', async () => {
    const bootstrap: BootstrapState = {
      documents: [],
      prompts: [],
      browsers: [],
      providers: [],
      history: [],
      preferences: {},
      activeJob: null
    }
    let pollCount = 0
    const pollEvents = vi.fn(async () => {
      pollCount += 1
      if (pollCount === 1)
        return {
          ok: true as const,
          value: {
            nextSequence: 1,
            events: [
              {
                sequence: 1,
                type: 'ocr',
                jobId: 4,
                stage: 'progress',
                completed: 1,
                failed: 0,
                skipped: 0,
                total: 3
              }
            ]
          }
        }
      return new Promise<never>(() => undefined)
    })
    window.pywebview = {
      api: {
        get_bootstrap_state: vi.fn(async () => ({
          ok: true as const,
          value: bootstrap
        })),
        poll_events: pollEvents,
        list_documents: vi.fn(async () => ({
          ok: true as const,
          value: { documents: [] }
        }))
      } as unknown as PyWebviewApi
    }

    render(<App />)
    expect(
      await screen.findByRole('heading', { name: 'Documentos' })
    ).toBeInTheDocument()
    expect(await screen.findByText('1 de 3 arquivos')).toBeInTheDocument()
    expect(screen.getAllByText('Processando')).toHaveLength(2)
    expect(pollEvents).toHaveBeenCalledWith({ after: 0, timeoutMs: 20_000 })
  })

  it('maps overwrite conflict events to the awaiting-overwrite state', async () => {
    const bootstrap: BootstrapState = {
      documents: [],
      prompts: [],
      browsers: [],
      providers: [],
      history: [],
      preferences: {},
      activeJob: null
    }
    let pollCount = 0
    window.pywebview = {
      api: {
        get_bootstrap_state: vi.fn(async () => ({
          ok: true as const,
          value: bootstrap
        })),
        poll_events: vi.fn(async () => {
          pollCount += 1
          if (pollCount === 1)
            return {
              ok: true as const,
              value: {
                nextSequence: 1,
                events: [
                  {
                    sequence: 1,
                    type: 'ocr',
                    jobId: 7,
                    stage: 'overwrite-confirmation-required',
                    inputPath: 'C:\\source',
                    outputPath: 'C:\\output',
                    recursive: true,
                    conflictCount: 1,
                    overwriteConfirmationJobId: 7,
                    conflictingOutputs: ['C:\\output\\scan.pdf']
                  }
                ]
              }
            }
          return new Promise<never>(() => undefined)
        })
      } as unknown as PyWebviewApi
    }

    render(<App />)

    expect(
      await screen.findByRole(
        'heading',
        { name: '1 arquivo já existe' },
        { timeout: 3_000 }
      )
    ).toBeInTheDocument()
    expect(screen.getAllByText('Revisão necessária')).toHaveLength(2)
    expect(screen.getByText('Aguardando confirmação')).toBeInTheDocument()
  })

  it('restores overwrite confirmation from bootstrap without an event', async () => {
    const bootstrap: BootstrapState = {
      documents: [],
      prompts: [],
      browsers: [],
      providers: [],
      history: [],
      preferences: {},
      activeJob: {
        jobId: 12,
        status: 'awaiting-overwrite',
        completed: 0,
        failed: 0,
        skipped: 0,
        total: 2,
        overwriteConfirmationJobId: 12,
        inputPath: 'C:\\restored-source',
        outputPath: 'C:\\restored-output',
        recursive: true,
        conflictCount: 2,
        conflictingOutputs: [
          'C:\\restored-output\\scan.pdf',
          'C:\\restored-output\\letter.pdf'
        ]
      }
    }
    window.pywebview = {
      api: {
        get_bootstrap_state: vi.fn(async () => ({
          ok: true as const,
          value: bootstrap
        })),
        poll_events: vi.fn(() => new Promise<never>(() => undefined))
      } as unknown as PyWebviewApi
    }

    render(<App />)

    expect(
      await screen.findByRole('heading', { name: '2 arquivos já existem' })
    ).toBeInTheDocument()
    expect(screen.getByText('C:\\restored-output\\scan.pdf')).toBeVisible()
    expect(screen.getByText('C:\\restored-output\\letter.pdf')).toBeVisible()
  })

  it('keeps every view mounted and preserves panel scroll across navigation', async () => {
    installDesktopApi()
    render(<App />)

    await screen.findByRole('heading', { name: 'Documentos' })
    const documents = screen.getByTestId('view-panel-documents')
    const chat = screen.getByTestId('view-panel-chat')
    const history = screen.getByTestId('view-panel-history')
    const prompts = screen.getByTestId('view-panel-prompts')
    documents.scrollTop = 147

    expect(documents).not.toHaveAttribute('hidden')
    expect(chat).toHaveAttribute('hidden')
    expect(history).toHaveAttribute('hidden')
    expect(prompts).toHaveAttribute('hidden')

    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    expect(documents).toHaveAttribute('hidden')
    expect(chat).not.toHaveAttribute('hidden')

    fireEvent.click(screen.getByRole('button', { name: 'Documentos' }))
    expect(documents).not.toHaveAttribute('hidden')
    expect(documents.scrollTop).toBe(147)
  })

  it('applies and persists a theme chosen from the app shell', async () => {
    installDesktopApi()
    render(<App />)

    await screen.findByRole('heading', { name: 'Documentos' })
    fireEvent.click(screen.getByRole('button', { name: 'Tema escuro' }))

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(window.localStorage.getItem('doc2webchat-theme')).toBe('dark')
    expect(screen.getByRole('button', { name: 'Tema escuro' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })

  it('removes a deleted document from the shared app context immediately', async () => {
    const deleteDocument = vi.fn(async () => ({
      ok: true as const,
      value: { documentId: 9 }
    }))
    window.pywebview = {
      api: {
        get_bootstrap_state: vi.fn(async () => ({
          ok: true as const,
          value: {
            ...emptyBootstrap,
            documents: [
              {
                id: 9,
                inputPath: 'C:\\source\\scan.pdf',
                resultAvailable: true,
                latestStatus: 'completed'
              }
            ]
          }
        })),
        poll_events: vi.fn(() => new Promise<never>(() => undefined)),
        delete_document: deleteDocument
      } as unknown as PyWebviewApi
    }

    render(<App />)
    await screen.findByText('source/scan.pdf')
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Excluir documento source/scan.pdf'
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Excluir documento' }))

    await waitFor(() =>
      expect(deleteDocument).toHaveBeenCalledWith({ documentId: 9 })
    )
    expect(screen.queryByText('source/scan.pdf')).toBeNull()
  })

  it('removes a deleted terminal Thread and shows the empty state', async () => {
    const interactionId = '00000000-0000-4000-8000-000000000009'
    const deleteInteraction = vi.fn(async () => ({
      ok: true as const,
      value: { interactionId }
    }))
    window.pywebview = {
      api: {
        get_bootstrap_state: vi.fn(async () => ({
          ok: true as const,
          value: {
            ...emptyBootstrap,
            history: [
              {
                interactionId,
                providerId: 'open-webui',
                status: 'completed',
                createdAt: '2026-01-02T00:00:00Z',
                messages: []
              }
            ]
          }
        })),
        poll_events: vi.fn(() => new Promise<never>(() => undefined)),
        delete_interaction: deleteInteraction
      } as unknown as PyWebviewApi
    }

    render(<App />)
    await screen.findByRole('heading', { name: 'Documentos' })
    fireEvent.click(screen.getByRole('button', { name: 'Threads' }))
    fireEvent.click(screen.getByRole('button', { name: 'Excluir Thread' }))
    const dialog = screen.getByRole('dialog', { name: 'Excluir Thread?' })
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Excluir Thread' })
    )

    await waitFor(() =>
      expect(deleteInteraction).toHaveBeenCalledWith({ interactionId })
    )
    expect(screen.getByText('Nenhuma Thread ainda')).toBeInTheDocument()
  })

  it('deletes selected documents through one atomic desktop request', async () => {
    const deleteDocuments = vi.fn(async () => ({
      ok: true as const,
      value: { documentIds: [2, 9] }
    }))
    window.pywebview = {
      api: {
        get_bootstrap_state: vi.fn(async () => ({
          ok: true as const,
          value: {
            ...emptyBootstrap,
            documents: [
              {
                id: 9,
                inputPath: 'C:\\source\\nine.pdf',
                resultAvailable: true,
                latestStatus: 'completed'
              },
              {
                id: 2,
                inputPath: 'C:\\source\\two.pdf',
                resultAvailable: true,
                latestStatus: 'completed'
              }
            ]
          }
        })),
        poll_events: vi.fn(() => new Promise<never>(() => undefined)),
        delete_documents: deleteDocuments
      } as unknown as PyWebviewApi
    }

    render(<App />)
    await screen.findByText('source/two.pdf')
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Selecionar todos os documentos' })
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Excluir selecionados' })
    )
    const dialog = screen.getByRole('dialog', {
      name: 'Excluir 2 documentos?'
    })
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Excluir documentos' })
    )

    await waitFor(() =>
      expect(deleteDocuments).toHaveBeenCalledWith({ documentIds: [2, 9] })
    )
    expect(screen.queryByText('source/two.pdf')).toBeNull()
    expect(screen.queryByText('source/nine.pdf')).toBeNull()
  })

  it('deletes selected terminal Threads through one atomic desktop request', async () => {
    const olderId = '00000000-0000-4000-8000-000000000002'
    const newerId = '00000000-0000-4000-8000-000000000009'
    const deleteInteractions = vi.fn(async () => ({
      ok: true as const,
      value: { interactionIds: [newerId, olderId] }
    }))
    window.pywebview = {
      api: {
        get_bootstrap_state: vi.fn(async () => ({
          ok: true as const,
          value: {
            ...emptyBootstrap,
            history: [
              {
                interactionId: olderId,
                providerId: 'open-webui',
                status: 'failed',
                createdAt: '2026-01-02T00:00:00Z',
                messages: []
              },
              {
                interactionId: newerId,
                providerId: 'open-webui',
                status: 'completed',
                createdAt: '2026-01-03T00:00:00Z',
                messages: []
              }
            ]
          }
        })),
        poll_events: vi.fn(() => new Promise<never>(() => undefined)),
        delete_interactions: deleteInteractions
      } as unknown as PyWebviewApi
    }

    render(<App />)
    await screen.findByRole('heading', { name: 'Documentos' })
    fireEvent.click(screen.getByRole('button', { name: 'Threads' }))
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Selecionar Threads finalizadas'
      })
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Excluir selecionadas' })
    )
    const dialog = screen.getByRole('dialog', { name: 'Excluir 2 Threads?' })
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Excluir 2 Threads' })
    )

    await waitFor(() =>
      expect(deleteInteractions).toHaveBeenCalledWith({
        interactionIds: [newerId, olderId]
      })
    )
    expect(screen.getByText('Nenhuma Thread ainda')).toBeInTheDocument()
  })
})
