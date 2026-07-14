import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { DocumentRow, OcrEvent, PyWebviewApi } from '../api/contracts'
import { DocumentsView } from './DocumentsView'

describe('DocumentsView', () => {
  it('uses separate native folder purposes and forwards explicit OCR options', async () => {
    const user = userEvent.setup()
    const selectDirectory = vi.fn(
      async ({ purpose }: { purpose: 'input' | 'output' }) => ({
        ok: true as const,
        value: { path: purpose === 'input' ? 'C:\\source' : 'C:\\output' }
      })
    )
    const startOcr = vi.fn(async () => ({
      ok: true as const,
      value: { jobId: 'job-1' }
    }))
    window.pywebview = {
      api: {
        select_directory: selectDirectory,
        start_ocr_job: startOcr
      } as unknown as PyWebviewApi
    }
    const onJobStarted = vi.fn()
    render(
      <DocumentsView
        documents={[]}
        events={[]}
        activeJob={null}
        onJobStarted={onJobStarted}
        onRefresh={vi.fn()}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn()}
      />
    )

    await user.click(
      screen.getByRole('button', { name: /selecionar pasta de origem/i })
    )
    await user.click(
      screen.getByRole('button', { name: /selecionar pasta de saída/i })
    )
    await user.selectOptions(
      screen.getByLabelText('Saída existente'),
      'overwrite'
    )
    await user.click(
      screen.getByRole('button', { name: /iniciar lote de ocr/i })
    )

    expect(selectDirectory).toHaveBeenNthCalledWith(1, { purpose: 'input' })
    expect(selectDirectory).toHaveBeenNthCalledWith(2, { purpose: 'output' })
    expect(startOcr).toHaveBeenCalledWith({
      inputPath: 'C:\\source',
      outputPath: 'C:\\output',
      recursive: true,
      conflictPolicy: 'overwrite'
    })
    expect(onJobStarted).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', status: 'discovering' })
    )
  })

  it('keeps discovery and server startup progress indeterminate even when a total is known', () => {
    const { rerender } = render(
      <DocumentsView
        documents={[]}
        events={[]}
        activeJob={{
          jobId: 'job-1',
          status: 'starting-server',
          completed: 0,
          failed: 0,
          skipped: 0,
          total: 8
        }}
        onJobStarted={vi.fn()}
        onRefresh={vi.fn()}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn()}
      />
    )

    expect(screen.getByText('Iniciando OCR')).toBeInTheDocument()
    expect(
      screen.getByText(
        'O primeiro download do mecanismo OCR pode levar vários minutos'
      )
    ).toBeInTheDocument()
    const indeterminateProgress = screen.getByRole('progressbar')
    expect(indeterminateProgress).not.toHaveAttribute('aria-valuenow')
    expect(indeterminateProgress).toHaveAttribute(
      'aria-valuetext',
      'Iniciando OCR'
    )
    expect(
      document.querySelector('.progress-track--indeterminate')
    ).toBeInTheDocument()

    rerender(
      <DocumentsView
        documents={[]}
        events={[]}
        activeJob={{
          jobId: 'job-1',
          status: 'running',
          completed: 2,
          failed: 0,
          skipped: 0,
          total: 8
        }}
        onJobStarted={vi.fn()}
        onRefresh={vi.fn()}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn()}
      />
    )

    expect(screen.getByText('25%')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '25'
    )
    expect(
      document.querySelector('.progress-track--indeterminate')
    ).not.toBeInTheDocument()
  })

  it('reports an empty planned batch as determinate and complete', () => {
    render(
      <DocumentsView
        documents={[]}
        events={[]}
        activeJob={{
          jobId: 'job-empty',
          status: 'completed',
          completed: 0,
          failed: 0,
          skipped: 0,
          total: 0
        }}
        onJobStarted={vi.fn()}
        onRefresh={vi.fn()}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn()}
      />
    )

    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '100'
    )
  })

  it('asks before overwriting conflicts and retries with event metadata', async () => {
    const user = userEvent.setup()
    const startOcr = vi.fn(async () => ({
      ok: true as const,
      value: { jobId: 'overwrite-job' }
    }))
    window.pywebview = {
      api: { start_ocr_job: startOcr } as unknown as PyWebviewApi
    }
    const onJobStarted = vi.fn()
    render(
      <DocumentsView
        documents={[]}
        events={[
          {
            sequence: 17,
            type: 'ocr',
            jobId: 'conflict-job',
            stage: 'overwrite-confirmation-required',
            inputPath: 'C:\\source-from-event',
            outputPath: 'C:\\output-from-event',
            recursive: false,
            conflictCount: 3,
            overwriteConfirmationJobId: 'confirmation-17',
            conflictingOutputs: [
              'C:\\output-from-event\\scan.pdf',
              'C:\\output-from-event\\letter.pdf'
            ]
          }
        ]}
        activeJob={{
          jobId: 'conflict-job',
          status: 'awaiting-overwrite',
          completed: 0,
          failed: 0,
          skipped: 0,
          total: 2
        }}
        onJobStarted={onJobStarted}
        onRefresh={vi.fn()}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn()}
      />
    )

    expect(
      screen.getByRole('heading', { name: '3 arquivos já existem' })
    ).toBeInTheDocument()
    expect(screen.getByText('C:\\output-from-event\\scan.pdf')).toBeVisible()
    expect(screen.getByText('C:\\output-from-event\\letter.pdf')).toBeVisible()
    expect(screen.getByText('e mais 1 arquivo')).toBeVisible()
    expect(screen.getByText('Aguardando confirmação')).toBeInTheDocument()
    expect(screen.queryByText('Processando…')).not.toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'Sobrescrever e processar' })
    )

    expect(startOcr).toHaveBeenCalledWith({
      inputPath: 'C:\\source-from-event',
      outputPath: 'C:\\output-from-event',
      recursive: false,
      conflictPolicy: 'error',
      overwriteConfirmationJobId: 'confirmation-17'
    })
    expect(onJobStarted).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'overwrite-job',
        status: 'discovering'
      })
    )
  })

  it('dismisses overwrite confirmation without blocking a later batch', async () => {
    const user = userEvent.setup()
    const selectDirectory = vi.fn(
      async ({ purpose }: { purpose: 'input' | 'output' }) => ({
        ok: true as const,
        value: {
          path:
            purpose === 'input' ? 'C:\\another-source' : 'C:\\another-output'
        }
      })
    )
    const startOcr = vi.fn(async () => ({
      ok: true as const,
      value: { jobId: 'later-job' }
    }))
    window.pywebview = {
      api: {
        select_directory: selectDirectory,
        start_ocr_job: startOcr
      } as unknown as PyWebviewApi
    }
    render(
      <DocumentsView
        documents={[]}
        events={[
          {
            sequence: 3,
            type: 'ocr',
            jobId: 'conflict-job',
            stage: 'overwrite-confirmation-required',
            inputPath: 'C:\\old-source',
            outputPath: 'C:\\old-output',
            recursive: true,
            conflictCount: 1,
            overwriteConfirmationJobId: 'confirmation-3',
            conflictingOutputs: ['C:\\old-output\\scan.pdf']
          }
        ]}
        activeJob={{
          jobId: 'conflict-job',
          status: 'awaiting-overwrite',
          completed: 0,
          failed: 0,
          skipped: 0,
          total: 1
        }}
        onJobStarted={vi.fn()}
        onRefresh={vi.fn()}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Agora não' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Revisar conflitos' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Agora não' }))

    await user.click(
      screen.getByRole('button', { name: /selecionar pasta de origem/i })
    )
    await user.click(
      screen.getByRole('button', { name: /selecionar pasta de saída/i })
    )
    await user.click(
      screen.getByRole('button', { name: /iniciar lote de ocr/i })
    )

    expect(startOcr).toHaveBeenCalledWith({
      inputPath: 'C:\\another-source',
      outputPath: 'C:\\another-output',
      recursive: true,
      conflictPolicy: 'error'
    })
  })

  it('shows genuine job failures instead of leaving progress working', () => {
    render(
      <DocumentsView
        documents={[]}
        events={[
          {
            sequence: 8,
            type: 'ocr',
            jobId: 'failed-job',
            stage: 'job-failed',
            error: 'The OCR server stopped unexpectedly.'
          }
        ]}
        activeJob={{
          jobId: 'failed-job',
          status: 'failed',
          completed: 0,
          failed: 1,
          skipped: 0,
          total: null
        }}
        onJobStarted={vi.fn()}
        onRefresh={vi.fn()}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn()}
      />
    )

    expect(screen.getAllByText('Falhou')).toHaveLength(2)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The OCR server stopped unexpectedly.'
    )
    expect(screen.queryByText('Processando…')).not.toBeInTheDocument()
    expect(
      document.querySelector('.progress-track--indeterminate')
    ).not.toBeInTheDocument()
  })

  it('renders a complete successful OCR sequence without unknown statuses', () => {
    const base = { type: 'ocr' as const, jobId: 'complete-job' }
    const events: OcrEvent[] = [
      { ...base, sequence: 1, stage: 'discovery' },
      { ...base, sequence: 2, stage: 'plan-validation' },
      { ...base, sequence: 3, stage: 'queued', file: 'test/5.png' },
      { ...base, sequence: 4, stage: 'server-startup' },
      { ...base, sequence: 5, stage: 'ocr-processing', file: 'test/5.png' },
      { ...base, sequence: 6, stage: 'writing', file: 'test/5.png' },
      { ...base, sequence: 7, stage: 'extracting', file: 'test/5.png' },
      { ...base, sequence: 8, stage: 'persisting', file: 'test/5.png' },
      { ...base, sequence: 9, stage: 'completed', file: 'test/5.png' },
      {
        ...base,
        sequence: 10,
        stage: 'progress',
        completed: 1,
        failed: 0,
        skipped: 0,
        total: 1
      },
      {
        ...base,
        sequence: 11,
        stage: 'job-finished',
        status: 'completed',
        completed: 1,
        failed: 0,
        skipped: 0,
        total: 1
      }
    ]

    render(
      <DocumentsView
        documents={[]}
        events={events}
        activeJob={{
          jobId: 'complete-job',
          status: 'completed',
          completed: 1,
          failed: 0,
          skipped: 0,
          total: 1
        }}
        onJobStarted={vi.fn()}
        onRefresh={vi.fn()}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn()}
      />
    )

    expect(screen.queryByText('Status desconhecido')).not.toBeInTheDocument()
    expect(screen.getByText('Gravando PDF')).toBeInTheDocument()
    expect(screen.getByText('Extraindo texto')).toBeInTheDocument()
    expect(screen.getByText('Salvando resultado')).toBeInTheDocument()
    expect(screen.getAllByText('Concluído')).toHaveLength(3)
  })

  it('uses friendly document statuses and shows recorded warnings', () => {
    render(
      <DocumentsView
        documents={[
          {
            id: 4,
            inputPath: 'C:\\source\\scan.pdf',
            resultAvailable: true,
            text: 'searchable',
            latestStatus: 'extract-failed',
            latestWarning: 'Text extraction omitted one blank page.'
          }
        ]}
        events={[]}
        activeJob={null}
        onJobStarted={vi.fn()}
        onRefresh={vi.fn()}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn()}
      />
    )

    expect(screen.getByText('Falha ao extrair texto')).toBeInTheDocument()
    expect(
      screen.getByText('Text extraction omitted one blank page.')
    ).toBeInTheDocument()
  })

  it('confirms document deletion without promising to delete local files', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn(async () => undefined)
    render(
      <DocumentsView
        documents={[
          {
            id: 7,
            inputPath: 'C:\\source\\scan.pdf',
            outputPath: 'C:\\output\\scan.pdf',
            resultAvailable: true,
            text: 'searchable',
            latestStatus: 'completed'
          }
        ]}
        events={[]}
        activeJob={null}
        onJobStarted={vi.fn()}
        onRefresh={vi.fn()}
        onDelete={onDelete}
        onDeleteMany={vi.fn()}
      />
    )

    const trigger = screen.getByRole('button', {
      name: 'Excluir documento source/scan.pdf'
    })
    await user.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Excluir documento?' })
    expect(dialog).toHaveTextContent('Os arquivos permanecerão no computador')
    expect(dialog).toHaveTextContent('Threads antigas serão preservadas')
    await user.click(screen.getByRole('button', { name: 'Excluir documento' }))

    expect(onDelete).toHaveBeenCalledWith(7)
  })

  it('keeps document deletion disabled while OCR is active', () => {
    render(
      <DocumentsView
        documents={[
          {
            id: 8,
            inputPath: 'C:\\source\\active.pdf',
            resultAvailable: true,
            latestStatus: 'completed'
          }
        ]}
        events={[]}
        activeJob={{
          jobId: 'active-job',
          status: 'running',
          completed: 0,
          failed: 0,
          skipped: 0,
          total: 1
        }}
        onJobStarted={vi.fn()}
        onRefresh={vi.fn()}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn()}
      />
    )

    expect(
      screen.getByRole('button', {
        name: 'Excluir documento source/active.pdf'
      })
    ).toBeDisabled()
  })

  it('supports partial selection and exposes mixed select-all semantics', async () => {
    const user = userEvent.setup()
    render(
      <DocumentsView
        documents={[
          {
            id: 3,
            inputPath: 'C:\\source\\three.pdf',
            resultAvailable: true,
            latestStatus: 'completed'
          },
          {
            id: 1,
            inputPath: 'C:\\source\\one.pdf',
            resultAvailable: true,
            latestStatus: 'completed'
          }
        ]}
        events={[]}
        activeJob={null}
        onJobStarted={vi.fn()}
        onRefresh={vi.fn()}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn()}
      />
    )

    const selectAll = screen.getByRole('checkbox', {
      name: 'Selecionar todos os documentos'
    }) as HTMLInputElement
    await user.click(
      screen.getByRole('checkbox', {
        name: 'Selecionar documento source/three.pdf'
      })
    )

    expect(selectAll.indeterminate).toBe(true)
    expect(selectAll).toHaveAttribute('aria-checked', 'mixed')
    expect(screen.getByText('1 documento selecionado')).toBeInTheDocument()

    await user.click(selectAll)
    expect(selectAll).toBeChecked()
    expect(selectAll.indeterminate).toBe(false)
    expect(screen.getByText('2 documentos selecionados')).toBeInTheDocument()
  })

  it('cancels bulk deletion and explains preserved files and Threads', async () => {
    const user = userEvent.setup()
    const onDeleteMany = vi.fn(async () => undefined)
    render(
      <DocumentsView
        documents={[
          {
            id: 1,
            inputPath: 'C:\\source\\one.pdf',
            resultAvailable: true,
            latestStatus: 'completed'
          },
          {
            id: 2,
            inputPath: 'C:\\source\\two.pdf',
            resultAvailable: true,
            latestStatus: 'completed'
          }
        ]}
        events={[]}
        activeJob={null}
        onJobStarted={vi.fn()}
        onRefresh={vi.fn()}
        onDelete={vi.fn()}
        onDeleteMany={onDeleteMany}
      />
    )

    await user.click(
      screen.getByRole('checkbox', { name: 'Selecionar todos os documentos' })
    )
    await user.click(
      screen.getByRole('button', { name: 'Excluir selecionados' })
    )
    const dialog = screen.getByRole('dialog', { name: 'Excluir 2 documentos?' })
    expect(dialog).toHaveTextContent('arquivos permanecerão no computador')
    expect(dialog).toHaveTextContent('Threads antigas serão preservadas')
    await user.click(screen.getByRole('button', { name: 'Cancelar' }))

    expect(onDeleteMany).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText('2 documentos selecionados')).toBeInTheDocument()
  })

  it('deletes selected documents atomically with ordered IDs', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn(async () => undefined)
    const onDeleteMany = vi.fn(async () => undefined)
    const { rerender } = render(
      <DocumentsView
        documents={[
          {
            id: 9,
            inputPath: 'C:\\source\\nine.pdf',
            resultAvailable: true,
            latestStatus: 'completed'
          },
          {
            id: 2,
            inputPath: 'C:\\source\\two.pdf',
            resultAvailable: true,
            latestStatus: 'completed'
          }
        ]}
        events={[]}
        activeJob={null}
        onJobStarted={vi.fn()}
        onRefresh={vi.fn()}
        onDelete={onDelete}
        onDeleteMany={onDeleteMany}
      />
    )

    await user.click(
      screen.getByRole('checkbox', { name: 'Selecionar todos os documentos' })
    )
    await user.click(
      screen.getByRole('button', { name: 'Excluir selecionados' })
    )
    await user.click(screen.getByRole('button', { name: 'Excluir documentos' }))

    expect(onDeleteMany).toHaveBeenCalledTimes(1)
    expect(onDeleteMany).toHaveBeenCalledWith([2, 9])
    expect(onDelete).not.toHaveBeenCalled()
    expect(screen.queryByText(/documentos? selecionados/)).toBeNull()

    await user.click(
      screen.getByRole('checkbox', {
        name: 'Selecionar documento source/two.pdf'
      })
    )
    rerender(
      <DocumentsView
        documents={[
          {
            id: 9,
            inputPath: 'C:\\source\\nine.pdf',
            resultAvailable: true,
            latestStatus: 'completed'
          }
        ]}
        events={[]}
        activeJob={null}
        onJobStarted={vi.fn()}
        onRefresh={vi.fn()}
        onDelete={vi.fn()}
        onDeleteMany={onDeleteMany}
      />
    )
    expect(screen.queryByText(/documentos? selecionados/)).toBeNull()
  })

  it('disables all selection and bulk deletion controls while OCR is active', async () => {
    const user = userEvent.setup()
    const documents: DocumentRow[] = [
      {
        id: 1,
        inputPath: 'C:\\source\\one.pdf',
        resultAvailable: true,
        latestStatus: 'completed'
      }
    ]
    const { rerender } = render(
      <DocumentsView
        documents={documents}
        events={[]}
        activeJob={null}
        onJobStarted={vi.fn()}
        onRefresh={vi.fn()}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn()}
      />
    )
    await user.click(
      screen.getByRole('checkbox', {
        name: 'Selecionar documento source/one.pdf'
      })
    )

    rerender(
      <DocumentsView
        documents={documents}
        events={[]}
        activeJob={{
          jobId: 8,
          status: 'running',
          completed: 0,
          failed: 0,
          skipped: 0,
          total: 1
        }}
        onJobStarted={vi.fn()}
        onRefresh={vi.fn()}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn()}
      />
    )

    expect(
      screen.getByRole('checkbox', { name: /todos os documentos/ })
    ).toBeDisabled()
    expect(
      screen.getByRole('checkbox', {
        name: /documento source\/one\.pdf/
      })
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Excluir selecionados' })
    ).toBeDisabled()
  })
})
