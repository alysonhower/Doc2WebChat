import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from './ConfirmDialog'

function Harness({ onConfirm = vi.fn() }: { onConfirm?: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Delete prompt
      </button>
      <ConfirmDialog
        open={open}
        title="Delete prompt?"
        description="This cannot be undone."
        confirmLabel="Delete"
        danger
        onCancel={() => setOpen(false)}
        onConfirm={onConfirm}
      />
    </>
  )
}

describe('ConfirmDialog', () => {
  it('traps focus, closes with Escape, and restores the trigger focus', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    const trigger = screen.getByRole('button', { name: 'Delete prompt' })
    await user.click(trigger)
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    const confirm = screen.getByRole('button', { name: 'Delete' })
    expect(cancel).toHaveFocus()

    await user.tab({ shift: true })
    expect(confirm).toHaveFocus()
    await user.tab()
    expect(cancel).toHaveFocus()
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('exposes a modal name and invokes its confirmation action', async () => {
    const user = userEvent.setup()
    const confirm = vi.fn()
    render(<Harness onConfirm={confirm} />)

    await user.click(screen.getByRole('button', { name: 'Delete prompt' }))
    expect(
      screen.getByRole('dialog', { name: 'Delete prompt?' })
    ).toHaveAttribute('aria-modal', 'true')
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(confirm).toHaveBeenCalledOnce()
  })
})
