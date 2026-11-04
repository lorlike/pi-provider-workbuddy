import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gunzipSync } from 'node:zlib'

import { requestIdentityFor } from './request-identity.ts'
import { prepareMessagesBody } from './client.ts'
import { usesMessagesApi } from './routing.ts'
import { requestHeadersFor } from './wire.ts'
import { createWorkBuddyStream } from './stream.ts'
import { workBuddyRequestHeaders } from './wire-headers.ts'
import type { WorkBuddyCredential } from './store.ts'
import type {
  Api,
  Model,
  TranscriptContext,
} from '@earendil-works/pi-ai/compat'

const HEX32 = /^[0-9a-f]{32}$/

function chat(...messages: unknown[]): string {
  return JSON.stringify({ model: 'glm-5.3', stream: true, messages })
}

const user = (content: unknown) => ({ role: 'user', content })
const call = {
  role: 'assistant',
  content: null,
  tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
}
const result = { role: 'tool', tool_call_id: 'c1', content: 'a.go' }

const credential: WorkBuddyCredential = {
  accessToken: 'access-token',
  refreshToken: 'must-not-leak',
  expiresAtMs: Date.now() + 3_600_000,
  domain: '',
  uid: 'u1',
  source: 'oauth',
}

test('one user send keeps one turn id across a tool loop', () => {
  const first = requestIdentityFor(chat(user('run it')), 'ses_1', 'u1|')
  const toolStep = requestIdentityFor(
    chat(user('run it'), call, result),
    'ses_1',
    'u1|',
  )
  const toolImage = requestIdentityFor(
    chat(
      user('run it'),
      call,
      result,
      user([{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }]),
    ),
    'ses_1',
    'u1|',
  )

  assert.equal(toolStep.requestId, first.requestId)
  assert.equal(toolImage.requestId, first.requestId)
  assert.equal(toolStep.conversationId, first.conversationId)
  assert.notEqual(toolStep.messageId, first.messageId)
})

test('the next user message starts a new turn in the same conversation', () => {
  const first = requestIdentityFor(chat(user('first')), 'ses_1', 'u1|')
  const next = requestIdentityFor(
    chat(user('first'), { role: 'assistant', content: 'ok' }, user('next')),
    'ses_1',
    'u1|',
  )

  assert.equal(next.conversationId, first.conversationId)
  assert.notEqual(next.requestId, first.requestId)
})

test('Anthropic tool_result user messages do not become new user sends', () => {
  const first = requestIdentityFor(chat(user('run it')), 'ses_1', 'u1|')
  const messages = chat(
    user('run it'),
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'read', input: {} }],
    },
    user([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.go' },
      { type: 'text', text: 'continue' },
    ]),
  )
  const step = requestIdentityFor(messages, 'ses_1', 'u1|')

  assert.equal(step.requestId, first.requestId)
})

test('conversation ids are stable, account-scoped, and never invented', () => {
  const one = requestIdentityFor(chat(user('same words')), 'ses_1', 'u1|')
  const again = requestIdentityFor(chat(user('same words')), 'ses_1', 'u1|')
  const otherAccount = requestIdentityFor(chat(user('same words')), 'ses_1', 'u2|')
  const noUser = requestIdentityFor(chat({ role: 'system', content: 'hello' }), '', 'u1|')

  assert.equal(again.conversationId, one.conversationId)
  assert.equal(again.requestId, one.requestId)
  assert.notEqual(otherAccount.conversationId, one.conversationId)
  assert.notEqual(otherAccount.requestId, one.requestId)
  assert.equal(noUser.conversationId, undefined)
})

