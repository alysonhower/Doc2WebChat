import { useEffect, useMemo, useState } from 'react'
import { errorMessage, invoke } from '../api/client'
import type {
  BrowserRow,
  DocumentRow,
  InteractionRow,
  PromptRow,
  ProviderControlDefinition,
  ProviderControlKey,
  ProviderDefinition,
  ProviderSettings,
  StoredProviderSettings
} from '../api/contracts'
import {
  clonePrompt,
  emptyStructuredPrompt,
  promptEquals
} from '../structured/model'
import type { StructuredPrompt } from '../structured/types'
import { StructuredPromptEditor } from '../structured/StructuredPromptEditor'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { getInteractionStatusPresentation } from '../ui/status'
import { ArrowIcon, SparkIcon } from './Icons'
import { Conversation } from './Conversation'

interface ChatViewProps {
  documents: DocumentRow[]
  providers: ProviderDefinition[]
  browsers: BrowserRow[]
  history: InteractionRow[]
  prompts: PromptRow[]
  initialProviderId?: string | null
  initialBrowserId?: string | null
  initialReuseTab?: boolean
  initialSettings?: Record<string, StoredProviderSettings>
  initialProviderUrls?: Record<string, string>
  onRefreshHistory: () => Promise<void>
}

const getControl = (
  provider: ProviderDefinition | undefined,
  control: ProviderControlKey
): ProviderControlDefinition | undefined => provider?.controls[control]

const hasControl = (
  provider: ProviderDefinition | undefined,
  control: ProviderControlKey
) =>
  getControl(provider, control) !== undefined &&
  getControl(provider, control) !== false

const objectControl = (
  value: ProviderControlDefinition | undefined
): Record<string, unknown> => (value && typeof value === 'object' ? value : {})

function browserLabel(browser: BrowserRow): string {
  if (browser.label) return browser.label
  if (browser.browser)
    return `${browser.browser}${browser.version ? ` ${browser.version}` : ''}`
  const family =
    browser.userAgent?.match(/(Firefox|Edg|Chrome)\/[^ ]+/)?.[0] ??
    'Browser extension'
  return `${family} · ${browser.browserInstanceId.slice(0, 8)}`
}

const normalizeInitialSettings = (
  providers: ProviderDefinition[],
  initialSettings: Record<string, StoredProviderSettings>,
  initialProviderUrls: Record<string, string>
): Record<string, ProviderSettings> =>
  Object.fromEntries(
    Object.entries(initialSettings).map(([id, stored]) => {
      const definition = providers.find((candidate) => candidate.id === id)
      const storedUrl = initialProviderUrls[id]
      const parsedPort =
        storedUrl && definition && hasControl(definition, 'port')
          ? Number(new URL(storedUrl).port) || undefined
          : undefined
      return [
        id,
        {
          model: stored.model,
          temperature: stored.temperature,
          topP: stored.topP ?? stored.top_p,
          reasoningEffort: stored.reasoningEffort ?? stored.reasoning_effort,
          thinkingBudget: stored.thinkingBudget ?? stored.thinking_budget,
          systemInstructions:
            stored.systemInstructions ?? stored.system_instructions,
          urlOverride:
            stored.urlOverride ??
            (storedUrl &&
            definition &&
            hasControl(definition, 'url_override') &&
            storedUrl !== definition.canonicalUrl
              ? storedUrl
              : undefined),
          port: stored.port ?? parsedPort,
          options: stored.options
        }
      ]
    })
  )

const advancedSettingKeys: Array<keyof ProviderSettings> = [
  'model',
  'temperature',
  'topP',
  'reasoningEffort',
  'thinkingBudget',
  'systemInstructions',
  'urlOverride',
  'port',
  'options'
]

const advancedChangeCount = (
  current: ProviderSettings,
  baseline: ProviderSettings
) =>
  advancedSettingKeys.filter(
    (key) => JSON.stringify(current[key]) !== JSON.stringify(baseline[key])
  ).length

