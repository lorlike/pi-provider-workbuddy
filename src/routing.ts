/**
 * Model-level API routing measured against WorkBuddy's own builds.
 *
 * The CN build serves Claude models on Anthropic's Messages API. The global
 * build has no `/v1/messages` route, so even a Claude model listed there must
 * stay on chat completions.
 */

import type { WorkBuddyRegion } from './upstream.ts'

export const CHAT_API = 'workbuddy-api'
export const MESSAGES_API = 'workbuddy-messages'

export function usesMessagesApi(region: WorkBuddyRegion, modelId: string): boolean {
  return region === 'cn' && /^claude-/iu.test(modelId)
}

export function apiForModel(region: WorkBuddyRegion, modelId: string): string {
  return usesMessagesApi(region, modelId) ? MESSAGES_API : CHAT_API
}

