/**
 * Daily check-in (签到) for the CN gateway.
 *
 * While the campaign runs, a WorkBuddy (CN) account is given a few credits a
 * day for pressing 签到 in the app — more on a streak. The client asks the
 * campaign's status first and claims only while the campaign is on and
 * today's credit is not in yet; a claim is therefore idempotent, and a refused
 * claim is not retried blindly.
 *
 * Measured against the CN billing base (`www.codebuddy.cn`); the path is
 * prefixed `/v2/` — the un-prefixed spelling the older articles show 404s.
 * The international build ships with the campaign switched off, so this module
 * is only ever called for `cn`.
 *
 * Everything here is READ-ONLY except the single claim POST: the campaign
 * status costs nothing, and nothing else is written upstream.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pluginDataDir, workbuddyAccountId } from './auth.ts'
import type { WorkBuddyCredential } from './auth.ts'
import { APP_UA, CN_BILLING_BASE, CHECKIN_STATUS_PATHS, DAILY_CHECKIN_PATH, JSON_TIMEOUT_MS } from './upstream.ts'
import type { WorkBuddyRegion } from './upstream.ts'

/** The campaign as one account sees it. Absent fields stay undefined. */
export interface WorkBuddyCheckinStatus {
  /** The campaign is running right now. */
  active: boolean
  /** Today's (Beijing) credit is in already. */
  todayCheckedIn: boolean
  streakDays?: number
  /** Credits the campaign pays per day. */
  dailyCredit?: number
  /** Credits this account got today. */
  todayCredit?: number
  totalCredits?: number
  weekCheckinDays?: number
  activityName?: string
}

/** What a claim gave. */
export interface WorkBuddyCheckinClaim {
  credit?: number
  streakDays?: number
  isStreakDay?: boolean
  creditDelayed?: boolean
  message?: string
}

/**
 * Business codes a claim refuses with. They are ANSWERS about the day, not
 * failures to retry: `already` means the credits are in (pressed by the app
 * or by an earlier run), the other two mean nothing is claimable today.
 */
export const CHECKIN_ALREADY = 1001
export const CHECKIN_INELIGIBLE = 1002
export const CHECKIN_ENDED = 1003

/** One billing answer, envelope included (a refusal carries a code). */
interface BillingAnswer {
  httpStatus: number
  code: number
  message?: string
  data: Record<string, unknown>
}

export class WorkBuddyCheckinError extends Error {
  constructor(
    message: string,
    /** Business code when the upstream refused; 0 for transport/HTTP. */
    readonly code: number,
    readonly httpStatus: number,
  ) {
    super(message)
    this.name = 'WorkBuddyCheckinError'
  }

  /** A 401 — the sign-in, not the campaign, is what refused us. */
  get unauthorized(): boolean {
    return this.httpStatus === 401
  }
}

