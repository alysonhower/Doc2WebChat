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
    name: 'Untitled prompt',
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
    (draft.name !== 'Untitled prompt' ||
      !promptEquals(draft.document, draft.baseline))
  const shouldConfirmDiscard = draft.id ? dirty : newDraftHasEdits
  const sortedPrompts = useMemo(
    () => [...prompts].sort((a, b) => a.name.localeCompare(b.name)),
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
          <span className="eyebrow">Reusable instructions</span>
          <h1 id="prompts-title">Prompt Library</h1>
          <p>
            Build structured prompts with nested response tags, then load them
            into any browser chat.
          </p>
        </div>
        <button
          className="button button--primary"
          type="button"
          disabled={busy}
          onClick={requestCreate}
        >
          New prompt
        </button>
      </header>
      <div className="prompt-layout">
        <aside className="card prompt-list" aria-label="Saved prompts">
          <div className="prompt-list__heading">
            <strong>Saved prompts</strong>
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
                      ? `Updated ${new Date(prompt.updatedAt).toLocaleDateString()}`
                      : 'Saved prompt'}
                  </small>
                </span>
              </button>
            ))
          ) : (
            <div className="empty-state empty-state--small">
              <LibraryIcon />
              <strong>No saved prompts</strong>
              <p>Create your first reusable instruction.</p>
            </div>
          )}
        </aside>
        <div className="card prompt-editor-card" aria-busy={busy}>
          <div className="prompt-toolbar">
            <div className="prompt-name-field">
              <label htmlFor="prompt-name">Prompt name</label>
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
                  title="Delete prompt"
                  aria-label="Delete prompt"
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
                {busy ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </div>
          {!draft.id ? (
            <div className="draft-indicator">
              <span />
              Not saved
            </div>
          ) : dirty ? (
            <div className="draft-indicator">
              <span />
              Unsaved changes
            </div>
          ) : (
            <div className="draft-indicator draft-indicator--saved">
              <span />
              Saved
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
            ? `Delete “${draft.persistedName}”?`
            : 'Discard unsaved changes?'
        }
        description={
          confirmation?.kind === 'delete'
            ? dirty
              ? 'This prompt and its unsaved changes will be permanently deleted.'
              : 'This prompt will be permanently deleted. This cannot be undone.'
            : 'Your edits to this prompt will be lost.'
        }
        confirmLabel={
          confirmation?.kind === 'delete' ? 'Delete prompt' : 'Discard changes'
        }
        danger={confirmation?.kind === 'delete'}
        busy={busy}
        onCancel={() => setConfirmation(null)}
        onConfirm={confirmAction}
      />
    </section>
  )
}
