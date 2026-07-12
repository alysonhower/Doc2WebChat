import { render, screen } from '@testing-library/react'
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
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    render(<PromptLibraryView prompts={[prompt]} onPromptsChange={vi.fn()} />)

    const name = screen.getByLabelText('Prompt name')
    await user.clear(name)
    await user.type(name, 'Unsaved name')
    await user.click(screen.getByRole('button', { name: /extract facts/i }))
    expect(loadPrompt).not.toHaveBeenCalled()
    expect(confirm).toHaveBeenCalledWith('Discard unsaved prompt changes?')

    await user.click(screen.getByRole('button', { name: /extract facts/i }))
    expect(loadPrompt).toHaveBeenCalledWith({ promptId: 7 })
    expect(await screen.findByDisplayValue('Extract facts')).toBeInTheDocument()
  })

  it('creates and deletes prompts through the persistent bridge CRUD', async () => {
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
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const onPromptsChange = vi.fn()
    render(<PromptLibraryView prompts={[]} onPromptsChange={onPromptsChange} />)

    const name = screen.getByLabelText('Prompt name')
    await user.clear(name)
    await user.type(name, 'Facts')
    await user.click(screen.getByRole('button', { name: 'Save' }))
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
    expect(deletePrompt).toHaveBeenCalledWith({ promptId: 9 })
  })
})
