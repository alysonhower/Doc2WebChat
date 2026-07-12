export const IMPORT_RESPONSE_STYLE_ID = 'doc2webchat-import-response-styles'

const IMPORT_RESPONSE_STYLES = `
button.doc2webchat-import-response-button {
  box-sizing: border-box !important;
  min-width: 34px !important;
  height: 34px !important;
  margin: 4px 8px !important;
  padding: 0 9px !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  border: 1px solid rgba(255, 255, 255, 0.24) !important;
  border-radius: 999px !important;
  background: linear-gradient(135deg, #4f46e5, #2563eb) !important;
  box-shadow: 0 5px 16px rgba(37, 99, 235, 0.28) !important;
  color: #ffffff !important;
  cursor: pointer !important;
  opacity: 1 !important;
  transition:
    transform 150ms ease,
    box-shadow 150ms ease,
    opacity 150ms ease !important;
}

button.doc2webchat-import-response-button:hover:not(:disabled) {
  transform: translateY(-1px) !important;
  box-shadow: 0 7px 20px rgba(37, 99, 235, 0.38) !important;
}

button.doc2webchat-import-response-button:focus-visible {
  outline: 3px solid rgba(96, 165, 250, 0.72) !important;
  outline-offset: 2px !important;
}

button.doc2webchat-import-response-button:disabled {
  cursor: wait !important;
  opacity: 0.52 !important;
  transform: none !important;
  box-shadow: none !important;
}

button.doc2webchat-import-response-button svg {
  width: 15px !important;
  height: 15px !important;
  display: block !important;
  pointer-events: none !important;
}

@media (prefers-reduced-motion: reduce) {
  button.doc2webchat-import-response-button {
    transition: none !important;
  }
}
`

export const ensure_import_response_styles = (ownerDocument: Document) => {
  if (ownerDocument.getElementById(IMPORT_RESPONSE_STYLE_ID)) return
  const style = ownerDocument.createElement('style')
  style.id = IMPORT_RESPONSE_STYLE_ID
  style.textContent = IMPORT_RESPONSE_STYLES
  ;(ownerDocument.head ?? ownerDocument.documentElement).appendChild(style)
}

export const apply_chat_response_button_style = (button: HTMLButtonElement) => {
  ensure_import_response_styles(button.ownerDocument)
  button.type = 'button'
}

export const set_button_disabled_state = (button: HTMLButtonElement) => {
  button.disabled = true

  setTimeout(() => {
    button.disabled = false
  }, 3000)
}