test('desktop CN headers carry client attribution and one message/request id', () => {
  const body = chat(user('hello'))
  const headers = workBuddyRequestHeaders(credential, body, 'ses_1', 'chat')

  assert.equal(headers['User-Agent'], 'WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0')
  assert.equal(headers['X-IDE-Name'], 'WorkBuddy')
  assert.equal(headers['X-IDE-Type'], 'WorkBuddy')
  assert.equal(headers['X-Agent-Purpose'], 'conversation')
  assert.equal(headers['X-Agent-Intent'], 'craft')
  assert.equal(headers['X-Agent-Type'], 'main')
  assert.equal(headers['X-Agent-Runtime'], 'local-agent')
  assert.equal(headers['X-Product'], 'SaaS')
  assert.equal(headers['X-Request-ID'], headers['X-Conversation-Message-ID'])
  assert.match(headers['X-Conversation-Request-ID']!, HEX32)
  assert.match(headers['X-Conversation-ID']!, HEX32)
  assert.equal(headers['X-No-User-Id'], undefined)
  assert.equal(headers['X-No-Enterprise-Id'], undefined)
  assert.equal(headers['X-No-Department-Info'], undefined)
  assert.equal(JSON.stringify(headers).includes(credential.refreshToken), false)
})

test('global headers use the global desktop application name', () => {
  const global = {
    ...credential,
    domain: 'workbuddy.ai',
    enterpriseId: 'ent-1',
  }
  const headers = workBuddyRequestHeaders(
    global,
    chat(user('hello')),
    'ses_1',
    'chat',
  )

  assert.equal(headers['User-Agent'], 'WorkBuddy/5.9.3 workbuddy-ai/5.9.3 CLI/2.165.0')
  assert.equal(headers['X-Enterprise-Id'], 'ent-1')
  assert.equal(headers['X-Tenant-Id'], 'ent-1')
})

test('host SDK headers are replaced while protocol headers are retained', () => {
  const headers = requestHeadersFor(
    credential,
    chat(user('hello')),
    'ses_1',
    'messages',
    {
      authorization: 'Bearer host-client',
      'x-api-key': 'host-client',
      'user-agent': 'host-agent/1.0',
      'x-stainless-runtime-version': 'v0',
      'anthropic-beta': 'some-beta',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
  )

  assert.equal(headers.get('authorization'), 'Bearer access-token')
  assert.equal(headers.get('x-api-key'), null)
  assert.equal(headers.get('user-agent'), 'WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0')
  assert.equal(headers.get('x-stainless-runtime-version'), 'v22.21.1')
  assert.equal(headers.get('anthropic-beta'), 'some-beta')
  assert.equal(headers.get('anthropic-dangerous-direct-browser-access'), null)
})

test('only CN Claude models use the Messages route', () => {
  assert.equal(usesMessagesApi('cn', 'claude-opus-5.5'), true)
  assert.equal(usesMessagesApi('cn', 'glm-5.3'), false)
  assert.equal(usesMessagesApi('global', 'claude-opus-5.5'), false)
})

test('Messages preparation keeps the agent body and drops unsigned thinking', () => {
  const source = JSON.stringify({
    model: 'claude-opus-5.5',
    max_tokens: 4096,
    system: [{ type: 'text', text: 'agent system prompt' }],
    messages: [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'unsigned' },
          { type: 'thinking', thinking: 'empty', signature: '' },
          { type: 'thinking', thinking: 'signed', signature: 'sig' },
          { type: 'text', text: 'answer' },
        ],
      },
    ],
  })
  const prepared = JSON.parse(prepareMessagesBody(source)) as {
    stream: boolean
    system: unknown
    messages: Array<{ content: Array<{ type: string }> }>
  }

  assert.equal(prepared.stream, true)
  assert.deepEqual(prepared.system, [{ type: 'text', text: 'agent system prompt' }])
  assert.deepEqual(
    prepared.messages[1]!.content.map((block) => block.type),
    ['thinking', 'text'],
  )
})

interface CapturedFetch {
  endpoint: string
  headers: Headers
  body: BodyInit | null | undefined
}

