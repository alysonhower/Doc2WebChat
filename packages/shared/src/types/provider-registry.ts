import registry_data from '../providers.json'

export type ProviderModel = {
  label: string
  disabled_options?: string[]
  reasoning_efforts?: string[]
}

export type ProviderControls = {
  model?: { user_provided?: boolean; values?: Record<string, ProviderModel> }
  temperature?: boolean
  top_p?: boolean
  system_instructions?: { default?: string }
  url_override?: { label: string; disabled_options?: string[] }
  port?: boolean
  reasoning_effort?: { values: string[] }
  thinking_budget?: boolean
  options?: Record<string, string>
}

export type ProviderDefinition = {
  id: string
  label: string
  adapter_key: string
  canonical_url: string
  allowed_url_prefixes: string[]
  manifest_matches: string[]
  detection: { url_prefixes?: string[]; title_includes?: string }
  controls: ProviderControls
  dom_controls: string[]
}

export type ProviderRegistry = {
  schema_version: 1
  providers: ProviderDefinition[]
}

export const PROVIDER_REGISTRY = registry_data as ProviderRegistry

export const get_provider = (provider_id: string) =>
  PROVIDER_REGISTRY.providers.find((provider) => provider.id === provider_id)

export const find_provider_for_page = (url: string, title: string) =>
  PROVIDER_REGISTRY.providers.find((provider) => {
    const by_url = provider.detection.url_prefixes?.some((prefix) =>
      url.startsWith(prefix)
    )
    const by_title = provider.detection.title_includes
      ? title.includes(provider.detection.title_includes)
      : false
    return by_url || by_title
  })

export const is_allowed_provider_url = (
  provider: ProviderDefinition,
  candidate: string
) => {
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return false
  }

  return provider.allowed_url_prefixes.some((prefix) => {
    let allowed: URL
    try {
      allowed = new URL(prefix.endsWith(':') ? `${prefix}1/` : prefix)
    } catch {
      return false
    }
    if (
      parsed.protocol !== allowed.protocol ||
      parsed.hostname !== allowed.hostname
    ) {
      return false
    }
    if (allowed.port && !prefix.endsWith(':') && parsed.port !== allowed.port) {
      return false
    }
    return parsed.pathname.startsWith(allowed.pathname)
  })
}
