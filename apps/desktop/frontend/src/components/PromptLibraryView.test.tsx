import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { PromptRow, PyWebviewApi } from '../api/contracts'
import { emptyStructuredPrompt } from '../structured/model'
import { PromptLibraryView } from './PromptLibraryView'

describe('PromptLibraryView', () => {
  it('confirms before switching away from an unsaved draft and deep-loads the selection', async () => {
    const user = userEvent.setup()
    const prompt: PromptRow = {
      id: 7,
      name: 'Extract facts',
      document: emptyStructuredPrompt()
    }
    const loadPrompt = vi.fn(async () => ({
      ok: true as const,
      value: { prompt }
    }))
    window.pywebview = {
      api: { load_prompt: loadPrompt } as unknown as PyWebviewApi
    }
    render(<PromptLibraryView prompts={[prompt]} onPromptsChange={vi.fn()} />)

    const name = screen.getByLabelText('Prompt name')
    await user.clear(name)
    await user.type(name, 'Unsaved name')
    await user.click(screen.getByRole('button', { name: /extract facts/i }))
    expect(loadPrompt).not.toHaveBeenCalled()
    expect(
      screen.getByRole('dialog', { name: 'Discard unsaved changes?' })
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(name).toHaveValue('Unsaved name')

    await user.click(screen.getByRole('button', { name: /extract facts/i }))
    await user.click(screen.getByRole('button', { name: 'Discard changes' }))
    await waitFor(() =>
      expect(loadPrompt).toHaveBeenCalledWith({ promptId: 7 })
    )
    expect(await screen.findByDisplayValue('Extract facts')).toBeInTheDocument()
  })

  it('saves name and document atomically, then deletes through accessible confirmation', async () => {
    const user = userEvent.setup()
    const saved: PromptRow = {
      id: 9,
      name: 'Facts',
      document: emptyStructuredPrompt()
    }
    const savePrompt = vi.fn(async () => ({
      ok: true as const,
      value: { prompt: saved }
    }))
    const deletePrompt = vi.fn(async () => ({
      ok: true as const,
      value: { promptId: 9 }
    }))
    const listPrompts = vi.fn(async () => ({
      ok: true as const,
      value: { prompts: [saved] }
    }))
    window.pywebview = {
      api: {
        save_prompt: savePrompt,
        delete_prompt: deletePrompt,
        list_prompts: listPrompts
      } as unknown as PyWebviewApi
    }
    const onPromptsChange = vi.fn()
    render(<PromptLibraryView prompts={[]} onPromptsChange={onPromptsChange} />)

    const name = screen.getByLabelText('Prompt name')
    await user.clear(name)
    await user.type(name, 'Facts')
    expect(screen.getByText('Not saved')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(savePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Facts',
        document: emptyStructuredPrompt()
      })
    )
    expect(onPromptsChange).toHaveBeenCalledWith([saved])

    await user.click(
      await screen.findByRole('button', { name: 'Delete prompt' })
    )
    const dialog = screen.getByRole('dialog', { name: 'Delete “Facts”?' })
    expect(deletePrompt).not.toHaveBeenCalled()
    await user.click(
      within(dialog).getByRole('button', { name: 'Delete prompt' })
    )
    await waitFor(() =>
      expect(deletePrompt).toHaveBeenCalledWith({ promptId: 9 })
    )
  })

  it('uses save_prompt for an existing prompt name and document change', async () => {
    const user = userEvent.setup()
    const prompt: PromptRow = {
      id: 7,
      name: 'Extract facts',
      document: emptyStructuredPrompt()
    }
    const saved = { ...prompt, name: 'Extract details' }
    const loadPrompt = vi.fn(async () => ({
      ok: true as const,
      value: { prompt }
    }))
    const savePrompt = vi.fn(async () => ({
      ok: true as const,
      value: { prompt: saved }
    }))
    const renamePrompt = vi.fn()
    const listPrompts = vi.fn(async () => ({
      ok: true as const,
      value: { prompts: [saved] }
    }))
    window.pywebview = {
      api: {
        load_prompt: loadPrompt,
        save_prompt: savePrompt,
        rename_prompt: renamePrompt,
        list_prompts: listPrompts
      } as unknown as PyWebviewApi
    }
    render(<PromptLibraryView prompts={[prompt]} onPromptsChange={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /extract facts/i }))
    const name = await screen.findByDisplayValue('Extract facts')
    await user.clear(name)
    await user.type(name, 'Extract details')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(savePrompt).toHaveBeenCalledWith({
      promptId: 7,
      name: 'Extract details',
      document: emptyStructuredPrompt()
    })
    expect(renamePrompt).not.toHaveBeenCalled()
    expect(await screen.findByText('Saved')).toBeInTheDocument()
  })
})