/** Headers the billing endpoints take (the app's own, not the CLI's). */
function billingHeaders(credential: WorkBuddyCredential): Record<string, string> {
  return {
    'Authorization': `Bearer ${credential.accessToken}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': APP_UA,
    'X-Product': 'SaaS',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    ...(credential.uid === '' ? {} : { 'X-User-Id': credential.uid }),
    ...(credential.enterpriseId === undefined || credential.enterpriseId === ''
      ? {}
      : { 'X-Enterprise-Id': credential.enterpriseId, 'X-Tenant-Id': credential.enterpriseId }),
    ...(credential.domain === '' ? {} : { 'X-Domain': credential.domain }),
  }
}

/**
 * POST one billing path. A non-JSON body is reported as a transport-level
 * failure with the HTTP status kept — the CN gateway answers a refused token
 * with an HTML 401, which must read as "sign in again", not as "campaign
 * error".
 */
async function billingPost(
  credential: WorkBuddyCredential,
  path: string,
  body: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<BillingAnswer> {
  const timeout = signal ?? AbortSignal.timeout(JSON_TIMEOUT_MS)
  const response = await fetch(`${CN_BILLING_BASE}${path}`, {
    method: 'POST',
    headers: billingHeaders(credential),
    body: JSON.stringify(body),
    signal: timeout,
  })
  const text = await response.text()
  let envelope: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
    envelope = parsed as Record<string, unknown>
  } catch {
    throw new WorkBuddyCheckinError(
      `签到接口返回了非 JSON 响应（http ${response.status}）：${text.slice(0, 160)}`,
      0,
      response.status,
    )
  }
  const code = typeof envelope['code'] === 'number' ? envelope['code'] : 0
  const data = typeof envelope['data'] === 'object' && envelope['data'] !== null && !Array.isArray(envelope['data'])
    ? envelope['data'] as Record<string, unknown>
    : {}
  const message = typeof envelope['msg'] === 'string'
    ? envelope['msg']
    : typeof envelope['message'] === 'string' ? envelope['message'] : undefined
  return {
    httpStatus: response.status,
    code,
    ...(message === undefined || message === '' ? {} : { message }),
    data,
  }
}

/** Raise a classified error for a failed answer; pass a success through. */
function expectOk(answer: BillingAnswer, what: string): BillingAnswer {
  if (answer.httpStatus === 401) {
    throw new WorkBuddyCheckinError(
      `${what}被上游拒绝（http 401，${answer.message ?? '会话已失效'}）。请在 WorkBuddy 桌面端重新登录，或运行 /login workbuddy 重新扫码`,
      answer.code,
      401,
    )
  }
  if (!answer.httpStatus || answer.httpStatus >= 400 || answer.code !== 0) {
    const detail = answer.message === undefined ? `code=${answer.code}` : `code=${answer.code} ${answer.message}`
    throw new WorkBuddyCheckinError(`${what}失败（http ${answer.httpStatus}）：${detail}`, answer.code, answer.httpStatus)
  }
  return answer
}

// ---------------------------------------------------------------------------
// Field readers (snake_case and camelCase are both served, per endpoint)
// ---------------------------------------------------------------------------

function boolOf(source: Record<string, unknown>, ...keys: string[]): boolean {
  for (const key of keys) {
    if (!(key in source)) continue
    const value = source[key]
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value !== 0
    if (typeof value === 'string') return value === 'true' || value === '1'
  }
  return false
}

function intOf(source: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    if (!(key in source)) continue
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  }
  return undefined
}

function strOf(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V }
}

export function parseCheckinStatus(data: Record<string, unknown>): WorkBuddyCheckinStatus {
  return {
    active: boolOf(data, 'active', 'Active'),
    todayCheckedIn: boolOf(data, 'today_checked_in', 'todayCheckedIn'),
    ...optional('streakDays', intOf(data, 'streak_days', 'streakDays')),
    ...optional('dailyCredit', intOf(data, 'daily_credit', 'dailyCredit')),
    ...optional('todayCredit', intOf(data, 'today_credit', 'todayCredit')),
    ...optional('totalCredits', intOf(data, 'total_credits', 'totalCredits')),
    ...optional('weekCheckinDays', intOf(data, 'week_checkin_days', 'weekCheckinDays')),
    ...optional('activityName', strOf(data, 'activity_name', 'activityName')),
  }
}

export function parseCheckinClaim(data: Record<string, unknown>): WorkBuddyCheckinClaim {
  return {
    ...optional('credit', intOf(data, 'credit', 'Credit')),
    ...optional('streakDays', intOf(data, 'streak_days', 'streakDays')),
    ...optional('isStreakDay', 'is_streak_day' in data || 'isStreakDay' in data
      ? boolOf(data, 'is_streak_day', 'isStreakDay')
      : undefined),
    ...optional('creditDelayed', 'credit_delayed' in data || 'creditDelayed' in data
      ? boolOf(data, 'credit_delayed', 'creditDelayed')
      : undefined),
    ...optional('message', strOf(data, 'message', 'Message')),
  }
}

// ---------------------------------------------------------------------------
// Campaign calls
// ---------------------------------------------------------------------------

/**
 * Read the campaign's status. The activity endpoint is asked first; the older
 * `checkin-status` spelling is the fallback, so a renamed path degrades to a
 * truthful "campaign not running" instead of a hard failure.
 */
export async function fetchCheckinStatus(
  credential: WorkBuddyCredential,
  signal?: AbortSignal,
): Promise<WorkBuddyCheckinStatus> {
  let lastError: unknown
  for (const path of CHECKIN_STATUS_PATHS) {
    try {
      const answer = expectOk(await billingPost(credential, path, {}, signal), '查询签到状态')
      return parseCheckinStatus(answer.data)
    } catch (error) {
      lastError = error
      if (error instanceof WorkBuddyCheckinError && error.unauthorized) throw error
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new WorkBuddyCheckinError('查询签到状态失败', 0, 0)
}

/**
 * Claim today's credit. A refusal is returned as data, not thrown: 1001/1002/
 * 1003 are the campaign's answers about the day, and a caller that cannot tell
 * "already in" from "the request died" would report a successful day as a
 * failure.
 */
export async function claimDailyCheckin(
  credential: WorkBuddyCredential,
  signal?: AbortSignal,
): Promise<{ claimed: boolean, claim?: WorkBuddyCheckinClaim, code: number, message?: string }> {
  const answer = await billingPost(credential, DAILY_CHECKIN_PATH, {}, signal)
  if (answer.httpStatus === 401) {
    throw new WorkBuddyCheckinError(
      `签到请求被上游拒绝（http 401，${answer.message ?? '会话已失效'}）。请在 WorkBuddy 桌面端重新登录，或运行 /login workbuddy 重新扫码`,
      answer.code,
      401,
    )
  }
  if (answer.httpStatus >= 400) {
    throw new WorkBuddyCheckinError(
      `签到失败（http ${answer.httpStatus}）：${answer.message ?? `code=${answer.code}`}`,
      answer.code,
      answer.httpStatus,
    )
  }
  if (answer.code !== 0) {
    return {
      claimed: false,
      code: answer.code,
      ...(answer.message === undefined ? {} : { message: answer.message }),
    }
  }
  return { claimed: true, claim: parseCheckinClaim(answer.data), code: 0 }
}

// ---------------------------------------------------------------------------
// One whole check-in
// ---------------------------------------------------------------------------

/** What one run came of. `outcome` decides how the callers phrase it. */
export interface CheckinRunResult {
  outcome: CheckinOutcome
  status?: WorkBuddyCheckinStatus
  claim?: WorkBuddyCheckinClaim
  /** Credits the day gave (claim answer first, campaign rate second). */
  credit?: number
  streakDays?: number
  message: string
}

/** A sentence about the streak, only when the upstream stated one. */
function streakText(streakDays: number | undefined): string {
  return streakDays === undefined ? '' : `（连签 ${streakDays} 天）`
}

/**
 * Check in as the app does: the campaign's status first, the claim only while
 * the campaign runs and today's credit is not in yet. A campaign that is off
 * is an ANSWER (nothing to claim today), not an error.
 */
export async function runDailyCheckin(
  credential: WorkBuddyCredential,
  signal?: AbortSignal,
): Promise<CheckinRunResult> {
  const status = await fetchCheckinStatus(credential, signal)
  if (!status.active) {
    return {
      outcome: 'inactive',
      status,
      message: '当前没有进行中的签到活动（或活动已结束），今天没有可领取的积分',
    }
  }
  if (status.todayCheckedIn) {
    return {
      outcome: 'done',
      status,
      ...optional('credit', status.todayCredit),
      ...optional('streakDays', status.streakDays),
      message: `今天已经签到过了${streakText(status.streakDays)}`
        + (status.todayCredit === undefined ? '' : `，今日获得 ${status.todayCredit} 积分`),
    }
  }

  const claimed = await claimDailyCheckin(credential, signal)
  const credit = claimed.claim?.credit ?? status.dailyCredit
  const streakDays = claimed.claim?.streakDays ?? status.streakDays
  if (claimed.claimed) {
    const delayed = claimed.claim?.creditDelayed === true ? '（上游提示积分稍后到账）' : ''
    return {
      outcome: 'claimed',
      status,
      ...(claimed.claim === undefined ? {} : { claim: claimed.claim }),
      ...optional('credit', credit),
      ...optional('streakDays', streakDays),
      message: `签到成功，今日获得 ${credit === undefined ? '（上游未说明）' : credit} 积分`
        + `${streakText(streakDays)}${delayed}`,
    }
  }

  const detail = claimed.message === undefined ? `code=${claimed.code}` : claimed.message
  switch (claimed.code) {
    case CHECKIN_ALREADY:
      return {
        outcome: 'done',
        status,
        ...optional('credit', credit),
        ...optional('streakDays', streakDays),
        message: `今天已经签到过了${streakText(streakDays)}（上游 code ${claimed.code}）`,
      }
    case CHECKIN_INELIGIBLE:
      return {
        outcome: 'ineligible',
        status,
        message: `该账号不能参与本次签到活动：${detail}`,
      }
    case CHECKIN_ENDED:
      return { outcome: 'inactive', status, message: `签到活动已结束：${detail}` }
    default:
      return { outcome: 'failed', status, message: `签到失败：${detail}` }
  }
}

// ---------------------------------------------------------------------------
// Beijing day + local record
// ---------------------------------------------------------------------------
/**
 * The day the campaign counts in: UTC+8, fixed. A fixed offset keeps this off
 * the platform time-zone database, which some Windows setups do not ship.
 */
export function beijingDay(at: number = Date.now()): string {
  return new Date(at + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** How a day's check-in ended. */
export type CheckinOutcome = 'claimed' | 'done' | 'inactive' | 'ineligible' | 'failed' | 'own-app'

/** One account's answer for one Beijing day. No name, no token is kept. */
export interface CheckinRecord {
  /** Beijing day, `YYYY-MM-DD`. */
  day: string
  /** Epoch ms the answer was obtained. */
  at: number
  outcome: CheckinOutcome
  credit?: number
  streakDays?: number
  message?: string
}

type CheckinFile = Record<string, CheckinRecord>

function checkinRecordPath(): string {
  return join(pluginDataDir(), 'workbuddy-checkin.json')
}

function recordKey(region: WorkBuddyRegion, credential: Pick<WorkBuddyCredential, 'uin' | 'uid'>): string {
  return `${region}|${workbuddyAccountId(credential)}`
}

/**
 * Read the whole record file. A file that does not parse yields an empty map
 * rather than throwing: the record is a convenience for offline display, and an
 * unreadable one must never break a command.
 */
function readRecords(): CheckinFile {
  const path = checkinRecordPath()
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as CheckinFile
  } catch {
    return {}
  }
}

/** Persist one account's answer for the day (atomic write-then-rename). */
export function saveCheckinRecord(
  region: WorkBuddyRegion,
  credential: Pick<WorkBuddyCredential, 'uin' | 'uid'>,
  record: CheckinRecord,
): void {
  const file = readRecords()
  file[recordKey(region, credential)] = record
  const path = checkinRecordPath()
  try {
    mkdirSync(join(path, '..'), { recursive: true })
  } catch {
    return
  }
  const tmp = `${path}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8')
    renameSync(tmp, path)
  } catch {
    // A read-only data dir only costs the next offline display.
  }
}

