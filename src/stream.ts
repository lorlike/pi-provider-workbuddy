/**
 * The WorkBuddy stream implementation.
 *
 * Rather than re-implementing the OpenAI Completions wire handling, this
 * delegates to pi-ai's `openai-completions` implementation and overlays the
 * WorkBuddy specifics through the seams it provides:
 *
 * - `options.onPayload` rewrites the serialized body per request (forced
 *   `stream: true`, flattened `tool_choice`, `developer`→`system`, guaranteed
 *   system head, channel-fingerprint neutralisation) AND swaps in the
 *   WorkBuddy headers via `options.headers` — Bearer access token, the
 *   conversation-identity triple, `X-User-Id`/`X-Enterprise-Id`/`X-Domain`,
 *   the CLI user agent.
 * - `options.fetch` posts to the real upstream with those headers, so the
 *   SDK's streaming parse, usage accounting, and cancellation all keep
 *   working; the access token never appears in `apiKey` (the SDK still
 *   requires one, so a placeholder is passed and the real header overrides).
 * - Error text is normalized (queue positions, overflow marker) so pi's
 *   retry/compaction machinery sees recognizable conditions.
 */

import {
  createAssistantMessageEventStream,
  getCurrentTools,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from '@earendil-works/pi-ai/compat'
import { gzipSync } from 'node:zlib'

import {
  WorkBuddyUpstreamClient,
  prepareChatBody,
  prepareMessagesBody,
  failureMessage,
  KIND_STATUS,
} from './client.ts'
import type { UpstreamErrorKind } from './client.ts'
import { DsmlStreamBuffer, parseToolCalls, stripMarkup } from './dsml.ts'
import type { RecoveredToolCall } from './dsml.ts'
import type { WorkBuddyCredential } from './store.ts'
import type { WorkBuddyWireProtocol } from './wire-headers.ts'

/**
 * A credential the stream can resolve per request. The store refreshes
 * tokens; the stream asks it afresh on every call so a mid-session refresh
 * applies without a reload.
 */
export type CredentialResolver = () => Promise<WorkBuddyCredential>

function placeholderMessage(model: Model<Api>, errorMessage: string, aborted: boolean): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: aborted ? 'aborted' : 'error',
    errorMessage,
    timestamp: Date.now(),
  }
}

/**
 * Stream one chat completion through the WorkBuddy gateway.
 *
 * The heavy lifting (request conversion, tool handling, usage accounting,
 * abort) belongs to pi-ai's openai-completions implementation; this wrapper
 * exists to (a) put the WorkBuddy headers and body rewrites on the wire and
 * (b) recover DSML tool-call markup the model writes into text instead of
 * `delta.tool_calls` — which the inner stream cannot know about.
 */
export function createWorkBuddyStream(
  resolveCredential: CredentialResolver,
  protocol: WorkBuddyWireProtocol = 'chat',
): (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => AssistantMessageEventStream {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream()

    void (async () => {
      try {
        const credential = await resolveCredential()

        // The DSML gate rides on the request's own tool declarations, read
        // from the transcript's system messages (the same source the inner
        // api reads; the request body itself is only fully known inside
        // onPayload, which is where prepareChatBody runs).
        const declaredTools = protocol === 'chat' ? getCurrentTools(context.messages) : []
        const gateNames = new Set(declaredTools.map(tool => tool.name))
        const buffer = protocol === 'chat' && gateNames.size > 0
          ? new DsmlStreamBuffer({
              declaredNames: gateNames,
              requiredParameters: new Map(declaredTools.map((tool) => {
                const parameters = (tool as { parameters?: { required?: string[] } }).parameters
                return [tool.name, Array.isArray(parameters?.required) ? parameters.required : []]
              })),
              acceptedParameters: new Map(declaredTools.map((tool) => {
                const parameters = (tool as { parameters?: { properties?: Record<string, unknown> } }).parameters
                return [tool.name, new Set(Object.keys(parameters?.properties ?? {}))]
              })),
            })
          : undefined

        const { endpointFor, requestHeadersFor, upstreamBaseFor } = await import('./wire.ts')
        const base = upstreamBaseFor(credential)
        const upstream = new WorkBuddyUpstreamClient()

        // Delegate to the built-in openai-completions implementation and
        // overlay the WorkBuddy specifics through its seams: headers carry
        // the real identity, onPayload forces the stream flag, and the
        // custom fetch forwards to the upstream client so classification,
        // queue notices and credential handling stay in one place.
        const innerOptions: SimpleStreamOptions = {
          ...options,
          apiKey: 'workbuddy-managed',
          headers: {
            Authorization: `Bearer ${credential.accessToken}`,
            ...(protocol === 'messages' ? { 'x-api-key': null } : {}),
          },
          maxRetries: 0,
          timeoutMs: 1_200_000,
          onPayload: (payload: unknown) => {
            const params = payload as Record<string, unknown>
            params['stream'] = true
            return params
          },
          fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
            const bodyJson = await bodyText(init?.body)
            const prepared = protocol === 'messages'
              ? prepareMessagesBody(bodyJson)
              : prepareChatBody(bodyJson)
            const signal = init?.signal ?? options?.signal
            const headers = requestHeadersFor(
              credential,
              prepared,
              options?.sessionId ?? '',
              protocol,
              init?.headers,
            )
            let requestBody: string | ArrayBuffer = prepared
            if (protocol === 'chat') {
              // The desktop CLI's GzipRequestProcessor compresses every model
              // POST. This is material for long agent histories and also part
              // of the request shape WorkBuddy measures.
              const compressed = gzipSync(Buffer.from(prepared))
              requestBody = compressed.buffer.slice(
                compressed.byteOffset,
                compressed.byteOffset + compressed.byteLength,
              )
              headers.set('Content-Encoding', 'gzip')
            }
            headers.delete('Content-Length')

            const result = await upstream.modelStream(
              endpointFor(credential, protocol),
              requestBody,
              headers,
              signal,
            )
            if (!result.ok) {
              const kind: UpstreamErrorKind = result.kind ?? 'server'
              const status = KIND_STATUS[kind]
              const message = failureMessage(kind, result.status, result.message ?? '')
              const error = new Error(message) as Error & { status?: number; headers?: Headers }
              error.status = status
              const responseHeaders = new Headers()
              // A queue is a 429 in the sense the host understands, but
              // retrying a position in the thousands only spends real
              // requests: tell every retrying client not to.
              if (kind === 'model_queue') responseHeaders.set('x-should-retry', 'false')
              error.headers = responseHeaders
              throw error
            }
            // Post-process the SSE stream: recover DSML tool calls written
            // into delta.content before the inner api parses the frames.
            if (buffer === undefined || result.response === undefined) {
              return result.response ?? new Response(null, { status: 200 })
            }
            return transformSse(result.response, buffer)
          }) as typeof fetch,
        }

        const { anthropicMessagesApi, openAICompletionsApi } = await import('@earendil-works/pi-ai/compat')
        const api = protocol === 'messages' ? anthropicMessagesApi() : openAICompletionsApi()
        const inner = api.streamSimple({ ...model, baseUrl: base }, context, innerOptions)
        for await (const event of inner) stream.push(event)
        stream.end()
      } catch (error) {
        stream.push({
          type: 'error',
          reason: options?.signal?.aborted ? 'aborted' : 'error',
          error: placeholderMessage(model, error instanceof Error ? error.message : String(error), options?.signal?.aborted === true),
        })
        stream.end()
      }
    })()

    return stream
  }
}

