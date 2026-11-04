/**
 * pi-provider-workbuddy — connect WorkBuddy (CodeBuddy) models to Pi.
 *
 * Two providers are registered, one per region:
 *   - `workbuddy`         → domestic gateway  (copilot.tencent.com)
 *   - `workbuddy-global`  → international gateway (www.workbuddy.ai /
 *     www.codebuddy.ai — two brand domains, one gateway stack)
 *
 * A region with a usable account exposes its models; without one it lists
 * nothing (a request would fail anyway) while the provider itself stays
 * registered, because its /login flow IS the sign-in entry.
 *
 * Model names embed the upstream's credit multiplier (e.g. `GLM-5.3 · x0.79`),
 * image input follows the vendor-documentation table (not the platform's
 * over-broad `supportsImages`), and thinking levels map only the efforts the
 * upstream actually declares for each model.
 *
 * Upstream protocol, measured wire behaviour and error classification follow
 * dingminhua/dsh-connect-workbuddy (MIT), which credits
 * corrinehu/dsh-workbuddy-connect, Sliverkiss/workbuddy2api and
 * hawklithm/workbuddy2api (all MIT).
 *
 * RISK NOTE: WorkBuddy restricts non-official clients; upstream changes can
 * break this provider at any time. Every call spends YOUR OWN account's
 * credits at the upstream's stated multiplier.
 */

import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent'
import type { Model, SimpleStreamOptions, TranscriptContext } from '@earendil-works/pi-ai/compat'

import { nativeImageInput, REFUSES_OFF_MODEL_IDS } from './catalog.ts'
import { WorkBuddyCredentialStore } from './store.ts'
import type { WorkBuddyUpstreamModel } from './store.ts'
import { WorkBuddyUpstreamClient } from './client.ts'
import { createWorkBuddyStream } from './stream.ts'
import { oauthPoll, oauthStart, regionOfOAuthAccount } from './oauth.ts'
import { CN_CHAT_BASE, GLOBAL_BASE, regionOf } from './upstream.ts'
import type { WorkBuddyRegion } from './upstream.ts'
import { CHAT_API, MESSAGES_API, apiForModel, usesMessagesApi } from './routing.ts'
import {
  beijingDay,
  describeCheckinToday,
  runDailyCheckin,
  saveCheckinRecord,
} from './checkin.ts'

const PROVIDER_IDS: Readonly<Record<WorkBuddyRegion, string>> = {
  cn: 'workbuddy',
  global: 'workbuddy-global',
}

const PROVIDER_NAMES: Readonly<Record<WorkBuddyRegion, string>> = {
  cn: 'WorkBuddy (CN)',
  global: 'WorkBuddy AI (Global)',
}

/** Regions whose credential domains the two providers serve. */
const REGIONS: readonly WorkBuddyRegion[] = ['cn', 'global']

const stores = new Map<WorkBuddyRegion, WorkBuddyCredentialStore>()
const catalogs = new Map<WorkBuddyRegion, readonly WorkBuddyUpstreamModel[]>()
const catalogFetchedAt = new Map<WorkBuddyRegion, number>()
/** Login sessions for /login, keyed by `${region}:${loginId}`. */
const loginSessions = new Map<string, { loginId: string; region: WorkBuddyRegion }>()

const CATALOG_REFRESH_MS = 10 * 60 * 1000

function storeFor(region: WorkBuddyRegion): WorkBuddyCredentialStore {
  let store = stores.get(region)
  if (store === undefined) {
    store = new WorkBuddyCredentialStore(region, message => console.warn(`[pi-provider-workbuddy] ${message}`))
    stores.set(region, store)
  }
  return store
}

/** Model display name: bare name, or `name · x0.79` with the parsed multiplier. */
function workBuddyDisplayName(info: WorkBuddyUpstreamModel): string {
  return info.creditMultiplier === undefined
    ? info.name
    : `${info.name} · x${info.creditMultiplier.toFixed(2)}`
}

/**
 * Map only the thinking levels the model actually advertises; undeclared
 * levels stay unavailable (`null`). `off` is offered exactly when the model
 * declares it AND is not on the measured refusal table.
 */
