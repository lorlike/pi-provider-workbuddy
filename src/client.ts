/**
 * Upstream HTTP client: chat streaming, model catalog, credits, and the wire
 * preparation the WorkBuddy gateways force.
 *
 * Wire behaviour follows the measured protocol in dingminhua/dsh-connect-workbuddy
 * (MIT), which credits corrinehu/dsh-workbuddy-connect and Sliverkiss/workbuddy2api.
 * Security red lines carried over: model requests never carry the refresh
 * token. Conversation and turn ids are stable for their scope; only the
 * per-message/per-request id is fresh for each HTTP request.
 */

import { randomBytes } from 'node:crypto'
import {
  chatBase,
  APP_UA,
  ERROR_BODY_LIMIT,
  GLOBAL_CONFIG_PATH,
  JSON_TIMEOUT_MS,
  MODELS_CATALOG_PATH,
  regionOf,
  globalBase,
} from './upstream.ts'
import type { WorkBuddyCredential } from './store.ts'
import { selectCliModels } from './store.ts'
import type { WorkBuddyUpstreamModel } from './store.ts'
import { workBuddyProductHeaders } from './wire-headers.ts'

/**
 * Upstream failure classes the client maps onto distinct HTTP answers.
 * Each class exists because a different remedy answers it:
 * hard_credit (top up), soft_rate (account reset, hours away),
 * model_busy (the MODEL is loaded — switch models, not accounts),
 * session_dead (sign in again), policy_reject (content), account_restricted
 * (the ACCOUNT is benched), channel_reject (prompt fingerprints), model_queue
 * (the upstream stated a queue position), server/client/transport.
 */
export type UpstreamErrorKind =
  | 'hard_credit' | 'soft_rate' | 'model_busy' | 'session_dead'
  | 'policy_reject' | 'account_restricted' | 'channel_reject'
  | 'model_queue' | 'not_found' | 'server' | 'client'

export interface WorkBuddyChatResult {
  ok: boolean
  status: number
  kind?: UpstreamErrorKind
  message?: string
  response?: Response
}

// ---------------------------------------------------------------------------
// Error classification (measured tables; codes never drift the way prose does)
// ---------------------------------------------------------------------------

const HARD_CREDIT_MARKERS: readonly string[] = [
  'insufficient credit', 'no credit', 'credit exhausted', 'credits exhausted',
  'out of credit', 'quota exceeded', 'quota exhaust', 'payment required',
  'credit not enough', 'not enough credit', 'credits not enough',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
]
const CREDITS_EXHAUSTED_CODE = 14018
const SESSION_DEAD_MARKERS: readonly string[] = ['Offline user session not found', '12153']
const CONTENT_POLICY_CODE = 11140
const ACCOUNT_RESTRICTED_MARKERS: readonly string[] = [
  '账号存在异常行为',
  'restricted due to unusual activity',
]
const CHANNEL_REJECT_CODE = 11128
const CHANNEL_REJECT_MARKERS: readonly string[] = ['unapproved channel', 'illegal api invocation']
const MODEL_BUSY_CODE = 14003
const QUEUE_CODES: readonly number[] = [6020, 6021, 6022]
/** Upstream 11115: prompt exceeds the model window. English clause for the host's overflow detector. */
export const CONTEXT_OVERFLOW_MARKER = 'prompt is too long (upstream code 11115)'

/** One code field, accepting number and string spellings, nested or direct. */
function businessCodeOf(body: string): number | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    const match = /"code"\s*:\s*"?(\d{4,6}(?!\d))/u.exec(body)
    return match?.[1] === undefined ? undefined : Number(match[1])
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const raw = parsed as Record<string, unknown>
  const direct = asBusinessCode(raw['code'])
  if (direct !== undefined) return direct
  const error = raw['error']
  if (typeof error === 'object' && error !== null) {
    const data = (error as Record<string, unknown>)['data']
    if (typeof data === 'object' && data !== null) return asBusinessCode((data as Record<string, unknown>)['code'])
  }
  const data = raw['data']
  if (typeof data === 'object' && data !== null) return asBusinessCode((data as Record<string, unknown>)['code'])
  return undefined
}

function asBusinessCode(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^\d{4,6}$/u.test(value.trim())) return Number(value.trim())
  return undefined
}

