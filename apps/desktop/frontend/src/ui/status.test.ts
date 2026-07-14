import { describe, expect, it } from 'vitest'
import type { AppEvent, OcrEvent } from '../api/contracts'
import { validateOcrEvent } from '../api/contracts'
import {
  OCR_DOCUMENT_STATUSES,
  OCR_EVENT_STAGES,
  OCR_FILE_STAGES,
  OCR_FILE_STATUSES,
  OCR_JOB_STATUSES
} from '../api/ocr-contract.generated'
import type { OcrEventStage } from '../api/ocr-contract.generated'
import {
  getInteractionStatusPresentation,
  getOcrEventStatusPresentation,
  getOcrStatusPresentation
} from './status'

describe('status presentation', () => {
  it('maps interaction lifecycle states to actionable copy', () => {
    expect(getInteractionStatusPresentation('dispatched')).toMatchObject({
      label: 'Abrindo provedor',
      tone: 'info',
      active: true
    })
    expect(getInteractionStatusPresentation('prefilled').label).toBe(
      'Pronta para enviar'
    )
    expect(getInteractionStatusPresentation('awaiting-import').label).toBe(
      'Pronta para importar'
    )
    expect(getInteractionStatusPresentation('completed')).toMatchObject({
      label: 'Importada',
      tone: 'success',
      active: false
    })
    expect(getInteractionStatusPresentation('expired').guidance).toMatch(
      /novo Chat/i
    )
  })

  it('maps every accepted OCR status without an unknown fallback', () => {
    expect(getOcrStatusPresentation('discovering').label).toBe(
      'Procurando arquivos'
    )
    expect(getOcrStatusPresentation('planning').label).toBe(
      'Verificando saídas'
    )
    expect(getOcrStatusPresentation('completed-with-errors')).toMatchObject({
      label: 'Concluído com problemas',
      tone: 'warning'
    })
    expect(getOcrStatusPresentation('ocr-failed').label).toBe('OCR falhou')
    expect(getOcrStatusPresentation('ocr-processing')).toMatchObject({
      label: 'Processando',
      tone: 'info'
    })
    expect(getOcrStatusPresentation('batch-failed').guidance).not.toBe('')
    expect(getOcrStatusPresentation('overwrite-confirmed').label).toBe(
      'Substituição confirmada'
    )

    const statuses = new Set([
      ...OCR_JOB_STATUSES,
      ...OCR_DOCUMENT_STATUSES,
      ...OCR_FILE_STAGES,
      ...OCR_FILE_STATUSES
    ])
    for (const status of statuses) {
      const presentation = getOcrStatusPresentation(status)
      expect(presentation.label).not.toBe('Status desconhecido')
      expect(presentation.label.trim()).not.toBe('')
      expect(presentation.guidance.trim()).not.toBe('')
    }
  })

  it('maps OCR orchestration events to their displayed status', () => {
    expect(
      getOcrEventStatusPresentation({
        sequence: 1,
        type: 'ocr',
        jobId: 1,
        stage: 'progress'
      })
    ).toMatchObject({ label: 'Processando', tone: 'info' })
    expect(
      getOcrEventStatusPresentation({
        sequence: 2,
        type: 'ocr',
        jobId: 1,
        stage: 'job-finished',
        status: 'completed'
      })
    ).toMatchObject({ label: 'Concluído', tone: 'success' })
    expect(
      getOcrEventStatusPresentation({
        sequence: 3,
        type: 'ocr',
        jobId: 1,
        stage: 'job-finished',
        status: 'completed-with-errors'
      })
    ).toMatchObject({ label: 'Concluído com problemas', tone: 'warning' })
  })

  it('provides a presentation for every contracted OCR event', () => {
    const base = { sequence: 1, type: 'ocr' as const, jobId: 1 }
    const events = {
      discovery: { ...base, stage: 'discovery' },
      'plan-validation': { ...base, stage: 'plan-validation' },
      'overwrite-confirmation-required': {
        ...base,
        stage: 'overwrite-confirmation-required'
      },
      queued: { ...base, stage: 'queued' },
      'server-startup': { ...base, stage: 'server-startup' },
      'ocr-processing': { ...base, stage: 'ocr-processing' },
      writing: { ...base, stage: 'writing' },
      extracting: { ...base, stage: 'extracting' },
      persisting: { ...base, stage: 'persisting' },
      completed: { ...base, stage: 'completed' },
      failed: { ...base, stage: 'failed' },
      skipped: { ...base, stage: 'skipped' },
      progress: { ...base, stage: 'progress' },
      'job-finished': {
        ...base,
        stage: 'job-finished',
        status: 'completed'
      },
      'job-failed': { ...base, stage: 'job-failed' }
    } satisfies Record<OcrEventStage, OcrEvent>

    expect(Object.keys(events)).toEqual([...OCR_EVENT_STAGES])
    for (const event of Object.values(events)) {
      const presentation = getOcrEventStatusPresentation(event)
      expect(presentation.label).not.toBe('Status desconhecido')
      expect(presentation.guidance.trim()).not.toBe('')
    }
  })

  it('rejects unknown OCR events at the frontend boundary', () => {
    const invalid = {
      sequence: 1,
      type: 'ocr',
      jobId: 1,
      stage: 'future-stage'
    } as unknown as AppEvent
    expect(() => validateOcrEvent(invalid)).toThrow(/contract violation/i)
  })
})
