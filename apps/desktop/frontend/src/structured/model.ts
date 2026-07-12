import {
  TAG_NAME_PATTERN,
  type InstructionDocument,
  type InstructionNode,
  type OccurrenceInfo,
  type OccurrenceRole,
  type StructuredPrompt,
  type TagInstructionNode
} from './types'

export const emptyDocument = (): InstructionDocument => ({
  version: 1,
  nodes: []
})

export const emptyStructuredPrompt = (): StructuredPrompt => ({
  version: 1,
  root: emptyDocument(),
  definitions: {}
})

export function clonePrompt(prompt: StructuredPrompt): StructuredPrompt {
  if (typeof structuredClone === 'function') return structuredClone(prompt)
  return JSON.parse(JSON.stringify(prompt)) as StructuredPrompt
}

export function createOccurrenceId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `tag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  )
}

export function isValidTagName(name: string): boolean {
  return TAG_NAME_PATTERN.test(name)
}

export function compactDocument(
  document: InstructionDocument
): InstructionDocument {
  const nodes: InstructionNode[] = []
  for (const node of document.nodes) {
    if (node.type === 'text' && node.text === '') continue
    const previous = nodes.at(-1)
    if (node.type === 'text' && previous?.type === 'text') {
      previous.text += node.text
    } else {
      nodes.push({ ...node })
    }
  }
  return { version: 1, nodes }
}

export function withDocument(
  prompt: StructuredPrompt,
  definitionName: string | null,
  document: InstructionDocument
): StructuredPrompt {
  const next = clonePrompt(prompt)
  const compacted = compactDocument(document)
  if (definitionName === null) next.root = compacted
  else next.definitions[definitionName] = compacted

  for (const node of compacted.nodes) {
    if (node.type === 'tag' && !(node.name in next.definitions)) {
      next.definitions[node.name] = null
    }
  }
  return next
}

function allDocuments(prompt: StructuredPrompt): InstructionDocument[] {
  return [
    prompt.root,
    ...Object.values(prompt.definitions).filter(
      (document): document is InstructionDocument => document !== null
    )
  ]
}

export function countOccurrences(
  prompt: StructuredPrompt,
  name: string
): number {
  return allDocuments(prompt).reduce(
    (count, document) =>
      count +
      document.nodes.filter((node) => node.type === 'tag' && node.name === name)
        .length,
    0
  )
}

export function renameOccurrence(
  prompt: StructuredPrompt,
  occurrenceId: string,
  nextName: string
): StructuredPrompt {
  if (!isValidTagName(nextName)) return prompt
  const next = clonePrompt(prompt)
  let target: TagInstructionNode | undefined
  for (const document of allDocuments(next)) {
    const found = document.nodes.find(
      (node): node is TagInstructionNode =>
        node.type === 'tag' && node.occurrenceId === occurrenceId
    )
    if (found) {
      target = found
      break
    }
  }
  if (!target || target.name === nextName) return next

  const previousName = target.name
  const isOnlyOldOccurrence = countOccurrences(next, previousName) === 1
  const targetIsUnused = countOccurrences(next, nextName) === 0
  const targetHasDefinition = Object.prototype.hasOwnProperty.call(
    next.definitions,
    nextName
  )
  target.name = nextName

  if (isOnlyOldOccurrence && targetIsUnused && !targetHasDefinition) {
    next.definitions[nextName] = next.definitions[previousName] ?? null
    delete next.definitions[previousName]
  } else if (!targetHasDefinition) {
    next.definitions[nextName] = null
  }
  return next
}

export function occurrenceInfo(prompt: StructuredPrompt): OccurrenceInfo[] {
  const seen = new Set<string>()
  const activeDefinitions = new Set<string>()
  const result: OccurrenceInfo[] = []

  const visit = (document: InstructionDocument, path: string[]) => {
    for (const node of document.nodes) {
      if (node.type !== 'tag') continue
      const role: OccurrenceRole = seen.has(node.name)
        ? 'reference'
        : 'definition'
      result.push({
        occurrenceId: node.occurrenceId,
        name: node.name,
        role,
        definitionPath: path
      })
      if (role === 'reference') continue
      seen.add(node.name)
      const nested = prompt.definitions[node.name]
      if (nested && !activeDefinitions.has(node.name)) {
        activeDefinitions.add(node.name)
        visit(nested, [...path, node.name])
        activeDefinitions.delete(node.name)
      }
    }
  }

  visit(prompt.root, [])
  return result
}

export function occurrenceRoles(
  prompt: StructuredPrompt
): Record<string, OccurrenceRole> {
  return Object.fromEntries(
    occurrenceInfo(prompt).map(({ occurrenceId, role }) => [occurrenceId, role])
  )
}

export function normalizeDefinition(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  const characters = Array.from(trimmed)
  let insideTag = false
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]
    if (character === '<') {
      insideTag = true
      continue
    }
    if (character === '>') {
      insideTag = false
      continue
    }
    if (!insideTag && /\p{L}/u.test(character)) {
      characters[index] = character.toUpperCase()
      break
    }
  }
  const capitalized = characters.join('')
  return capitalized.endsWith('.') ? capitalized : `${capitalized}.`
}

export function serializeStructuredPrompt(prompt: StructuredPrompt): string {
  const defined = new Set<string>()

  const serializeDocument = (document: InstructionDocument): string =>
    document.nodes
      .map((node) => {
        if (node.type === 'text') return node.text
        if (defined.has(node.name)) return `<${node.name}>`
        defined.add(node.name)
        const nested = prompt.definitions[node.name]
        const instruction = nested
          ? normalizeDefinition(serializeDocument(nested))
          : ''
        return `<${node.name}>[${instruction}]</${node.name}>`
      })
      .join('')

  return serializeDocument(prompt.root)
}

export function promptEquals(
  left: StructuredPrompt,
  right: StructuredPrompt
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