/** The last recorded answer for one account, whatever day it belongs to. */
export function readCheckinRecord(
  region: WorkBuddyRegion,
  credential: Pick<WorkBuddyCredential, 'uin' | 'uid'>,
): CheckinRecord | undefined {
  return readRecords()[recordKey(region, credential)]
}

/** Whether a record says that day's credit is in. */
export function recordCheckedIn(record: CheckinRecord | undefined, day: string): boolean {
  return record !== undefined && record.day === day && (record.outcome === 'claimed' || record.outcome === 'done')
}

/**
 * One line answering "did I check in today?".
 *
 * The campaign's own status is the authority. When the upstream cannot be
 * reached, only a record for TODAY is reported, and it is labelled as a local
 * record — a day the plugin did not see must never read as checked in.
 */
export async function describeCheckinToday(
  region: WorkBuddyRegion,
  credential: WorkBuddyCredential,
  signal?: AbortSignal,
): Promise<string> {
  const day = beijingDay()
  const recorded = readCheckinRecord(region, credential)
  try {
    const status = await fetchCheckinStatus(credential, signal)
    if (!status.active) {
      return recordCheckedIn(recorded, day)
        ? `今日签到: 当前没有进行中的签到活动（本地记录显示今日已签到：${recorded?.message ?? '已签到'}）`
        : '今日签到: 当前没有进行中的签到活动'
    }
    if (status.todayCheckedIn) {
      const gained = status.todayCredit === undefined ? '' : `，今日 +${status.todayCredit} 积分`
      const streak = status.streakDays === undefined ? '' : `，连签 ${status.streakDays} 天`
      return `今日签到: 已签到（${day}${gained}${streak}）`
    }
    return '今日签到: 未签到（运行 /workbuddy.sign 领取今日积分）'
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (recordCheckedIn(recorded, day)) {
      return `今日签到: 已签到（本地记录：${recorded?.message ?? '已签到'}；上游状态查询失败：${detail}）`
    }
    return `今日签到: 无法确认（上游状态查询失败：${detail}）`
  }
}
