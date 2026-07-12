export const show_response_ready_notification = async (params: {
  chatbot_name: string
}) => {
  if (!('Notification' in window) || document.hasFocus()) {
    return
  }

  let permission = Notification.permission

  if (permission == 'default') {
    permission = await Notification.requestPermission()
  }

  if (permission == 'granted') {
    const notification = new Notification(
      `${params.chatbot_name} response is ready`,
      {
        body: 'Return to the chat and use Import response to bring it into Doc2WebChat.',
        tag: 'doc2webchat'
      }
    )

    notification.onclick = () => {
      window.focus()
      notification.close()
    }
  }
}
