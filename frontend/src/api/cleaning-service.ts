/**
 * 清洗规则影响域的本地服务：页面只调这里，引擎不直接接触 localStorage。
 * 规则变更会同时改写清洗影响域状态与 silver / gold / quality 三个模块的清单，
 * 模块清单仍走统一的 local-store 持久化，保证刷新页面后状态一致。
 */
import {
  applyRuleChange,
  currentRuleVersion,
  isHistoricalBatch,
  listBatches,
  parseDedupFields,
  resumeRecompute,
} from '@/domain/cleaning/engine'
import type {
  BatchFilter,
  CleaningBatch,
  CleaningRuleVersion,
  CleaningState,
  RecomputeReport,
  RecomputeTask,
  RuleChangeRecord,
  RuleChangeReport,
} from '@/domain/cleaning/types'
import { cleaningState, mutateCleaningState, resetCleaningState } from '@/data/cleaning-store'
import { listRows, resetRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

function silverRows(): EntryRow[] {
  return listRows('silver').map((row) => ({ ...row }))
}

function goldRows(): EntryRow[] {
  return listRows('gold').map((row) => ({ ...row }))
}

function qualityRows(): EntryRow[] {
  return listRows('quality').map((row) => ({ ...row }))
}

export function getCleaningState(): CleaningState {
  return cleaningState()
}

export function getCurrentRule(silverRowId: number): CleaningRuleVersion | null {
  return currentRuleVersion(cleaningState(), silverRowId)
}

export function getDedupOptions(silverRowId?: number): string[] {
  const state = cleaningState()
  const fields = new Set<string>()
  for (const batch of state.batches) {
    if (silverRowId !== undefined && batch.silverRowId !== silverRowId) {
      continue
    }
    for (const field of batch.dedupFields) {
      fields.add(field)
    }
  }
  return [...fields].sort((a, b) => a.localeCompare(b))
}

export type RuleChangeInput = {
  silverRowId: number
  dedupFields: string
  anomalyFilter: string
}

/**
 * 提交清洗规则变更。同一张表连续提交相同口径时引擎直接幂等返回，
 * 不会落新版本、不会重建批次，也不会重复置下游待校验。
 */
export function changeCleaningRule(input: RuleChangeInput): RuleChangeReport {
  const now = Date.now()

  const nextSilver = silverRows()
  const nextGold = goldRows()
  const nextQuality = qualityRows()
  const holder: { report?: RuleChangeReport } = {}

  mutateCleaningState((draft) => {
    holder.report = applyRuleChange({
      state: draft,
      silverRowId: input.silverRowId,
      nextRule: {
        dedupFields: parseDedupFields(input.dedupFields),
        anomalyFilter: input.anomalyFilter,
      },
      silverRows: nextSilver,
      goldRows: nextGold,
      qualityRows: nextQuality,
      now,
    })
  })

  const report = holder.report!
  // 幂等跳过时模块清单没有任何改动，无需回写。
  if (report.deduped) {
    return report
  }

  saveRows('silver', nextSilver)
  saveRows('gold', nextGold)
  saveRows('quality', nextQuality)
  return report
}

/**
 * 续跑重算任务。已完成任务重复调用为空操作；失败任务从最后成功分区之后续跑，
 * 成功收尾时只刷新真正受影响的聚合视图数据新鲜度与质量指标结果时间。
 */
export function resumeCleaningTask(taskId: number, failPartition?: string): RecomputeReport {
  const now = Date.now()

  const nextSilver = silverRows()
  const nextGold = goldRows()
  const nextQuality = qualityRows()
  const holder: { report?: RecomputeReport } = {}

  mutateCleaningState((draft) => {
    holder.report = resumeRecompute({
      state: draft,
      taskId,
      silverRows: nextSilver,
      goldRows: nextGold,
      qualityRows: nextQuality,
      now,
      failPartition,
    })
  })

  const result = holder.report!
  // 只有真正发生下游刷新时才回写模块清单，避免无意义的存储抖动。
  if (result.refreshedGoldRowIds.length > 0) {
    saveRows('gold', nextGold)
  }
  if (result.refreshedQualityRowIds.length > 0) {
    saveRows('quality', nextQuality)
  }
  return result
}

export function queryCleaningBatches(filter: BatchFilter = {}): CleaningBatch[] {
  return listBatches(cleaningState(), filter)
}

export function batchIsHistorical(batch: CleaningBatch): boolean {
  return isHistoricalBatch(cleaningState(), batch)
}

export function listRecomputeTasks(): RecomputeTask[] {
  return [...cleaningState().tasks].sort((a, b) => b.id - a.id)
}

export function listRuleChanges(): RuleChangeRecord[] {
  return [...cleaningState().changes].sort((a, b) => b.id - a.id)
}

export function listRuleVersions(silverRowId?: number): CleaningRuleVersion[] {
  return cleaningState()
    .ruleVersions.filter((version) => silverRowId === undefined || version.silverRowId === silverRowId)
    .sort((a, b) => b.id - a.id)
}

/** 按行 id 取业务编号，供影响清单展示可读名称（只读，不产生持久化）。 */
export function goldRowCode(rowId: number): string {
  return String(listRows('gold').find((row) => Number(row.id) === rowId)?.['视图编号'] ?? `GOLD#${rowId}`)
}

export function qualityRowCode(rowId: number): string {
  return String(listRows('quality').find((row) => Number(row.id) === rowId)?.['指标编号'] ?? `QUAL#${rowId}`)
}

/** 同时重置清洗影响域与相关模块清单，回到示例口径。 */
export function resetCleaningDomain(): void {
  resetCleaningState()
  resetRows('silver')
  resetRows('gold')
  resetRows('quality')
}
