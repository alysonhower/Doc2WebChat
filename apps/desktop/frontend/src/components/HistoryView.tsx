import { useMemo, useState } from 'react'
import type { InteractionRow, ProviderDefinition } from '../api/contracts'
import { getInteractionStatusPresentation } from '../ui/status'
import { Conversation } from './Conversation'
import { HistoryIcon } from './Icons'

function interactionSummary(interaction: InteractionRow): string {
  const summary =
    interaction.renderedInstructions?.trim() ||
    interaction.messages
      .find((message) => message.role === 'user')
      ?.content.trim()
  if (!summary) return 'Interaction started'
  const firstLine = summary.split(/\r?\n/, 1)[0]
  return firstLine.length > 110 ? `${firstLine.slice(0, 109)}…` : firstLine
}

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
        {sorted.length ? (
          <>
            <aside className="card history-list" aria-label="Conversations">
              {sorted.map((interaction) => {
                const status = getInteractionStatusPresentation(
                  interaction.status
                )
                return (
                  <button
                    type="button"
                    className={
                      selected?.interactionId === interaction.interactionId
                        ? 'is-selected'
                        : ''
                    }
                    aria-current={
                      selected?.interactionId === interaction.interactionId
                        ? 'true'
                        : undefined
                    }
                    key={interaction.interactionId}
                    onClick={() => setSelectedId(interaction.interactionId)}
                  >
                    <div>
                      <strong>{providerLabel(interaction.providerId)}</strong>
                      <span className={`status status--${status.tone}`}>
                        {status.label}
                      </span>
                    </div>
                    <p>{interactionSummary(interaction)}</p>
                    <small>
                      {new Date(interaction.createdAt).toLocaleString()} ·{' '}
                      {interaction.messages.length}{' '}
                      {interaction.messages.length === 1
                        ? 'message'
                        : 'messages'}
                    </small>
                  </button>
                )
              })}
            </aside>
            <div className="card history-detail">
              {selected ? (
                <>
                  <header>
                    <div>
                      <span className="eyebrow">
                        {providerLabel(selected.providerId)}
                      </span>
                      <h2>{interactionSummary(selected)}</h2>
                      <small className="history-detail__date">
                        {new Date(selected.createdAt).toLocaleString()}
                      </small>
                    </div>
                    <div>
                      <span
                        className={`status status--${getInteractionStatusPresentation(selected.status).tone}`}
                      >
                        {
                          getInteractionStatusPresentation(selected.status)
                            .label
                        }
                      </span>
                      <small>
                        {selected.promptBytes === undefined
                          ? 'Prompt size not recorded'
                          : `${selected.promptBytes.toLocaleString()} bytes`}{' '}
                        · {selected.documentIds?.length ?? 0}{' '}
                        {(selected.documentIds?.length ?? 0) === 1
                          ? 'document'
                          : 'documents'}
                      </small>
                    </div>
                  </header>
                  <Conversation interaction={selected} />
                </>
              ) : (
                <div className="empty-state">
                  <strong>Conversation unavailable</strong>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="card empty-state history-empty">
            <HistoryIcon />
            <strong>No conversations yet</strong>
            <p>
              Open a provider from Chat. Dispatched prompts and imported
              responses will be stored here.
            </p>
          </div>
        )}
      </div>
    </section>
  )
}
