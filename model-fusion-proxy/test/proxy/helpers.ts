import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface TestResponse {
  statusCode: number
  headers: Record<string, string>
  body: string
  json<T = unknown>(): T
}

export function callHandler(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  method: string,
  url: string,
  body?: unknown,
): Promise<TestResponse> {
  return new Promise<TestResponse>((resolve) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : ''
    const readable = new Readable({ read() {} })
    if (bodyStr) readable.push(bodyStr)
    readable.push(null)
    const req = Object.assign(readable, {
      method,
      url,
      headers: bodyStr ? { 'content-type': 'application/json' } : {},
    }) as unknown as IncomingMessage
    let statusCode = 200
    const resHeaders: Record<string, string> = {}
    const chunks: Buffer[] = []
    const res = {
      get statusCode() { return statusCode },
      set statusCode(v: number) { statusCode = v },
      setHeader(name: string, value: unknown): void {
        resHeaders[name.toLowerCase()] = String(value)
      },
      getHeader(name: string): string | undefined {
        return resHeaders[name.toLowerCase()]
      },
      writeHead(code: number, hdrsOrMsg?: unknown, maybeHdrs?: unknown): void {
        statusCode = code
        const h = (maybeHdrs ?? (hdrsOrMsg !== null && typeof hdrsOrMsg === 'object' ? hdrsOrMsg : null)) as Record<string, unknown> | null
        if (h) {
          for (const [k, v] of Object.entries(h)) {
            resHeaders[k.toLowerCase()] = String(v)
          }
        }
      },
      write(chunk: Buffer | string): boolean {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
        return true
      },
      end(chunk?: Buffer | string): void {
        if (chunk !== undefined) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
        }
        const bodyText = Buffer.concat(chunks).toString()
        resolve({
          statusCode,
          headers: resHeaders,
          body: bodyText,
          json<T = unknown>() { return JSON.parse(bodyText) as T },
        })
      },
    } as unknown as ServerResponse
    handler(req, res)
  })
}
