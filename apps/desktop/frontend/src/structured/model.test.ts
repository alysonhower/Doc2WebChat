import { describe, expect, it } from 'vitest'
import {
  emptyStructuredPrompt,
  normalizeDefinition,
  occurrenceInfo,
  renameOccurrence,
  serializeStructuredPrompt,
  withDocument
} from './model'
import type { StructuredPrompt } from './types'

const tag = (occurrenceId: string, name: string) => ({
  type: 'tag' as const,
  occurrenceId,
  name
})
const text = (value: string) => ({ type: 'text' as const, text: value })

describe('structured prompt model', () => {
  it('normalizes only surrounding whitespace, the first Unicode letter, and final period', () => {
    expect(normalizeDefinition('  42 élève?  ')).toBe('42 Élève?.')
    expect(normalizeDefinition('\n\t')).toBe('')
    expect(normalizeDefinition('already Done.')).toBe('Already Done.')
  })

  it('serializes first occurrences as definitions and later occurrences as references', () => {
    const prompt: StructuredPrompt = {
      version: 1,
      root: {
        version: 1,
        nodes: [
          text('Give '),
          tag('one', 'summary'),
          text(' then '),
          tag('two', 'summary')
        ]
      },
      definitions: { summary: { version: 1, nodes: [text('a short answer')] } }
    }
    expect(serializeStructuredPrompt(prompt)).toBe(
      'Give <summary>[A short answer.]</summary> then <summary>'
    )
    expect(
      occurrenceInfo(prompt).map(({ occurrenceId, role }) => [
        occurrenceId,
        role
      ])
    ).toEqual([
      ['one', 'definition'],
      ['two', 'reference']
    ])
  })

  it('serializes an omitted definition instruction as empty square brackets', () => {
    const prompt: StructuredPrompt = {
      version: 1,
      root: { version: 1, nodes: [tag('one', 'summary')] },
      definitions: { summary: null }
    }
    expect(serializeStructuredPrompt(prompt)).toBe('<summary>[]</summary>')
  })

  it('walks nested definitions depth-first and terminates self references', () => {
    const prompt: StructuredPrompt = {
      version: 1,
      root: {
        version: 1,
        nodes: [tag('a-root', 'answer'), tag('date-root', 'date')]
      },
      definitions: {
        answer: {
          version: 1,
          nodes: [
            text('include '),
            tag('date-nested', 'date'),
            text(' and '),
            tag('a-self', 'answer')
          ]
        },
        date: { version: 1, nodes: [text('ISO date')] }
      }
    }
    expect(
      occurrenceInfo(prompt).map(({ occurrenceId, role }) => [
        occurrenceId,
        role
      ])
    ).toEqual([
      ['a-root', 'definition'],
      ['date-nested', 'definition'],
      ['a-self', 'reference'],
      ['date-root', 'reference']
    ])
    expect(serializeStructuredPrompt(prompt)).toBe(
      '<answer>[Include <date>[ISO date.]</date> and <answer>.]</answer><date>'
    )
  })

  it('does not change a nested tag token when it begins a definition', () => {
    const prompt: StructuredPrompt = {
      version: 1,
      root: { version: 1, nodes: [tag('parent', 'parent')] },
      definitions: {
        parent: { version: 1, nodes: [tag('date', 'iso-date')] },
        'iso-date': { version: 1, nodes: [text('provide a date')] }
      }
    }
    expect(serializeStructuredPrompt(prompt)).toBe(
      '<parent>[<iso-date>[Provide a date.]</iso-date>.]</parent>'
    )
  })

  it('transfers a sole occurrence definition only when the target registry name is unused', () => {
    const prompt: StructuredPrompt = {
      version: 1,
      root: { version: 1, nodes: [tag('one', 'old')] },
      definitions: { old: { version: 1, nodes: [text('kept')] } }
    }
    const renamed = renameOccurrence(prompt, 'one', 'new')
    expect(renamed.definitions.old).toBeUndefined()
    expect(renamed.definitions.new).toEqual({
      version: 1,
      nodes: [text('kept')]
    })

    const withExistingTarget = {
      ...prompt,
      definitions: {
        ...prompt.definitions,
        new: { version: 1 as const, nodes: [text('do not overwrite')] }
      }
    }
    const protectedTarget = renameOccurrence(withExistingTarget, 'one', 'new')
    expect(protectedTarget.definitions.old).toEqual(prompt.definitions.old)
    expect(protectedTarget.definitions.new).toEqual(
      withExistingTarget.definitions.new
    )
  })

  it('keeps the old definition when another old-name occurrence remains', () => {
    const prompt: StructuredPrompt = {
      version: 1,
      root: {
        version: 1,
        nodes: [tag('one', 'old'), tag('two', 'old')]
      },
      definitions: { old: { version: 1, nodes: [text('kept')] } }
    }
    const renamed = renameOccurrence(prompt, 'one', 'new')
    expect(renamed.definitions.old).toEqual(prompt.definitions.old)
    expect(renamed.definitions.new).toBeNull()
    expect(renamed.root.nodes).toEqual([tag('one', 'new'), tag('two', 'old')])
  })

  it('preserves orphaned registry definitions when occurrences are deleted', () => {
    const prompt = withDocument(emptyStructuredPrompt(), null, {
      version: 1,
      nodes: [tag('one', 'summary')]
    })
    const defined = {
      ...prompt,
      definitions: {
        summary: { version: 1 as const, nodes: [text('keep me')] }
      }
    }
    const deleted = withDocument(defined, null, { version: 1, nodes: [] })
    expect(deleted.definitions.summary).toEqual({
      version: 1,
      nodes: [text('keep me')]
    })
  })
})