export function ChatView({
  documents,
  providers,
  browsers,
  history,
  prompts,
  initialProviderId,
  initialBrowserId,
  initialReuseTab = true,
  initialSettings = {},
  initialProviderUrls = {},
  onRefreshHistory
}: ChatViewProps) {
  const connectedBrowsers = browsers.filter(
    (browser) => browser.connected !== false
  )
  const [instructions, setInstructions] = useState<StructuredPrompt>(
    emptyStructuredPrompt
  )
  const [instructionBaseline, setInstructionBaseline] =
    useState<StructuredPrompt>(() => clonePrompt(emptyStructuredPrompt()))
  const [selectedPromptId, setSelectedPromptId] = useState('')
  const [promptToLoad, setPromptToLoad] = useState<string | null>(null)
  const [providerId, setProviderId] = useState(
    initialProviderId ?? providers[0]?.id ?? ''
  )
  const [browserId, setBrowserId] = useState(initialBrowserId ?? '')
  const [reuseTab, setReuseTab] = useState(initialReuseTab)
  const [settingsBaseline] = useState<Record<string, ProviderSettings>>(() =>
    normalizeInitialSettings(providers, initialSettings, initialProviderUrls)
  )
  const [settingsByProvider, setSettingsByProvider] = useState<
    Record<string, ProviderSettings>
  >(() =>
    normalizeInitialSettings(providers, initialSettings, initialProviderUrls)
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dispatchInfo, setDispatchInfo] = useState<{
    interactionId: string
    promptBytes: number
    providerId: string
    providerLabel?: string
    providerUrl?: string
    createdAt: string
  } | null>(null)
  const provider = providers.find((candidate) => candidate.id === providerId)
  const settings = settingsByProvider[providerId] ?? {}

  useEffect(() => {
    if (!providerId && providers[0]) setProviderId(providers[0].id)
  }, [providerId, providers])
  useEffect(() => {
    if (connectedBrowsers.length === 1)
      setBrowserId(connectedBrowsers[0].browserInstanceId)
    else if (
      browserId &&
      !connectedBrowsers.some(
        (browser) => browser.browserInstanceId === browserId
      )
    )
      setBrowserId('')
  }, [browserId, connectedBrowsers])

  const updateSettings = (patch: Partial<ProviderSettings>) => {
    setSettingsByProvider((current) => ({
      ...current,
      [providerId]: { ...current[providerId], ...patch }
    }))
  }

  const latestInteraction = useMemo(() => {
    if (dispatchInfo) {
      const exact = history.find(
        (interaction) =>
          interaction.interactionId === dispatchInfo.interactionId
      )
      if (exact) return exact
      return {
        interactionId: dispatchInfo.interactionId,
        providerId: dispatchInfo.providerId,
        providerLabel: dispatchInfo.providerLabel,
        providerUrl: dispatchInfo.providerUrl,
        status: 'dispatched',
        createdAt: dispatchInfo.createdAt,
        promptBytes: dispatchInfo.promptBytes,
        messages: []
      } satisfies InteractionRow
    }
    return [...history].sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )[0]
  }, [dispatchInfo, history])

  const loadSavedPrompt = async (promptId: string) => {
    if (!promptId) return
    setBusy(true)
    setError(null)
    try {
      const { prompt } = await invoke((api) =>
        api.load_prompt({ promptId: Number(promptId) })
      )
      const document = clonePrompt(prompt.document ?? emptyStructuredPrompt())
      setInstructions(document)
      setInstructionBaseline(clonePrompt(document))
      setSelectedPromptId(String(prompt.id))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const requestSavedPrompt = (promptId: string) => {
    if (!promptId || busy || promptId === selectedPromptId) return
    if (!promptEquals(instructions, instructionBaseline)) {
      setPromptToLoad(promptId)
      return
    }
    void loadSavedPrompt(promptId)
  }

  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      const wireSettings: Record<string, string | number | boolean | string[]> =
        {}
      const systemControl = objectControl(
        getControl(provider, 'system_instructions')
      )
      if (settings.model) wireSettings.model = settings.model
      if (settings.temperature !== undefined)
        wireSettings.temperature = settings.temperature
      if (settings.topP !== undefined) wireSettings.top_p = settings.topP
      if (settings.reasoningEffort)
        wireSettings.reasoning_effort = settings.reasoningEffort
      if (settings.thinkingBudget !== undefined)
        wireSettings.thinking_budget = settings.thinkingBudget
      const systemInstructions =
        settings.systemInstructions ??
        (typeof systemControl.default === 'string'
          ? systemControl.default
          : undefined)
      if (systemInstructions)
        wireSettings.system_instructions = systemInstructions
      if (settings.options?.length)
        wireSettings.options = settings.options.filter(
          (option) => !disabledOptions.has(option)
        )

      let providerUrl = settings.urlOverride || undefined
      if (!providerUrl && settings.port !== undefined && provider) {
        const parsed = new URL(provider.canonicalUrl)
        if (parsed.hostname === 'openwebui') parsed.hostname = 'localhost'
        parsed.port = String(settings.port)
        providerUrl = parsed.toString()
      }
      const result = await invoke((api) =>
        api.start_interaction({
          instructions,
          providerId,
          providerUrl,
          browserInstanceId: browserId || undefined,
          settings: wireSettings,
          reuseTab
        })
      )
      setDispatchInfo({
        interactionId: result.interactionId,
        promptBytes: result.promptBytes,
        providerId,
        providerLabel: provider?.label,
        providerUrl,
        createdAt: new Date().toISOString()
      })
      await onRefreshHistory()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const readyDocuments = documents.filter(
    (document) => document.resultAvailable
  )
  const selectedBrowser = connectedBrowsers.find(
    (browser) => browser.browserInstanceId === browserId
  )
  const browserRequired =
    connectedBrowsers.length !== 1 && selectedBrowser === undefined
  const modelControl = objectControl(getControl(provider, 'model'))
  const modelValues =
    modelControl.values &&
    typeof modelControl.values === 'object' &&
    !Array.isArray(modelControl.values)
      ? (modelControl.values as Record<
          string,
          { label?: string; reasoning_efforts?: string[] }
        >)
      : {}
  const reasoningControl = objectControl(
    getControl(provider, 'reasoning_effort')
  )
  const selectedModelReasoning = settings.model
    ? modelValues[settings.model]?.reasoning_efforts
    : undefined
  const reasoningValues =
    selectedModelReasoning ??
    (Array.isArray(reasoningControl.values)
      ? (reasoningControl.values as string[])
      : [])
  const optionControl = objectControl(getControl(provider, 'options'))
  const optionEntries = Object.entries(optionControl).filter(
    ([, label]) => typeof label === 'string'
  ) as Array<[string, string]>
  const urlControl = objectControl(getControl(provider, 'url_override'))
  const disabledOptions = new Set(
    settings.urlOverride && Array.isArray(urlControl.disabled_options)
      ? urlControl.disabled_options.filter(
          (item): item is string => typeof item === 'string'
        )
      : []
  )
  const systemControl = objectControl(
    getControl(provider, 'system_instructions')
  )
  const changedSettings = advancedChangeCount(
    settings,
    settingsBaseline[providerId] ?? {}
  )
  const statusPresentation = latestInteraction
    ? getInteractionStatusPresentation(latestInteraction.status)
    : null
  const browserGuidance =
    connectedBrowsers.length === 0
      ? 'Extension offline. Open the Doc2WebChat browser extension to connect.'
      : connectedBrowsers.length === 1
        ? `Using ${browserLabel(connectedBrowsers[0])} automatically.`
        : selectedBrowser
          ? `Using ${browserLabel(selectedBrowser)}.`
          : `Choose one of ${connectedBrowsers.length} connected browsers.`

  return (
    <section className="page page--chat" aria-labelledby="chat-title">
      <header className="page-header">
        <div>
          <span className="eyebrow">Structured browser chat</span>
          <h1 id="chat-title">Chat</h1>
          <p>
            Compose once, send through your browser, and import the native
            copied response.
          </p>
        </div>
        <div className="document-context">
          <strong>{readyDocuments.length}</strong>
          <span>
            documents
            <br />
            in context
          </span>
        </div>
      </header>

      <div className="chat-layout">
        <div className="chat-composer">
          <div className="card chat-settings">
            <div className="provider-row">
              <label>
                Provider
                <select
                  value={providerId}
                  disabled={busy}
                  onChange={(event) => setProviderId(event.target.value)}
                >
                  {providers.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Browser
                <select
                  value={browserId}
                  onChange={(event) => setBrowserId(event.target.value)}
                  disabled={busy || connectedBrowsers.length <= 1}
                >
                  <option value="">
                    {connectedBrowsers.length
                      ? 'Select browser'
                      : 'No extension connected'}
                  </option>
                  {connectedBrowsers.map((browser) => (
                    <option
                      key={browser.browserInstanceId}
                      value={browser.browserInstanceId}
                    >
                      {browserLabel(browser)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Saved prompt
                <select
                  value={selectedPromptId}
                  disabled={busy}
                  onChange={(event) => requestSavedPrompt(event.target.value)}
                >
                  <option value="">Load from library…</option>
                  {prompts.map((prompt) => (
                    <option key={prompt.id} value={prompt.id}>
                      {prompt.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {provider ? (
              <p className="provider-destination">
                Destination{' '}
                <span>{settings.urlOverride || provider.canonicalUrl}</span>
              </p>
            ) : null}
            <p className="browser-guidance">{browserGuidance}</p>
            <details className="advanced-provider-settings">
              <summary>
                <span>Advanced provider settings</span>
                {changedSettings ? (
                  <span className="settings-change-count">
                    {changedSettings} changed
                  </span>
                ) : null}
              </summary>
              <fieldset className="provider-controls" disabled={busy}>
                {hasControl(provider, 'model') ? (
                  <label>
                    Model
                    {Object.keys(modelValues).length ? (
                      <select
                        value={settings.model ?? ''}
                        onChange={(event) =>
                          updateSettings({
                            model: event.target.value || undefined,
                            reasoningEffort: undefined
                          })
                        }
                      >
                        <option value="">Provider default</option>
                        {Object.entries(modelValues).map(
                          ([model, definition]) => (
                            <option key={model} value={model}>
                              {definition.label ?? model}
                            </option>
                          )
                        )}
                      </select>
                    ) : (
                      <input
                        value={settings.model ?? ''}
                        onChange={(event) =>
                          updateSettings({
                            model: event.target.value || undefined
                          })
                        }
                        placeholder="Provider default"
                      />
                    )}
                  </label>
                ) : null}
                {hasControl(provider, 'temperature') ? (
                  <label>
                    Temperature
                    <input
                      type="number"
                      min="0"
                      max="2"
                      step="0.1"
                      value={settings.temperature ?? ''}
                      onChange={(event) =>
                        updateSettings({
                          temperature:
                            event.target.value === ''
                              ? undefined
                              : Number(event.target.value)
                        })
                      }
                    />
                  </label>
                ) : null}
                {hasControl(provider, 'top_p') ? (
                  <label>
                    Top P
                    <input
                      type="number"
                      min="0"
                      max="1"
                      step="0.05"
                      value={settings.topP ?? ''}
                      onChange={(event) =>
                        updateSettings({
                          topP:
                            event.target.value === ''
                              ? undefined
                              : Number(event.target.value)
                        })
                      }
                    />
                  </label>
                ) : null}
                {hasControl(provider, 'url_override') ? (
                  <label className="provider-control--wide">
                    {typeof urlControl.label === 'string'
                      ? urlControl.label
                      : 'URL override'}
                    <input
                      type="url"
                      value={settings.urlOverride ?? ''}
                      onChange={(event) =>
                        updateSettings({
                          urlOverride: event.target.value || undefined
                        })
                      }
                      placeholder={provider?.canonicalUrl}
                    />
                  </label>
                ) : null}
                {hasControl(provider, 'port') ? (
                  <label>
                    Port
                    <input
                      type="number"
                      min="1"
                      max="65535"
                      value={settings.port ?? ''}
                      onChange={(event) =>
                        updateSettings({
                          port:
                            event.target.value === ''
                              ? undefined
                              : Number(event.target.value)
                        })
                      }
                    />
                  </label>
                ) : null}
                {reasoningValues.length > 0 ? (
                  <label>
                    Reasoning effort
                    <select
                      value={settings.reasoningEffort ?? ''}
                      onChange={(event) =>
                        updateSettings({
                          reasoningEffort: event.target.value || undefined
                        })
                      }
                    >
                      <option value="">Provider default</option>
                      {reasoningValues.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {hasControl(provider, 'thinking_budget') ? (
                  <label>
                    Thinking budget
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={settings.thinkingBudget ?? ''}
                      onChange={(event) =>
                        updateSettings({
                          thinkingBudget:
                            event.target.value === ''
                              ? undefined
                              : Number(event.target.value)
                        })
                      }
                    />
                  </label>
                ) : null}
                {optionEntries.map(([name, label]) => (
                  <label className="check-control" key={name}>
                    <input
                      type="checkbox"
                      disabled={disabledOptions.has(name)}
                      checked={settings.options?.includes(name) ?? false}
                      onChange={(event) => {
                        const next = event.target.checked
                          ? [...(settings.options ?? []), name]
                          : (settings.options ?? []).filter(
                              (item) => item !== name
                            )
                        updateSettings({
                          options: next.length ? next : undefined
                        })
                      }}
                    />
                    <span>{label}</span>
                  </label>
                ))}
                {hasControl(provider, 'system_instructions') ? (
                  <label className="provider-control--full">
                    Provider system instructions
                    <textarea
                      value={
                        settings.systemInstructions ??
                        (typeof systemControl.default === 'string'
                          ? systemControl.default
                          : '')
                      }
                      onChange={(event) =>
                        updateSettings({
                          systemInstructions: event.target.value
                        })
                      }
                    />
                  </label>
                ) : null}
              </fieldset>
            </details>
          </div>

          <div className="card composer-card">
            <StructuredPromptEditor
              value={instructions}
              onChange={setInstructions}
              compact
            />
            <div className="composer-footer">
              <label className="check-control">
                <input
                  type="checkbox"
                  checked={reuseTab}
                  onChange={(event) => setReuseTab(event.target.checked)}
                />
                <span>Reuse provider tab</span>
              </label>
              <div>
                <span>
                  {dispatchInfo
                    ? `${dispatchInfo.promptBytes.toLocaleString()} bytes last sent`
                    : 'Full document text is included'}
                </span>
                <button
                  className="button button--primary"
                  type="button"
                  disabled={busy || !providerId || browserRequired}
                  onClick={() => void send()}
                >
                  {busy ? 'Dispatching…' : 'Open in browser'}
                  <ArrowIcon />
                </button>
              </div>
            </div>
            {browserRequired ? (
              <div className="inline-alert">
                {connectedBrowsers.length
                  ? 'Choose a connected browser before sending.'
                  : 'Connect the Doc2WebChat browser extension before sending.'}
              </div>
            ) : null}
            {error ? (
              <div className="inline-alert inline-alert--error" role="alert">
                {error}
              </div>
            ) : null}
          </div>
        </div>

        <aside className="card response-panel">
          <div className="response-panel__header">
            <div>
              <SparkIcon />
              <div>
                <span className="eyebrow">Latest conversation</span>
                <strong>
                  {latestInteraction?.providerLabel ??
                    latestInteraction?.providerId ??
                    'Waiting'}
                </strong>
              </div>
            </div>
            {latestInteraction ? (
              <span
                className={`status status--${statusPresentation?.tone ?? 'neutral'}`}
              >
                {statusPresentation?.label}
              </span>
            ) : null}
          </div>
          {statusPresentation ? (
            <p className="interaction-guidance">
              {statusPresentation.guidance}
            </p>
          ) : null}
          <Conversation interaction={latestInteraction} />
        </aside>
      </div>
      <ConfirmDialog
        open={promptToLoad !== null}
        title="Replace edited instructions?"
        description="Loading a saved prompt will replace your unsaved instruction edits."
        confirmLabel="Load saved prompt"
        busy={busy}
        onCancel={() => setPromptToLoad(null)}
        onConfirm={() => {
          const promptId = promptToLoad
          setPromptToLoad(null)
          if (promptId) void loadSavedPrompt(promptId)
        }}
      />
    </section>
  )
}
