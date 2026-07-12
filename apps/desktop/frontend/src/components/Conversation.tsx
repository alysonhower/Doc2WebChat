import type { InteractionRow, MessageRow } from '../api/contracts'

function Message({ message }: { message: MessageRow }) {
  return (
    <article
      className={`message message--${message.role}`}
      data-testid={`message-${message.id}`}
    >
      <header>
        <span>{message.role === 'assistant' ? 'Browser response' : 'You'}</span>
        <time dateTime={message.createdAt}>
          {new Date(message.createdAt).toLocaleString()}
        </time>
      </header>
      <div className="message__content">{message.content}</div>
      {message.tagValues?.length ? (
        <div className="tag-results">
          {message.tagValues.map((value, index) => (
            <div
              className="tag-result"
              key={value.id ?? `${value.name}-${index}`}
            >
              <span>@{value.name}</span>
              <p>{value.trimmed}</p>
            </div>
          ))}
        </div>
      ) : null}
      {message.warnings?.length ? (
        <ul className="message-warnings">
          {message.warnings.map((warning, index) => (
            <li key={`${warning.code}-${index}`}>{warning.message}</li>
          ))}
        </ul>
      ) : null}
    </article>
  )
}

export function Conversation({
  interaction,
  emptyText = 'No messages yet.'
}: {
  interaction?: InteractionRow
  emptyText?: string
}) {
  if (!interaction)
    return (
      <div className="empty-state empty-state--conversation">
        <strong>{emptyText}</strong>
        <p>A dispatched prompt and imported response will appear here.</p>
      </div>
    )
  const messages = [...interaction.messages].sort(
    (a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
      a.id - b.id
  )
  return (
    <div className="conversation" aria-live="polite">
      {messages.map((message) => (
        <Message key={message.id} message={message} />
      ))}
      {interaction.status !== 'completed' && interaction.status !== 'failed' ? (
        <div className="waiting-response">
          <span />
          <span />
          <span /> <p>{interaction.status}</p>
        </div>
      ) : null}
    </div>
  )
}
