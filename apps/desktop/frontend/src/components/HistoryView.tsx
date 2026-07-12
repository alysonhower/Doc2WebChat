import { useMemo, useState } from 'react'
import type { InteractionRow, ProviderDefinition } from '../api/contracts'
import { Conversation } from './Conversation'
import { HistoryIcon } from './Icons'

export function HistoryView({
  history,
  providers
}: {
  history: InteractionRow[]
  providers: ProviderDefinition[]
}) {
  const sorted = useMemo(
    () =>
      [...history].sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      ),
    [history]
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected =
    sorted.find((interaction) => interaction.interactionId === selectedId) ??
    sorted[0]
  const providerLabel = (id: string) =>
    providers.find((provider) => provider.id === id)?.label ?? id

  return (
    <section className="page" aria-labelledby="history-title">
      <header className="page-header">
        <div>
          <span className="eyebrow">Local archive</span>
          <h1 id="history-title">Conversation History</h1>
          <p>
            Review dispatched prompts, imported responses, extracted tag values,
            and parsing warnings.
          </p>
        </div>
      </header>
      <div className="history-layout">
        <aside className="card history-list" aria-label="Conversations">
          {sorted.length ? (
            sorted.map((interaction) => (
              <button
                type="button"
                className={
                  selected?.interactionId === interaction.interactionId
                    ? 'is-selected'
                    : ''
                }
                key={interaction.interactionId}
                onClick={() => setSelectedId(interaction.interactionId)}
              >
                <div>
                  <strong>{providerLabel(interaction.providerId)}</strong>
                  <span className={`status status--${interaction.status}`}>
                    {interaction.status}
                  </span>
                </div>
                <p>
                  {interaction.messages
                    .find((message) => message.role === 'user')
                    ?.content.slice(0, 110) || 'Interaction started'}
                </p>
                <small>
                  {new Date(interaction.createdAt).toLocaleString()} ·{' '}
                  {interaction.messages.length} messages
                </small>
              </button>
            ))
          ) : (
            <div className="empty-state">
              <HistoryIcon />
              <strong>No conversations yet</strong>
              <p>Browser chats will be stored here.</p>
            </div>
          )}
        </aside>
        <div className="card history-detail">
          {selected ? (
            <>
              <header>
                <div>
                  <span className="eyebrow">
                    {providerLabel(selected.providerId)}
                  </span>
                  <h2>{new Date(selected.createdAt).toLocaleString()}</h2>
                </div>
                <div>
                  <span className={`status status--${selected.status}`}>
                    {selected.status}
                  </span>
                  <small>
                    {selected.promptBytes?.toLocaleString() ?? '—'} bytes ·{' '}
                    {selected.documentIds?.length ?? 0} documents
                  </small>
                </div>
              </header>
              <Conversation interaction={selected} />
            </>
          ) : (
            <div className="empty-state">
              <strong>Select a conversation</strong>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
