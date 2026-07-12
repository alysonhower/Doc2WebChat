// WebSocket configuration
export const DEFAULT_PORT = 55155
export const LOOPBACK_HOST = '127.0.0.1'
export const BRIDGE_HTTP_ORIGIN = `http://${LOOPBACK_HOST}:${DEFAULT_PORT}`
export const BRIDGE_WS_URL = `ws://${LOOPBACK_HOST}:${DEFAULT_PORT}/bridge`
