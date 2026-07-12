import { describe, expect, it } from 'vitest'
import {
  getInteractionStatusPresentation,
  getOcrStatusPresentation
} from './status'

describe('status presentation', () => {
  it('maps interaction lifecycle states to actionable copy', () => {
    expect(getInteractionStatusPresentation('dispatched')).toMatchObject({
      label: 'Opening provider',
      tone: 'info',
      active: true
    })
    expect(getInteractionStatusPresentation('prefilled').label).toBe(
      'Ready to submit'
    )
    expect(getInteractionStatusPresentation('awaiting-import').label).toBe(
      'Ready to import'
    )
    expect(getInteractionStatusPresentation('completed')).toMatchObject({
      label: 'Imported',
      tone: 'success',
      active: false
    })
    expect(getInteractionStatusPresentation('expired').guidance).toMatch(
      /start a new chat/i
    )
  })

  it('maps OCR stages and safely humanizes unknown values', () => {
    expect(getOcrStatusPresentation('discovering').label).toBe('Finding files')
    expect(getOcrStatusPresentation('planning').label).toBe('Checking outputs')
    expect(getOcrStatusPresentation('completed-with-errors')).toMatchObject({
      label: 'Completed with issues',
      tone: 'warning'
    })
    expect(getOcrStatusPresentation('ocr_failed').label).toBe('Ocr failed')
  })
})
