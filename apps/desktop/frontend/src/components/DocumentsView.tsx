import { useEffect, useMemo, useRef, useState } from 'react'
import { errorMessage, invoke } from '../api/client'
import { isOcrEvent } from '../api/contracts'
import type {
  AppEvent,
  DocumentRow,
  OcrEvent,
  OcrJobState
} from '../api/contracts'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import {
  getOcrEventStatusPresentation,
  getOcrStatusPresentation
} from '../ui/status'
import { ArrowIcon, FolderIcon, RefreshIcon, TrashIcon } from './Icons'

interface DocumentsViewProps {
  documents: DocumentRow[]
  events: AppEvent[]
  activeJob: OcrJobState | null
  onJobStarted: (job: OcrJobState) => void
  onRefresh: () => Promise<void>
  onDelete: (documentId: number) => Promise<void>
  onDeleteMany: (documentIds: number[]) => Promise<void>
}

interface OcrRequest {
  inputPath: string
  outputPath: string
  recursive: boolean
  conflictPolicy: 'error' | 'skip' | 'overwrite'
  overwriteConfirmationJobId?: string | number
}

interface OverwriteConfirmation {
  overwriteConfirmationJobId: string | number
  inputPath: string
  outputPath: string
  recursive: boolean
  conflictCount: number
  conflictingOutputs: string[]
}

function shortPath(path: string): string {
  const parts = path.replaceAll('\\', '/').split('/').filter(Boolean)
  return parts.slice(-2).join('/') || path
}

function parseOverwriteConfirmation(
  source: AppEvent | OcrJobState | undefined
): OverwriteConfirmation | null {
  if (
    !source ||
    (typeof source.overwriteConfirmationJobId !== 'string' &&
      typeof source.overwriteConfirmationJobId !== 'number') ||
    typeof source.inputPath !== 'string' ||
    typeof source.outputPath !== 'string' ||
    typeof source.recursive !== 'boolean' ||
    typeof source.conflictCount !== 'number' ||
    !Number.isFinite(source.conflictCount) ||
    !Array.isArray(source.conflictingOutputs) ||
    !source.conflictingOutputs.every((path) => typeof path === 'string')
  )
    return null
  return {
    overwriteConfirmationJobId: source.overwriteConfirmationJobId,
    inputPath: source.inputPath,
    outputPath: source.outputPath,
    recursive: source.recursive,
    conflictCount: source.conflictCount,
    conflictingOutputs: source.conflictingOutputs
  }
}

function findOverwriteConfirmation(
  events: AppEvent[],
  activeJob: OcrJobState | null
): OverwriteConfirmation | null {
  if (!activeJob || activeJob.status !== 'awaiting-overwrite') return null
  const event = [...events]
    .reverse()
    .find(
      (candidate) =>
        candidate.stage === 'overwrite-confirmation-required' &&
        String(candidate.jobId) === String(activeJob.jobId)
    )
  return (
    parseOverwriteConfirmation(event) ?? parseOverwriteConfirmation(activeJob)
  )
}

