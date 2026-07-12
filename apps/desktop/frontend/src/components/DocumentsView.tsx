import { useMemo, useState } from 'react'
import { errorMessage, invoke } from '../api/client'
import type { AppEvent, DocumentRow, OcrJobState } from '../api/contracts'
import { ArrowIcon, FolderIcon, RefreshIcon } from './Icons'

interface DocumentsViewProps {
  documents: DocumentRow[]
  events: AppEvent[]
  activeJob: OcrJobState | null
  onJobStarted: (job: OcrJobState) => void
  onRefresh: () => Promise<void>
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
  onRefresh
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
    ['discovering', 'planning', 'starting-server'].includes(activeJob.status)
  const progress =
    activeJob?.total && !indeterminate
      ? Math.min(100, (processedCount / activeJob.total) * 100)
      : null
  const jobEvents = useMemo(
    () =>
      events
        .filter((event) => activeJob && event.jobId === activeJob.jobId)
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
      ? 'Waiting for confirmation'
      : activeJob?.status === 'failed'
        ? 'Failed'
        : activeJob?.status === 'interrupted'
          ? 'Interrupted'
          : progress === null
            ? 'Working…'
            : `${Math.round(progress)}%`

  return (
    <section className="page" aria-labelledby="documents-title">
      <header className="page-header">
        <div>
          <span className="eyebrow">OCR workspace</span>
          <h1 id="documents-title">Documents</h1>
          <p>
            Turn local documents into searchable PDFs and conversation-ready
            text.
          </p>
        </div>
        <button
          className="button button--secondary"
          type="button"
          onClick={() => void onRefresh()}
        >
          <RefreshIcon /> Refresh
        </button>
      </header>

      <div className="documents-layout">
        <div className="card import-card">
          <div className="card-heading">
            <div>
              <span className="step-number">01</span>
              <h2>Choose folders</h2>
            </div>
            <p>
              Source files stay local. Output PDFs mirror the source directory
              structure.
            </p>
          </div>
          <div className="folder-pair">
            <div className="folder-field">
              <label>Input folder</label>
              <button
                type="button"
                onClick={() => void chooseDirectory('input')}
              >
                <FolderIcon />
                <span>{inputPath || 'Select source folder'}</span>
              </button>
            </div>
            <ArrowIcon className="folder-pair__arrow" />
            <div className="folder-field">
              <label>Output folder</label>
              <button
                type="button"
                onClick={() => void chooseDirectory('output')}
              >
                <FolderIcon />
                <span>{outputPath || 'Select output folder'}</span>
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
              <span>Include subfolders</span>
            </label>
            <label>
              Existing output
              <select
                value={conflictPolicy}
                onChange={(event) =>
                  setConflictPolicy(event.target.value as typeof conflictPolicy)
                }
              >
                <option value="error">Ask before overwriting</option>
                <option value="skip">Skip existing</option>
                <option value="overwrite">Overwrite existing</option>
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
              {busy ? 'Starting…' : 'Start OCR batch'}
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
              <h2>Batch progress</h2>
            </div>
            {activeJob ? (
              <span className={`status status--${activeJob.status}`}>
                {activeJob.status}
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
                    <span className="eyebrow">Existing output</span>
                    <h3 id="overwrite-confirmation-title">
                      {visibleOverwriteConfirmation.conflictCount}{' '}
                      {visibleOverwriteConfirmation.conflictCount === 1
                        ? 'file already exists'
                        : 'files already exist'}
                    </h3>
                    <p>
                      Overwrite the listed output{' '}
                      {visibleOverwriteConfirmation.conflictCount === 1
                        ? 'file'
                        : 'files'}{' '}
                      and process this batch?
                    </p>
                  </div>
                  <ul aria-label="Conflicting outputs">
                    {visibleOverwriteConfirmation.conflictingOutputs.map(
                      (path) => (
                        <li key={path}>{path}</li>
                      )
                    )}
                    {visibleOverwriteConfirmation.conflictCount >
                    visibleOverwriteConfirmation.conflictingOutputs.length ? (
                      <li className="overwrite-confirmation__more">
                        and{' '}
                        {visibleOverwriteConfirmation.conflictCount -
                          visibleOverwriteConfirmation.conflictingOutputs
                            .length}{' '}
                        more
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
                      {busy ? 'Starting…' : 'Overwrite and process'}
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
                      Not now
                    </button>
                  </div>
                </div>
              ) : null}
              <div className="progress-summary">
                <strong>{progressLabel}</strong>
                <span>
                  {activeJob.status === 'awaiting-overwrite' &&
                  overwriteConfirmation
                    ? `${overwriteConfirmation.conflictCount} existing output${overwriteConfirmation.conflictCount === 1 ? '' : 's'}`
                    : activeJob.status === 'failed'
                      ? 'Batch stopped'
                      : activeJob.total
                        ? `${processedCount} of ${activeJob.total} files`
                        : 'Planning files'}
                </span>
              </div>
              <div
                className={`progress-track ${indeterminate ? 'progress-track--indeterminate' : ''}`}
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
                  <strong>{successfulCount}</strong> complete
                </span>
                <span>
                  <strong>{activeJob.failed}</strong> failed
                </span>
                <span>
                  <strong>{activeJob.skipped}</strong> skipped
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
                        {String(event.stage ?? event.status ?? event.type)}
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
              <strong>No batch running</strong>
              <p>Choose source and output folders to begin.</p>
            </div>
          )}
        </aside>
      </div>

      <div className="section-heading">
        <div>
          <span className="eyebrow">Library</span>
          <h2>Processed documents</h2>
        </div>
        <span>
          {documents.filter((document) => document.resultAvailable).length}{' '}
          ready for chat
        </span>
      </div>
      <div className="document-table card">
        {documents.length ? (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Document</th>
                <th>Status</th>
                <th>Text</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {[...documents]
                .sort((a, b) => a.id - b.id)
                .map((document) => (
                  <tr key={document.id}>
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
                    </td>
                    <td>
                      <span
                        className={`status status--${document.latestStatus}`}
                      >
                        {document.latestStatus}
                      </span>
                    </td>
                    <td>
                      {document.resultAvailable
                        ? `${(document.text?.length ?? 0).toLocaleString()} chars`
                        : 'Unavailable'}
                    </td>
                    <td>
                      {document.updatedAt
                        ? new Date(document.updatedAt).toLocaleString()
                        : '—'}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-state">
            <FolderIcon />
            <strong>No processed documents</strong>
            <p>Completed OCR results will appear here with stable IDs.</p>
          </div>
        )}
      </div>
    </section>
  )
}