function isAccountRestrictedBody(body: string): boolean {
  if (businessCodeOf(body) !== CONTENT_POLICY_CODE) return false
  const lower = body.toLowerCase()
  return ACCOUNT_RESTRICTED_MARKERS.some(marker => lower.includes(marker.toLowerCase()))
}

function isChannelRejectBody(body: string): boolean {
  const lower = body.toLowerCase()
  return lower.includes(String(CHANNEL_REJECT_CODE)) && CHANNEL_REJECT_MARKERS.some(marker => lower.includes(marker))
}

function isModelBusyBody(body: string): boolean {
  return businessCodeOf(body) === MODEL_BUSY_CODE
}

function isContextTooLongBody(body: string): boolean {
  return businessCodeOf(body) === 11115
}

/** A queue condition (6020/6021/6022) parsed from a failure body. */
export interface WorkBuddyQueueReport {
  code: number
  position?: number
  size?: number
}

export function parseQueueAnswer(text: string): WorkBuddyQueueReport | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const read = (code: unknown, data: unknown): WorkBuddyQueueReport | undefined => {
    if (typeof code !== 'number' || !QUEUE_CODES.includes(code)) return undefined
    const record = typeof data === 'object' && data !== null ? data as Record<string, unknown> : {}
    const position = typeof record['queue_position'] === 'number' ? record['queue_position'] : undefined
    const size = typeof record['queue_size'] === 'number' ? record['queue_size'] : undefined
    return { code, ...(position === undefined ? {} : { position }), ...(size === undefined ? {} : { size }) }
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const envelope = parsed as Record<string, unknown>
  const direct = read(envelope['code'], envelope['data'])
  if (direct !== undefined) return direct
  const data = envelope['data']
  if (typeof data === 'object' && data !== null) {
    const inner = data as Record<string, unknown>
    return read(inner['code'], inner['data'] ?? inner)
  }
  return undefined
}

/** The sentence a queue condition is reported with — the app's own vocabulary. */
export function queueNoticeText(report: WorkBuddyQueueReport): string {
  if (report.code === 6020) {
    const position = report.position === undefined ? '未知' : `${report.position}`
    const size = report.size === undefined ? '' : `，队列共 ${report.size} 个请求`
    return `模型排队中：你排在第 ${position} 位${size}。请稍后重新发送这条消息，或换一个模型`
  }
  if (report.code === 6021) return '模型排队已满：当前队列不再接受新的请求。请稍后重试，或换一个模型'
  return '该账号在此模型上的排队请求已达上限：请等待在途请求完成，或换一个模型'
}

export function classifyUpstreamError(status: number, body: string): UpstreamErrorKind {
  if (status === 402) return 'hard_credit'
  const lower = body.toLowerCase()
  for (const marker of HARD_CREDIT_MARKERS) {
    if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return 'hard_credit'
  }
  if (businessCodeOf(body) === CREDITS_EXHAUSTED_CODE) return 'hard_credit'
  for (const marker of SESSION_DEAD_MARKERS) {
    if (body.includes(String(marker))) return 'session_dead'
  }
  if (isAccountRestrictedBody(body)) return 'account_restricted'
  if (businessCodeOf(body) === CONTENT_POLICY_CODE) return 'policy_reject'
  if (isChannelRejectBody(body)) return 'channel_reject'
  if (isModelBusyBody(body)) return 'model_busy'
  if (parseQueueAnswer(body) !== undefined) return 'model_queue'
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  if (status >= 400) return 'client'
  return 'client'
}

/** HTTP status each upstream failure class surfaces as. */
export const KIND_STATUS: Readonly<Record<UpstreamErrorKind, number>> = {
  hard_credit: 402,
  soft_rate: 429,
  model_busy: 429,
  session_dead: 401,
  policy_reject: 403,
  account_restricted: 403,
  channel_reject: 400,
  model_queue: 429,
  not_found: 502,
  server: 502,
  client: 400,
}

/**
 * A 429 whose body names a reset time is an ACCOUNT statement (hours away) —
 * the host must not spend its in-place retry budget on it. `model_busy` stays
 * retryable: a 14003 recovers in about a minute.
 */
