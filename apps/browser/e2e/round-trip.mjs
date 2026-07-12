import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(HERE, '../../..')
const EXTENSION_DIRECTORY = path.join(REPOSITORY_ROOT, 'apps/browser/dist')
const FIXTURE_ORIGIN = 'http://127.0.0.1:3000'
const ASSISTANT_RESPONSE =
  'Fixture assistant response\n\n<answer>Correlated clipboard import ✓</answer>'
const CLIPBOARD_RESPONSE =
  process.platform === 'win32'
    ? ASSISTANT_RESPONSE.replaceAll('\n', '\r\n')
    : ASSISTANT_RESPONSE
const GENERATING_PATH =
  'M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12zm6-2.438c0-.724.588-1.312 1.313-1.312h4.874c.725 0 1.313.588 1.313 1.313v4.874c0 .725-.588 1.313-1.313 1.313H9.564a1.312 1.312 0 01-1.313-1.313V9.564z'

const fixture_html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Open WebUI — local fixture</title>
    <style>#chat-input { white-space: pre-wrap; }</style>
  </head>
  <body data-input-count="0" data-change-count="0" data-submit-count="0" data-native-copy-count="0">
    <button type="button" aria-label="Controls">Controls</button>
    <main id="messages-container"></main>
    <form id="composer">
      <div id="chat-input" role="textbox" contenteditable="true"></div>
      <button id="send" type="submit">Send</button>
    </form>
    <script>
      const composer = document.querySelector('#composer')
      const chatInput = document.querySelector('#chat-input')
      composer.addEventListener('submit', (event) => {
        event.preventDefault()
        document.body.dataset.submitCount = String(Number(document.body.dataset.submitCount) + 1)
      })
      chatInput.addEventListener('input', () => {
        document.body.dataset.inputCount = String(Number(document.body.dataset.inputCount) + 1)
      })
      chatInput.addEventListener('change', () => {
        document.body.dataset.changeCount = String(Number(document.body.dataset.changeCount) + 1)
      })
      chatInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          document.body.dataset.submitCount = String(Number(document.body.dataset.submitCount) + 1)
        }
      })
      window.fixture = {
        startGeneration() {
          const marker = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
          marker.id = 'generation-marker'
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
          path.setAttribute('d', ${JSON.stringify(GENERATING_PATH)})
          marker.append(path)
          document.body.append(marker)
        },
        finishGeneration(response) {
          document.querySelector('#generation-marker')?.remove()
          const turn = document.createElement('section')
          const assistant = document.createElement('div')
          assistant.className = 'chat-assistant'
          const content = document.createElement('div')
          content.id = 'response-content-container'
          content.textContent = response
          assistant.append(content)
          const footer = document.createElement('div')
          footer.className = 'response-footer'
          const copy = document.createElement('button')
          copy.type = 'button'
          copy.className = 'copy-response-button'
          copy.textContent = 'Copy'
          copy.addEventListener('click', async () => {
            document.body.dataset.nativeCopyCount = String(Number(document.body.dataset.nativeCopyCount) + 1)
            try {
              await navigator.clipboard.writeText(response)
              document.body.dataset.copyStatus = 'success'
            } catch (error) {
              document.body.dataset.copyStatus = 'failed:' + error.name
            }
          })
          footer.append(copy, document.createElement('span'))
          turn.append(assistant, footer)
          document.querySelector('#messages-container').append(turn)
        }
      }
    </script>
    <div data-pane>
      <button type="button" id="close-controls">Close</button>
      <textarea id="system-instructions"></textarea>
    </div>
  </body>
