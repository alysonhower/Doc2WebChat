export type MessageContentProperty = 'value' | 'innerText' | 'textContent'

export const prefill_message = (
  element: HTMLElement | HTMLTextAreaElement,
  message: string,
  property: MessageContentProperty
) => {
  if (property === 'value') {
    ;(element as HTMLTextAreaElement).value = message
  } else if (property === 'innerText') {
    element.innerText = message
  } else {
    element.textContent = message
  }

  const input_event =
    typeof InputEvent === 'function'
      ? new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: message
        })
      : new Event('input', { bubbles: true, cancelable: true })

  element.dispatchEvent(input_event)
  element.dispatchEvent(new Event('change', { bubbles: true }))
  element.focus()
}
