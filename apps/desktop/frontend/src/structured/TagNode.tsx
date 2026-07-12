import { createContext, useContext, type JSX } from 'react'
import {
  $applyNodeReplacement,
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread
} from 'lexical'
import type { OccurrenceRole } from './types'

export interface TagEditorContextValue {
  roles: Record<string, OccurrenceRole>
  onSelect: (occurrenceId: string, name: string) => void
}

export const TagEditorContext = createContext<TagEditorContextValue>({
  roles: {},
  onSelect: () => undefined
})

export type SerializedTagNode = Spread<
  {
    occurrenceId: string
    name: string
  },
  SerializedLexicalNode
>

function TagChip({
  occurrenceId,
  name
}: {
  occurrenceId: string
  name: string
}) {
  const context = useContext(TagEditorContext)
  const role = context.roles[occurrenceId] ?? 'reference'
  return (
    <button
      className={`tag-chip tag-chip--${role}`}
      type="button"
      title={`${name} · ${role}`}
      onClick={() => context.onSelect(occurrenceId, name)}
      data-occurrence-id={occurrenceId}
      data-role={role}
    >
      <span aria-hidden="true">@</span>
      {name}
      <span className="tag-chip__role">
        {role === 'definition' ? 'D' : 'R'}
      </span>
    </button>
  )
}

export class TagNode extends DecoratorNode<JSX.Element> {
  __occurrenceId: string
  __name: string

  static getType(): string {
    return 'instruction-tag'
  }

  static clone(node: TagNode): TagNode {
    return new TagNode(node.__occurrenceId, node.__name, node.__key)
  }

  static importJSON(serializedNode: SerializedTagNode): TagNode {
    return $createTagNode(serializedNode.occurrenceId, serializedNode.name)
  }

  constructor(occurrenceId: string, name: string, key?: NodeKey) {
    super(key)
    this.__occurrenceId = occurrenceId
    this.__name = name
  }

  exportJSON(): SerializedTagNode {
    return {
      ...super.exportJSON(),
      type: 'instruction-tag',
      version: 1,
      occurrenceId: this.__occurrenceId,
      name: this.__name
    }
  }

  createDOM(): HTMLElement {
    const element = document.createElement('span')
    element.className = 'tag-node'
    return element
  }

  updateDOM(previousNode: this): boolean {
    return (
      previousNode.__occurrenceId !== this.__occurrenceId ||
      previousNode.__name !== this.__name
    )
  }

  isInline(): boolean {
    return true
  }

  isKeyboardSelectable(): boolean {
    return true
  }

  getTextContent(): string {
    return `@${this.__name}`
  }

  getOccurrenceId(): string {
    return this.getLatest().__occurrenceId
  }

  getName(): string {
    return this.getLatest().__name
  }

  decorate(): JSX.Element {
    return <TagChip occurrenceId={this.__occurrenceId} name={this.__name} />
  }
}

export function $createTagNode(occurrenceId: string, name: string): TagNode {
  return $applyNodeReplacement(new TagNode(occurrenceId, name))
}

export function $isTagNode(
  node: LexicalNode | null | undefined
): node is TagNode {
  return node instanceof TagNode
}