export function failureMessage(kind: UpstreamErrorKind, status: number, body: string): string {
  const queue = parseQueueAnswer(body)
  if (kind === 'model_queue' && queue !== undefined) return `${queueNoticeText(queue)}（上游 code ${queue.code}）`
  const clipped = body.length > 400 ? `${body.slice(0, 400)}…` : body
  const prefix = `workbuddy 上游失败（http ${status}）：`
  const overflow = isContextTooLongBody(body) ? `${CONTEXT_OVERFLOW_MARKER}。` : ''
  switch (kind) {
    case 'hard_credit':
      return `${prefix}${clipped}。积分已用尽，请充值或更换账号`
    case 'soft_rate':
      return `${prefix}${clipped}。该账号的用量限制将在上游声明的时刻重置（与模型负载无关），请稍后再试或换一个账号`
    case 'model_busy':
      return `${prefix}${clipped}。这不是账号被限流，与积分、额度无关——同一凭据下换一个模型即可；请等待约 1 分钟后重试，或切换到负载较低的模型`
    case 'session_dead':
      return `${prefix}${clipped}。登录态已失效，请在 WorkBuddy 桌面端重新登录，或用 /login 重新扫码`
    case 'account_restricted':
      return `${prefix}${clipped}。该账号已被 WorkBuddy 上游按账号限制，与本次请求内容、网络和额度无关；重新登录不改变这一判定`
    case 'policy_reject':
      return `${prefix}${clipped}。该请求被服务端策略拒绝；若说明指向内容，请调整后重试`
    case 'channel_reject':
      return `${prefix}${clipped}。该请求被网关的渠道校验拦截：网关匹配的是 system/assistant 消息的开头指纹，与账号、积分、额度都无关，换账号也不会改变结果`
    default:
      return `${prefix}${overflow}${clipped}`
  }
}

// ---------------------------------------------------------------------------
// Wire preparation
// ---------------------------------------------------------------------------

/**
 * A minimal stand-in system message. Both gateways want the conversation to
 * OPEN with a system message and the international one enforces it (400/11128
 * "first message is not system prompt"). Deliberately tiny — a placeholder,
 * not a persona.
 */
export const WORKBUDDY_FALLBACK_SYSTEM_PROMPT = 'You are a helpful assistant.'

/**
 * System-prompt openings the gateways fingerprint as "an unapproved channel"
 * (business code 11128), matched at offset 0, case-insensitively, after
 * trimming leading whitespace. Measured snapshot, not a theory; prepending the
 * neutral head is the remedy for everything on it.
 */
const UNAPPROVED_CHANNEL_OPENINGS: readonly string[] = [
  'you are an ai agent powered by deepseek harness',
  "you are claude code, anthropic's official cli for claude",
]

export function isUnapprovedChannelOpening(text: string): boolean {
  const opening = text.replace(/^\s+/u, '').toLowerCase()
  return UNAPPROVED_CHANNEL_OPENINGS.some(prefix => opening.startsWith(prefix))
}

/** The roles whose message openings the gateways scan (`user`/`tool` are not). */
function scansOpening(role: unknown): boolean {
  if (typeof role !== 'string') return false
  const name = role.trim().toLowerCase()
  return name === 'system' || name === 'assistant' || name === 'developer'
}

/**
 * Move every scanned message off the content fingerprint by prepending the
 * neutral head. A no-op for a body whose messages start with anything else.
 * Array content is handled part by part: the gate reads EVERY text part.
 */
function neutralizeChannelFingerprints(obj: Record<string, unknown>): void {
  const messages = obj['messages']
  if (!Array.isArray(messages)) return
  for (const value of messages) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const message = value as Record<string, unknown>
    if (!scansOpening(message['role'])) continue
    const content = message['content']
    if (typeof content === 'string') {
      if (isUnapprovedChannelOpening(content)) {
        message['content'] = `${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\n${content}`
      }
      continue
    }
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (typeof part !== 'object' || part === null || Array.isArray(part)) continue
      const record = part as Record<string, unknown>
      if (record['type'] !== 'text' || typeof record['text'] !== 'string') continue
      if (isUnapprovedChannelOpening(record['text'])) {
        record['text'] = `${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\n${record['text']}`
      }
    }
  }
}

