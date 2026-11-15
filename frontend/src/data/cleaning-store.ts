import { buildCleaningSeed } from './cleaning-seed'
import type { CleaningState } from '@/domain/cleaning/types'

// 清洗影响域独立持久化：与模块清单的存储键分开，重置模块清单不会抹掉规则版本与批次历史。
const STORAGE_KEY = 'lake-govern-config:cleaning'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): CleaningState {
  const fallback = buildCleaningSeed()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CleaningState>
    // 以示例状态为底做合并，老版本缓存缺少新增集合时自动补齐，不会出现 undefined。
    return {
      ...fallback,
      ...parsed,
      seq: { ...fallback.seq, ...(parsed.seq ?? {}) },
    }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: CleaningState | null = null

export function cleaningState(): CleaningState {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function saveCleaningState(state: CleaningState): void {
  cache = state
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

/** 用一个深拷贝替换当前状态，服务层在拷贝上跑完引擎再整体落库。 */
export function mutateCleaningState(mutator: (draft: CleaningState) => void): CleaningState {
  const draft = clone(cleaningState())
  mutator(draft)
  saveCleaningState(draft)
  return draft
}

export function resetCleaningState(): CleaningState {
  const fresh = buildCleaningSeed()
  saveCleaningState(fresh)
  return fresh
}

export function cleaningStorageKey(): string {
  return STORAGE_KEY
}
