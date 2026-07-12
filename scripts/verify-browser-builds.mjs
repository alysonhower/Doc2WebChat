import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'))
const registry = readJson('packages/shared/src/providers.json')
const chrome = readJson('apps/browser/dist/manifest.json')
const firefox = readJson('apps/browser/dist-firefox/manifest.json')
const expectedMatches = [
  ...new Set(
    registry.providers.flatMap((provider) => provider.manifest_matches)
  )
]

const failures = []
const requireValue = (condition, message) => {
  if (!condition) failures.push(message)
}
const sameValues = (left, right) =>
  left.length === right.length &&
  left.every((value, index) => value === right[index])

requireValue(
  registry.providers.length === 20,
  'provider registry must contain 20 providers'
)
requireValue(
  registry.providers.find((provider) => provider.id === 'z-ai')?.label ===
    'Z.AI',
  'Z.AI display label is incorrect'
)
requireValue(chrome.manifest_version === 3, 'Chrome manifest must be MV3')
requireValue(
  sameValues(chrome.content_scripts[0].matches, expectedMatches),
  'Chrome content matches do not match the provider registry'
)
requireValue(
  chrome.host_permissions.includes('http://127.0.0.1:55155/*') &&
    chrome.host_permissions.includes('ws://127.0.0.1:55155/*'),
  'Chrome loopback bridge permissions are missing'
)
requireValue(firefox.manifest_version === 2, 'Firefox manifest must be MV2')
requireValue(
  sameValues(firefox.content_scripts[0].matches, expectedMatches),
  'Firefox content matches do not match the provider registry'
)
requireValue(
  !('host_permissions' in firefox) &&
    firefox.permissions.includes('http://127.0.0.1:55155/*') &&
    firefox.permissions.includes('ws://127.0.0.1:55155/*'),
  'Firefox localhost permissions were not migrated to MV2 permissions'
)
requireValue(
  firefox.permissions.includes('contextualIdentities') &&
    firefox.optional_permissions.includes('cookies'),
  'Firefox container permissions are missing'
)
requireValue(
  firefox.background?.persistent === true &&
    firefox.background.scripts?.includes('background.js'),
  'Firefox persistent reconnect background is missing'
)

if (failures.length) {
  console.error(failures.join('\n'))
  process.exitCode = 1
} else {
  console.log('Chrome and Firefox build manifests verified')
}
