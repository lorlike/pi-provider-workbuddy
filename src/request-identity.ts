/**
 * WorkBuddy request identity.
 *
 * WorkBuddy's backend counts one user send as one request by
 * X-Conversation-Request-ID. Every request made while answering that send -
 * tool-result round trips and retries included - must keep the same value;
 * the user's next message gets a new one. A conversation keeps its
 * X-Conversation-ID across turns.
 *
 * The ids are derived from the Pi session and the user's own message. Tool
 * results and tool-result image attachments never become a "user send" of
 * their own. The process salt prevents message text from being recoverable
 * from the ids that leave the machine.
 */

import { createHash, randomBytes } from 'node:crypto'

const SALT = randomBytes(16).toString('hex')

type JsonRecord = Record<string, unknown>

export interface WorkBuddyRequestIdentity {
  /** Present only when the session or first real user message names a conversation. */
  conversationId?: string
  /** Shared by every HTTP request made while answering one user send. */
  requestId: string
  /** This HTTP request's own id. Always changes between sends. */
  messageId: string
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value) ?? '')
    .digest('hex')
    .slice(0, 8)
}

/**
 * What a message carries as the user's own words. Tool-result blocks are
 * explicitly excluded because they change on every tool-loop step.
 */
export function signatureParts(content: unknown): string[] {
  if (typeof content === 'string') return content === '' ? [] : [content]
  if (!Array.isArray(content)) return []

  const parts: string[] = []
  for (const value of content) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const part = value as JsonRecord
    const type = typeof part['type'] === 'string' ? part['type'] : ''
    if (type === '' || type === 'text') {
      const text = part['text']
      if (typeof text === 'string' && text !== '') parts.push(text)
      continue
    }
    if (type === 'tool_result' || type === 'tool-result') continue
    parts.push(`[${type}:${digest(part)}]`)
  }
  return parts
}

function hasBlock(message: JsonRecord, type: string): boolean {
  const content = message['content']
  return Array.isArray(content) && content.some((part) => {
    if (typeof part !== 'object' || part === null || Array.isArray(part)) return false
    return (part as JsonRecord)['type'] === type
  })
}

/**
 * Whether a user-shaped message answers an earlier tool call instead of being
 * a new thing the person typed. Anthropic carries tool results in user
 * messages; Pi also emits a user message for images attached to a tool result.
 */
function answeredBefore(messages: readonly JsonRecord[], index: number): boolean {
  if (hasBlock(messages[index]!, 'tool_result')) return true

  let previousIndex = index - 1
  while (previousIndex >= 0 && messages[previousIndex]?.['role'] === 'system') previousIndex--
  const previous = messages[previousIndex]
  if (previous === undefined) return false
  if (previous['role'] === 'tool') return true
  if (previous['role'] === 'user' && hasBlock(previous, 'tool_result')) return true
  if (previous['role'] !== 'assistant') return false

  const tools = previous['tool_calls']
  if (Array.isArray(tools) && tools.length > 0) return true
  return hasBlock(previous, 'tool_use')
}

/** Parts that name the user send a request belongs to. */
export function turnParts(messages: readonly JsonRecord[]): string[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.['role'] !== 'user' || answeredBefore(messages, index)) continue
    const signature = signatureParts(message['content'])
    return signature.length === 0 ? [] : [`u${index}:`, ...signature]
  }
  return []
}

/** Parts that name the conversation: the Pi session, else its first user message. */
export function conversationParts(
  messages: readonly JsonRecord[],
  sessionId: string,
): string[] {
  const session = sessionId.trim().slice(0, 128)
  if (session !== '') return [`session:${session}`]

  for (const message of messages) {
    if (message?.['role'] !== 'user') continue
    const signature = signatureParts(message['content'])
    if (signature.length > 0) return ['first:', ...signature]
  }
  return []
}

function idFor(kind: string, accountScope: string, parts: readonly string[]): string {
  const hash = createHash('sha256').update(`${SALT}|${kind}|account:${accountScope}|`)
  for (const part of parts) {
    // Length-prefix each part so adjacent parts cannot produce the same stream.
    hash.update(`${part.length}:`)
    hash.update(part)
  }
  return hash.digest('hex').slice(0, 32)
}

function freshId(): string {
  return randomBytes(16).toString('hex')
}

/**
 * Derive the three ids WorkBuddy's own client sends. The account scope keeps
 * one Pi session's ids from being reused under a different account.
 */
export function requestIdentityFor(
  bodyJson: string,
  sessionId: string,
  accountScope: string,
): WorkBuddyRequestIdentity {
  let messages: JsonRecord[] = []
  try {
    const body: unknown = JSON.parse(bodyJson)
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
      const candidate = (body as JsonRecord)['messages']
      if (Array.isArray(candidate)) {
        messages = candidate.filter((message): message is JsonRecord =>
          typeof message === 'object' && message !== null && !Array.isArray(message))
      }
    }
  } catch {
    // A malformed body still gets a unique request id.
  }

  const conversation = conversationParts(messages, sessionId)
  const turn = turnParts(messages)
  const conversationId = conversation.length === 0
    ? undefined
    : idFor('conversation', accountScope, conversation)
  const requestId = turn.length === 0
    ? freshId()
    : idFor('turn', accountScope, [
        ...(conversationId === undefined ? [] : [`conversation:${conversationId}`]),
        '|',
        ...turn,
      ])
  const messageId = freshId()

  return {
    ...(conversationId === undefined ? {} : { conversationId }),
    requestId,
    messageId,
  }
}

