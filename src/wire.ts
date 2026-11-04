/**
 * Wire assembly for model requests, split out so the stream module can import
 * it lazily without forming a cycle through the client.
 */

import type { WorkBuddyCredential } from './store.ts'
import {
  chatBaseFor,
  globalBaseFor,
  regionOf,
  workBuddyRequestHeaders,
} from './wire-headers.ts'
import type { WorkBuddyWireProtocol } from './wire-headers.ts'
import { CHAT_PATH, MESSAGES_PATH } from './upstream.ts'

export { chatBaseFor as chatBase }

export function requestHeadersFor(
  credential: WorkBuddyCredential,
  bodyJson: string,
  sessionId: string,
  protocol: WorkBuddyWireProtocol,
  providerHeaders?: HeadersInit,
): Headers {
  const headers = new Headers(providerHeaders)
  // Keep SDK protocol headers (for example anthropic-beta), but replace every
  // header that would reveal the host client or conflict with desktop auth.
  for (const name of [
    'authorization',
    'x-api-key',
    'user-agent',
    'accept',
    'content-type',
    'content-length',
    'content-encoding',
    'connection',
    'host',
    'origin',
    'referer',
    'anthropic-dangerous-direct-browser-access',
  ]) {
    headers.delete(name)
  }
  const names: string[] = []
  headers.forEach((_value, name) => names.push(name))
  for (const name of names) {
    if (name.toLowerCase().startsWith('x-stainless-')) headers.delete(name)
  }
  for (const [name, value] of Object.entries(
    workBuddyRequestHeaders(credential, bodyJson, sessionId, protocol),
  )) {
    headers.set(name, value)
  }
  return headers
}

export function upstreamBaseFor(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global'
    ? globalBaseFor(credential.domain)
    : chatBaseFor(credential)
}

export function endpointFor(
  credential: WorkBuddyCredential,
  protocol: WorkBuddyWireProtocol,
): string {
  const base = upstreamBaseFor(credential)
  return `${base}${protocol === 'messages' ? MESSAGES_PATH : CHAT_PATH}`
}
