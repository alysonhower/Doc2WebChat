import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage, invoke } from '../api/client'
import type {
  AppEvent,
  BootstrapState,
  BrowserRow,
  DocumentRow,
  InteractionRow,
  OcrJobState,
  PromptRow
} from '../api/contracts'

function ocrStatus(event: AppEvent, previous: OcrJobState | null): string {
  const stage = String(event.stage ?? '')
  if (stage === 'overwrite-confirmation-required') return 'awaiting-overwrite'
  if (stage === 'job-finished') return String(event.status ?? 'completed')
  if (stage === 'job-failed') return 'failed'
  if (stage === 'discovery') return 'discovering'
  if (stage === 'plan-validation') return 'planning'
  if (stage === 'server-startup') return 'starting-server'
  if (stage) return 'running'
  return String(event.status ?? previous?.status ?? 'running')
}

export interface DesktopState {
  bootstrap: BootstrapState | null
  loading: boolean
  error: string | null
  events: AppEvent[]
  activeJob: OcrJobState | null
}

export function useDesktopState() {
  const [state, setState] = useState<DesktopState>({
    bootstrap: null,
    loading: true,
    error: null,
    events: [],
    activeJob: null
  })
  const sequence = useRef(0)
  const mounted = useRef(true)
  const ready = state.bootstrap !== null

  const load = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }))
    try {
      const bootstrap = await invoke((api) => api.get_bootstrap_state())
      if (!mounted.current) return
      setState((current) => ({
        ...current,
        bootstrap,
        activeJob: bootstrap.activeJob ?? null,
        loading: false
      }))
    } catch (error) {
      if (!mounted.current) return
      setState((current) => ({
        ...current,
        error: errorMessage(error),
        loading: false
      }))
    }
  }, [])

  const refreshDocuments = useCallback(async () => {
    const value = await invoke((api) => api.list_documents())
    const documents = Array.isArray(value) ? value : value.documents
    setState((current) =>
      current.bootstrap
        ? {
            ...current,
            bootstrap: { ...current.bootstrap, documents }
          }
        : current
    )
  }, [])

  const refreshHistory = useCallback(async () => {
    const value = await invoke((api) => api.list_history())
    const history = Array.isArray(value) ? value : value.history
    setState((current) =>
      current.bootstrap
        ? {
            ...current,
            bootstrap: { ...current.bootstrap, history }
          }
        : current
    )
  }, [])

  const refreshBrowsers = useCallback(async () => {
    const value = await invoke((api) => api.list_browsers())
    const browsers = Array.isArray(value) ? value : value.browsers
    setState((current) =>
      current.bootstrap
        ? {
            ...current,
            bootstrap: { ...current.bootstrap, browsers }
          }
        : current
    )
  }, [])

  const replacePrompts = useCallback((prompts: PromptRow[]) => {
    setState((current) =>
      current.bootstrap
        ? {
            ...current,
            bootstrap: { ...current.bootstrap, prompts }
          }
        : current
    )
  }, [])

  const setActiveJob = useCallback((activeJob: OcrJobState | null) => {
    setState((current) => ({ ...current, activeJob }))
  }, [])

  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
    }
  }, [load])

  useEffect(() => {
    if (!ready) return
    let cancelled = false
    let timer: number | undefined

    const poll = async () => {
      while (!cancelled) {
        try {
          const value = await invoke((api) =>
            api.poll_events({ after: sequence.current, timeoutMs: 20_000 })
          )
          if (cancelled) return
          sequence.current = Math.max(sequence.current, value.nextSequence)
          if (value.events.length) {
            setState((current) => ({
              ...current,
              events: [...current.events, ...value.events].slice(-200)
            }))
            let documentsChanged = false
            let historyChanged = false
            let browsersChanged = false
            for (const event of value.events) {
              const eventType = event.type.toLocaleLowerCase()
              const action = String(event.action ?? '').toLocaleLowerCase()
              if (event.jobId) {
                setState((current) => {
                  const previous = current.activeJob
                  const status = ocrStatus(event, previous)
                  return {
                    ...current,
                    activeJob: {
                      jobId: event.jobId!,
                      status,
                      completed: Number(
                        event.completed ?? previous?.completed ?? 0
                      ),
                      failed: Number(event.failed ?? previous?.failed ?? 0),
                      skipped: Number(event.skipped ?? previous?.skipped ?? 0),
                      total:
                        event.total === undefined
                          ? previous?.total
                          : Number(event.total),
                      currentFile: event.file ?? previous?.currentFile,
                      overwriteConfirmationJobId:
                        event.overwriteConfirmationJobId ??
                        previous?.overwriteConfirmationJobId,
                      inputPath: event.inputPath ?? previous?.inputPath,
                      outputPath: event.outputPath ?? previous?.outputPath,
                      recursive: event.recursive ?? previous?.recursive,
                      conflictCount:
                        event.conflictCount ?? previous?.conflictCount,
                      conflictingOutputs:
                        event.conflictingOutputs ?? previous?.conflictingOutputs
                    }
                  }
                })
                if (
                  ['job-finished', 'job-failed'].includes(String(event.stage))
                )
                  documentsChanged = true
              }
              if (
                [
                  'completed',
                  'failed',
                  'skipped',
                  'persisting',
                  'job-finished',
                  'job-failed'
                ].includes(String(event.stage))
              )
                documentsChanged = true
              if (
                event.interactionId ||
                event.interaction_id ||
                ['bridge', 'chat'].includes(eventType) ||
                /prefill|response|import/.test(action)
              )
                historyChanged = true
              if (eventType.includes('browser')) browsersChanged = true
            }
            if (documentsChanged) void refreshDocuments()
            if (historyChanged) void refreshHistory()
            if (browsersChanged) void refreshBrowsers()
          } else {
            await new Promise<void>((resolve) => {
              timer = window.setTimeout(resolve, 250)
            })
          }
        } catch (error) {
          if (cancelled) return
          setState((current) => ({ ...current, error: errorMessage(error) }))
          await new Promise<void>((resolve) => {
            timer = window.setTimeout(resolve, 1_500)
          })
        }
      }
    }
    void poll()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [ready, refreshBrowsers, refreshDocuments, refreshHistory])

  useEffect(() => {
    if (!ready) return
    const timer = window.setInterval(
      () => void refreshBrowsers().catch(() => undefined),
      5_000
    )
    return () => window.clearInterval(timer)
  }, [ready, refreshBrowsers])

  const replaceDocuments = useCallback((documents: DocumentRow[]) => {
    setState((current) =>
      current.bootstrap
        ? { ...current, bootstrap: { ...current.bootstrap, documents } }
        : current
    )
  }, [])
  const replaceHistory = useCallback((history: InteractionRow[]) => {
    setState((current) =>
      current.bootstrap
        ? { ...current, bootstrap: { ...current.bootstrap, history } }
        : current
    )
  }, [])
  const replaceBrowsers = useCallback((browsers: BrowserRow[]) => {
    setState((current) =>
      current.bootstrap
        ? { ...current, bootstrap: { ...current.bootstrap, browsers } }
        : current
    )
  }, [])

  return {
    ...state,
    reload: load,
    refreshDocuments,
    refreshHistory,
    refreshBrowsers,
    replaceDocuments,
    replaceHistory,
    replaceBrowsers,
    replacePrompts,
    setActiveJob,
    clearError: () => setState((current) => ({ ...current, error: null }))
  }
}