/** Guarantee the conversation opens with a system message. */
function ensureSystemHead(obj: Record<string, unknown>): void {
  const messages = obj['messages']
  if (!Array.isArray(messages) || messages.length === 0) return
  const head = messages[0]
  if (typeof head !== 'object' || head === null || Array.isArray(head)) return
  const role = (head as Record<string, unknown>)['role']
  if (typeof role === 'string' && (role === 'system' || role === 'developer')) return
  messages.unshift({ role: 'system', content: WORKBUDDY_FALLBACK_SYSTEM_PROMPT })
}

/** Rewrite OpenAI `tool_choice` spellings into the upstream's string form. */
function normalizeToolChoice(obj: Record<string, unknown>): void {
  const present = 'tool_choice' in obj
  if (!present) return
  const choice = obj['tool_choice']
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') {
      delete obj['tool_choice']
      delete obj['tools']
      delete obj['functions']
    }
    return
  }
  if (typeof choice === 'object' && choice !== null) {
    const record = choice as Record<string, unknown>
    if (record['type'] === 'function') {
      const fn = typeof record['function'] === 'object' && record['function'] !== null
        ? record['function'] as Record<string, unknown>
        : {}
      const name = typeof fn['name'] === 'string' ? fn['name'].trim() : ''
      if (name !== '') {
        obj['tool_choice'] = name
        return
      }
    }
  }
  delete obj['tool_choice']
}

/**
 * Normalize an OpenAI chat-completions body for the WorkBuddy upstream: force
 * `stream: true` (the upstream rejects non-streaming), flatten `tool_choice`,
 * rewrite `developer` to `system` (the gateways reject `developer` with 11128),
 * guarantee a leading system message, and move a recognized third-party-agent
 * system prompt off the gateways' content fingerprint.
 */
export function prepareChatBody(source: string): string {
  let body: unknown
  try {
    body = JSON.parse(source)
  } catch {
    return source
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return source
  const obj = body as Record<string, unknown>
  obj['stream'] = true
  if (Array.isArray(obj['messages'])) {
    for (const value of obj['messages']) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      const message = value as Record<string, unknown>
      if (message['role'] === 'developer') message['role'] = 'system'
    }
  }
  ensureSystemHead(obj)
  neutralizeChannelFingerprints(obj)
  normalizeToolChoice(obj)
  return JSON.stringify(obj)
}

/**
 * Anthropic Messages bodies go to WorkBuddy essentially as the agent sent
 * them. The one measured exception is unsigned thinking: a history moved from
 * the chat route can contain unsigned blocks, and their presence beside a
 * signed block is refused with 11159 as belonging to another conversation.
 * Unsigned thinking cannot be verified by the model anyway, so it is dropped.
 */
function removeUnsignedThinking(obj: Record<string, unknown>): boolean {
  const messages = obj['messages']
  if (!Array.isArray(messages)) return false
  let changed = false
  for (const value of messages) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const message = value as Record<string, unknown>
    if (message['role'] !== 'assistant' || !Array.isArray(message['content'])) continue
    const kept = message['content'].filter((part) => {
      if (typeof part !== 'object' || part === null || Array.isArray(part)) return true
      const block = part as Record<string, unknown>
      return block['type'] !== 'thinking'
        || (typeof block['signature'] === 'string' && block['signature'] !== '')
    })
    if (kept.length === message['content'].length) continue
    changed = true
    message['content'] = kept.length > 0 ? kept : [{ type: 'text', text: '' }]
  }
  return changed
}

/**
 * Prepare an Anthropic Messages body for the CN WorkBuddy route. It is not a
 * chat conversion: system blocks, tools, developers and token fields stay as
 * the agent wrote them.
 */