function thinkingLevelMapFor(
  info: WorkBuddyUpstreamModel,
  messages: boolean,
): Record<string, string | null> | undefined {
  const declared = info.reasoning?.supportedEfforts?.filter(effort =>
    ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort))
  const supported = messages && declared !== undefined && !declared.includes('max')
    ? [...declared, 'max']
    : declared
  if (supported === undefined || supported.length === 0) return undefined
  const map: Record<string, string | null> = {}
  for (const level of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
    map[level] = supported.includes(level) ? level : null
  }
  // pi-ai treats `off: null` as "this level is not supported" and withholds
  // thinking-disabled requests; the refusal table is re-checked here so the
  // wall does not depend on every caller remembering to stamp first.
  map['off'] = info.reasoning?.canDisableThinking === true && !REFUSES_OFF_MODEL_IDS.has(info.id)
    ? 'off'
    : null
  return map
}

function toModelConfigs(region: WorkBuddyRegion, models: readonly WorkBuddyUpstreamModel[]): ProviderConfig['models'] {
  return models.map((info) => {
    const image = nativeImageInput(info.id)
    const messages = usesMessagesApi(region, info.id)
    const thinkingLevelMap = thinkingLevelMapFor(info, messages)
    return {
      id: info.id,
      name: workBuddyDisplayName(info),
      api: apiForModel(region, info.id),
      reasoning: thinkingLevelMap !== undefined,
      ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
      input: image === true ? ['text', 'image'] : ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: info.contextWindow,
      maxTokens: info.maxTokens,
      compat: messages
        // Messages carries effort as `output_config.effort`; the CN Claude
        // models are adaptive-thinking models, so the route must use that
        // field rather than chat's `reasoning_effort`.
        ? { forceAdaptiveThinking: true, supportsTemperature: true }
        : {
            // The gateways reject the `developer` role (11128) and count
            // `reasoning_effort` from the model's own ladder only.
            supportsDeveloperRole: false,
            supportsReasoningEffort: thinkingLevelMap !== undefined,
            maxTokensField: 'max_tokens',
            supportsStore: false,
          },
    }
  })
}

async function fetchCatalog(region: WorkBuddyRegion, force = false): Promise<readonly WorkBuddyUpstreamModel[]> {
  const fetchedAt = catalogFetchedAt.get(region) ?? 0
  const cached = catalogs.get(region)
  if (!force && cached !== undefined && Date.now() - fetchedAt < CATALOG_REFRESH_MS) return cached

  const store = storeFor(region)
  try {
    const credential = await store.resolve()
    const client = new WorkBuddyUpstreamClient()
    const models = await client.fetchModels(credential)
    if (models.length > 0) {
      catalogs.set(region, models)
      catalogFetchedAt.set(region, Date.now())
      return models
    }
  } catch (error) {
    console.warn(`[pi-provider-workbuddy] ${region} catalog refresh failed:`,
      error instanceof Error ? error.message : error)
  }
  if (cached !== undefined) return cached
  const { fallbackModelsFor } = await import('./catalog.ts')
  const fallback = fallbackModelsFor(region)
  catalogs.set(region, fallback)
  catalogFetchedAt.set(region, Date.now())
  return fallback
}

