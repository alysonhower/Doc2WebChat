import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const expectedDirectories = {
  apps: new Set(['browser', 'desktop']),
  packages: new Set(['shared'])
}
const ignoredNames = new Set([
  '.codegraph',
  '.pytest_cache',
  '.ruff_cache',
  '.venv',
  '__pycache__',
  'coverage',
  'dist',
  'dist-firefox',
  'node_modules',
  'static'
])
const sourceExtensions = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.lock',
  '.mjs',
  '.py',
  '.scss',
  '.toml',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml'
])
const forbiddenPatterns = [
  [/(?:from\s+|require\()['"]vscode['"]/, 'vscode import'],
  [/@types\/vscode|@vscode\//, 'vscode dependency'],
  [/\baxios\b/, 'direct HTTP API client'],
  [
    /api\.(?:openai|anthropic)\.com|generativelanguage\.googleapis\.com|@anthropic-ai\/sdk|(?:from\s+|require\()['"]openai['"]/i,
    'direct model API subsystem'
  ],
  [/\b(?:api_key|apiKey|BYOK)\b/, 'API-key subsystem'],
  [
    /\b(?:coding[_ -]?metadata|coding[_ -]?mode|checkpoint|voice|git[_ -]?diff|git[_ -]?status|stage[_ -]?files|commit[_ -]?message)\b/i,
    'removed editor subsystem'
  ],
  [/CodeWebChat|Code Web Chat|gemini-coder|\bcwc[-_:]/i, 'old branding']
]

const failures = []

for (const [parent, expected] of Object.entries(expectedDirectories)) {
  const actual = readdirSync(join(root, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  for (const directory of actual) {
    if (!expected.has(directory)) {
      failures.push(`unexpected ${parent} directory: ${directory}`)
    }
  }
  for (const directory of expected) {
    if (!actual.includes(directory)) {
      failures.push(`missing ${parent} directory: ${directory}`)
    }
  }
}

const files = []
const visit = (path) => {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (ignoredNames.has(entry.name)) continue
    const child = join(path, entry.name)
    if (entry.isDirectory()) {
      visit(child)
    } else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
      files.push(child)
    }
  }
}

for (const path of [
  join(root, 'apps', 'browser'),
  join(root, 'apps', 'desktop'),
  join(root, 'packages', 'shared')
]) {
  if (existsSync(path) && statSync(path).isDirectory()) visit(path)
}
for (const path of [
  join(root, 'package.json'),
  join(root, 'pnpm-lock.yaml'),
  join(root, 'tsconfig.json')
]) {
  if (existsSync(path)) files.push(path)
}

for (const file of files) {
  const content = readFileSync(file, 'utf8')
  for (const [pattern, label] of forbiddenPatterns) {
    if (pattern.test(content)) {
      failures.push(`${label}: ${relative(root, file)}`)
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exitCode = 1
} else {
  console.log('Doc2WebChat boundaries verified')
}
