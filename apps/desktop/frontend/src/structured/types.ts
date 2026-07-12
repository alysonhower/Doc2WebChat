export const TAG_NAME_SOURCE = '^[A-Za-z_][A-Za-z0-9._-]*$'
export const TAG_NAME_PATTERN = new RegExp(TAG_NAME_SOURCE)

export interface TextInstructionNode {
  type: 'text'
  text: string
}

export interface TagInstructionNode {
  type: 'tag'
  occurrenceId: string
  name: string
}

export type InstructionNode = TextInstructionNode | TagInstructionNode

export interface InstructionDocument {
  version: 1
  nodes: InstructionNode[]
}

export interface StructuredPrompt {
  version: 1
  root: InstructionDocument
  definitions: Record<string, InstructionDocument | null>
}

export type OccurrenceRole = 'definition' | 'reference'

export interface OccurrenceInfo {
  occurrenceId: string
  name: string
  role: OccurrenceRole
  definitionPath: string[]
}