export default async function (pi: ExtensionAPI) {
  const streamFor = (
    region: WorkBuddyRegion,
    protocol: 'chat' | 'messages' = 'chat',
  ) => createWorkBuddyStream(async () => storeFor(region).resolve(), protocol)

  const registerRegion = (region: WorkBuddyRegion, models: readonly WorkBuddyUpstreamModel[]) => {
    pi.registerProvider(PROVIDER_IDS[region], {
      name: PROVIDER_NAMES[region],
      baseUrl: region === 'cn' ? CN_CHAT_BASE : GLOBAL_BASE,
      api: CHAT_API,
      models: toModelConfigs(region, models),
      oauth: {
        name: PROVIDER_NAMES[region],
        async login(callbacks) {
          const region2 = region
          const started = await oauthStart(region2)
          if ('error' in started) throw new Error(started.error)
          callbacks.onAuth({
            url: started.verificationUri,
            instructions: '在浏览器中打开该链接并登录 WorkBuddy（国内版扫码，国际版网页登录），完成后此处会自动继续',
          })
          callbacks.onProgress?.('等待你在浏览器中完成登录…')
          const deadline = Date.now() + started.expiresIn * 1000
          while (Date.now() < deadline) {
            if (callbacks.signal?.aborted) throw new Error('登录已取消')
            await new Promise(resolve => setTimeout(resolve, 2000))
            const polled = await oauthPoll(started.loginId, region2)
            if (!polled.done) continue
            if ('error' in polled) throw new Error(polled.error)
            const account = polled.account
            const credentialRegion = regionOfOAuthAccount(account)
            if (credentialRegion !== region2) {
              throw new Error(`该账号属于${credentialRegion === 'global' ? '国际版' : '国内版'}，请使用对应的 /login 入口`)
            }
            const store = storeFor(region2)
            store.acceptOAuthCredential({
              accessToken: account.accessToken,
              refreshToken: account.refreshToken,
              expiresAtMs: account.expiresAtMs,
              domain: account.domain,
              uid: account.uid,
              ...(account.nickname === undefined ? {} : { nickname: account.nickname }),
              ...(account.uin === undefined ? {} : { uin: account.uin }),
              ...(account.enterpriseId === undefined ? {} : { enterpriseId: account.enterpriseId }),
              source: 'oauth',
              filePath: '(oauth)',
            })
            // Refresh the model catalog right away so the region's models
            // appear without a restart.
            const models2 = await fetchCatalog(region2, true)
            pi.registerProvider(PROVIDER_IDS[region2], {
              name: PROVIDER_NAMES[region2],
              baseUrl: region2 === 'cn' ? CN_CHAT_BASE : GLOBAL_BASE,
              api: CHAT_API,
              models: toModelConfigs(region2, models2),
            })
            return {
              refresh: account.refreshToken,
              access: account.accessToken,
              expires: account.expiresAtMs,
              domain: account.domain,
              uid: account.uid,
            }
          }
          throw new Error('登录超时，请重试')
        },
        async refreshToken(credentials, signal) {
          // Token refresh goes through the store, which owns the upstream
          // endpoint and the plugin-owned copy. The returned credential shape
          // is what pi persists in auth.json.
          const store = storeFor(region)
          store.invalidate()
          const credential = await store.resolve()
          void signal
          return {
            refresh: credential.refreshToken || credentials.refresh,
            access: credential.accessToken,
            expires: credential.expiresAtMs || (Date.now() + 3600 * 1000),
            domain: credential.domain,
            uid: credential.uid,
          }
        },
        getApiKey: credentials => credentials.access,
      },
      streamSimple: streamFor(region),
    })
  }

  // Startup: read credentials, fetch catalogs, register both regions.
  for (const region of REGIONS) {
    const store = storeFor(region)
    try {
      const status = await store.status()
      if (status.signedIn) {
        const models = await fetchCatalog(region, true)
        registerRegion(region, models)
      } else {
        const { fallbackModelsFor } = await import('./catalog.ts')
        // Provider stays registered with the region's OWN fallback roster:
        // its settings/login card is the region's sign-in entry, and a
        // region with no account lists models that could only fail.
        registerRegion(region, fallbackModelsFor(region).slice(0, 3))
      }
    } catch (error) {
      console.warn(`[pi-provider-workbuddy] ${region} startup failed:`,
        error instanceof Error ? error.message : error)
    }
  }

  // Register both wire implementations. Chat and Messages each delegate their
  // parsing to Pi's built-in adapter; only headers, endpoint, body preparation
  // and failure classification are WorkBuddy-specific.
  try {
    const compat = await import('@earendil-works/pi-ai/compat')
    const register = compat.registerApiProvider
    if (typeof register === 'function') {
      register(
        {
          api: CHAT_API,
          stream: (model, context, options) => {
            const region = providerRegionOf(model)
            return streamFor(region, 'chat')(model, context, options as SimpleStreamOptions | undefined)
          },
          streamSimple: (model, context, options) => {
            const region = providerRegionOf(model)
            return streamFor(region, 'chat')(model, context, options)
          },
        },
        'provider:workbuddy-chat',
      )
      register(
        {
          api: MESSAGES_API,
          stream: (model, context, options) => {
            const region = providerRegionOf(model)
            return streamFor(region, 'messages')(model, context, options as SimpleStreamOptions | undefined)
          },
          streamSimple: (model, context, options) => {
            const region = providerRegionOf(model)
            return streamFor(region, 'messages')(model, context, options)
          },
        },
        'provider:workbuddy-messages',
      )
    }
  } catch (error) {
    console.warn('[pi-provider-workbuddy] api registration failed:', error instanceof Error ? error.message : error)
  }

  // Commands -----------------------------------------------------------------

  pi.registerCommand('workbuddy.status', {
    description: 'Show WorkBuddy sign-in status and credit balance for both regions',
    handler: async (_args, ctx) => {
      const lines: string[] = []
      for (const region of REGIONS) {
        const store = storeFor(region)
        const status = await store.status()
        const label = PROVIDER_NAMES[region]
        if (!status.signedIn) {
          lines.push(`${label}: 未登录（运行 /login ${PROVIDER_IDS[region]} 登录）`)
          for (const candidate of status.candidates) {
            lines.push(`  · ${candidate.path}: ${candidate.reason}`)
          }
          continue
        }
        lines.push(`${label}: ${status.label ?? '已登录'}（来源 ${status.source}）`)
        if (status.expiresAtMs !== undefined && status.expiresAtMs > 0) {
          const minutes = Math.round((status.expiresAtMs - Date.now()) / 60000)
          lines.push(`  token ${minutes >= 0 ? `${minutes} 分钟后过期` : '已过期，将在下次请求时刷新'}`)
        }
        let credential: Awaited<ReturnType<typeof store.resolve>> | undefined
        try {
          credential = await store.resolve()
          const client = new WorkBuddyUpstreamClient()
          const credits = await client.fetchCredits(credential)
          if (credits.total !== undefined) lines.push(`  积分余额: ${credits.total}`)
        } catch (error) {
          lines.push(`  积分查询失败: ${error instanceof Error ? error.message : String(error)}`)
        }
        // The check-in line stands on its own: credits failing to read says
        // nothing about today's campaign.
        if (region === 'cn' && credential !== undefined) {
          lines.push(`  ${await describeCheckinToday(region, credential)}`)
        }
      }
      await ctx.ui.notify(lines.join('\n'), 'info')
    },
  })

  pi.registerCommand('workbuddy.sign', {
    description: 'WorkBuddy（国内版）每日签到，领取今日积分；已签到会如实说明',
    handler: async (args, ctx) => {
      const target = args.trim().toLowerCase()
      if (target === 'global') {
        await ctx.ui.notify('国际版没有每日签到活动，无需签到（积分来自套餐与一次性 trial）', 'warning')
        return
      }
      if (target !== '' && target !== 'cn') {
        await ctx.ui.notify('用法：/workbuddy.sign [cn]（目前只有国内版有签到活动）', 'warning')
        return
      }
      const store = storeFor('cn')
      const status = await store.status()
      if (!status.signedIn) {
        await ctx.ui.notify(`${PROVIDER_NAMES['cn']}: 未登录，请先运行 /login ${PROVIDER_IDS['cn']}`, 'warning')
        return
      }
      try {
        const credential = await store.resolve()
        const day = beijingDay()
        const result = await runDailyCheckin(credential)
        // Only a real answer for the day is recorded; a failure records
        // nothing, so /workbuddy.status never claims a day that did not happen.
        if (result.outcome !== 'failed') {
          saveCheckinRecord('cn', credential, {
            day,
            at: Date.now(),
            outcome: result.outcome,
            ...(result.credit === undefined ? {} : { credit: result.credit }),
            ...(result.streakDays === undefined ? {} : { streakDays: result.streakDays }),
            ...(result.message === '' ? {} : { message: result.message }),
          })
        }
        await ctx.ui.notify(
          `WorkBuddy (CN) 签到（北京时间 ${day}）：${result.message}`,
          result.outcome === 'failed' ? 'error' : 'info',
        )
      } catch (error) {
        await ctx.ui.notify(
          `WorkBuddy (CN) 签到失败：${error instanceof Error ? error.message : String(error)}`,
          'error',
        )
      }
    },
  })

  pi.registerCommand('workbuddy.refresh', {
    description: 'Refresh the WorkBuddy model catalog from the upstream',
    handler: async (_args, ctx) => {
      const parts: string[] = []
      for (const region of REGIONS) {
        const models = await fetchCatalog(region, true)
        parts.push(`${PROVIDER_NAMES[region]}: ${models.length} 个模型`)
      }
      await ctx.ui.notify(parts.join('\n'), 'info')
      ctx.reload()
    },
  })

  pi.registerCommand('workbuddy.logout', {
    description: 'Clear the stored WorkBuddy credential for a region (cn | global, default both)',
    handler: async (args, ctx) => {
      const target = args.trim().toLowerCase()
      const regions = target === 'cn' ? (['cn'] as const)
        : target === 'global' ? (['global'] as const)
        : REGIONS
      const { clearStoredCredentials } = await import('./auth-io.ts')
      for (const region of regions) {
        clearStoredCredentials(region)
        stores.get(region)?.invalidate()
        catalogs.delete(region)
      }
      await ctx.ui.notify(`已清除 ${regions.map(region => PROVIDER_IDS[region]).join(', ')} 的本地凭据（不影响桌面端登录）`, 'info')
    },
  })
}

/** Which region a model belongs to, from its provider stamp. */
function providerRegionOf(model: { provider?: string }): WorkBuddyRegion {
  return model.provider === 'workbuddy-global' ? 'global' : 'cn'
}
