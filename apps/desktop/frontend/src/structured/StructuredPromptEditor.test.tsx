import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  getNearestEditorFromDOMNode
} from 'lexical'
import { emptyStructuredPrompt } from './model'
import { StructuredPromptEditor } from './StructuredPromptEditor'
import type { StructuredPrompt } from './types'

function Harness({ onValue }: { onValue?: (value: StructuredPrompt) => void }) {
  const [value, setValue] = useState(emptyStructuredPrompt())
  return (
    <StructuredPromptEditor
      value={value}
      onChange={(next) => {
        setValue(next)
        onValue?.(next)
      }}
    />
  )
}

function insertText(editorElement: HTMLElement, text: string) {
  const editor = getNearestEditorFromDOMNode(editorElement)!
  editor.update(
    () => {
      $getRoot().selectEnd()
      const selection = $getSelection()
      if ($isRangeSelection(selection)) selection.insertText(text)
    },
    { discrete: true }
  )
}

function clearEditor(editorElement: HTMLElement) {
  const editor = getNearestEditorFromDOMNode(editorElement)!
  editor.update(
    () => {
      const root = $getRoot()
      root.clear()
      root.append($createParagraphNode())
    },
    { discrete: true }
  )
}

describe('StructuredPromptEditor', () => {
  it('emits a local return to the parent value while an earlier edit is pending', async () => {
    const values: StructuredPrompt[] = []
    const value = emptyStructuredPrompt()
    render(
      <StructuredPromptEditor
        value={value}
        onChange={(next) => values.push(next)}
      />
    )
    const editor = screen.getByLabelText('Instructions')

    insertText(editor, 'temporary')
    await waitFor(() =>
      expect(values.at(-1)?.root.nodes).toEqual([
        { type: 'text', text: 'temporary' }
      ])
    )
    const emittedCount = values.length

    clearEditor(editor)
    await waitFor(() => expect(values.length).toBeGreaterThan(emittedCount))
    expect(values.at(-1)?.root.nodes).toEqual([])
  })

  it('accepts a valid @tag with Enter and retains an invalid token with an inline error', async () => {
    render(<Harness />)
    const editor = screen.getByLabelText('Instructions')
    insertText(editor, '@summary')
    await screen.findByRole('listbox', { name: 'Tag suggestions' })
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(await screen.findByTitle('summary · definition')).toBeInTheDocument()

    insertText(editor, '@sum')
    await screen.findByRole('listbox', { name: 'Tag suggestions' })
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(await screen.findByTitle('sum · definition')).toBeInTheDocument()

    insertText(editor, '@1bad')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Use a letter or underscore first'
    )
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(editor).toHaveTextContent('@1bad')
  })

  it('does not replace an invalid token with a known suggestion', async () => {
    render(<Harness />)
    const editor = screen.getByLabelText('Instructions')

    insertText(editor, '@tag1')
    await screen.findByRole('listbox', { name: 'Tag suggestions' })
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(await screen.findByTitle('tag1 · definition')).toBeInTheDocument()

    insertText(editor, '@1')
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /@tag1/ })).toBeInTheDocument()
    fireEvent.keyDown(editor, { key: 'Tab' })

    expect(editor).toHaveTextContent('@1')
    expect(screen.getAllByTitle('tag1 · definition')).toHaveLength(1)
  })

  it('supports nested tags and occurrence-only renaming', async () => {
    const values: StructuredPrompt[] = []
    const user = userEvent.setup()
    render(<Harness onValue={(value) => values.push(value)} />)
    const root = screen.getByLabelText('Instructions')
    insertText(root, '@summary')
    await screen.findByRole('listbox', { name: 'Tag suggestions' })
    fireEvent.keyDown(root, { key: 'Tab' })
    const chip = await screen.findByTitle('summary · definition')
    await user.click(chip)

    const nested = await screen.findByLabelText(
      'Nested instruction for summary'
    )
    insertText(nested, 'include @date')
    await screen.findByRole('listbox', { name: 'Tag suggestions' })
    fireEvent.keyDown(nested, { key: 'Tab' })
    await waitFor(() => {
      const latest = values.at(-1)!
      expect(latest.definitions.summary?.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'tag', name: 'date' })
        ])
      )
    })

    const rename = screen.getByLabelText('Occurrence name')
    fireEvent.change(rename, { target: { value: 'overview' } })
    await user.click(screen.getByRole('button', { name: 'Rename' }))
    await waitFor(() =>
      expect(values.at(-1)?.root.nodes).toEqual([
        expect.objectContaining({ type: 'tag', name: 'overview' }),
        expect.objectContaining({ type: 'text' })
      ])
    )
  })

  it('accepts suggestion-menu choices in root and nested editors', async () => {
    const user = userEvent.setup()
    const values: StructuredPrompt[] = []
    render(<Harness onValue={(value) => values.push(value)} />)

    const root = screen.getByLabelText('Instructions')
    insertText(root, '@summary')
    await user.click(
      await screen.findByRole('option', { name: /Create @summary/ })
    )
    await user.click(await screen.findByTitle('summary · definition'))

    const nested = await screen.findByLabelText(
      'Nested instruction for summary'
    )
    insertText(nested, '@date')
    await user.click(
      await screen.findByRole('option', { name: /Create @date/ })
    )
    await waitFor(() =>
      expect(values.at(-1)?.definitions.summary?.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'tag', name: 'date' })
        ])
      )
    )
  })
})
