export namespace Logger {
  const LOG_PREFIX = '[Doc2WebChat]'

  type Entry = {
    function_name?: string
    message: string
    data?: unknown
  }

  const format = (entry: Entry) =>
    `${LOG_PREFIX}${entry.function_name ? `[${entry.function_name}] ` : ''}${entry.message}`

  export const info = (entry: Entry) => console.info(format(entry), entry.data)
  export const warn = (entry: Entry) => console.warn(format(entry), entry.data)
  export const error = (entry: Entry) =>
    console.error(format(entry), entry.data)
}
