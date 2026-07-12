# Doc2WebChat

Doc2WebChat is a local pywebview desktop application for turning image and PDF
folders into searchable PDF/A-4 files, keeping their OCR text in SQLite, and
prefilling supported AI chat websites through a browser extension. It never
calls a model API and never submits a provider message for the user.

## Requirements

- Python 3.14 and [uv](https://docs.astral.sh/uv/)
- Node.js and pnpm 10.10.0
- Docker Desktop for the managed TurboOCR service
- Chrome or Firefox with the locally built Doc2WebChat extension installed

## Build and run

```powershell
pnpm install --frozen-lockfile
pnpm build:desktop
pnpm build:browser
uv sync --project .\apps\desktop --locked
uv run --project .\apps\desktop doc2webchat
```

Load `apps\browser\dist` as an unpacked Chrome extension. For Firefox, load
`apps\browser\dist-firefox\manifest.json` as a temporary add-on during local
development. Provider pages open in the ordinary browser and retain its normal
login session.

## Workflow

1. Choose separate input and output folders, recursion, and an output-conflict
   policy in **Documents/OCR**.
2. Run OCR and follow per-file progress. Successful files are published as
   PDF/A-4 and become searchable chat documents.
3. Create or select structured instructions in **Prompt Library** or **Chat**.
4. Select a connected browser and provider, then prefill the complete prompt.
5. Review and submit it yourself in the provider page.
6. Use the injected Doc2WebChat import button on the next assistant response.
   The extension invokes the provider's native Copy action and the desktop app
   imports the clipboard text into local history.

## Verification

```powershell
pnpm check
pnpm test:e2e
uv run --directory .\apps\desktop pytest
uv run --directory .\apps\desktop ruff check src tests
uv run --directory .\apps\desktop basedpyright
```

`pnpm test:e2e` builds the unpacked Chrome extension and runs the real
Python-to-extension-to-clipboard round trip against a local Open WebUI-shaped
fixture in a fresh temporary Chromium profile.

The maintained source boundaries are `apps\browser`, `apps\desktop`, and
`packages\shared`. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for
provenance and retained license notices.
