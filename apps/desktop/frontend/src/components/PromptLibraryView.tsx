import { useMemo, useState } from 'react'
import { errorMessage, invoke } from '../api/client'
import type { PromptRow } from '../api/contracts'
import {
  clonePrompt,
  emptyStructuredPrompt,
  promptEquals
} from '../structured/model'
import type { StructuredPrompt } from '../structured/types'
import { StructuredPromptEditor } from '../structured/StructuredPromptEditor'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { LibraryIcon, TrashIcon } from './Icons'

interface PromptLibraryViewProps {
  prompts: PromptRow[]
  onPromptsChange: (prompts: PromptRow[]) => void
}

interface Draft {
  id?: number
  name: string
  persistedName: string
  document: StructuredPrompt
  baseline: StructuredPrompt
}

interface ConfirmationState {
  kind: 'discard' | 'delete'
  action: () => void
}

const newDraft = (): Draft => {
  const document = emptyStructuredPrompt()
  return {
    name: 'Prompt sem título',
    persistedName: '',
    document,
    baseline: clonePrompt(document)
  }
}

export function PromptLibraryView({
  prompts,
  onPromptsChange
}: PromptLibraryViewProps) {
  const [draft, setDraft] = useState<Draft>(newDraft)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<ConfirmationState | null>(
    null
  )
  const dirty =
    !draft.id ||
    draft.name !== draft.persistedName ||
    !promptEquals(draft.document, draft.baseline)
  const newDraftHasEdits =
    !draft.id &&
    (draft.name !== 'Prompt sem título' ||
      !promptEquals(draft.document, draft.baseline))
  const shouldConfirmDiscard = draft.id ? dirty : newDraftHasEdits
  const sortedPrompts = useMemo(
    () => [...prompts].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
    [prompts]
  )

  const refresh = async () => {
    const value = await invoke((api) => api.list_prompts())
    onPromptsChange(Array.isArray(value) ? value : value.prompts)
  }

  const selectPrompt = async (promptId: number) => {
    if (promptId === selectedId || busy) return
    setBusy(true)
    setError(null)
    try {
      const { prompt } = await invoke((api) => api.load_prompt({ promptId }))
      const document = clonePrompt(prompt.document ?? emptyStructuredPrompt())
      setSelectedId(prompt.id)
      setDraft({
        id: prompt.id,
        name: prompt.name,
        persistedName: prompt.name,
        document,
        baseline: clonePrompt(document)
      })
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const requestSelectPrompt = (promptId: number) => {
    if (promptId === selectedId || busy) return
    if (shouldConfirmDiscard) {
      setConfirmation({
        kind: 'discard',
        action: () => void selectPrompt(promptId)
      })
      return
    }
    void selectPrompt(promptId)
  }

  const create = () => {
    if (busy) return
    setSelectedId(null)
    setDraft(newDraft())
    setError(null)
  }

  const requestCreate = () => {
    if (busy) return
    if (shouldConfirmDiscard) {
      setConfirmation({ kind: 'discard', action: create })
      return
    }
    create()
  }

  const save = async () => {
    if (!draft.name.trim()) {
      setError('Prompt name is required.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { prompt } = await invoke((api) =>
        api.save_prompt({
          promptId: draft.id,
          name: draft.name.trim(),
          document: draft.document
        })
      )
      const document = clonePrompt(prompt.document ?? draft.document)
      setSelectedId(prompt.id)
      setDraft({
        id: prompt.id,
        name: prompt.name,
        persistedName: prompt.name,
        document,
        baseline: clonePrompt(document)
      })
      await refresh()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!draft.id || busy) return
    setBusy(true)
    setError(null)
    try {
      await invoke((api) => api.delete_prompt({ promptId: draft.id! }))
      setSelectedId(null)
      setDraft(newDraft())
      await refresh()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const requestRemove = () => {
    if (!draft.id || busy) return
    setConfirmation({ kind: 'delete', action: () => void remove() })
  }

  const confirmAction = () => {
    const action = confirmation?.action
    setConfirmation(null)
    action?.()
  }

  return (
    <section className="page" aria-labelledby="prompts-title">
      <header className="page-header">
        <div>
          <span className="eyebrow">Instruções reutilizáveis</span>
          <h1 id="prompts-title">Biblioteca de Prompts</h1>
          <p>
            Crie prompts estruturados com tags de resposta aninhadas e use-os em
            qualquer Chat no navegador.
          </p>
        </div>
        <button
          className="button button--primary"
          type="button"
          disabled={busy}
          onClick={requestCreate}
        >
          Novo prompt
        </button>
      </header>
      <div className="prompt-layout">
        <aside className="card prompt-list" aria-label="Prompts salvos">
          <div className="prompt-list__heading">
            <strong>Prompts salvos</strong>
            <span>{prompts.length}</span>
          </div>
          {sortedPrompts.length ? (
            sortedPrompts.map((prompt) => (
              <button
                type="button"
                className={selectedId === prompt.id ? 'is-selected' : ''}
                key={prompt.id}
                disabled={busy}
                onClick={() => requestSelectPrompt(prompt.id)}
              >
                <LibraryIcon />
                <span>
                  <strong>{prompt.name}</strong>
                  <small>
                    {prompt.updatedAt
                      ? `Atualizado em ${new Date(prompt.updatedAt).toLocaleDateString('pt-BR')}`
                      : 'Prompt salvo'}
                  </small>
                </span>
              </button>
            ))
          ) : (
            <div className="empty-state empty-state--small">
              <LibraryIcon />
              <strong>Nenhum prompt salvo</strong>
              <p>Crie sua primeira instrução reutilizável.</p>
            </div>
          )}
        </aside>
        <div className="card prompt-editor-card" aria-busy={busy}>
          <div className="prompt-toolbar">
            <div className="prompt-name-field">
              <label htmlFor="prompt-name">Nome do prompt</label>
              <input
                id="prompt-name"
                value={draft.name}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    name: event.target.value
                  }))
                }
              />
            </div>
            <div>
              {draft.id ? (
                <button
                  className="icon-button icon-button--danger"
                  type="button"
                  title="Excluir prompt"
                  aria-label="Excluir prompt"
                  disabled={busy}
                  onClick={requestRemove}
                >
                  <TrashIcon />
                </button>
              ) : null}
              <button
                className="button button--primary"
                type="button"
                disabled={
                  busy || !draft.name.trim() || (!dirty && Boolean(draft.id))
                }
                onClick={() => void save()}
              >
                {busy ? 'Salvando…' : 'Salvar alterações'}
              </button>
            </div>
          </div>
          {!draft.id ? (
            <div className="draft-indicator">
              <span />
              Não salvo
            </div>
          ) : dirty ? (
            <div className="draft-indicator">
              <span />
              Alterações não salvas
            </div>
          ) : (
            <div className="draft-indicator draft-indicator--saved">
              <span />
              Salvo
            </div>
          )}
          <StructuredPromptEditor
            value={draft.document}
            onChange={(document) =>
              setDraft((current) => ({ ...current, document }))
            }
          />
          {error ? (
            <div className="inline-alert inline-alert--error" role="alert">
              {error}
            </div>
          ) : null}
        </div>
      </div>
      <ConfirmDialog
        open={confirmation !== null}
        title={
          confirmation?.kind === 'delete'
            ? `Excluir “${draft.persistedName}”?`
            : 'Descartar alterações não salvas?'
        }
        description={
          confirmation?.kind === 'delete'
            ? dirty
              ? 'Este prompt e suas alterações não salvas serão excluídos permanentemente.'
              : 'Este prompt será excluído permanentemente. Esta ação não pode ser desfeita.'
            : 'As alterações feitas neste prompt serão perdidas.'
        }
        confirmLabel={
          confirmation?.kind === 'delete'
            ? 'Excluir prompt'
            : 'Descartar alterações'
        }
        danger={confirmation?.kind === 'delete'}
        busy={busy}
        onCancel={() => setConfirmation(null)}
        onConfirm={confirmAction}
      />
    </section>
  )
}
