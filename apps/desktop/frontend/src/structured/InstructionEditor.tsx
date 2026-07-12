import { useEffect, useMemo, useRef } from 'react'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin'
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin'
import type { EditorState } from 'lexical'
import { MentionPlugin } from './MentionPlugin'
import { TagEditorContext, TagNode } from './TagNode'
import {
  $readInstructionDocument,
  $writeInstructionDocument
} from './lexical-document'
import type { InstructionDocument, OccurrenceRole } from './types'

interface DocumentSyncPluginProps {
  value: InstructionDocument
  pendingLocalValues: { current: string[] }
}

function DocumentSyncPlugin({
  value,
  pendingLocalValues
}: DocumentSyncPluginProps) {
  const [editor] = useLexicalComposerContext()
  const serializedValue = JSON.stringify(value)

  useEffect(() => {
    const pendingIndex = pendingLocalValues.current.indexOf(serializedValue)
    if (pendingIndex >= 0) {
      pendingLocalValues.current.splice(0, pendingIndex + 1)
      return
    }
    const current = editor
      .getEditorState()
      .read(() => JSON.stringify($readInstructionDocument()))
    if (current !== serializedValue) {
      pendingLocalValues.current.length = 0
      editor.update(() => $writeInstructionDocument(value))
    }
  }, [editor, pendingLocalValues, serializedValue, value])
  return null
}

export interface InstructionEditorProps {
  id: string
  label: string
  value: InstructionDocument
  roles: Record<string, OccurrenceRole>
  knownNames: string[]
  placeholder: string
  onChange: (document: InstructionDocument) => void
  onSelectTag: (occurrenceId: string, name: string) => void
}

export function InstructionEditor({
  id,
  label,
  value,
  roles,
  knownNames,
  placeholder,
  onChange,
  onSelectTag
}: InstructionEditorProps) {
  const initialValue = useRef(value)
  const pendingLocalValues = useRef<string[]>([])
  const initialConfig = useMemo(
    () => ({
      namespace: `Doc2WebChat-${id}`,
      nodes: [TagNode],
      editorState: () => $writeInstructionDocument(initialValue.current),
      onError: (error: Error) => {
        throw error
      },
      theme: {
        paragraph: 'instruction-editor__paragraph'
      }
    }),
    [id]
  )

  const handleChange = (editorState: EditorState) => {
    const document = editorState.read(() => $readInstructionDocument())
    const serializedDocument = JSON.stringify(document)
    const latestKnownValue =
      pendingLocalValues.current.at(-1) ?? JSON.stringify(value)
    if (serializedDocument === latestKnownValue) return
    pendingLocalValues.current.push(serializedDocument)
    onChange(document)
  }

  return (
    <TagEditorContext.Provider value={{ roles, onSelect: onSelectTag }}>
      <div
        className="instruction-editor"
        data-testid={`instruction-editor-${id}`}
      >
        <span className="sr-only" id={`${id}-label`}>
          {label}
        </span>
        <LexicalComposer initialConfig={initialConfig}>
          <div className="instruction-editor__surface">
            <PlainTextPlugin
              contentEditable={
                <ContentEditable
                  className="instruction-editor__input"
                  aria-labelledby={`${id}-label`}
                  spellCheck
                />
              }
              placeholder={
                <div className="instruction-editor__placeholder">
                  {placeholder}
                </div>
              }
              ErrorBoundary={LexicalErrorBoundary}
            />
            <OnChangePlugin onChange={handleChange} ignoreSelectionChange />
            <HistoryPlugin />
            <DocumentSyncPlugin
              value={value}
              pendingLocalValues={pendingLocalValues}
            />
            <MentionPlugin knownNames={knownNames} />
          </div>
        </LexicalComposer>
      </div>
    </TagEditorContext.Provider>
  )
}
