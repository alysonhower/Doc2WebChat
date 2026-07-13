import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { Conversation } from './Conversation'

describe('Conversation', () => {
  it('renders response markup as inert text and messages chronologically', () => {
    render(
      <Conversation
        interaction={{
          interactionId: 'interaction',
          providerId: 'open-webui',
          status: 'completed',
          createdAt: '2026-01-01T00:00:00Z',
          messages: [
            {
              id: 2,
              role: 'assistant',
              content: '<img src=x onerror="alert(1)">response',
              createdAt: '2026-01-01T00:00:02Z'
            },
            {
              id: 1,
              role: 'user',
              content: 'prompt',
              createdAt: '2026-01-01T00:00:01Z'
            }
          ]
        }}
      />
    )
    expect(document.querySelector('img')).toBeNull()
    expect(
      screen.getByText('<img src=x onerror="alert(1)">response')
    ).toBeInTheDocument()
    const messages = screen.getAllByTestId(/message-/)
    expect(messages[0]).toHaveTextContent('prompt')
    expect(messages[1]).toHaveTextContent('response')
  })

  it('summarizes the outgoing prompt before progressively revealing raw text', async () => {
    const user = userEvent.setup()
    const prompt = 'p'.repeat(20_000)
    render(
      <Conversation
        interaction={{
          interactionId: 'interaction',
          providerId: 'open-webui',
          status: 'awaiting-import',
          createdAt: '2026-01-01T00:00:00Z',
          renderedInstructions: 'Compare the documents.',
          promptBytes: 20_000,
          documentIds: [2, 7],
          messages: [
            {
              id: 1,
              role: 'user',
              content: prompt,
              createdAt: '2026-01-01T00:00:01Z'
            }
          ]
        }}
      />
    )

    const summary = screen.getByLabelText('Resumo do prompt enviado')
    expect(summary).toHaveTextContent('Compare the documents.')
    expect(summary).toHaveTextContent('20.000 bytes')
    expect(summary).toHaveTextContent('Documentos 2, 7')
    const content = screen.getByTestId('progressive-content-1')
    expect(content.textContent).toHaveLength(1_200)
    await user.click(screen.getByRole('button', { name: /mostrar mais/i }))
    expect(content.textContent).toHaveLength(9_200)
    expect(screen.getByRole('button', { name: /mostrar tudo/i })).toBeVisible()
    expect(
      summary.compareDocumentPosition(content) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('limits long assistant responses and omits Mostrar tudo above 100,000 characters', async () => {
    const user = userEvent.setup()
    render(
      <Conversation
        interaction={{
          interactionId: 'interaction',
          providerId: 'open-webui',
          status: 'completed',
          createdAt: '2026-01-01T00:00:00Z',
          messages: [
            {
              id: 9,
              role: 'assistant',
              content: 'a'.repeat(100_001),
              createdAt: '2026-01-01T00:00:01Z'
            }
          ]
        }}
      />
    )

    const content = screen.getByTestId('progressive-content-9')
    expect(content.textContent).toHaveLength(4_000)
    expect(screen.queryByRole('button', { name: /mostrar tudo/i })).toBeNull()
    await user.click(screen.getByRole('button', { name: /mostrar mais/i }))
    expect(content.textContent).toHaveLength(12_000)
  })

  it('renders extracted values as a parent-child tree and warnings separately', () => {
    render(
      <Conversation
        interaction={{
          interactionId: 'interaction',
          providerId: 'open-webui',
          status: 'completed',
          createdAt: '2026-01-01T00:00:00Z',
          messages: [
            {
              id: 5,
              role: 'assistant',
              content: 'response',
              createdAt: '2026-01-01T00:00:01Z',
              tagValues: [
                { name: 'result', raw: 'raw', trimmed: 'parent' },
                {
                  name: 'source',
                  raw: 'raw',
                  trimmed: 'child',
                  parentIndex: 0
                }
              ],
              warnings: [
                {
                  code: 'missing-child',
                  message: 'Tag <result> is missing child <source>',
                  tagName: 'source',
                  parentIndex: 0
                }
              ]
            }
          ]
        }}
      />
    )

    const parent = screen.getByTestId('tag-value-0')
    const child = screen.getByTestId('tag-value-1')
    expect(
      parent.compareDocumentPosition(child) &
        Node.DOCUMENT_POSITION_CONTAINED_BY
    ).toBeTruthy()
    expect(
      screen.getByRole('region', { name: 'Avisos da resposta' })
    ).toHaveTextContent('Dentro de @result')
    expect(screen.getByText(/não contém a tag filha <source>/)).toBeVisible()
  })

  it('uses an actionable lifecycle label instead of a raw status', () => {
    render(
      <Conversation
        interaction={{
          interactionId: 'interaction',
          providerId: 'open-webui',
          status: 'awaiting-import',
          createdAt: '2026-01-01T00:00:00Z',
          messages: []
        }}
      />
    )
    expect(screen.getByText('Pronta para importar')).toBeInTheDocument()
    expect(screen.queryByText('awaiting-import')).toBeNull()
  })
})
