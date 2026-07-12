import { PROVIDER_REGISTRY } from '../types/provider-registry'

type Chatbot = {
  id: string
  url: string
  supports_custom_temperature?: boolean
  supports_custom_top_p?: boolean
  supports_system_instructions?: boolean
  supports_user_provided_model?: boolean
  supports_user_provided_port?: boolean
  supports_reasoning_effort?: boolean
  supported_reasoning_efforts?: string[]
  supports_thinking_budget?: boolean
  supports_url_override?: boolean
  url_override_label?: string
  url_override_disabled_options?: string[]
  default_system_instructions?: string
  supported_options?: Record<string, string>
  models?: Record<
    string,
    {
      label: string
      disabled_options?: string[]
      supported_reasoning_efforts?: string[]
    }
  >
}

export const CHATBOTS: Record<string, Chatbot> = Object.fromEntries(
  PROVIDER_REGISTRY.providers.map((provider) => {
    const controls = provider.controls
    const models = controls.model?.values
      ? Object.fromEntries(
          Object.entries(controls.model.values).map(([id, model]) => [
            id,
            {
              label: model.label,
              disabled_options: model.disabled_options,
              supported_reasoning_efforts: model.reasoning_efforts
            }
          ])
        )
      : undefined
    return [
      provider.label,
      {
        id: provider.id,
        url: provider.canonical_url,
        supports_custom_temperature: controls.temperature,
        supports_custom_top_p: controls.top_p,
        supports_system_instructions:
          controls.system_instructions !== undefined,
        supports_user_provided_model: controls.model?.user_provided,
        supports_user_provided_port: controls.port,
        supports_reasoning_effort: controls.reasoning_effort !== undefined,
        supported_reasoning_efforts: controls.reasoning_effort?.values,
        supports_thinking_budget: controls.thinking_budget,
        supports_url_override: controls.url_override !== undefined,
        url_override_label: controls.url_override?.label,
        url_override_disabled_options: controls.url_override?.disabled_options,
        default_system_instructions: controls.system_instructions?.default,
        supported_options: controls.options,
        models
      }
    ]
  })
)
