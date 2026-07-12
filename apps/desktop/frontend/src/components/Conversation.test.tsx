import { render, screen } from '@testing-library/react'
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
})
