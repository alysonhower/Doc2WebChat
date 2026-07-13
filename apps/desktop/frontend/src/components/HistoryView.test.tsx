import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { InteractionRow } from '../api/contracts'
import { HistoryView } from './HistoryView'

const providers = [
  {
    id: 'open-webui',
    label: 'Open WebUI',
    canonicalUrl: 'http://localhost:3000',
    controls: {}
  }
]

const thread = (
  interactionId: string,
  status: string,
  createdAt: string,
  content: string
): InteractionRow => ({
  interactionId,
  providerId: 'open-webui',
  status,
  createdAt,
  messages: [
    {
      id: Number.parseInt(createdAt.slice(-2), 10) || 1,
      role: 'user',
      content,
      createdAt
    }
  ]
})

describe('HistoryView', () => {
  it('shows a useful empty state without an orphan selection prompt', () => {
    render(
      <HistoryView
        history={[]}
        providers={providers}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn()}
      />
    )
    expect(screen.getByText('Nenhuma Thread ainda')).toBeInTheDocument()
    expect(screen.queryByText('Select a conversation')).toBeNull()
  })

  it('sorts newest first, uses friendly labels, and changes selection', async () => {
    const user = userEvent.setup()
    render(
      <HistoryView
        providers={providers}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn()}
        history={[
          {
            interactionId: 'older',
            providerId: 'open-webui',
            status: 'completed',
            createdAt: '2026-01-01T00:00:00Z',
            messages: [
              {
                id: 1,
                role: 'user',
                content: 'Older prompt',
                createdAt: '2026-01-01T00:00:00Z'
              }
            ]
          },
          {
            interactionId: 'newer',
            providerId: 'open-webui',
            status: 'awaiting-import',
            createdAt: '2026-01-02T00:00:00Z',
            messages: [
              {
                id: 2,
                role: 'user',
                content: 'Newer prompt',
                createdAt: '2026-01-02T00:00:00Z'
              }
            ]
          }
        ]}
      />
    )

    const items = screen.getAllByRole('button', { name: /Open WebUI/i })
    expect(items[0]).toHaveTextContent('Newer prompt')
    expect(items[0]).toHaveTextContent('Pronta para importar')
    expect(screen.getByRole('heading', { name: /Newer prompt/i })).toBeVisible()
    await user.click(items[1])
    expect(screen.getByRole('heading', { name: /Older prompt/i })).toBeVisible()
    expect(screen.getAllByText('Importada').length).toBeGreaterThan(0)
  })

  it('deletes only a terminal Thread after confirmation', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn(async () => undefined)
    render(
      <HistoryView
        providers={providers}
        onDelete={onDelete}
        onDeleteMany={vi.fn()}
        history={[
          {
            interactionId: 'done',
            providerId: 'open-webui',
            status: 'completed',
            createdAt: '2026-01-02T00:00:00Z',
            messages: []
          }
        ]}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Excluir Thread' }))
    const dialog = screen.getByRole('dialog', { name: 'Excluir Thread?' })
    expect(dialog).toHaveTextContent(
      'documentos e arquivos locais não serão apagados'
    )
    await user.click(
      within(dialog).getByRole('button', { name: 'Excluir Thread' })
    )
    expect(onDelete).toHaveBeenCalledWith('done')
  })

  it('does not allow deleting a Thread that is still active', () => {
    render(
      <HistoryView
        providers={providers}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn()}
        history={[
          {
            interactionId: 'active',
            providerId: 'open-webui',
            status: 'awaiting-import',
            createdAt: '2026-01-02T00:00:00Z',
            messages: []
          }
        ]}
      />
    )

    expect(
      screen.getByRole('button', { name: 'Excluir Thread' })
    ).toBeDisabled()
  })

  it('selects the next available Thread when the selected one disappears', async () => {
    const user = userEvent.setup()
    const newer = {
      interactionId: 'newer',
      providerId: 'open-webui',
      status: 'completed',
      createdAt: '2026-01-02T00:00:00Z',
      messages: [
        {
          id: 2,
          role: 'user' as const,
          content: 'Newer prompt',
          createdAt: '2026-01-02T00:00:00Z'
        }
      ]
    }
    const older = {
      interactionId: 'older',
      providerId: 'open-webui',
      status: 'completed',
      createdAt: '2026-01-01T00:00:00Z',
      messages: [
        {
          id: 1,
          role: 'user' as const,
          content: 'Older prompt',
          createdAt: '2026-01-01T00:00:00Z'
        }
      ]
    }
    const { rerender } = render(
      <HistoryView
        providers={providers}
        history={[older, newer]}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn()}
      />
    )

    await user.click(screen.getAllByRole('button', { name: /Open WebUI/i })[1])
    expect(screen.getByRole('heading', { name: 'Older prompt' })).toBeVisible()

    rerender(
      <HistoryView
        providers={providers}
        history={[newer]}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn()}
      />
    )
    expect(screen.getByRole('heading', { name: 'Newer prompt' })).toBeVisible()
  })

  it('selects only terminal Threads and deletes them in deterministic display order', async () => {
    const user = userEvent.setup()
    const onDeleteMany = vi.fn(async () => undefined)
    render(
      <HistoryView
        providers={providers}
        onDelete={vi.fn()}
        onDeleteMany={onDeleteMany}
        history={[
          thread('completed', 'completed', '2026-01-01T00:00:01Z', 'Concluída'),
          thread('active', 'awaiting-import', '2026-01-03T00:00:03Z', 'Ativa'),
          thread('expired', 'expired', '2026-01-02T00:00:02Z', 'Expirada')
        ]}
      />
    )

    const selectAll = screen.getByRole('checkbox', {
      name: 'Selecionar Threads finalizadas'
    })
    const active = screen.getByRole('checkbox', {
      name: 'Selecionar Thread: Ativa'
    })
    expect(active).toBeDisabled()

    await user.click(selectAll)
    expect(
      screen.getByRole('checkbox', { name: 'Selecionar Thread: Expirada' })
    ).toBeChecked()
    expect(
      screen.getByRole('checkbox', { name: 'Selecionar Thread: Concluída' })
    ).toBeChecked()
    expect(active).not.toBeChecked()
    expect(screen.getByText('2 Threads selecionadas')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Excluir Thread' })).toBeNull()

    await user.click(
      screen.getByRole('button', { name: 'Excluir selecionadas' })
    )
    const dialog = screen.getByRole('dialog', { name: 'Excluir 2 Threads?' })
    expect(dialog).toHaveTextContent(
      'documentos e arquivos locais não serão apagados'
    )
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(onDeleteMany).not.toHaveBeenCalled()
    expect(screen.getByText('2 Threads selecionadas')).toBeVisible()

    await user.click(
      screen.getByRole('button', { name: 'Excluir selecionadas' })
    )
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Excluir 2 Threads'
      })
    )
    await waitFor(() =>
      expect(onDeleteMany).toHaveBeenCalledWith(['expired', 'completed'])
    )
  })

  it('shows partial selection and lets select-all complete it', async () => {
    const user = userEvent.setup()
    render(
      <HistoryView
        providers={providers}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn()}
        history={[
          thread('newer', 'failed', '2026-01-02T00:00:02Z', 'Mais recente'),
          thread('older', 'completed', '2026-01-01T00:00:01Z', 'Mais antiga')
        ]}
      />
    )

    await user.click(
      screen.getByRole('checkbox', { name: 'Selecionar Thread: Mais antiga' })
    )
    const selectAll = screen.getByRole('checkbox', {
      name: 'Selecionar Threads finalizadas'
    }) as HTMLInputElement
    expect(selectAll.indeterminate).toBe(true)
    expect(screen.getByText('1 Thread selecionada')).toBeVisible()

    await user.click(selectAll)
    expect(selectAll).toBeChecked()
    expect(screen.getByText('2 Threads selecionadas')).toBeVisible()
  })

  it('clears stale bulk selection and keeps the detail fallback when history changes', async () => {
    const user = userEvent.setup()
    const removed = thread(
      'removed',
      'completed',
      '2026-01-02T00:00:02Z',
      'Será removida'
    )
    const remaining = thread(
      'remaining',
      'completed',
      '2026-01-01T00:00:01Z',
      'Permanece'
    )
    const { rerender } = render(
      <HistoryView
        providers={providers}
        history={[remaining, removed]}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn()}
      />
    )

    await user.click(
      screen.getByRole('checkbox', {
        name: 'Selecionar Thread: Será removida'
      })
    )
    await user.click(
      screen.getByRole('button', { name: 'Excluir selecionadas' })
    )
    expect(
      screen.getByRole('dialog', { name: 'Excluir 1 Thread?' })
    ).toBeVisible()

    rerender(
      <HistoryView
        providers={providers}
        history={[remaining]}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn()}
      />
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByText('1 Thread selecionada')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Permanece' })).toBeVisible()
  })
})
