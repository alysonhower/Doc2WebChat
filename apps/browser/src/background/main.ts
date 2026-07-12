import { connect_websocket } from './websocket'
import { setup_keep_alive } from './keep-alive'
import {
  setup_message_listeners,
  sweep_expired_handoffs
} from './message-handler'

async function init() {
  setup_message_listeners()
  await sweep_expired_handoffs()
  setup_keep_alive()
  await connect_websocket()
}

init().catch((error) => {
  console.error('[Doc2WebChat] Extension initialization failed', error)
})