</html>`

class DesktopHarness {
  constructor(workDirectory) {
    this.stderr = ''
    this.process = spawn(
      'uv',
      [
        'run',
        '--project',
        'apps/desktop',
        'python',
        'apps/browser/e2e/desktop-harness.py'
      ],
      {
        cwd: REPOSITORY_ROOT,
        env: {
          ...process.env,
          DOC2WEBCHAT_E2E_WORK_DIR: workDirectory,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1',
          PYTHONUTF8: '1'
        },
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    this.lines = createInterface({ input: this.process.stdout })[
      Symbol.asyncIterator
    ]()
    this.process.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString()
    })
  }

  async read(timeout = 20_000) {
    const result = await Promise.race([
      this.lines.next(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('Desktop harness timed out')),
          timeout
        )
      )
    ])
    if (result.done) {
      throw new Error(`Desktop harness exited early\n${this.stderr}`)
    }
    return JSON.parse(result.value)
  }

  async command(command, values = {}) {
    this.process.stdin.write(`${JSON.stringify({ command, ...values })}\n`)
    const response = await this.read()
    if (!response.ok) throw new Error(`Desktop harness: ${response.error}`)
    return response
  }

  async close() {
    if (this.process.exitCode !== null) return
    try {
      await this.command('close')
    } finally {
      this.process.stdin.end()
      await Promise.race([
        new Promise((resolve) => this.process.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000))
      ])
      if (this.process.exitCode === null) this.process.kill()
    }
  }
}

const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(3000, '127.0.0.1', resolve)
  })

const close_server = (server) =>
  new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )

const wait_for = async (operation, description, timeout = 15_000) => {
  const deadline = Date.now() + timeout
  let latest
  while (Date.now() < deadline) {
    latest = await operation()
    if (latest) return latest
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

const main = async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'doc2webchat-e2e-'))
  const browserProfile = path.join(temporaryRoot, 'chrome-profile')
  const desktopWork = path.join(temporaryRoot, 'desktop')
  let releaseFixture
  const fixtureGate = new Promise((resolve) => {
    releaseFixture = resolve
  })
  let markFixtureRequested
  const fixtureRequested = new Promise((resolve) => {
    markFixtureRequested = resolve
  })
  const server = createServer(async (request, response) => {
    if (request.url === '/' || request.url?.startsWith('/?')) {
      markFixtureRequested()
      await fixtureGate
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/html; charset=utf-8'
      })
      response.end(fixture_html)
      return
    }
    response.writeHead(404)
    response.end('not found')
  })
  const harness = new DesktopHarness(desktopWork)
  let context
  const browserLogs = []
  try {
    await listen(server)
    const ready = await harness.read()
    assert.equal(ready.status, 'ready')

    context = await chromium.launchPersistentContext(browserProfile, {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_DIRECTORY}`,
        `--load-extension=${EXTENSION_DIRECTORY}`,
        '--disable-default-apps',
        '--no-first-run',
        '--window-position=-32000,-32000',
        '--window-size=1280,900'
      ]
    })
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: FIXTURE_ORIGIN
    })
    for (const page of context.pages()) {
      page.on('console', (message) => browserLogs.push(message.text()))
    }
    context.on('page', (page) =>
      page.on('console', (message) => browserLogs.push(message.text()))
    )
    context.on('serviceworker', (worker) =>
      worker.on('console', (message) => browserLogs.push(message.text()))
    )

    let worker = await wait_for(
      async () =>
        context
          .serviceWorkers()
          .find((candidate) => candidate.url().endsWith('/background.js')),
      'the unpacked extension service worker'
    )
    worker.on('console', (message) => browserLogs.push(message.text()))

    const connected = await harness.command('wait-browser')
    const browserInstanceId = connected.browser.browserInstanceId
    assert.match(
      browserInstanceId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )

    const started = await harness.command('start-interaction', {
      instructions: 'Use every document. Return an <answer>.'
    })
    assert.equal(Buffer.byteLength(started.prompt, 'utf8'), started.promptBytes)

    await Promise.race([
      fixtureRequested,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('Provider fixture request did not start')),
          10_000
        )
      )
    ])
    const workerUrl = new URL(worker.url())
    const extensionOrigin = `${workerUrl.protocol}//${workerUrl.host}`
    const controlPage = context
      .pages()
      .find((page) => !page.url().startsWith(`${FIXTURE_ORIGIN}/`))
    assert(controlPage, 'A browser control page is required')
    const cdp = await context.newCDPSession(controlPage)
    const targets = await cdp.send('Target.getTargets')
    const workerTarget = targets.targetInfos.find(
      (target) =>
        target.type === 'service_worker' && target.url === worker.url()
    )
    assert(workerTarget, 'The extension service-worker target was not found')
    const stopped = await cdp.send('Target.closeTarget', {
      targetId: workerTarget.targetId
    })
    assert.equal(stopped.success, true)
    const wakePage = await context.newPage()
    await wakePage.goto(`${extensionOrigin}/popup.html`)
    await wakePage
      .evaluate(() => chrome.runtime.sendMessage({ action: 'wake-worker' }))
      .catch(() => undefined)
    await cdp.detach()
    releaseFixture()
    const reconnected = await harness.command('wait-browser', {
      connectedAfter: connected.browser.connectedAt
    })
    assert.equal(
      reconnected.browser.browserInstanceId,
      connected.browser.browserInstanceId
    )
    const fixturePage = await wait_for(
      async () =>
        context
          .pages()
          .find((page) => page.url().startsWith(`${FIXTURE_ORIGIN}/`)),
      'the extension-created provider tab'
    )
    await wakePage.close()
    await fixturePage.bringToFront()
    await fixturePage.waitForLoadState('domcontentloaded')
    try {
      await fixturePage.waitForFunction(
        (expectedPrompt) => {
          const input = document.querySelector('#chat-input')
          return (
            input?.innerText === expectedPrompt &&
            document.body.dataset.inputCount === '1' &&
            document.body.dataset.changeCount === '1'
          )
        },
        started.prompt,
        { timeout: 10_000 }
      )
    } catch (error) {
      const pageState = await fixturePage.evaluate(() => ({
        changeCount: document.body.dataset.changeCount,
        focused: document.activeElement?.id,
        inputCount: document.body.dataset.inputCount,
        inputText: document.querySelector('#chat-input')?.innerText,
        systemInstructions: document.querySelector('#system-instructions')
          ?.value
      }))
      const historyState = await harness.command('history')
      throw new Error(
        `${error.message}\nPage state: ${JSON.stringify(pageState)}\nHistory state: ${JSON.stringify(historyState.history)}`
      )
    }
    assert.equal(
      await fixturePage.evaluate(() => document.activeElement?.id),
      'chat-input'
    )
    assert.equal(
      await fixturePage.evaluate(() => document.body.dataset.submitCount),
      '0'
    )

    const storagePage = await context.newPage()
    await storagePage.goto(`${extensionOrigin}/popup.html`)
    const extensionStorage = await storagePage.evaluate(
      () => new Promise((resolve) => chrome.storage.local.get(null, resolve))
    )
    await storagePage.close()
    await fixturePage.bringToFront()
    assert.equal(
      JSON.stringify(extensionStorage).includes(started.prompt),
      false
    )
    assert.equal(
      Object.keys(extensionStorage).some((key) =>
        key.startsWith('doc2webchat:handoff:')
      ),
      false
    )

    await fixturePage.evaluate(() => window.fixture.startGeneration())
    await fixturePage.waitForTimeout(100)
    await fixturePage.evaluate(
      (response) => window.fixture.finishGeneration(response),
      ASSISTANT_RESPONSE
    )
    const importButton = fixturePage.locator(
      '.doc2webchat-import-response-button'
    )
    await importButton.waitFor({ state: 'visible' })

    await wait_for(async () => {
      const current = await harness.command('history')
      return current.history.status === 'awaiting-import'
    }, 'the correlated response-finished event')

    await importButton.click()
    await fixturePage.waitForFunction(
      () => document.body.dataset.copyStatus === 'success'
    )
    assert.equal(
      await fixturePage.evaluate(() => document.body.dataset.nativeCopyCount),
      '1'
    )

    const completed = await wait_for(async () => {
      const current = await harness.command('history')
      return current.history.status === 'completed'
        ? current.history
        : undefined
    }, 'the persisted clipboard import')
    assert.equal(completed.interactionId, started.interactionId)
    assert.equal(completed.browserInstanceId, browserInstanceId)
    assert.equal(completed.providerId, 'open-webui')
    assert.equal(completed.providerUrl, `${FIXTURE_ORIGIN}/`)
    assert.equal(completed.messages.length, 2)
    assert.equal(completed.messages[0].content, started.prompt)
    assert.equal(completed.messages[1].role, 'assistant')
    assert.equal(completed.messages[1].content, CLIPBOARD_RESPONSE)
    assert.equal(browserLogs.join('\n').includes(started.prompt), false)

    console.log(
      JSON.stringify(
        {
          result: 'passed',
          extensionWorker: workerTarget.url,
          browserInstanceId,
          interactionId: started.interactionId,
          promptBytes: started.promptBytes,
          serviceWorkerRestarted: true,
          nativeCopyClicks: 1,
          persistedAssistantBytes: Buffer.byteLength(CLIPBOARD_RESPONSE, 'utf8')
        },
        null,
        2
      )
    )
  } catch (error) {
    error.message += `\nBrowser logs:\n${browserLogs.join('\n')}\nDesktop stderr:\n${harness.stderr}`
    throw error
  } finally {
    releaseFixture()
    if (context) await context.close()
    await harness.close()
    await close_server(server).catch(() => undefined)
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

await main()
