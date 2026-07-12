import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { BootstrapState, PyWebviewApi } from './api/contracts'
import App from './App'

describe('App', () => {
  it('bootstraps through pywebview and applies sequenced OCR polling events', async () => {
    const bootstrap: BootstrapState = {
      documents: [],
      prompts: [],
      browsers: [],
      providers: [],
      history: [],
      preferences: {},
      activeJob: null
    }
    let pollCount = 0
    const pollEvents = vi.fn(async () => {
      pollCount += 1
      if (pollCount === 1)
        return {
          ok: true as const,
          value: {
            nextSequence: 1,
            events: [
              {
                sequence: 1,
                type: 'ocr',
                jobId: 4,
                stage: 'progress',
                completed: 1,
                failed: 0,
                skipped: 0,
                total: 3
              }
            ]
          }
        }
      return new Promise<never>(() => undefined)
    })
    window.pywebview = {
      api: {
        get_bootstrap_state: vi.fn(async () => ({
          ok: true as const,
          value: bootstrap
        })),
        poll_events: pollEvents,
        list_documents: vi.fn(async () => ({
          ok: true as const,
          value: { documents: [] }
        }))
      } as unknown as PyWebviewApi
    }

    render(<App />)
    expect(
      await screen.findByRole('heading', { name: 'Documents' })
    ).toBeInTheDocument()
    expect(await screen.findByText('1 of 3 files')).toBeInTheDocument()
    expect(screen.getByText('running')).toBeInTheDocument()
    expect(pollEvents).toHaveBeenCalledWith({ after: 0, timeoutMs: 20_000 })
  })

  it('maps overwrite conflict events to the awaiting-overwrite state', async () => {
    const bootstrap: BootstrapState = {
      documents: [],
      prompts: [],
      browsers: [],
      providers: [],
      history: [],
      preferences: {},
      activeJob: null
    }
    let pollCount = 0
    window.pywebview = {
      api: {
        get_bootstrap_state: vi.fn(async () => ({
          ok: true as const,
          value: bootstrap
        })),
        poll_events: vi.fn(async () => {
          pollCount += 1
          if (pollCount === 1)
            return {
              ok: true as const,
              value: {
                nextSequence: 1,
                events: [
                  {
                    sequence: 1,
                    type: 'ocr',
                    jobId: 7,
                    stage: 'overwrite-confirmation-required',
                    inputPath: 'C:\\source',
                    outputPath: 'C:\\output',
                    recursive: true,
                    conflictCount: 1,
                    overwriteConfirmationJobId: 7,
                    conflictingOutputs: ['C:\\output\\scan.pdf']
                  }
                ]
              }
            }
          return new Promise<never>(() => undefined)
        })
      } as unknown as PyWebviewApi
    }

    render(<App />)

    expect(
      await screen.findByRole('heading', { name: '1 file already exists' })
    ).toBeInTheDocument()
    expect(screen.getByText('awaiting-overwrite')).toBeInTheDocument()
    expect(screen.getByText('Waiting for confirmation')).toBeInTheDocument()
  })

  it('restores overwrite confirmation from bootstrap without an event', async () => {
    const bootstrap: BootstrapState = {
      documents: [],
      prompts: [],
      browsers: [],
      providers: [],
      history: [],
      preferences: {},
      activeJob: {
        jobId: 12,
        status: 'awaiting-overwrite',
        completed: 0,
        failed: 0,
        skipped: 0,
        total: 2,
        overwriteConfirmationJobId: 12,
        inputPath: 'C:\\restored-source',
        outputPath: 'C:\\restored-output',
        recursive: true,
        conflictCount: 2,
        conflictingOutputs: [
          'C:\\restored-output\\scan.pdf',
          'C:\\restored-output\\letter.pdf'
        ]
      }
    }
    window.pywebview = {
      api: {
        get_bootstrap_state: vi.fn(async () => ({
          ok: true as const,
          value: bootstrap
        })),
        poll_events: vi.fn(() => new Promise<never>(() => undefined))
      } as unknown as PyWebviewApi
    }

    render(<App />)

    expect(
      await screen.findByRole('heading', { name: '2 files already exist' })
    ).toBeInTheDocument()
    expect(screen.getByText('C:\\restored-output\\scan.pdf')).toBeVisible()
    expect(screen.getByText('C:\\restored-output\\letter.pdf')).toBeVisible()
  })
})