export function DocumentsView({
  documents,
  events,
  activeJob,
  onJobStarted,
  onRefresh,
  onDelete,
  onDeleteMany
}: DocumentsViewProps) {
  const [inputPath, setInputPath] = useState('')
  const [outputPath, setOutputPath] = useState('')
  const [recursive, setRecursive] = useState(true)
  const [conflictPolicy, setConflictPolicy] = useState<
    'error' | 'skip' | 'overwrite'
  >('error')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dismissedConfirmation, setDismissedConfirmation] = useState<
    string | number | null
  >(null)
  const [documentToDelete, setDocumentToDelete] = useState<DocumentRow | null>(
    null
  )
  const [deletingDocumentId, setDeletingDocumentId] = useState<number | null>(
    null
  )
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<Set<number>>(
    () => new Set()
  )
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)
  const [deletingMany, setDeletingMany] = useState(false)
  const selectAllRef = useRef<HTMLInputElement>(null)

  const sortedDocuments = useMemo(
    () => [...documents].sort((a, b) => a.id - b.id),
    [documents]
  )
  const currentDocumentIds = useMemo(
    () => new Set(documents.map((document) => document.id)),
    [documents]
  )
  const selectedIds = useMemo(
    () =>
      sortedDocuments
        .filter((document) => selectedDocumentIds.has(document.id))
        .map((document) => document.id),
    [selectedDocumentIds, sortedDocuments]
  )

  useEffect(() => {
    setSelectedDocumentIds((current) => {
      const next = new Set(
        [...current].filter((documentId) => currentDocumentIds.has(documentId))
      )
      return next.size === current.size ? current : next
    })
    setDocumentToDelete((current) =>
      current && currentDocumentIds.has(current.id) ? current : null
    )
  }, [currentDocumentIds])

  const chooseDirectory = async (purpose: 'input' | 'output') => {
    setError(null)
    try {
      const { path } = await invoke((api) => api.select_directory({ purpose }))
      if (path !== null) {
        if (purpose === 'input') setInputPath(path)
        else setOutputPath(path)
      }
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  const start = async (request?: OcrRequest) => {
    setBusy(true)
    setError(null)
    try {
      const { jobId } = await invoke((api) =>
        api.start_ocr_job(
          request ?? { inputPath, outputPath, recursive, conflictPolicy }
        )
      )
      onJobStarted({
        jobId,
        status: 'discovering',
        completed: 0,
        failed: 0,
        skipped: 0,
        total: null
      })
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const processedCount = activeJob?.completed ?? 0
  const successfulCount = activeJob
    ? Math.max(0, activeJob.completed - activeJob.failed - activeJob.skipped)
    : 0
  const indeterminate =
    activeJob !== null &&
    ['pending', 'discovering', 'planning', 'starting-server'].includes(
      activeJob.status
    )
  const progress =
    activeJob?.total !== null &&
    activeJob?.total !== undefined &&
    !indeterminate
      ? activeJob.total === 0
        ? 100
        : Math.min(100, (processedCount / activeJob.total) * 100)
      : null
  const jobEvents = useMemo(
    () =>
      events
        .filter(
          (event): event is OcrEvent =>
            isOcrEvent(event) &&
            Boolean(activeJob) &&
            event.jobId === activeJob?.jobId
        )
        .slice(-6)
        .reverse(),
    [activeJob, events]
  )
  const overwriteConfirmation = useMemo(
    () => findOverwriteConfirmation(events, activeJob),
    [activeJob, events]
  )
  const visibleOverwriteConfirmation =
    overwriteConfirmation &&
    String(overwriteConfirmation.overwriteConfirmationJobId) ===
      String(dismissedConfirmation)
      ? null
      : overwriteConfirmation
  const jobStatus = activeJob
    ? getOcrStatusPresentation(activeJob.status)
    : null
  const deletionBlocked =
    activeJob !== null &&
    !['completed', 'completed-with-errors', 'failed', 'interrupted'].includes(
      activeJob.status
    )
  const selectionDisabled =
    deletionBlocked || deletingDocumentId !== null || deletingMany
  const allDocumentsSelected =
    sortedDocuments.length > 0 && selectedIds.length === sortedDocuments.length
  const someDocumentsSelected = selectedIds.length > 0 && !allDocumentsSelected

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someDocumentsSelected
    }
  }, [someDocumentsSelected])

  useEffect(() => {
    if (deletionBlocked || selectedIds.length === 0) setBulkDeleteOpen(false)
    if (deletionBlocked) setDocumentToDelete(null)
  }, [deletionBlocked, selectedIds.length])
  const jobFailure = useMemo(() => {
    const event = [...events]
      .reverse()
      .find(
        (candidate) =>
          activeJob &&
          String(candidate.jobId) === String(activeJob.jobId) &&
          candidate.stage === 'job-failed'
      )
    if (typeof event?.error === 'string' && event.error.trim())
      return event.error
    if (typeof event?.message === 'string' && event.message.trim())
      return event.message
    return undefined
  }, [activeJob, events])
  const progressLabel =
    activeJob?.status === 'awaiting-overwrite'
      ? 'Aguardando confirmação'
      : activeJob?.status === 'failed'
        ? 'Lote interrompido'
        : activeJob?.status === 'interrupted'
          ? 'Lote interrompido'
          : activeJob?.status === 'discovering'
            ? 'Procurando arquivos nas pastas…'
            : activeJob?.status === 'planning'
              ? 'Validando plano de arquivos…'
              : activeJob?.status === 'starting-server'
                ? 'Iniciando serviço OCR local…'
                : progress === null
                  ? (jobStatus?.label ?? 'Processando…')
                  : `${Math.round(progress)}%`

  const confirmDocumentDeletion = async () => {
    if (!documentToDelete) return
    setDeletingDocumentId(documentToDelete.id)
    setError(null)
    try {
      await onDelete(documentToDelete.id)
      setSelectedDocumentIds((current) => {
        const next = new Set(current)
        next.delete(documentToDelete.id)
        return next
      })
      setDocumentToDelete(null)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setDeletingDocumentId(null)
    }
  }

  const confirmBulkDeletion = async () => {
    if (!selectedIds.length || selectionDisabled) return
    setDeletingMany(true)
    setError(null)
    try {
      await onDeleteMany([...selectedIds])
      setSelectedDocumentIds(new Set())
      setBulkDeleteOpen(false)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setDeletingMany(false)
    }
  }

  const toggleDocumentSelection = (documentId: number, selected: boolean) => {
    setSelectedDocumentIds((current) => {
      const next = new Set(current)
      if (selected) next.add(documentId)
      else next.delete(documentId)
      return next
    })
  }

  const toggleAllDocuments = (selected: boolean) => {
    setSelectedDocumentIds(
      selected
        ? new Set(sortedDocuments.map((document) => document.id))
        : new Set()
    )
  }

  return (
    <section className="page" aria-labelledby="documents-title">
      <header className="page-header">
        <div>
          <span className="eyebrow">Espaço de OCR</span>
          <h1 id="documents-title">Documentos</h1>
          <p>
            Transforme documentos locais em PDFs pesquisáveis e texto pronto
            para usar no Chat.
          </p>
        </div>
        <button
          className="button button--secondary"
          type="button"
          onClick={() => void onRefresh()}
        >
          <RefreshIcon /> Atualizar
        </button>
      </header>

      <div className="documents-layout">
        <div className="card import-card">
          <div className="card-heading">
            <div>
              <span className="step-number">01</span>
              <h2>Escolha as pastas</h2>
            </div>
            <p>
              Os arquivos de origem permanecem locais. Os PDFs de saída
              reproduzem a estrutura de pastas da origem.
            </p>
          </div>
          <div className="folder-pair">
            <div className="folder-field">
              <label>Pasta de entrada</label>
              <button
                type="button"
                onClick={() => void chooseDirectory('input')}
              >
                <FolderIcon />
                <span>{inputPath || 'Selecionar pasta de origem'}</span>
              </button>
            </div>
            <ArrowIcon className="folder-pair__arrow" />
            <div className="folder-field">
              <label>Pasta de saída</label>
              <button
                type="button"
                onClick={() => void chooseDirectory('output')}
              >
                <FolderIcon />
                <span>{outputPath || 'Selecionar pasta de saída'}</span>
              </button>
            </div>
          </div>

          <div className="ocr-options">
            <label className="check-control">
              <input
                type="checkbox"
                checked={recursive}
                onChange={(event) => setRecursive(event.target.checked)}
              />
              <span>Incluir subpastas</span>
            </label>
            <label>
              Saída existente
              <select
                value={conflictPolicy}
                onChange={(event) =>
                  setConflictPolicy(event.target.value as typeof conflictPolicy)
                }
              >
                <option value="error">Perguntar antes de sobrescrever</option>
                <option value="skip">Ignorar existentes</option>
                <option value="overwrite">Sobrescrever existentes</option>
              </select>
            </label>
            <button
              className="button button--primary button--wide"
              type="button"
              disabled={
                !inputPath ||
                !outputPath ||
                busy ||
                (activeJob !== null &&
                  ![
                    'completed',
                    'completed-with-errors',
                    'failed',
                    'interrupted',
                    'awaiting-overwrite'
                  ].includes(activeJob.status))
              }
              onClick={() => void start()}
            >
              {busy ? 'Iniciando…' : 'Iniciar lote de OCR'}
              <ArrowIcon />
            </button>
          </div>
          {error ? (
            <div className="inline-alert inline-alert--error" role="alert">
              {error}
            </div>
          ) : null}
        </div>

        <aside className="card progress-card" aria-live="polite">
          <div className="card-heading">
            <div>
              <span className="step-number">02</span>
              <h2>Progresso do lote</h2>
            </div>
            {activeJob ? (
              <span className={`status status--${jobStatus?.tone}`}>
                {jobStatus?.label}
              </span>
            ) : null}
          </div>
          {activeJob ? (
            <>
              {visibleOverwriteConfirmation ? (
                <div
                  className="overwrite-confirmation"
                  role="dialog"
                  aria-labelledby="overwrite-confirmation-title"
                >
                  <div>
                    <span className="eyebrow">Saída existente</span>
                    <h3 id="overwrite-confirmation-title">
                      {visibleOverwriteConfirmation.conflictCount}{' '}
                      {visibleOverwriteConfirmation.conflictCount === 1
                        ? 'arquivo já existe'
                        : 'arquivos já existem'}
                    </h3>
                    <p>
                      Sobrescrever{' '}
                      {visibleOverwriteConfirmation.conflictCount === 1
                        ? 'o arquivo de saída listado'
                        : 'os arquivos de saída listados'}{' '}
                      e processar este lote?
                    </p>
                  </div>
                  <ul aria-label="Saídas em conflito">
                    {visibleOverwriteConfirmation.conflictingOutputs.map(
                      (path) => (
                        <li key={path}>{path}</li>
                      )
                    )}
                    {visibleOverwriteConfirmation.conflictCount >
                    visibleOverwriteConfirmation.conflictingOutputs.length ? (
                      <li className="overwrite-confirmation__more">
                        e mais{' '}
                        {visibleOverwriteConfirmation.conflictCount -
                          visibleOverwriteConfirmation.conflictingOutputs
                            .length}{' '}
                        {visibleOverwriteConfirmation.conflictCount -
                          visibleOverwriteConfirmation.conflictingOutputs
                            .length ===
                        1
                          ? 'arquivo'
                          : 'arquivos'}
                      </li>
                    ) : null}
                  </ul>
                  <div className="overwrite-confirmation__actions">
                    <button
                      className="button button--primary"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void start({
                          inputPath: visibleOverwriteConfirmation.inputPath,
                          outputPath: visibleOverwriteConfirmation.outputPath,
                          recursive: visibleOverwriteConfirmation.recursive,
                          conflictPolicy: 'error',
                          overwriteConfirmationJobId:
                            visibleOverwriteConfirmation.overwriteConfirmationJobId
                        })
                      }
                    >
                      {busy ? 'Iniciando…' : 'Sobrescrever e processar'}
                    </button>
                    <button
                      className="button button--secondary"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        setDismissedConfirmation(
                          visibleOverwriteConfirmation.overwriteConfirmationJobId
                        )
                      }
                    >
                      Agora não
                    </button>
                  </div>
                </div>
              ) : null}
              {!visibleOverwriteConfirmation && overwriteConfirmation ? (
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => setDismissedConfirmation(null)}
                >
                  Revisar conflitos
                </button>
              ) : null}
              <div className="progress-summary">
                <strong>{progressLabel}</strong>
                <span>
                  {activeJob.status === 'awaiting-overwrite' &&
                  overwriteConfirmation
                    ? `${overwriteConfirmation.conflictCount} ${overwriteConfirmation.conflictCount === 1 ? 'saída existente' : 'saídas existentes'}`
                    : activeJob.status === 'failed'
                      ? 'Lote interrompido'
                      : activeJob.status === 'starting-server'
                        ? 'O primeiro download do mecanismo OCR pode levar vários minutos'
                        : activeJob.total
                          ? `${processedCount} de ${activeJob.total} arquivos`
                          : 'Planejando arquivos'}
                </span>
              </div>
              <div
                className={`progress-track ${indeterminate ? 'progress-track--indeterminate' : ''}`}
                role="progressbar"
                aria-label="Progresso do lote de OCR"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={
                  progress === null ? undefined : Math.round(progress)
                }
                aria-valuetext={
                  progress === null
                    ? jobStatus?.label
                    : `${jobStatus?.label ?? 'Processando'}: ${Math.round(progress)}%`
                }
              >
                <span
                  style={
                    progress === null ? undefined : { width: `${progress}%` }
                  }
                />
              </div>
              {jobFailure ? (
                <div className="inline-alert inline-alert--error" role="alert">
                  {jobFailure}
                </div>
              ) : null}
              <div className="progress-counts">
                <span>
                  <strong>{successfulCount}</strong> concluídos
                </span>
                <span>
                  <strong>{activeJob.failed}</strong> falharam
                </span>
                <span>
                  <strong>{activeJob.skipped}</strong> ignorados
                </span>
              </div>
              {activeJob.currentFile ? (
                <p className="current-file" title={activeJob.currentFile}>
                  {shortPath(activeJob.currentFile)}
                </p>
              ) : null}
              <ol className="event-list">
                {jobEvents.map((event) => (
                  <li key={event.sequence}>
                    <span />
                    <div>
                      <strong>
                        {getOcrEventStatusPresentation(event).label}
                      </strong>
                      {event.file ? (
                        <small>{shortPath(event.file)}</small>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <div className="empty-state empty-state--small">
              <div className="pulse-mark" aria-hidden="true" />
              <strong>Nenhum lote em execução</strong>
              <p>Escolha as pastas de origem e saída para começar.</p>
            </div>
          )}
        </aside>
      </div>

      <div className="section-heading">
        <div>
          <span className="eyebrow">Biblioteca</span>
          <h2>Documentos processados</h2>
        </div>
        <span>
          {documents.filter((document) => document.resultAvailable).length}{' '}
          prontos para o Chat
        </span>
      </div>
      <div className="document-table card">
        {documents.length ? (
          <>
            {selectedIds.length ? (
              <div
                className="document-bulk-actions"
                role="group"
                aria-label="Ações para documentos selecionados"
              >
                <strong role="status" aria-live="polite">
                  {selectedIds.length}{' '}
                  {selectedIds.length === 1
                    ? 'documento selecionado'
                    : 'documentos selecionados'}
                </strong>
                <div>
                  <button
                    className="button button--secondary"
                    type="button"
                    disabled={selectionDisabled}
                    onClick={() => setSelectedDocumentIds(new Set())}
                  >
                    Limpar seleção
                  </button>
                  <button
                    className="button button--danger"
                    type="button"
                    disabled={selectionDisabled}
                    onClick={() => setBulkDeleteOpen(true)}
                  >
                    Excluir selecionados
                  </button>
                </div>
              </div>
            ) : null}
            <table>
              <thead>
                <tr>
                  <th className="document-table__select">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={allDocumentsSelected}
                      aria-checked={
                        someDocumentsSelected ? 'mixed' : allDocumentsSelected
                      }
                      aria-label={
                        allDocumentsSelected
                          ? 'Desmarcar todos os documentos'
                          : 'Selecionar todos os documentos'
                      }
                      disabled={selectionDisabled}
                      onChange={(event) =>
                        toggleAllDocuments(event.target.checked)
                      }
                    />
                  </th>
                  <th>ID</th>
                  <th>Documento</th>
                  <th>Status</th>
                  <th>Texto</th>
                  <th>Atualizado</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {sortedDocuments.map((document) => {
                  const selected = selectedDocumentIds.has(document.id)
                  return (
                    <tr
                      key={document.id}
                      className={selected ? 'is-selected' : undefined}
                      aria-selected={selected}
                    >
                      <td className="document-table__select">
                        <input
                          type="checkbox"
                          checked={selected}
                          aria-label={`${selected ? 'Desmarcar' : 'Selecionar'} documento ${shortPath(document.inputPath)}`}
                          disabled={selectionDisabled}
                          onChange={(event) =>
                            toggleDocumentSelection(
                              document.id,
                              event.target.checked
                            )
                          }
                        />
                      </td>
                      <td>
                        <span className="document-id">{document.id}</span>
                      </td>
                      <td>
                        <strong>{shortPath(document.inputPath)}</strong>
                        <small title={document.inputPath}>
                          {document.inputPath}
                        </small>
                        {document.latestError ? (
                          <em>{document.latestError}</em>
                        ) : null}
                        {document.latestWarning ? (
                          <em className="document-warning">
                            {document.latestWarning}
                          </em>
                        ) : null}
                      </td>
                      <td>
                        <span
                          className={`status status--${getOcrStatusPresentation(document.latestStatus).tone}`}
                        >
                          {
                            getOcrStatusPresentation(document.latestStatus)
                              .label
                          }
                        </span>
                      </td>
                      <td>
                        {document.resultAvailable
                          ? `${(document.text?.length ?? 0).toLocaleString('pt-BR')} caracteres`
                          : 'Indisponível'}
                      </td>
                      <td>
                        {document.updatedAt
                          ? new Date(document.updatedAt).toLocaleString('pt-BR')
                          : '—'}
                      </td>
                      <td>
                        <button
                          className="icon-button icon-button--danger"
                          type="button"
                          disabled={selectionDisabled}
                          aria-label={`Excluir documento ${shortPath(document.inputPath)}`}
                          title={
                            deletionBlocked
                              ? 'Aguarde a conclusão do lote de OCR para excluir documentos.'
                              : 'Excluir documento'
                          }
                          onClick={() => setDocumentToDelete(document)}
                        >
                          <TrashIcon />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </>
        ) : (
          <div className="empty-state">
            <FolderIcon />
            <strong>Nenhum documento processado</strong>
            <p>
              Resultados de OCR concluídos aparecerão aqui com IDs estáveis.
            </p>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={documentToDelete !== null && !bulkDeleteOpen}
        title="Excluir documento?"
        description={
          documentToDelete
            ? `“${shortPath(documentToDelete.inputPath)}” será removido da biblioteca e de novos chats. Os arquivos permanecerão no computador e as Threads antigas serão preservadas.`
            : ''
        }
        confirmLabel="Excluir documento"
        cancelLabel="Cancelar"
        danger
        busy={deletingDocumentId !== null}
        onConfirm={() => void confirmDocumentDeletion()}
        onCancel={() => setDocumentToDelete(null)}
      />
      <ConfirmDialog
        open={bulkDeleteOpen && selectedIds.length > 0}
        title={`Excluir ${selectedIds.length} ${selectedIds.length === 1 ? 'documento' : 'documentos'}?`}
        description={`${selectedIds.length === 1 ? 'O documento selecionado será removido' : `Os ${selectedIds.length} documentos selecionados serão removidos`} da biblioteca e de novos chats. Os arquivos permanecerão no computador e as Threads antigas serão preservadas.`}
        confirmLabel={
          selectedIds.length === 1 ? 'Excluir documento' : 'Excluir documentos'
        }
        cancelLabel="Cancelar"
        danger
        busy={deletingMany}
        onConfirm={() => void confirmBulkDeletion()}
        onCancel={() => setBulkDeleteOpen(false)}
      />
    </section>
  )
}
