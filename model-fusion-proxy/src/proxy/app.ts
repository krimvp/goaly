import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ModelRegistry } from './registry'
import type { FusionRouter } from './router'
import type { ChatCompletionRequest, ChatMessage } from './provider'

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(json)
}

function errorEnvelope(res: ServerResponse, status: number, message: string, type: string): void {
  sendJson(res, status, { error: { message, type } })
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

function validateChatRequest(body: unknown): ChatCompletionRequest {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Request body must be a JSON object')
  }
  const obj = body as Record<string, unknown>

  const model = obj['model']
  if (typeof model !== 'string' || !model) {
    throw new Error('"model" must be a non-empty string')
  }

  const messages = obj['messages']
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('"messages" must be a non-empty array')
  }

  const validRoles = new Set(['system', 'user', 'assistant'])
  for (const msg of messages as unknown[]) {
    if (typeof msg !== 'object' || msg === null) {
      throw new Error('Each message must be an object')
    }
    const m = msg as Record<string, unknown>
    const role = m['role']
    const content = m['content']
    if (typeof role !== 'string' || !validRoles.has(role)) {
      throw new Error('Message role must be one of: system, user, assistant')
    }
    if (typeof content !== 'string') {
      throw new Error('Message content must be a string')
    }
  }

  const req: ChatCompletionRequest = {
    model,
    messages: messages as ChatMessage[],
  }
  const stream = obj['stream']
  const temperature = obj['temperature']
  const max_tokens = obj['max_tokens']
  if (stream !== undefined) req.stream = Boolean(stream)
  if (temperature !== undefined) req.temperature = Number(temperature)
  if (max_tokens !== undefined) req.max_tokens = Number(max_tokens)
  return req
}

export function createApp(
  registry: ModelRegistry,
  router: FusionRouter,
): (req: IncomingMessage, res: ServerResponse) => void {
  return async (req, res) => {
    const { method, url } = req

    if (method === 'GET' && url === '/health') {
      sendJson(res, 200, { status: 'ok' })
      return
    }

    if (method === 'GET' && url === '/v1/models') {
      sendJson(res, 200, { object: 'list', data: registry.listModels() })
      return
    }

    if (method === 'POST' && url === '/v1/chat/completions') {
      let parsed: unknown
      try {
        const text = await readBody(req)
        if (!text) {
          errorEnvelope(res, 400, 'Request body is required', 'invalid_request_error')
          return
        }
        parsed = JSON.parse(text)
      } catch {
        errorEnvelope(res, 400, 'Invalid JSON body', 'invalid_request_error')
        return
      }

      let chatReq: ChatCompletionRequest
      try {
        chatReq = validateChatRequest(parsed)
      } catch (e) {
        errorEnvelope(res, 400, e instanceof Error ? e.message : 'Invalid request', 'invalid_request_error')
        return
      }

      try {
        const result = await router.route(chatReq)
        res.setHeader('x-fusion-route', `${result.provider}/${result.model}`)
        sendJson(res, 200, result.completion)
      } catch {
        errorEnvelope(res, 502, 'All upstream routes failed', 'upstream_error')
      }
      return
    }

    errorEnvelope(res, 404, `Cannot ${method ?? 'UNKNOWN'} ${url ?? '/'}`, 'not_found')
  }
}
