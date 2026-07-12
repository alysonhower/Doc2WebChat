import {
  PROVIDER_REGISTRY,
  get_provider,
  is_allowed_provider_url
} from './provider-registry'

describe('provider registry', () => {
  it('defines exactly 20 unique provider and adapter IDs', () => {
    expect(PROVIDER_REGISTRY.providers).toHaveLength(20)
    expect(new Set(PROVIDER_REGISTRY.providers.map((p) => p.id)).size).toBe(20)
    expect(
      new Set(PROVIDER_REGISTRY.providers.map((p) => p.adapter_key)).size
    ).toBe(20)
    expect(get_provider('z-ai')?.label).toBe('Z.AI')
  })

  it('keeps manifest matches and native controls in every adapter entry', () => {
    for (const provider of PROVIDER_REGISTRY.providers) {
      expect(provider.manifest_matches.length).toBeGreaterThan(0)
      expect(provider.dom_controls).toContain('message')
      expect(provider.dom_controls).toContain('response_observer')
      expect(provider.dom_controls).toContain('native_copy')
    }
  })

  it('validates URLs by parsed host rather than unsafe string prefix', () => {
    const open_webui = get_provider('open-webui')!
    expect(is_allowed_provider_url(open_webui, 'http://localhost:3000/')).toBe(
      true
    )
    expect(
      is_allowed_provider_url(open_webui, 'http://localhost.evil.test/')
    ).toBe(false)
    expect(
      is_allowed_provider_url(
        get_provider('chatgpt')!,
        'https://chatgpt.com.evil.test/'
      )
    ).toBe(false)
  })
})
