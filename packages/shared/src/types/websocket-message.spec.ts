import {
  is_browser_to_bridge_message,
  parse_bridge_frame,
  parse_health_response,
  parse_handoff_payload
} from './websocket-message'

const identity = {
  interaction_id: 'ec20c80d-a1a4-4b6a-922c-e13a9c1052ec',
  browser_instance_id: 'f816afc4-76e7-48e4-b66f-4ebfad72f943',
  provider_id: 'open-webui',
  provider_url: 'http://localhost:3000/'
}

describe('browser bridge protocol validation', () => {
  it('requires the Doc2WebChat service identity in health responses', () => {
    expect(
      parse_health_response({
        service: 'doc2webchat',
        protocol_version: 1,
        session_token: '0123456789abcdef0123456789abcdef'
      })
    ).not.toBeNull()
    expect(
      parse_health_response({
        service: 'other',
        protocol_version: 1,
        session_token: '0123456789abcdef0123456789abcdef'
      })
    ).toBeNull()
  })

  it('accepts a correlated initialization and rejects wrong providers or URLs', () => {
    const message = {
      action: 'initialize-interaction',
      ...identity,
      handoff_id: 'opaque_handoff_id_123456',
      expires_at: Date.now() + 60_000,
      settings: { model: 'test', reuse_last_tab: true }
    }
    expect(parse_bridge_frame(JSON.stringify(message))).toEqual(message)
    expect(
      parse_bridge_frame(
        JSON.stringify({ ...message, provider_url: 'https://attacker.test/' })
      )
    ).toBeNull()
    expect(
      parse_bridge_frame(
        JSON.stringify({ ...message, interaction_id: 'not-a-uuid' })
      )
    ).toBeNull()
    expect(
      parse_bridge_frame(
        JSON.stringify({
          ...message,
          provider_id: 'copilot',
          provider_url: 'https://copilot.microsoft.com/',
          settings: { temperature: 0.4 }
        })
      )
    ).toBeNull()
  })

  it('rejects non-text, oversized, unknown, and malformed control frames', () => {
    expect(parse_bridge_frame(new ArrayBuffer(1))).toBeNull()
    expect(
      parse_bridge_frame(`{"action":"ping","nonce":"${'x'.repeat(70_000)}"}`)
    ).toBeNull()
    expect(parse_bridge_frame('{')).toBeNull()
    expect(
      parse_bridge_frame(JSON.stringify({ action: 'legacy-chat' }))
    ).toBeNull()
  })

  it('requires identity and a tab for outgoing interaction events', () => {
    expect(
      is_browser_to_bridge_message({
        action: 'prefill-completed',
        ...identity,
        tab_id: 12
      })
    ).toBe(true)
    expect(
      is_browser_to_bridge_message({ action: 'prefill-completed', ...identity })
    ).toBe(false)
  })

  it('accepts the clipboard-baseline ready acknowledgement', () => {
    const message = { action: 'import-result', ...identity, status: 'ready' }
    expect(parse_bridge_frame(JSON.stringify(message))).toEqual(message)
  })

  it('requires an in-memory handoff credential when registration completes', () => {
    const registered = {
      action: 'browser-registered',
      browser_instance_id: identity.browser_instance_id,
      handoff_token: 'handoff-credential-0123456789abcdef'
    }
    expect(parse_bridge_frame(JSON.stringify(registered))).toEqual(registered)
    expect(
      parse_bridge_frame(
        JSON.stringify({ ...registered, handoff_token: 'short' })
      )
    ).toBeNull()
  })

  it('validates leased handoffs without logging or persisting prompt content', () => {
    const handoff = {
      ...identity,
      handoff_id: 'opaque_handoff_id_123456',
      expires_at: Date.now() + 60_000,
      settings: {},
      prompt: '<files>private text</files>'
    }
    expect(parse_handoff_payload(handoff)).toEqual(handoff)
    expect(parse_handoff_payload({ ...handoff, prompt: 1 })).toBeNull()
  })
})
