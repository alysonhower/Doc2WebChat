# Doc2WebChat Browser Bridge

This Chrome/Firefox extension connects supported provider pages to the local
Doc2WebChat desktop application. It prefills the selected provider without
submitting, observes only the next response, invokes the provider's native Copy
control, and notifies the desktop app to import the clipboard result.

The bridge connects only to `127.0.0.1:55155`. Complete prompts are fetched from
an authenticated, expiring desktop handoff and are never written to extension
storage. Stored handoff records contain only opaque/correlation IDs, provider
ID, tab metadata, and expiry.

Provider metadata lives in `packages/shared/src/providers.json`; the build
generates Chrome and Firefox content-script matches from that registry.

## Development

```sh
pnpm --dir apps/browser test
pnpm --dir apps/browser lint
pnpm --dir apps/browser typecheck
pnpm --dir apps/browser build
pnpm --dir apps/browser test:e2e
```

## Provenance

The provider DOM adapters were derived from the upstream browser autofill
extension identified in the repository's third-party notices. Its license and
copyright notice remain in [LICENSE](LICENSE).
