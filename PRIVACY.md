# Doc2WebChat privacy

Doc2WebChat stores selected paths, OCR text, prompt-library entries, chat
interactions, imported assistant responses, and application preferences in a
local SQLite database under the operating system's application-data directory.

The desktop application makes no LLM or model-provider API calls. Complete
prompts are handed to the browser extension through an authenticated,
loopback-only, short-lived transfer and are not retained in browser extension
storage. The extension opens the selected provider website in the user's normal
browser, prefills its composer, and does not submit it.

Assistant text is imported only after the user presses the injected import
button. The extension invokes the provider's visible native Copy control; the
desktop application then reads the operating-system clipboard. It does not read
provider cookies, credentials, private APIs, or response DOM text, and it does
not claim to capture messages entered directly on provider pages.

TurboOCR processing uses the configured local TurboOCR server. Diagnostic logs
must contain identifiers and error metadata only, not OCR text, complete
prompts, clipboard contents, API keys, cookies, or credentials.
