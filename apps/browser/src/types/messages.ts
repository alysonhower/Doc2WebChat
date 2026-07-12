import {
  HandoffPayload,
  ImportResultMessage,
  InteractionIdentity
} from '@shared/types/websocket-message'

export type RequestHandoffMessage = {
  action: 'request-handoff'
  handoff_id: string
}

export type ContentInteractionMessage = InteractionIdentity & {
  action:
    | 'prefill-completed'
    | 'prefill-failed'
    | 'response-finished'
    | 'import-started'
    | 'import-response'
    | 'import-failed'
  code?: string
  message?: string
}

export type ContentToBackgroundMessage =
  | RequestHandoffMessage
  | ContentInteractionMessage

export type HandoffResponse =
  | { ok: true; payload: HandoffPayload }
  | { ok: false; code: string }

export type BackgroundToContentMessage = ImportResultMessage
