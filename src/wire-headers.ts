/**
 * WorkBuddy desktop request headers.
 *
 * WorkBuddy's backend identifies requests by the desktop client's attribution
 * group, its conversation ids, and its SDK headers. These values are built per
 * HTTP request so a tool loop can keep one turn id while every step still gets
 * its own message/request id.
 */

import type { WorkBuddyCredential } from './store.ts'
import { requestIdentityFor } from './request-identity.ts'
import {
  APP_VERSION,
  CN_CHAT_BASE,
  GLOBAL_BASE,
  GLOBAL_CODEBUDDY_BASE,
  chatBase,
  clientUserAgent,
  globalBase,
  regionOf,
} from './upstream.ts'

export {
  CN_CHAT_BASE,
  GLOBAL_BASE,
  GLOBAL_CODEBUDDY_BASE,
  regionOf,
}

export type WorkBuddyWireProtocol = 'chat' | 'messages'

const OPENAI_SDK_VERSION = '6.25.0'
const ELECTRON_NODE_VERSION = 'v22.21.1'

const SDK_OS: Readonly<Record<string, string>> = {
  darwin: 'MacOS',
  win32: 'Windows',
  linux: 'Linux',
  freebsd: 'FreeBSD',
  openbsd: 'OpenBSD',
  android: 'Android',
}

const SDK_ARCH: Readonly<Record<string, string>> = {
  x64: 'x64',
  arm64: 'arm64',
  arm: 'arm',
  ia32: 'x32',
  x32: 'x32',
}

export function chatBaseFor(credential: { domain: string }): string {
  return regionOf(credential.domain) === 'global'
    ? globalBase(credential.domain)
    : CN_CHAT_BASE
}

export function globalBaseFor(domain: string): string {
  return globalBase(domain)
}

function accountScope(credential: WorkBuddyCredential): string {
  return `${credential.uid}|${credential.enterpriseId ?? ''}`
}

function domainFor(credential: WorkBuddyCredential): string {
  const domain = credential.domain.trim()
  return domain === '' ? new URL(chatBase(credential)).host : domain
}

function enterpriseHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const enterpriseId = credential.enterpriseId?.trim() ?? ''
  return enterpriseId === ''
    ? {}
    : {
        'X-Enterprise-Id': enterpriseId,
        'X-Tenant-Id': enterpriseId,
      }
}

/**
 * Desktop attribution for product/config reads. These are the same client
 * headers the app sends, without the per-model conversation identity.
 */
export function workBuddyProductHeaders(
  credential: WorkBuddyCredential,
): Record<string, string> {
  const region = regionOf(credential.domain)
  return {
    'Accept': 'application/json',
    'Authorization': `Bearer ${credential.accessToken}`,
    'X-User-Id': credential.uid,
    'X-Domain': domainFor(credential),
    ...enterpriseHeaders(credential),
    'X-Product': 'SaaS',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': APP_VERSION,
    'User-Agent': clientUserAgent(region),
    'X-Requested-With': 'XMLHttpRequest',
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
  }
}

/**
 * Headers every request the desktop CLI makes carries: account, client
 * attribution, agent role, transport, and the bundled OpenAI SDK's
 * fingerprint. WorkBuddy's usage list reads the attribution group as the
 * requesting client.
 */
export function workBuddyRequestHeaders(
  credential: WorkBuddyCredential,
  bodyJson: string,
  sessionId: string,
  protocol: WorkBuddyWireProtocol,
): Record<string, string> {
  const identity = requestIdentityFor(bodyJson, sessionId, accountScope(credential))
  const region = regionOf(credential.domain)

  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${credential.accessToken}`,
    'X-User-Id': credential.uid,
    'X-Domain': domainFor(credential),
    ...enterpriseHeaders(credential),
    'X-Product': 'SaaS',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': APP_VERSION,
    'User-Agent': clientUserAgent(region),
    'X-Requested-With': 'XMLHttpRequest',
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    'X-Agent-Type': 'main',
    'X-Agent-Runtime': 'local-agent',
    'X-Conversation-Message-ID': identity.messageId,
    'X-Request-ID': identity.messageId,
    'X-Conversation-Request-ID': identity.requestId,
    ...(identity.conversationId === undefined
      ? {}
      : { 'X-Conversation-ID': identity.conversationId }),
    // The desktop CLI reports the OpenAI SDK it sends through, even for the
    // Messages route.
    'X-Stainless-Retry-Count': '0',
    'X-Stainless-Timeout': '1200',
    'X-Stainless-Lang': 'js',
    'X-Stainless-Package-Version': OPENAI_SDK_VERSION,
    'X-Stainless-OS': SDK_OS[process.platform] ?? `Other:${process.platform}`,
    'X-Stainless-Arch': SDK_ARCH[process.arch] ?? `other:${process.arch}`,
    'X-Stainless-Runtime': 'node',
    'X-Stainless-Runtime-Version': ELECTRON_NODE_VERSION,
    // Kept explicit so the route choice is visible at the call site. Both
    // routes currently send the same Accept header, as the desktop does.
    ...(protocol === 'messages' ? { 'anthropic-version': '2023-06-01' } : {}),
  }
}
