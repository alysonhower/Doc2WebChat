import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isLineBreakNode,
  $isTextNode,
  type LexicalNode
} from 'lexical'
import { $createTagNode, $isTagNode } from './TagNode'
import { compactDocument } from './model'
import type { InstructionDocument, InstructionNode } from './types'

function appendText(nodes: InstructionNode[], text: string): void {
  if (!text) return
  const previous = nodes.at(-1)
  if (previous?.type === 'text') previous.text += text
  else nodes.push({ type: 'text', text })
}

function readNode(node: LexicalNode, nodes: InstructionNode[]): void {
  if ($isTagNode(node)) {
    nodes.push({
      type: 'tag',
      occurrenceId: node.getOccurrenceId(),
      name: node.getName()
    })
    return
  }
  if ($isTextNode(node)) {
    appendText(nodes, node.getTextContent())
    return
  }
  if ($isLineBreakNode(node)) {
    appendText(nodes, '\n')
    return
  }
  if ($isElementNode(node)) {
    for (const child of node.getChildren()) readNode(child, nodes)
  }
}

export function $readInstructionDocument(): InstructionDocument {
  const nodes: InstructionNode[] = []
  const blocks = $getRoot().getChildren()
  blocks.forEach((block, index) => {
    if (index > 0) appendText(nodes, '\n')
    readNode(block, nodes)
  })
  return compactDocument({ version: 1, nodes })
}

export function $writeInstructionDocument(document: InstructionDocument): void {
  const root = $getRoot()
  root.clear()
  const paragraph = $createParagraphNode()
  for (const node of document.nodes) {
    if (node.type === 'tag') {
      paragraph.append($createTagNode(node.occurrenceId, node.name))
      continue
    }
    const lines = node.text.split('\n')
    lines.forEach((line, index) => {
      if (index > 0) paragraph.append($createLineBreakNode())
      if (line) paragraph.append($createTextNode(line))
    })
  }
  root.append(paragraph)
}
