import { show_response_ready_notification } from './show-response-ready-notification'

describe('response-ready notification PT-BR copy', () => {
  it('uses Portuguese user-facing notification text', async () => {
    const created: Array<{ title: string; options: NotificationOptions }> = []
    class FakeNotification {
      static permission: NotificationPermission = 'granted'
      onclick: (() => void) | null = null

      constructor(title: string, options: NotificationOptions) {
        created.push({ title, options })
      }

      close() {}
    }
    ;(global as any).Notification = FakeNotification
    ;(global as any).window = {
      Notification: FakeNotification,
      focus: jest.fn()
    }
    ;(global as any).document = { hasFocus: () => false }

    await show_response_ready_notification({ chatbot_name: 'Z.AI' })

    expect(created).toEqual([
      {
        title: 'Z.AI: resposta pronta',
        options: {
          body: 'Volte ao chat e use Importar resposta para trazê-la ao Doc2WebChat.',
          tag: 'doc2webchat'
        }
      }
    ])
  })
})
