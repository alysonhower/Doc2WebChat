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
            Mostrar mais
          </button>
          {content.length <= SHOW_ALL_LIMIT ? (
            <button
              className="text-button"
              type="button"
              onClick={() => setVisibleLength(content.length)}
            >
              Mostrar tudo
            </button>
          ) : null}
          <span>
            {shownLength.toLocaleString('pt-BR')} de{' '}
            {content.length.toLocaleString('pt-BR')} caracteres
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

function warningMessage(
  warning: MessageWarning,
  parent?: MessageTagValue
): string {
  if (warning.code === 'missing-required' && warning.tagName)
    return `A tag esperada <${warning.tagName}> não foi encontrada.`
  if (warning.code === 'empty-occurrence' && warning.tagName)
    return `A tag <${warning.tagName}> está vazia.`
  if (warning.code === 'missing-child' && warning.tagName && parent)
    return `A tag <${parent.name}> não contém a tag filha <${warning.tagName}>.`
  if (warning.code === 'malformed-structure' && warning.tagName) {
    if (warning.message.startsWith('Unexpected closing tag'))
      return `Tag de fechamento inesperada </${warning.tagName}>.`
    if (warning.message.startsWith('Unclosed tag'))
      return `A tag <${warning.tagName}> não foi fechada.`
  }
  return warning.message
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
      aria-label="Avisos da resposta"
    >
      <strong>Revisar avisos</strong>
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
              <span>{warningMessage(warning, parent)}</span>
              {parent ? <small>Dentro de @{parent.name}</small> : null}
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
      aria-label="Resumo do prompt enviado"
    >
      <div>
        <strong>Instruções enviadas</strong>
        <p>
          {interaction.renderedInstructions || 'Nenhuma instrução registrada.'}
        </p>
      </div>
      <dl>
        <div>
          <dt>Tamanho do prompt</dt>{' '}
          <dd>
            {interaction.promptBytes === undefined
              ? 'Não registrado'
              : `${interaction.promptBytes.toLocaleString('pt-BR')} bytes`}
          </dd>
        </div>
        <div>
          <dt>Documentos</dt>{' '}
          <dd>{documentIds.length ? documentIds.join(', ') : 'Nenhum'}</dd>
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
        <span>{isUser ? 'Seu prompt' : 'Resposta do navegador'}</span>
        <time dateTime={message.createdAt}>
          {new Date(message.createdAt).toLocaleString('pt-BR')}
        </time>
      </header>
      {isUser ? <OutgoingPromptSummary interaction={interaction} /> : null}
      {isUser ? (
        <strong className="message__section-title">
          Prompt completo enviado
        </strong>
      ) : null}
      <ProgressiveText
        content={message.content}
        initialLength={isUser ? USER_PREVIEW_LENGTH : ASSISTANT_PREVIEW_LENGTH}
        messageId={message.id}
      />
      {tagTree.length ? (
        <section className="tag-results" aria-label="Valores extraídos">
          <strong>Valores extraídos</strong>
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
  emptyText = 'Nenhuma mensagem ainda.'
}: {
  interaction?: InteractionRow
  emptyText?: string
}) {
  if (!interaction)
    return (
      <div className="empty-state empty-state--conversation">
        <strong>{emptyText}</strong>
        <p>O prompt enviado e a resposta importada aparecerão aqui.</p>
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