/** Read a provider SDK's JSON body without assuming it is always a string. */
async function bodyText(body: BodyInit | null | undefined): Promise<string> {
  if (typeof body === 'string') return body
  if (body === undefined || body === null) return ''
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body)
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    )
  }
  return await new Response(body).text()
}

/**
 * Pass an upstream SSE response through a DSML recovery buffer, rewriting
 * `delta.content` frames: recovered calls leave as real `delta.tool_calls`
 * deltas; markup that failed the gates leaves verbatim (gate 4).
 */
function transformSse(response: Response, buffer: DsmlStreamBuffer): Response {
  const decoder = new TextDecoder()
  let carry = ''
  const reader = response.body!.getReader()

  const textStream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          const flushed = buffer.flush()
          if (flushed.text !== '') {
            // The flushed tail is plain text inside the LAST content chunk;
            // re-emit it as its own content delta frame so nothing held is
            // lost when the upstream ends mid-answer.
            controller.enqueue(encodeFrame(contentDeltaFrame(flushed.text)))
          }
          controller.enqueue(ENCODER.encode('data: [DONE]\n\n'))
          controller.close()
          return
        }
        carry += decoder.decode(value, { stream: true })
        // Frames are separated by blank lines; keep the trailing partial.
        let newline: number
        while ((newline = carry.indexOf('\n\n')) !== -1) {
          const frame = carry.slice(0, newline + 2)
          carry = carry.slice(newline + 2)
          for (const rewritten of processFrame(frame, buffer)) {
            controller.enqueue(encodeFrame(rewritten))
          }
        }
      } catch (error) {
        controller.error(error)
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })

  return new Response(textStream, {
    status: response.status,
    headers: response.headers,
  })
}

const ENCODER = new TextEncoder()

function encodeFrame(frame: string): Uint8Array {
  return ENCODER.encode(frame.endsWith('\n\n') ? frame : frame.endsWith('\n') ? `${frame}\n` : `${frame}\n\n`)
}

/** One minimal OpenAI chunk frame carrying a content delta. */
function contentDeltaFrame(text: string): string {
  const chunk = {
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  }
  return `data: ${JSON.stringify(chunk)}\n\n`
}

/**
 * Rewrite one SSE frame: recover calls from its `delta.content`, replace the
 * content with what survived, and append any recovered calls as native
 * `delta.tool_calls` deltas.
 */
function processFrame(frame: string, buffer: DsmlStreamBuffer): string[] {
  if (!frame.startsWith('data:')) return [frame]
  const payload = frame.slice(5).trim()
  if (payload === '' || payload === '[DONE]') return [frame]
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return [frame]
  }
  if (typeof parsed !== 'object' || parsed === null) return [frame]
  const chunk = parsed as Record<string, unknown>
  const choices = chunk['choices']
  if (!Array.isArray(choices) || choices.length === 0) return [frame]
  const choice = choices[0] as Record<string, unknown>
  const delta = typeof choice['delta'] === 'object' && choice['delta'] !== null
    ? choice['delta'] as Record<string, unknown>
    : undefined
  if (delta === undefined) return [frame]

  const content = delta['content']
  if (typeof content !== 'string' || content === '') {
    // Reasoning content passes through untouched; no content means nothing
    // for the buffer to see.
    return [frame]
  }

  const outcome = buffer.add(content)
  delta['content'] = outcome.text

  if (outcome.calls !== undefined && outcome.calls.length > 0) {
    const toolCalls = outcome.calls.map((call, index) => ({
      index,
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }))
    delta['tool_calls'] = toolCalls
  }

  return [`data: ${JSON.stringify(chunk)}\n\n`]
}
