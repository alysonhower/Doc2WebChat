import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $createTextNode,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
  KEY_TAB_COMMAND
} from 'lexical'
import { $createTagNode } from './TagNode'
import { createOccurrenceId, isValidTagName } from './model'

interface MatchState {
  key: string
  start: number
  end: number
  query: string
}

export interface MentionPluginProps {
  knownNames: string[]
}

export function MentionPlugin({ knownNames }: MentionPluginProps) {
  const [editor] = useLexicalComposerContext()
  const [match, setMatch] = useState<MatchState | null>(null)

  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState }) => {
        editorState.read(() => {
          const selection = $getSelection()
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
            setMatch(null)
            return
          }
          const anchor = selection.anchor.getNode()
          if (!$isTextNode(anchor)) {
            setMatch(null)
            return
          }
          const end = selection.anchor.offset
          const beforeCursor = anchor.getTextContent().slice(0, end)
          const found = beforeCursor.match(/@([^\s@<>]*)$/u)
          if (!found) {
            setMatch(null)
            return
          }
          setMatch({
            key: anchor.getKey(),
            start: end - found[0].length,
            end,
            query: found[1]
          })
        })
      }),
    [editor]
  )

  const suggestions = useMemo(() => {
    if (!match) return []
    const query = match.query.toLocaleLowerCase()
    return [...new Set(knownNames)]
      .filter((name) => name.toLocaleLowerCase().includes(query))
      .slice(0, 6)
  }, [knownNames, match])

  const typedName = match?.query ?? ''
  const typedNameValid = isValidTagName(typedName)
  const preferredName = typedNameValid
    ? typedName
    : (suggestions[0] ?? typedName)
  const valid = isValidTagName(preferredName)

  const insert = useCallback(
    (name: string) => {
      if (!match || !isValidTagName(name)) return false
      editor.update(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection)) return
        const textNode = selection.anchor.getNode()
        if (!$isTextNode(textNode) || textNode.getKey() !== match.key) return
        const fullText = textNode.getTextContent()
        const prefix = fullText.slice(0, match.start)
        const suffix = fullText.slice(match.end)
        textNode.setTextContent(prefix)
        const tag = $createTagNode(createOccurrenceId(), name)
        textNode.insertAfter(tag)
        const tail = $createTextNode(suffix || ' ')
        tag.insertAfter(tail)
        const offset = suffix ? 0 : 1
        tail.select(offset, offset)
      })
      setMatch(null)
      return true
    },
    [editor, match]
  )

  useEffect(() => {
    const handleKey = (event: KeyboardEvent | null) => {
      if (!match) return false
      if (!typedNameValid || !valid) {
        event?.preventDefault()
        return true
      }
      event?.preventDefault()
      return insert(preferredName)
    }
    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      handleKey,
      COMMAND_PRIORITY_HIGH
    )
    const unregisterTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      handleKey,
      COMMAND_PRIORITY_HIGH
    )
    return () => {
      unregisterEnter()
      unregisterTab()
    }
  }, [editor, insert, match, preferredName, typedNameValid, valid])

  if (!match) return null

  return (
    <div className="mention-menu" role="listbox" aria-label="Tag suggestions">
      {suggestions.map((name) => (
        <button
          type="button"
          role="option"
          aria-selected={name === preferredName}
          key={name}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => insert(name)}
        >
          <span>@{name}</span>
          <small>{name === preferredName ? 'Enter or Tab' : ''}</small>
        </button>
      ))}
      {typedNameValid && !suggestions.includes(typedName) ? (
        <button
          type="button"
          role="option"
          aria-selected={preferredName === typedName}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => insert(typedName)}
        >
          <span>Create @{typedName}</span>
          <small>{preferredName === typedName ? 'Enter or Tab' : ''}</small>
        </button>
      ) : null}
      {typedName.length > 0 && !typedNameValid ? (
        <p className="mention-menu__error" role="alert">
          Use a letter or underscore first, then letters, numbers, dots, dashes,
          or underscores.
        </p>
      ) : null}
    </div>
  )
}
