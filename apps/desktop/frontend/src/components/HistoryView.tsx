import { useEffect, useMemo, useRef, useState } from 'react'
import { errorMessage } from '../api/client'
import type { InteractionRow, ProviderDefinition } from '../api/contracts'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { getInteractionStatusPresentation } from '../ui/status'
import { Conversation } from './Conversation'
import { HistoryIcon, TrashIcon } from './Icons'

const deletableStatuses = new Set(['completed', 'failed', 'expired'])

function interactionSummary(interaction: InteractionRow): string {
  const summary =
    interaction.renderedInstructions?.trim() ||
    interaction.messages
      .find((message) => message.role === 'user')
      ?.content.trim()
  if (!summary) return 'Thread iniciada'
  const firstLine = summary.split(/\r?\n/, 1)[0]
  return firstLine.length > 110 ? `${firstLine.slice(0, 109)}…` : firstLine
}

export function HistoryView({
  history,
  providers,
  onDelete,
  onDeleteMany
}: {
  history: InteractionRow[]
  providers: ProviderDefinition[]
  onDelete: (interactionId: string) => Promise<void>
  onDeleteMany: (interactionIds: string[]) => Promise<void>
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
  const [threadToDelete, setThreadToDelete] = useState<InteractionRow | null>(
    null
  )
  const [selectedForDeletion, setSelectedForDeletion] = useState<Set<string>>(
    () => new Set()
  )
  const [bulkConfirmationOpen, setBulkConfirmationOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selectAllRef = useRef<HTMLInputElement>(null)
  const deletableIds = useMemo(
    () =>
      sorted
        .filter((interaction) => deletableStatuses.has(interaction.status))
        .map((interaction) => interaction.interactionId),
    [sorted]
  )
  const selectedDeletionIds = deletableIds.filter((id) =>
    selectedForDeletion.has(id)
  )
  const allDeletableSelected =
    deletableIds.length > 0 &&
    selectedDeletionIds.length === deletableIds.length
  const someDeletableSelected = selectedDeletionIds.length > 0
  const selected =
    sorted.find((interaction) => interaction.interactionId === selectedId) ??
    sorted[0]
  const providerLabel = (id: string) =>
    providers.find((provider) => provider.id === id)?.label ?? id

  useEffect(() => {
    setSelectedId((current) => {
      if (
        current &&
        sorted.some(({ interactionId }) => interactionId === current)
      )
        return current
      return sorted[0]?.interactionId ?? null
    })
  }, [sorted])

  useEffect(() => {
    const allowed = new Set(deletableIds)
    setSelectedForDeletion((current) => {
      const next = new Set([...current].filter((id) => allowed.has(id)))
      if (
        next.size === current.size &&
        [...next].every((id) => current.has(id))
      )
        return current
      return next
    })
  }, [deletableIds])

  useEffect(() => {
    if (selectAllRef.current)
      selectAllRef.current.indeterminate =
        someDeletableSelected && !allDeletableSelected
  }, [allDeletableSelected, someDeletableSelected])

  useEffect(() => {
    if (!someDeletableSelected) setBulkConfirmationOpen(false)
  }, [someDeletableSelected])

  const confirmDeletion = async () => {
    if (!threadToDelete) return
    setDeleting(true)
    setError(null)
    try {
      await onDelete(threadToDelete.interactionId)
      setSelectedForDeletion((current) => {
        const next = new Set(current)
        next.delete(threadToDelete.interactionId)
        return next
      })
      setThreadToDelete(null)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setDeleting(false)
    }
  }

  const confirmBulkDeletion = async () => {
    if (!selectedDeletionIds.length) return
    setDeleting(true)
    setError(null)
    try {
      await onDeleteMany(selectedDeletionIds)
      setSelectedForDeletion(new Set())
      setBulkConfirmationOpen(false)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setDeleting(false)
    }
  }

  const toggleThreadSelection = (interactionId: string, checked: boolean) => {
    setSelectedForDeletion((current) => {
      const next = new Set(current)
      if (checked) next.add(interactionId)
      else next.delete(interactionId)
      return next
    })
  }

  const bulkCountLabel = `${selectedDeletionIds.length.toLocaleString('pt-BR')} ${
    selectedDeletionIds.length === 1
      ? 'Thread selecionada'
      : 'Threads selecionadas'
  }`

  return (
    <section className="page" aria-labelledby="history-title">
      <header className="page-header">
        <div>
          <span className="eyebrow">Arquivo local</span>
          <h1 id="history-title">Threads</h1>
          <p>
            Revise prompts enviados, respostas importadas, valores de tags
            extraídos e avisos de análise.
          </p>
        </div>
      </header>
      {error ? (
        <div className="inline-alert inline-alert--error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="history-layout">
        {sorted.length ? (
          <>
            <aside className="card history-list" aria-label="Threads">
              <div className="history-selection-panel">
                <div className="history-selection-toolbar">
                  <label>
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={allDeletableSelected}
                      disabled={!deletableIds.length || deleting}
                      onChange={(event) =>
                        setSelectedForDeletion(
                          event.target.checked
                            ? new Set(deletableIds)
                            : new Set()
                        )
                      }
                    />
                    <span>Selecionar Threads finalizadas</span>
                  </label>
                  <small>
                    {deletableIds.length.toLocaleString('pt-BR')}{' '}
                    {deletableIds.length === 1 ? 'disponível' : 'disponíveis'}
                  </small>
                </div>
                {someDeletableSelected ? (
                  <div
                    className="history-selection-action"
                    role="status"
                    aria-live="polite"
                  >
                    <strong>{bulkCountLabel}</strong>
                    <button
                      className="button button--danger"
                      type="button"
                      disabled={deleting}
                      onClick={() => setBulkConfirmationOpen(true)}
                    >
                      <TrashIcon /> Excluir selecionadas
                    </button>
                  </div>
                ) : null}
              </div>
              {sorted.map((interaction) => {
                const status = getInteractionStatusPresentation(
                  interaction.status
                )
                const deletable = deletableStatuses.has(interaction.status)
                const checked = selectedForDeletion.has(
                  interaction.interactionId
                )
                const summary = interactionSummary(interaction)
                return (
                  <div
                    className={
                      selected?.interactionId === interaction.interactionId
                        ? 'history-list__row is-current'
                        : checked
                          ? 'history-list__row is-checked'
                          : 'history-list__row'
                    }
                    key={interaction.interactionId}
                  >
                    <label
                      className="history-list__check"
                      title={
                        deletable
                          ? `Selecionar Thread: ${summary}`
                          : 'Apenas Threads concluídas, com falha ou expiradas podem ser selecionadas.'
                      }
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!deletable || deleting}
                        aria-label={`Selecionar Thread: ${summary}`}
                        onChange={(event) =>
                          toggleThreadSelection(
                            interaction.interactionId,
                            event.target.checked
                          )
                        }
                      />
                    </label>
                    <button
                      className="history-list__item-button"
                      type="button"
                      aria-current={
                        selected?.interactionId === interaction.interactionId
                          ? 'true'
                          : undefined
                      }
                      onClick={() => setSelectedId(interaction.interactionId)}
                    >
                      <div>
                        <strong>{providerLabel(interaction.providerId)}</strong>
                        <span className={`status status--${status.tone}`}>
                          {status.label}
                        </span>
                      </div>
                      <p>{summary}</p>
                      <small>
                        {new Date(interaction.createdAt).toLocaleString(
                          'pt-BR'
                        )}{' '}
                        · {interaction.messages.length}{' '}
                        {interaction.messages.length === 1
                          ? 'mensagem'
                          : 'mensagens'}
                      </small>
                    </button>
                  </div>
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
                        {new Date(selected.createdAt).toLocaleString('pt-BR')}
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
                          ? 'Tamanho do prompt não registrado'
                          : `${selected.promptBytes.toLocaleString('pt-BR')} bytes`}{' '}
                        · {selected.documentIds?.length ?? 0}{' '}
                        {(selected.documentIds?.length ?? 0) === 1
                          ? 'documento'
                          : 'documentos'}
                      </small>
                      {!someDeletableSelected ? (
                        <button
                          className="button button--secondary"
                          type="button"
                          disabled={!deletableStatuses.has(selected.status)}
                          title={
                            deletableStatuses.has(selected.status)
                              ? 'Excluir Thread'
                              : 'Aguarde a Thread ser concluída, falhar ou expirar para excluí-la.'
                          }
                          onClick={() => setThreadToDelete(selected)}
                        >
                          <TrashIcon /> Excluir Thread
                        </button>
                      ) : null}
                    </div>
                  </header>
                  <Conversation interaction={selected} />
                </>
              ) : (
                <div className="empty-state">
                  <strong>Thread indisponível</strong>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="card empty-state history-empty">
            <HistoryIcon />
            <strong>Nenhuma Thread ainda</strong>
            <p>
              Abra um provedor pelo Chat. Os prompts enviados e as respostas
              importadas serão armazenados aqui.
            </p>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={threadToDelete !== null}
        title="Excluir Thread?"
        description="A Thread, suas mensagens, tags extraídas e avisos serão removidos permanentemente. Os documentos e arquivos locais não serão apagados."
        confirmLabel="Excluir Thread"
        cancelLabel="Cancelar"
        danger
        busy={deleting}
        onConfirm={() => void confirmDeletion()}
        onCancel={() => setThreadToDelete(null)}
      />
      <ConfirmDialog
        open={bulkConfirmationOpen}
        title={
          selectedDeletionIds.length === 1
            ? 'Excluir 1 Thread?'
            : `Excluir ${selectedDeletionIds.length.toLocaleString('pt-BR')} Threads?`
        }
        description={
          selectedDeletionIds.length === 1
            ? 'A Thread selecionada, suas mensagens, tags extraídas e avisos serão removidos permanentemente. Os documentos e arquivos locais não serão apagados.'
            : `As ${selectedDeletionIds.length.toLocaleString('pt-BR')} Threads selecionadas, suas mensagens, tags extraídas e avisos serão removidos permanentemente. Os documentos e arquivos locais não serão apagados.`
        }
        confirmLabel={
          selectedDeletionIds.length === 1
            ? 'Excluir 1 Thread'
            : `Excluir ${selectedDeletionIds.length.toLocaleString('pt-BR')} Threads`
        }
        cancelLabel="Cancelar"
        danger
        busy={deleting}
        onConfirm={() => void confirmBulkDeletion()}
        onCancel={() => setBulkConfirmationOpen(false)}
      />
    </section>
  )
}