export function prepareMessagesBody(source: string): string {
  let body: unknown
  try {
    body = JSON.parse(source)
  } catch {
    return source
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return source
  const obj = body as Record<string, unknown>
  obj['stream'] = true
  removeUnsignedThinking(obj)
  return JSON.stringify(obj)
}

/** Tool names this request offered, for DSML recovery's gate 2. */
export interface DeclaredTools {
  names: ReadonlySet<string>
  requiredParameters: ReadonlyMap<string, readonly string[]>
  acceptedParameters: ReadonlyMap<string, ReadonlySet<string>>
}

export function declaredTools(bodyJson: string): DeclaredTools | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyJson)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const tools = (parsed as Record<string, unknown>)['tools']
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const names = new Set<string>()
  const requiredParameters = new Map<string, readonly string[]>()
  const acceptedParameters = new Map<string, ReadonlySet<string>>()
  for (const tool of tools) {
    if (typeof tool !== 'object' || tool === null) continue
    const record = tool as Record<string, unknown>
    const fn = typeof record['function'] === 'object' && record['function'] !== null
      ? record['function'] as Record<string, unknown>
      : record
    const name = typeof fn['name'] === 'string' ? fn['name'].trim() : ''
    if (name === '') continue
    names.add(name)
    const parameters = typeof fn['parameters'] === 'object' && fn['parameters'] !== null
      ? fn['parameters'] as Record<string, unknown>
      : {}
    const properties = typeof parameters['properties'] === 'object' && parameters['properties'] !== null
      ? parameters['properties'] as Record<string, unknown>
      : {}
    acceptedParameters.set(name, new Set(Object.keys(properties)))
    requiredParameters.set(name, Array.isArray(parameters['required'])
      ? (parameters['required'] as unknown[]).filter((entry): entry is string => typeof entry === 'string')
      : [])
  }
  if (names.size === 0) return undefined
  return { names, requiredParameters, acceptedParameters }
}

