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
  const dirty =
    draft.name !== (draft.id ? draft.persistedName : 'Untitled prompt') ||
    !promptEquals(draft.document, draft.baseline)
  const sortedPrompts = useMemo(
    () => [...prompts].sort((a, b) => a.name.localeCompare(b.name)),
    [prompts]
  )

  const confirmDiscard = () =>
    !dirty || window.confirm('Discard unsaved prompt changes?')

  const refresh = async () => {
    const value = await invoke((api) => api.list_prompts())
    onPromptsChange(Array.isArray(value) ? value : value.prompts)
  }

  const selectPrompt = async (promptId: number) => {
    if (promptId === selectedId || !confirmDiscard()) return
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

  const create = () => {
    if (!confirmDiscard()) return
    setSelectedId(null)
    setDraft(newDraft())
    setError(null)
  }

  const save = async () => {
    if (!draft.name.trim()) {
      setError('Prompt name is required.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const name = draft.id ? draft.persistedName : draft.name.trim()
      const { prompt } = await invoke((api) =>
        api.save_prompt({
          promptId: draft.id,
          name,
          document: draft.document
        })
      )
      const document = clonePrompt(prompt.document ?? draft.document)
      const draftName = draft.id ? draft.name : prompt.name
      setSelectedId(prompt.id)
      setDraft({
        id: prompt.id,
        name: draftName,
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

  const rename = async () => {
    if (
      !draft.id ||
      !draft.name.trim() ||
      draft.name.trim() === draft.persistedName
    )
      return
    setBusy(true)
    setError(null)
    try {
      const { prompt } = await invoke((api) =>
        api.rename_prompt({ promptId: draft.id!, name: draft.name.trim() })
      )
      setDraft((current) => ({
        ...current,
        name: prompt.name,
        persistedName: prompt.name
      }))
      await refresh()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (
      !draft.id ||
      !confirmDiscard() ||
      !window.confirm(`Delete “${draft.persistedName}”?`)
    )
      return
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
          onClick={create}
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
                onClick={() => void selectPrompt(prompt.id)}
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
                  className="button button--secondary"
                  type="button"
                  disabled={
                    busy ||
                    draft.name.trim() === draft.persistedName ||
                    !draft.name.trim()
                  }
                  onClick={() => void rename()}
                >
                  Rename
                </button>
              ) : null}
              {draft.id ? (
                <button
                  className="icon-button icon-button--danger"
                  type="button"
                  title="Delete prompt"
                  aria-label="Delete prompt"
                  disabled={busy}
                  onClick={() => void remove()}
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
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
          {dirty ? (
            <div className="draft-indicator">
              <span />
              Unsaved draft
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
    </section>
  )
}
