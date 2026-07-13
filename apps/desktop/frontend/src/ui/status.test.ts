import { describe, expect, it } from 'vitest'
import {
  getInteractionStatusPresentation,
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

  it('maps OCR stages and safely humanizes unknown values', () => {
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
    expect(getOcrStatusPresentation('ocr_failed').label).toBe(
      'Status desconhecido'
    )
  })
})
