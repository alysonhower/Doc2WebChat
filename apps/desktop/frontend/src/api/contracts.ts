import type { StructuredPrompt } from '../structured/types'

export interface BridgeError {
  code: string
  message: string
  field?: string
  file?: string
}

export type BridgeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: BridgeError }

export interface DocumentRow {
  id: number
  inputPath: string
  outputPath?: string | null
  latestOutputPath?: string | null
  text?: string | null
  resultAvailable: boolean
  latestStatus: string
  latestWarning?: string | null
  latestError?: string | null
  updatedAt?: string
}

export interface PromptRow {
  id: number
  name: string
  document?: StructuredPrompt
  createdAt?: string
  updatedAt?: string
}

export interface BrowserRow {
  browserInstanceId: string
  label?: string
  browser?: string
  version?: string
  userAgent?: string
  connected?: boolean
  connectedAt?: number
  lastSeen?: number
}

export type ProviderControlKey =
  | 'model'
  | 'options'
  | 'temperature'
  | 'top_p'
  | 'reasoning_effort'
  | 'thinking_budget'
  | 'system_instructions'
  | 'url_override'
  | 'port'

export interface ProviderValueDefinition {
  label?: string
  reasoning_efforts?: string[]
}

export type ProviderControlDefinition =
  | boolean
  | {
      label?: string
      default?: string | number
      user_provided?: boolean
      disabled_options?: string[]
      values?: string[] | Record<string, ProviderValueDefinition>
    }
  | Record<string, string>

export interface ProviderDefinition {
  id: string
  label: string
  canonicalUrl: string
  controls: Partial<Record<ProviderControlKey, ProviderControlDefinition>>
  adapterKey?: string
  allowedUrlPrefixes?: string[]
  domControls?: string[]
}

export interface MessageTagValue {
  id?: number
  name: string
  raw: string
  trimmed: string
  start?: number
  end?: number
  parentIndex?: number | null
}

export interface MessageWarning {
  code: string
  message: string
  tagName?: string
  parentIndex?: number | null
}

export interface MessageRow {
  id: number
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  tagValues?: MessageTagValue[]
  warnings?: MessageWarning[]
}

export interface InteractionRow {
  interactionId: string
  providerId: string
  providerLabel?: string
  providerUrl?: string
  browserInstanceId?: string
  status: string
  createdAt: string
  updatedAt?: string
  promptBytes?: number
  documentIds?: number[]
  instructions?: StructuredPrompt
  renderedInstructions?: string
  messages: MessageRow[]
}

export interface AppPreferences {
  selectedProviderId?: string | null
  selectedBrowserInstanceId?: string | null
  reuseTab?: boolean
  providerUrls?: Record<string, string>
  providerSettings?: Record<string, StoredProviderSettings>
}

export interface ProviderSettings {
  model?: string
  temperature?: number
  topP?: number
  reasoningEffort?: string
  thinkingBudget?: number
  systemInstructions?: string
  urlOverride?: string
  port?: number
  options?: string[]
}

export interface StoredProviderSettings extends ProviderSettings {
  top_p?: number
  reasoning_effort?: string
  thinking_budget?: number
  system_instructions?: string
  reuse_last_tab?: boolean
}

export interface OcrJobState {
  jobId: string | number
  status: string
  completed: number
  failed: number
  skipped: number
  total?: number | null
  currentFile?: string | null
  overwriteConfirmationJobId?: string | number
  inputPath?: string
  outputPath?: string
  recursive?: boolean
  conflictCount?: number
  conflictingOutputs?: string[]
}

export interface BootstrapState {
  documents: DocumentRow[]
  prompts: PromptRow[]
  browsers: BrowserRow[]
  providers: ProviderDefinition[]
  history: InteractionRow[]
  preferences: AppPreferences
  activeJob?: OcrJobState | null
}

export interface AppEvent {
  sequence: number
  type: string
  timestamp?: string
  jobId?: string | number
  interactionId?: string
  interaction_id?: string
  action?: string
  stage?: string
  status?: string
  completed?: number
  failed?: number
  skipped?: number
  total?: number | null
  file?: string
  message?: string
  error?: string
  inputPath?: string
  outputPath?: string
  recursive?: boolean
  conflictCount?: number
  conflictingOutputs?: string[]
  overwriteConfirmationJobId?: string | number
  [key: string]: unknown
}

export interface PyWebviewApi {
  get_bootstrap_state(): Promise<BridgeResult<BootstrapState>>
  select_directory(input: {
    purpose: 'input' | 'output'
  }): Promise<BridgeResult<{ path: string | null }>>
  start_ocr_job(input: {
    inputPath: string
    outputPath: string
    recursive: boolean
    conflictPolicy: 'error' | 'skip' | 'overwrite'
    overwriteConfirmationJobId?: string | number
  }): Promise<BridgeResult<{ jobId: string | number }>>
  poll_events(input: {
    after: number
    timeoutMs?: number
  }): Promise<BridgeResult<{ events: AppEvent[]; nextSequence: number }>>
  list_documents(): Promise<
    BridgeResult<{ documents: DocumentRow[] } | DocumentRow[]>
  >
  list_prompts(): Promise<BridgeResult<{ prompts: PromptRow[] } | PromptRow[]>>
  load_prompt(input: {
    promptId: number
  }): Promise<BridgeResult<{ prompt: PromptRow }>>
  save_prompt(input: {
    promptId?: number
    name: string
    document: StructuredPrompt
  }): Promise<BridgeResult<{ prompt: PromptRow }>>
  rename_prompt(input: {
    promptId: number
    name: string
  }): Promise<BridgeResult<{ prompt: PromptRow }>>
  delete_prompt(input: {
    promptId: number
  }): Promise<BridgeResult<{ promptId: number }>>
  start_interaction(input: {
    instructions: StructuredPrompt
    providerId: string
    providerUrl?: string
    browserInstanceId?: string
    settings: Record<string, string | number | boolean | string[]>
    reuseTab: boolean
  }): Promise<
    BridgeResult<{ interactionId: string; status: string; promptBytes: number }>
  >
  list_browsers(): Promise<
    BridgeResult<{ browsers: BrowserRow[] } | BrowserRow[]>
  >
  list_history(): Promise<
    BridgeResult<{ history: InteractionRow[] } | InteractionRow[]>
  >
}

declare global {
  interface Window {
    pywebview?: { api: PyWebviewApi }
  }
}
