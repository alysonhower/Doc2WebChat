import { useEffect, useMemo, useState } from 'react'
import {
  emptyDocument,
  isValidTagName,
  occurrenceInfo,
  occurrenceRoles,
  renameOccurrence,
  serializeStructuredPrompt,
  withDocument
} from './model'
import { InstructionEditor } from './InstructionEditor'
import type { StructuredPrompt } from './types'

export interface StructuredPromptEditorProps {
  value: StructuredPrompt
  onChange: (value: StructuredPrompt) => void
  compact?: boolean
}

export function StructuredPromptEditor({
  value,
  onChange,
  compact = false
}: StructuredPromptEditorProps) {
  const occurrences = useMemo(() => occurrenceInfo(value), [value])
  const roles = useMemo(() => occurrenceRoles(value), [value])
  const knownNames = useMemo(
    () =>
      [
        ...new Set([
          ...Object.keys(value.definitions),
          ...occurrences.map(({ name }) => name)
        ])
      ].sort(),
    [occurrences, value.definitions]
  )
  const [selected, setSelected] = useState<{
    occurrenceId: string
    name: string
  } | null>(null)
  const [renameValue, setRenameValue] = useState('')

  useEffect(() => {
    if (!selected) return
    const current = occurrences.find(
      ({ occurrenceId }) => occurrenceId === selected.occurrenceId
    )
    if (!current) setSelected(null)
    else if (current.name !== selected.name)
      setSelected({ ...selected, name: current.name })
  }, [occurrences, selected])

  useEffect(() => setRenameValue(selected?.name ?? ''), [selected])

  const selectTag = (occurrenceId: string, name: string) =>
    setSelected({ occurrenceId, name })
  const selectedName = selected?.name ?? null
  const selectedDefinition = selectedName
    ? (value.definitions[selectedName] ?? null)
    : null
  const renameIsValid = selected ? isValidTagName(renameValue) : false

  const applyRename = () => {
    if (!selected || !renameIsValid) return
    onChange(renameOccurrence(value, selected.occurrenceId, renameValue))
    setSelected({ occurrenceId: selected.occurrenceId, name: renameValue })
  }

  return (
    <div
      className={`structured-prompt ${compact ? 'structured-prompt--compact' : ''}`}
    >
      <div className="structured-prompt__main">
        <div className="field-heading">
          <div>
            <label>Instruções</label>
            <p>
              Digite <kbd>@</kbd> para inserir uma tag de resposta estruturada.
            </p>
          </div>
          <span className="quiet-badge">
            {occurrences.length.toLocaleString('pt-BR')}{' '}
            {occurrences.length === 1 ? 'tag' : 'tags'}
          </span>
        </div>
        <InstructionEditor
          id={compact ? 'chat-root' : 'library-root'}
          label="Instruções"
          value={value.root}
          roles={roles}
          knownNames={knownNames}
          placeholder="Descreva a tarefa. Digite @resumo, @data ou outra tag…"
          onChange={(document) => onChange(withDocument(value, null, document))}
          onSelectTag={selectTag}
        />
        <details className="serialized-preview">
          <summary>Prévia do prompt</summary>
          <pre>
            {serializeStructuredPrompt(value) || 'Nenhuma instrução ainda.'}
          </pre>
        </details>
      </div>

      <aside
        className="definition-panel"
        aria-label="Editor de definição da tag"
      >
        {selected && selectedName ? (
          <>
            <div className="definition-panel__header">
              <div>
                <span className="eyebrow">Tag selecionada</span>
                <strong>@{selectedName}</strong>
              </div>
              <span
                className={`role-pill role-pill--${roles[selected.occurrenceId] ?? 'reference'}`}
              >
                {roles[selected.occurrenceId] === 'definition'
                  ? 'Define a resposta'
                  : 'Usa a definição'}
              </span>
            </div>
            <div className="inline-form">
              <label htmlFor={`rename-${selected.occurrenceId}`}>
                Nome da tag
              </label>
              <div>
                <input
                  id={`rename-${selected.occurrenceId}`}
                  value={renameValue}
                  aria-invalid={!renameIsValid}
                  onChange={(event) => setRenameValue(event.target.value)}
                />
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={applyRename}
                  disabled={!renameIsValid || renameValue === selectedName}
                >
                  Renomear
                </button>
              </div>
              {!renameIsValid ? (
                <small className="field-error">Enter a valid tag name.</small>
              ) : null}
            </div>
            <div className="field-heading field-heading--definition">
              <div>
                <label>Instrução aninhada</label>
                <p>Usada apenas na primeira ocorrência de @{selectedName}.</p>
              </div>
              {selectedDefinition ? (
                <button
                  className="text-button"
                  type="button"
                  onClick={() => {
                    const next = {
                      ...value,
                      definitions: {
                        ...value.definitions,
                        [selectedName]: null
                      }
                    }
                    onChange(next)
                  }}
                >
                  Limpar
                </button>
              ) : null}
            </div>
            <InstructionEditor
              key={`definition-${selectedName}`}
              id={`definition-${selectedName}`}
              label={`Instrução aninhada para ${selectedName}`}
              value={selectedDefinition ?? emptyDocument()}
              roles={roles}
              knownNames={knownNames}
              placeholder={`Descreva o que <${selectedName}> deve conter. Tags @ aninhadas são compatíveis.`}
              onChange={(document) =>
                onChange(withDocument(value, selectedName, document))
              }
              onSelectTag={selectTag}
            />
          </>
        ) : (
          <div className="definition-panel__empty">
            <span className="empty-orbit" aria-hidden="true">
              @
            </span>
            <strong>Selecione uma tag</strong>
            <p>
              O nome, a função e a instrução aninhada opcional aparecerão aqui.
            </p>
          </div>
        )}
      </aside>
    </div>
  )
}