function modelFor(protocol: 'chat' | 'messages'): Model<Api> {
  const messages = protocol === 'messages'
  return {
    id: messages ? 'claude-opus-5.5' : 'glm-5.3',
    name: messages ? 'Claude-Opus-5.5' : 'GLM-5.3',
    api: messages ? 'workbuddy-messages' : 'workbuddy-api',
    provider: 'workbuddy',
    baseUrl: 'https://copilot.tencent.com',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 4_096,
    compat: messages
      ? { forceAdaptiveThinking: true, supportsTemperature: true }
      : {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          maxTokensField: 'max_tokens',
          supportsStore: false,
        },
  }
}

async function captureFinalRequest(protocol: 'chat' | 'messages'): Promise<CapturedFetch> {
  const originalFetch = globalThis.fetch
  let captured: CapturedFetch | undefined
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    captured = {
      endpoint: input instanceof Request ? input.url : String(input),
      headers: new Headers(init?.headers),
      body: init?.body,
    }
    return new Response('{"error":"integration probe"}', {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const context = {
      messages: [{
        role: 'user',
        content: 'one user send',
        timestamp: Date.now(),
      }],
    } as unknown as TranscriptContext
    const stream = createWorkBuddyStream(async () => credential, protocol)(
      modelFor(protocol),
      context,
      { sessionId: 'ses_integration' },
    )
    for await (const _event of stream) {
      // The probe returns 500, so draining ends in the normalized error event.
    }
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.notEqual(captured, undefined)
  return captured!
}

function decodedBody(body: BodyInit | null | undefined): string {
  if (typeof body === 'string') return body
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString('utf8')
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8')
  }
  throw new Error(`unexpected final request body: ${String(body)}`)
}

function headerText(headers: Headers): string {
  const lines: string[] = []
  headers.forEach((value, name) => lines.push(`${name}: ${value}`))
  return lines.join('\n')
}

test('final Chat request carries desktop attribution, auth, and gzip', async () => {
  const request = await captureFinalRequest('chat')
  const body = request.headers.get('content-encoding') === 'gzip'
    ? gunzipSync(Buffer.from(request.body as ArrayBuffer)).toString('utf8')
    : decodedBody(request.body)

  assert.equal(request.endpoint, 'https://copilot.tencent.com/v2/chat/completions')
  assert.equal(request.headers.get('authorization'), 'Bearer access-token')
  assert.equal(request.headers.get('x-api-key'), null)
  assert.equal(request.headers.get('content-encoding'), 'gzip')
  assert.equal(request.headers.get('user-agent'), 'WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0')
  assert.equal(request.headers.get('x-agent-purpose'), 'conversation')
  assert.equal(request.headers.get('x-agent-intent'), 'craft')
  assert.equal(request.headers.get('x-agent-type'), 'main')
  assert.equal(request.headers.get('x-agent-runtime'), 'local-agent')
  assert.equal(request.headers.get('x-ide-name'), 'WorkBuddy')
  assert.equal(request.headers.get('x-request-id'), request.headers.get('x-conversation-message-id'))
  assert.match(request.headers.get('x-conversation-request-id')!, HEX32)
  assert.equal(headerText(request.headers).includes(credential.refreshToken), false)
  assert.equal(headerText(request.headers).includes('workbuddy-managed'), false)
  assert.equal(JSON.parse(body).stream, true)
})

test('final Messages request keeps its body plain and removes SDK auth headers', async () => {
  const request = await captureFinalRequest('messages')
  const body = decodedBody(request.body)

  assert.equal(request.endpoint, 'https://copilot.tencent.com/v1/messages')
  assert.equal(request.headers.get('authorization'), 'Bearer access-token')
  assert.equal(request.headers.get('x-api-key'), null)
  assert.equal(request.headers.get('content-encoding'), null)
  assert.equal(request.headers.get('anthropic-version'), '2023-06-01')
  assert.equal(request.headers.get('x-stainless-package-version'), '6.25.0')
  assert.equal(headerText(request.headers).includes(credential.refreshToken), false)
  assert.equal(headerText(request.headers).includes('workbuddy-managed'), false)
  assert.equal(JSON.parse(body).stream, true)
})

