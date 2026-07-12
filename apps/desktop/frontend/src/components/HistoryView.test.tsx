import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { HistoryView } from './HistoryView'

const providers = [
  {
    id: 'open-webui',
    label: 'Open WebUI',
    canonicalUrl: 'http://localhost:3000',
    controls: {}
  }
]

describe('HistoryView', () => {
  it('shows a useful empty state without an orphan selection prompt', () => {
    render(<HistoryView history={[]} providers={providers} />)
    expect(screen.getByText('No conversations yet')).toBeInTheDocument()
    expect(screen.queryByText('Select a conversation')).toBeNull()
  })

  it('sorts newest first, uses friendly labels, and changes selection', async () => {
    const user = userEvent.setup()
    render(
      <HistoryView
        providers={providers}
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
    expect(items[0]).toHaveTextContent('Ready to import')
    expect(screen.getByRole('heading', { name: /Newer prompt/i })).toBeVisible()
    await user.click(items[1])
    expect(screen.getByRole('heading', { name: /Older prompt/i })).toBeVisible()
    expect(screen.getAllByText('Imported').length).toBeGreaterThan(0)
  })
})
