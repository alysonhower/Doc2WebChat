import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { PyWebviewApi } from '../api/contracts'
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
      />
    )

    await user.click(
      screen.getByRole('button', { name: /select source folder/i })
    )
    await user.click(
      screen.getByRole('button', { name: /select output folder/i })
    )
    await user.selectOptions(
      screen.getByLabelText('Existing output'),
      'overwrite'
    )
    await user.click(screen.getByRole('button', { name: /start ocr batch/i }))

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
      />
    )

    expect(screen.getByText('Working…')).toBeInTheDocument()
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
      />
    )

    expect(screen.getByText('25%')).toBeInTheDocument()
    expect(
      document.querySelector('.progress-track--indeterminate')
    ).not.toBeInTheDocument()
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
      />
    )

    expect(
      screen.getByRole('heading', { name: '3 files already exist' })
    ).toBeInTheDocument()
    expect(screen.getByText('C:\\output-from-event\\scan.pdf')).toBeVisible()
    expect(screen.getByText('C:\\output-from-event\\letter.pdf')).toBeVisible()
    expect(screen.getByText('and 1 more')).toBeVisible()
    expect(screen.getByText('Waiting for confirmation')).toBeInTheDocument()
    expect(screen.queryByText('Working…')).not.toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'Overwrite and process' })
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
      />
    )

    await user.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: /select source folder/i })
    )
    await user.click(
      screen.getByRole('button', { name: /select output folder/i })
    )
    await user.click(screen.getByRole('button', { name: /start ocr batch/i }))

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
      />
    )

    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The OCR server stopped unexpectedly.'
    )
    expect(screen.queryByText('Working…')).not.toBeInTheDocument()
    expect(
      document.querySelector('.progress-track--indeterminate')
    ).not.toBeInTheDocument()
  })
})
