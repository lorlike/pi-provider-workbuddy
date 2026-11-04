/**
 * WorkBuddy upstream regions, gateways and wire constants.
 *
 * Endpoint and wire behaviour follow the measured protocol documented in
 * dingminhua/dsh-connect-workbuddy (MIT), which itself credits
 * corrinehu/dsh-workbuddy-connect and Sliverkiss/workbuddy2api (both MIT).
 *
 * Key measured facts this module encodes:
 *
 * - Two regions: CN (`copilot.tencent.com`) and Global (`www.workbuddy.ai`,
 *   whose tokens are ALSO issued at `www.codebuddy.ai` — two brand domains,
 *   one gateway stack; a token issued at one domain is refused by the other).
 * - The model catalog lives at `/v3/config` and answers a DIFFERENT document
 *   per client channel. The CLI channel's answer is a strict subset of the
 *   app channel's and publishes neither `modelPromotions` nor `modelTiers`,
 *   so catalogs are read with the app's product UA while CHAT is sent with
 *   the CLI UA (the channel the conversation identity is bound to).
 * - CN falls back to the legacy `/v2/enterprises/personal/models` when
 *   `/v3/config` fails; the global gateway only answers `/v2` there (its
 *   `/console` spelling returns 500) — both regions use `/v2` as fallback.
 * - Credits (read-only, no cost) live at the billing base:
 *   CN `https://www.codebuddy.cn/v2/billing/meter/get-user-resource`;
 *   global accounts read their own gateway.
 * - Chat is `/v2/chat/completions`, OpenAI-compatible, `stream: true` forced,
 *   `tool_choice` flattened to a string, `developer` rewritten to `system`.
 * - The CN build serves Claude models on Anthropic's Messages route,
 *   `/v1/messages`; the global build has no such route.
 * - Token refresh is `/v2/plugin/auth/token/refresh` with `X-Refresh-Token`
 *   (the ONLY place the refresh token travels).
 */

/** WorkBuddy region selected by the credential's login domain. */
export type WorkBuddyRegion = 'cn' | 'global'

export const CN_CHAT_BASE = 'https://copilot.tencent.com'
export const CN_BILLING_BASE = 'https://www.codebuddy.cn'
export const GLOBAL_BASE = 'https://www.workbuddy.ai'
export const GLOBAL_CODEBUDDY_BASE = 'https://www.codebuddy.ai'

/** Legacy CN catalog path — the fallback when `/v3/config` fails. */
export const MODELS_CATALOG_PATH = '/v2/enterprises/personal/models'

/** The document the WorkBuddy app itself reads: models, prices, promotions. */
export const GLOBAL_CONFIG_PATH = '/v3/config'

/** Chat endpoint (OpenAI-compatible, forced `stream: true`). */
export const CHAT_PATH = '/v2/chat/completions'

/** Anthropic Messages endpoint used by the CN build for Claude models. */
export const MESSAGES_PATH = '/v1/messages'

/** Token refresh; `X-Refresh-Token` appears here and nowhere else. */
export const REFRESH_PATH = '/v2/plugin/auth/token/refresh'

/**
 * Daily check-in (签到) paths, read from the billing base. The activity
 * endpoint is the one the client asks first; `checkin-status` is the older
 * spelling kept as a fallback (a gateway that stops serving the modern one
 * degrades instead of reporting "no campaign").
 *
 * Only the CN build runs the campaign; the international one ships with it
 * off.
 */
export const CHECKIN_STATUS_PATHS: readonly string[] = [
  '/v2/billing/meter/checkin-activity-status',
  '/v2/billing/meter/checkin-status',
]

/** The claim itself — POST once per Beijing day while the campaign runs. */
export const DAILY_CHECKIN_PATH = '/v2/billing/meter/daily-checkin'

/**
 * WorkBuddy desktop identities measured from the current builds. The
 * User-Agent is not merely decorative: WorkBuddy answers error 10085 when it
 * does not start with WorkBuddy/<version>, and the channel selects different
 * product-config documents.
 */
export const APP_VERSION = '5.9.3'
export const CLI_VERSION = '2.165.0'

export function clientUserAgent(region: WorkBuddyRegion): string {
  const appName = region === 'global' ? 'workbuddy-ai' : 'WorkBuddy'
  return `WorkBuddy/${APP_VERSION} ${appName}/${APP_VERSION} CLI/${CLI_VERSION}`
}

/** The desktop app's User-Agent for product and billing reads. */
export const APP_UA = `WorkBuddy/${APP_VERSION}`

/**
 * Region for a login domain; an empty domain means CN (matching upstream
 * tooling). `codebuddy.ai` is the international CLI brand — missing it sent
 * those tokens to the CN gateway, which rejected them with an HTML 401.
 */
export function regionOf(domain: string): WorkBuddyRegion {
  const lowered = domain.trim().toLowerCase()
  if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) return 'global'
  if (lowered === 'codebuddy.ai' || lowered.endsWith('.codebuddy.ai')) return 'global'
  return 'cn'
}

/**
 * STRICT region for a domain read out of a file someone handed the plugin:
 * `undefined` for anything unrecognised rather than the CN catch-all.
 */
export function knownRegionOf(domain: string): WorkBuddyRegion | undefined {
  const lowered = domain.trim().toLowerCase()
  if (lowered === '') return undefined
  if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) return 'global'
  if (lowered === 'codebuddy.ai' || lowered.endsWith('.codebuddy.ai')) return 'global'
  if (lowered === 'workbuddy.cn' || lowered.endsWith('.workbuddy.cn')) return 'cn'
  if (lowered === 'codebuddy.cn' || lowered.endsWith('.codebuddy.cn')) return 'cn'
  if (lowered === 'copilot.tencent.com' || lowered.endsWith('.copilot.tencent.com')) return 'cn'
  return undefined
}

/**
 * Gateway for a global credential. International accounts are NOT
 * interchangeable across brand domains: a token issued at `codebuddy.ai` is
 * rejected by the `workbuddy.ai` gateway (and vice versa), so the base follows
 * the credential's own domain.
 */
export function globalBase(domain: string): string {
  const lowered = domain.trim().toLowerCase()
  if (lowered === 'codebuddy.ai' || lowered.endsWith('.codebuddy.ai')) return GLOBAL_CODEBUDDY_BASE
  return GLOBAL_BASE
}

export function chatBase(credential: { domain: string }): string {
  return regionOf(credential.domain) === 'global' ? globalBase(credential.domain) : CN_CHAT_BASE
}

export function billingBase(credential: { domain: string }): string {
  return regionOf(credential.domain) === 'global' ? globalBase(credential.domain) : CN_BILLING_BASE
}

export const JSON_TIMEOUT_MS = 30_000
export const ERROR_BODY_LIMIT = 4096
