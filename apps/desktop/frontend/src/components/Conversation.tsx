import { useState } from 'react'
import type {
  InteractionRow,
  MessageRow,
  MessageTagValue,
  MessageWarning
} from '../api/contracts'
import { getInteractionStatusPresentation } from '../ui/status'

const USER_PREVIEW_LENGTH = 1_200
const ASSISTANT_PREVIEW_LENGTH = 4_000
const EXPANSION_LENGTH = 8_000
const SHOW_ALL_LIMIT = 100_000

function ProgressiveText({
  content,
  initialLength,
  messageId
}: {
  content: string
  initialLength: number
  messageId: number
}) {
  const [visibleLength, setVisibleLength] = useState(initialLength)
  const shownLength = Math.min(content.length, visibleLength)
  const hasMore = shownLength < content.length

  return (
    <>
      <div
        className="message__content"
        data-testid={`progressive-content-${messageId}`}
      >
        {content.slice(0, shownLength)}
      </div>
      {hasMore ? (
        <div className="message__expansion-actions">
          <button
            className="text-button"
            type="button"
            onClick={() =>
              setVisibleLength((current) =>
                Math.min(content.length, current + EXPANSION_LENGTH)
              )
            }
          >
            Show more
          </button>
          {content.length <= SHOW_ALL_LIMIT ? (
            <button
              className="text-button"
              type="button"
              onClick={() => setVisibleLength(content.length)}
            >
              Show all
            </button>
          ) : null}
          <span>
            {shownLength.toLocaleString()} of {content.length.toLocaleString()}{' '}
            characters
          </span>
        </div>
      ) : null}
    </>
  )
}

interface TagTreeNode {
  index: number
  value: MessageTagValue
  children: TagTreeNode[]
}

function buildTagTree(values: MessageTagValue[]): TagTreeNode[] {
  const nodes = values.map((value, index) => ({
    index,
    value,
    children: [] as TagTreeNode[]
  }))
  const roots: TagTreeNode[] = []
  nodes.forEach((node) => {
    const parentIndex = node.value.parentIndex
    if (
      typeof parentIndex === 'number' &&
      parentIndex >= 0 &&
      parentIndex < node.index
    ) {
      nodes[parentIndex].children.push(node)
    } else {
      roots.push(node)
    }
  })
  return roots
}

function TagResult({ node }: { node: TagTreeNode }) {
  return (
    <li className="tag-result" data-testid={`tag-value-${node.index}`}>
      <span>@{node.value.name}</span>
      <p>{node.value.trimmed}</p>
      {node.children.length ? (
        <ul className="tag-result__children">
          {node.children.map((child) => (
            <TagResult key={child.value.id ?? child.index} node={child} />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

function WarningPanel({
  warnings,
  values
}: {
  warnings: MessageWarning[]
  values: MessageTagValue[]
}) {
  return (
    <section
      className="message-warnings"
      role="region"
      aria-label="Response warnings"
    >
      <strong>Review warnings</strong>
      <ul>
        {warnings.map((warning, index) => {
          const parent =
            typeof warning.parentIndex === 'number'
              ? values[warning.parentIndex]
              : undefined
          return (
            <li
              key={`${warning.code}-${warning.parentIndex ?? 'root'}-${index}`}
            >
              <span>{warning.message}</span>
              {parent ? <small>Inside @{parent.name}</small> : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function OutgoingPromptSummary({
  interaction
}: {
  interaction: InteractionRow
}) {
  const documentIds = interaction.documentIds ?? []
  return (
    <section
      className="outgoing-prompt-summary"
      aria-label="Outgoing prompt summary"
    >
      <div>
        <strong>Instructions sent</strong>
        <p>{interaction.renderedInstructions || 'No instructions recorded.'}</p>
      </div>
      <dl>
        <div>
          <dt>Prompt size</dt>{' '}
          <dd>
            {interaction.promptBytes === undefined
              ? 'Not recorded'
              : `${interaction.promptBytes.toLocaleString()} bytes`}
          </dd>
        </div>
        <div>
          <dt>Documents</dt>{' '}
          <dd>{documentIds.length ? documentIds.join(', ') : 'None'}</dd>
        </div>
      </dl>
    </section>
  )
}

function Message({
  message,
  interaction
}: {
  message: MessageRow
  interaction: InteractionRow
}) {
  const values = message.tagValues ?? []
  const tagTree = buildTagTree(values)
  const isUser = message.role === 'user'
  return (
    <article
      className={`message message--${message.role}`}
      data-testid={`message-${message.id}`}
    >
      <header>
        <span>{isUser ? 'Your prompt' : 'Browser response'}</span>
        <time dateTime={message.createdAt}>
          {new Date(message.createdAt).toLocaleString()}
        </time>
      </header>
      {isUser ? <OutgoingPromptSummary interaction={interaction} /> : null}
      {isUser ? (
        <strong className="message__section-title">
          Complete outgoing prompt
        </strong>
      ) : null}
      <ProgressiveText
        content={message.content}
        initialLength={isUser ? USER_PREVIEW_LENGTH : ASSISTANT_PREVIEW_LENGTH}
        messageId={message.id}
      />
      {tagTree.length ? (
        <section className="tag-results" aria-label="Extracted values">
          <strong>Extracted values</strong>
          <ul>
            {tagTree.map((node) => (
              <TagResult key={node.value.id ?? node.index} node={node} />
            ))}
          </ul>
        </section>
      ) : null}
      {message.warnings?.length ? (
        <WarningPanel warnings={message.warnings} values={values} />
      ) : null}
    </article>
  )
}

export function Conversation({
  interaction,
  emptyText = 'No messages yet.'
}: {
  interaction?: InteractionRow
  emptyText?: string
}) {
  if (!interaction)
    return (
      <div className="empty-state empty-state--conversation">
        <strong>{emptyText}</strong>
        <p>A dispatched prompt and imported response will appear here.</p>
      </div>
    )
  const messages = [...interaction.messages].sort(
    (a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
      a.id - b.id
  )
  const status = getInteractionStatusPresentation(interaction.status)
  return (
    <div className="conversation" aria-live="polite">
      {messages.map((message) => (
        <Message key={message.id} message={message} interaction={interaction} />
      ))}
      {status.active ||
      status.tone === 'danger' ||
      status.tone === 'warning' ? (
        <div
          className={`waiting-response status-guidance status-guidance--${status.tone}`}
        >
          {status.active ? (
            <span className="waiting-response__dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          ) : null}
          <div>
            <strong>{status.label}</strong>
            <p>{status.guidance}</p>
          </div>
        </div>
      ) : null}
    </div>
  )
}