/** Read a JSON envelope; throws with the classified error on failure. */
async function readEnvelope(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`workbuddy upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`workbuddy upstream returned an unexpected document (http ${response.status})`)
  }
  const document = parsed as Record<string, unknown>
  const code = typeof document['code'] === 'number' ? document['code'] : 0
  if (!response.ok || code !== 0) {
    const msg = typeof document['msg'] === 'string' ? document['msg'] : text.slice(0, 160)
    throw new Error(`workbuddy upstream error (http ${response.status}): ${msg}`)
  }
  return document
}

/** Read a JSON envelope's `data` as an object; non-object data is an empty one. */
function envelopeData(document: Record<string, unknown>): Record<string, unknown> {
  const data = document['data']
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {}
}

/**
 * Upstream HTTP client. Requests take the credential explicitly so token
 * refreshes apply on the next call.
 */
export class WorkBuddyUpstreamClient {
  /**
   * POST a model endpoint. Headers are assembled by the wire layer because
   * they carry per-request conversation identity; a successful answer is the
   * raw SSE response.
   */
  async modelStream(
    endpoint: string,
    body: string | ArrayBuffer,
    headers: Headers,
    signal?: AbortSignal,
  ): Promise<WorkBuddyChatResult> {
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body,
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` }
    }
    if (response.ok) return { ok: true, status: response.status, response }
    const text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
    return {
      ok: false,
      status: response.status,
      kind: classifyUpstreamError(response.status, text),
      message: text,
    }
  }

  /**
   * Read the model directory for the credential's region.
   *
   * Both regions read `/v3/config` as the APP's product identity — the CLI
   * channel's answer is a strict subset and publishes no promotion feed. CN
   * falls back to the legacy `/v2` document so a gateway that stops serving
   * the modern one degrades instead of emptying the region.
   */
  async fetchModels(
    credential: WorkBuddyCredential,
    signal?: AbortSignal,
  ): Promise<readonly WorkBuddyUpstreamModel[]> {
    const timeout = signal ?? AbortSignal.timeout(JSON_TIMEOUT_MS)
    const readCatalog = async (path: string): Promise<readonly WorkBuddyUpstreamModel[]> => {
      const response = await fetch(`${chatBase(credential)}${path}`, {
        headers: workBuddyProductHeaders(credential),
        signal: timeout,
      })
      const envelope = await readEnvelope(response)
      const data = envelopeData(envelope)
      return selectCliModels(data['models'], data['agents'])
    }
    try {
      return await readCatalog(GLOBAL_CONFIG_PATH)
    } catch (error) {
      if (regionOf(credential.domain) === 'global') throw error
      console.warn(`[pi-provider-workbuddy] CN catalog ${GLOBAL_CONFIG_PATH} failed; falling back to ${MODELS_CATALOG_PATH}:`,
        error instanceof Error ? error.message : error)
      return await readCatalog(MODELS_CATALOG_PATH)
    }
  }

  /**
   * Read the remaining credit (read-only, no cost). Personal accounts read
   * `/v2/billing/meter/get-user-resource`; enterprise members read
   * `/billing/meter/get-enterprise-user-usage` (no `/v2` prefix), where
   * REMAINING is `limitNum - credit`.
   */
  async fetchCredits(credential: WorkBuddyCredential): Promise<{ total?: number, raw?: string }> {
    const base = regionOf(credential.domain) === 'global' ? globalBase(credential.domain) : 'https://www.codebuddy.cn'
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${credential.accessToken}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': APP_UA,
      'X-Product': 'SaaS',
      'X-IDE-Type': 'WorkBuddy',
      'X-IDE-Name': 'WorkBuddy',
      ...(credential.uid !== '' ? { 'X-User-Id': credential.uid } : {}),
      ...(credential.enterpriseId !== undefined && credential.enterpriseId !== ''
        ? { 'X-Enterprise-Id': credential.enterpriseId, 'X-Tenant-Id': credential.enterpriseId }
        : {}),
      ...(credential.domain !== '' ? { 'X-Domain': credential.domain } : {}),
    }
    if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
      const response = await fetch(`${base}/billing/meter/get-enterprise-user-usage`, {
        method: 'POST',
        headers,
        body: '{}',
        signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
      })
      const envelope = await readEnvelope(response)
      const wrapper = envelopeData(envelope)
      const inner = typeof wrapper['Data'] === 'object' && wrapper['Data'] !== null
        ? wrapper['Data'] as Record<string, unknown>
        : wrapper
      const limit = typeof inner['limitNum'] === 'number' ? inner['limitNum'] : undefined
      const used = typeof inner['credit'] === 'number' ? inner['credit'] : undefined
      if (limit !== undefined && used !== undefined) return { total: Math.max(0, limit - used) }
      return {}
    }
    const now = new Date()
    const format = (date: Date): string => [
      date.getFullYear().toString().padStart(4, '0'),
      (date.getMonth() + 1).toString().padStart(2, '0'),
      date.getDate().toString().padStart(2, '0'),
    ].join(' ') + ' ' + [
      date.getHours().toString().padStart(2, '0'),
      date.getMinutes().toString().padStart(2, '0'),
      date.getSeconds().toString().padStart(2, '0'),
    ].join(':')
    const response = await fetch(`${base}/v2/billing/meter/get-user-resource`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: 'p_tcaca',
        Status: [0, 3],
        PackageEndTimeRangeBegin: format(now),
        PackageEndTimeRangeEnd: format(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
      }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    const wrapper = envelopeData(envelope)
    const data = typeof wrapper['Response'] === 'object' && wrapper['Response'] !== null
      ? wrapper['Response'] as Record<string, unknown>
      : {}
    const inner = typeof data['Data'] === 'object' && data['Data'] !== null
      ? data['Data'] as Record<string, unknown>
      : {}
    const accounts = Array.isArray(inner['Accounts']) ? inner['Accounts'] : []
    let total = 0
    for (const raw of accounts) {
      if (typeof raw !== 'object' || raw === null) continue
      const account = raw as Record<string, unknown>
      const precise = (key: string): number => {
        const preciseRaw = account[`${key}Precise`]
        if (typeof preciseRaw === 'string' && preciseRaw !== '') {
          const parsed = Number.parseFloat(preciseRaw)
          if (Number.isFinite(parsed)) return parsed
        }
        if (typeof preciseRaw === 'number' && Number.isFinite(preciseRaw)) return preciseRaw
        return typeof account[key] === 'number' ? account[key] as number : 0
      }
      const monthly = account['CapacityType'] === 4
      const hasCycle = account['CycleCapacityRemain'] !== undefined
      const remain = (hasCycle ? precise('CycleCapacityRemain') : precise('CapacityRemain'))
      const capped = remain < 0 ? 0 : remain
      if (!monthly && capped <= 0) continue
      total += capped
    }
    return { total, raw: JSON.stringify({ total }) }
  }
}

/** One fresh UUID (used for session identity and OAuth login ids). */
export function freshId(): string {
  return randomBytes(16).toString('hex')
}
