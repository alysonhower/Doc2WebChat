import {
  apply_chat_response_button_style,
  ensure_import_response_styles,
  IMPORT_RESPONSE_STYLE_ID,
  set_button_disabled_state
} from './apply-response-styles'

type FakeStyle = { id?: string; textContent?: string }

const fakeDocument = () => {
  const nodes = new Map<string, FakeStyle>()
  const appendChild = jest.fn((node: FakeStyle) => {
    if (node.id) nodes.set(node.id, node)
  })
  return {
    document: {
      getElementById: (id: string) => nodes.get(id),
      createElement: () => ({}) as FakeStyle,
      head: { appendChild },
      documentElement: { appendChild }
    } as unknown as Document,
    appendChild,
    nodes
  }
}

describe('import response presentation', () => {
  it('injects the isolated control stylesheet once', () => {
    const { document, appendChild, nodes } = fakeDocument()

    ensure_import_response_styles(document)
    ensure_import_response_styles(document)

    expect(appendChild).toHaveBeenCalledTimes(1)
    expect(nodes.get(IMPORT_RESPONSE_STYLE_ID)?.textContent).toContain(
      'button.doc2webchat-import-response-button:focus-visible'
    )
  })

  it('prepares an accessible button without inline theme colors', () => {
    const { document } = fakeDocument()
    const button = {
      ownerDocument: document,
      type: 'submit',
      style: { backgroundColor: '' },
      querySelector: jest.fn(() => null)
    } as unknown as HTMLButtonElement

    apply_chat_response_button_style(button)

    expect(button.type).toBe('button')
    expect(button.style.backgroundColor).toBe('')
  })

  it('restores the button after the guarded disabled interval', () => {
    jest.useFakeTimers()
    const button = { disabled: false } as HTMLButtonElement

    set_button_disabled_state(button)
    expect(button.disabled).toBe(true)

    jest.advanceTimersByTime(3000)
    expect(button.disabled).toBe(false)
    jest.useRealTimers()
  })
})
