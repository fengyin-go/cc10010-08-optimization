/**
 * 清洗规则变更影响计算引擎（纯函数核心）。
 *
 * 设计约束（对应需求）：
 * 1. 只对包含变更字段的清洗结果重算去重批次，不整表重刷；
 * 2. 只让真正引用受影响结果的上游清洗表 / 聚合视图进入待校验，不级联全模块；
 * 3. 历史批次按当时规则版本保留，重算产生新批次，旧批次不改写；
 * 4. 同一输出路径多版本口径冲突时，由最新已启用清洗表裁决；
 * 5. 同一份口径连续提交只生效一次（指纹幂等）；
 * 6. 重算失败后从最后成功的分区续跑，已完成分区与指标结果保持不变；
 * 7. 跨模块下游指标只更新受影响项，其余行一律不动。
 *
 * 本文件不碰 localStorage / React：状态与模块行由调用方传入并持久化。
 */
import type { EntryRow } from '@/data/types'
import type {
  BatchFilter,
  CleaningBatch,
  CleaningRuleVersion,
  CleaningState,
  RecomputeReport,
  RecomputeTask,
  RuleChangeRecord,
  RuleChangeReport,
  RuleSpec,
} from './types'

const SILVER_STATUS_PENDING = '待校验'
const ROW_STATUS_DISABLED = '已停用'
const ROW_STATUS_DRAFT = '草稿'

/** 去重字段在清洗表行里是逗号分隔的字符串，统一解析成集合（去序、去重）。 */
export function parseDedupFields(value: unknown): string[] {
  const raw = String(value ?? '')
  const parts = raw
    .split(/[,，;；、\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
  return [...new Set(parts)].sort((a, b) => a.localeCompare(b))
}

/** 规则口径指纹：去重字段集合 + 异常过滤表达式，连续相同指纹直接幂等跳过。 */
export function ruleFingerprint(rule: RuleSpec): string {
  const fields = parseDedupFields(rule.dedupFields)
  return `dedup=[${fields.join('|')}]::filter=${rule.anomalyFilter.trim()}`
}

function todayText(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

function rowCode(row: EntryRow | undefined, codeField: string): string {
  return row ? String(row[codeField] ?? '') : ''
}

/** 取一张清洗表当前已启用的规则版本；没有则返回 null。 */
export function currentRuleVersion(state: CleaningState, silverRowId: number): CleaningRuleVersion | null {
  const versions = state.ruleVersions
    .filter((item) => item.silverRowId === silverRowId && item.enabled)
    .sort((a, b) => b.version - a.version)
  return versions[0] ?? null
}

/** 该批次是否已被新版本替代（历史批次仍保留，只是不再代表当前口径）。 */
export function isHistoricalBatch(state: CleaningState, batch: CleaningBatch): boolean {
  const current = currentRuleVersion(state, batch.silverRowId)
  if (current && batch.ruleVersionId !== current.id) {
    return true
  }
  return state.batches.some((other) => other.sourceBatchId === batch.id)
}

function rowReferences(row: EntryRow, field: string, codes: string[]): boolean {
  const text = String(row[field] ?? '')
  return codes.some((code) => code !== '' && text.includes(code))
}

type ImpactContext = {
  silverRows: EntryRow[]
  goldRows: EntryRow[]
  qualityRows: EntryRow[]
}

/**
 * 计算真正引用受影响清洗结果的下游行：
 * - 上游清洗表：其他清洗表的「上游清洗表」引用了变更表编号；
 * - 聚合视图：「上游清洗表」引用了变更表或受影响清洗表的编号；
 * - 质量指标：「监控对象」引用了上述清洗表或受影响聚合视图的编号。
 * 只返回当前仍在消费数据的行（草稿、已停用不参与）。
 */
function resolveImpactedRows(
  ctx: ImpactContext,
  changedSilverRow: EntryRow,
  downstreamSilverRows: EntryRow[],
): Pick<RuleChangeRecord, 'impactedSilverRowIds' | 'impactedGoldRowIds' | 'impactedQualityRowIds'> {
  const isConsuming = (row: EntryRow) => {
    const status = String(row.status)
    return status !== ROW_STATUS_DRAFT && status !== ROW_STATUS_DISABLED
  }

  const impactedSilverRowIds = downstreamSilverRows.filter(isConsuming).map((row) => Number(row.id))
  const silverCodes = [
    rowCode(changedSilverRow, '表编号'),
    ...downstreamSilverRows.map((row) => rowCode(row, '表编号')),
  ]

  const impactedGoldRows = ctx.goldRows.filter(
    (row) => isConsuming(row) && rowReferences(row, '上游清洗表', silverCodes),
  )
  const impactedGoldRowIds = impactedGoldRows.map((row) => Number(row.id))

  const goldCodes = impactedGoldRows.map((row) => rowCode(row, '视图编号'))
  const watchedCodes = [...silverCodes, ...goldCodes]
  const impactedQualityRowIds = ctx.qualityRows
    .filter((row) => isConsuming(row) && rowReferences(row, '监控对象', watchedCodes))
    .map((row) => Number(row.id))

  return { impactedSilverRowIds, impactedGoldRowIds, impactedQualityRowIds }
}

/**
 * 同一输出路径存在多个已启用清洗表时的口径冲突说明。
 * 冲突由最新已启用清洗表（当前规则版本时间最新，id 兜底）裁决。
 */
function resolveConflictNote(silverRows: EntryRow[], state: CleaningState, changedRow: EntryRow, now: number): string {
  const outputPath = String(changedRow['输出路径'] ?? '').trim()
  if (!outputPath) {
    return ''
  }
  const rivals = silverRows.filter(
    (row) =>
      Number(row.id) !== Number(changedRow.id) &&
      String(row.status) !== ROW_STATUS_DISABLED &&
      String(row['输出路径'] ?? '').trim() === outputPath,
  )
  if (rivals.length === 0) {
    return ''
  }
  const candidates = [changedRow, ...rivals]
  const decider = candidates
    .map((row) => ({ row, version: currentRuleVersion(state, Number(row.id)) }))
    .sort((a, b) => {
      const ta = a.version?.createdAt ?? 0
      const tb = b.version?.createdAt ?? 0
      if (tb !== ta) {
        return tb - ta
      }
      return Number(b.row.id) - Number(a.row.id)
    })[0]
  const deciderCode = rowCode(decider.row, '表编号')
  const selfDecides = Number(decider.row.id) === Number(changedRow.id)
  return selfDecides
    ? `输出路径「${outputPath}」存在多个已启用清洗表，当前口径由最新已启用清洗表 ${deciderCode}（本表）裁决`
    : `输出路径「${outputPath}」存在多个已启用清洗表，当前口径冲突由最新已启用清洗表 ${deciderCode} 裁决，本表重算结果待其口径确认`
}

function markPending(row: EntryRow, reason: string): void {
  const status = String(row.status)
  if (status === ROW_STATUS_DRAFT || status === ROW_STATUS_DISABLED) {
    return
  }
  row.status = SILVER_STATUS_PENDING
  row.pending = true
  row.abnormal = false
  row['待校验原因'] = reason
}

export type ApplyRuleChangeInput = {
  state: CleaningState
  silverRowId: number
  nextRule: RuleSpec
  silverRows: EntryRow[]
  goldRows: EntryRow[]
  qualityRows: EntryRow[]
  now: number
}

/**
 * 应用一次清洗规则变更。
 * 同一张表提交与当前已启用版本完全相同的口径时，直接幂等返回，不产生新版本、新批次与新待校验。
 */
export function applyRuleChange(input: ApplyRuleChangeInput): RuleChangeReport {
  const { state, silverRowId, nextRule, now } = input
  const silverRow = input.silverRows.find((row) => Number(row.id) === silverRowId)
  if (!silverRow) {
    throw new Error(`没有找到编号为 ${silverRowId} 的清洗表`)
  }

  const fingerprint = ruleFingerprint(nextRule)
  const enabledVersion = currentRuleVersion(state, silverRowId)

  // 幂等：与当前已启用版本口径一致，连续重复触发只生效一次。
  // 重复提交本身不产生新批次，因此即使存在未完成任务也直接跳过，不做拦截。
  if (enabledVersion && ruleFingerprint(enabledVersion) === fingerprint) {
    return {
      deduped: true,
      message: '清洗规则与当前已启用版本口径一致，重复变更已忽略，未触发重算与下游待校验',
      silverRowId,
      changeId: null,
      newVersion: null,
      changedFields: [],
      impactedSilverRowIds: [],
      impactedGoldRowIds: [],
      impactedQualityRowIds: [],
      conflictNote: '',
      taskId: null,
      queuedBatchCount: 0,
    }
  }

  // 存在未完成的重算任务时拒绝新的口径变更，避免旧任务的在途批次与新版本批次交错，
  // 必须先把上一次重算续跑完成（或处理失败）后才能再次改规则。
  const openTask = state.tasks.find(
    (task) => task.silverRowId === silverRowId && task.status !== '已完成',
  )
  if (openTask) {
    throw new Error(`该清洗表存在未完成的重算任务（#${openTask.id}，状态：${openTask.status}），请先从断点续跑完成后再提交规则变更`)
  }

  // 1. 落新版本：旧版本保留但停用，历史批次继续绑定旧版本。
  const newVersionNo = (enabledVersion?.version ?? 0) + 1
  const newVersion: CleaningRuleVersion = {
    id: ++state.seq.ruleVersion,
    silverRowId,
    version: newVersionNo,
    dedupFields: parseDedupFields(nextRule.dedupFields),
    anomalyFilter: nextRule.anomalyFilter.trim(),
    enabled: true,
    createdAt: now,
  }
  for (const version of state.ruleVersions) {
    if (version.silverRowId === silverRowId) {
      version.enabled = false
    }
  }
  state.ruleVersions.push(newVersion)

  // 2. 计算实际变更项。
  const oldDedup = enabledVersion ? parseDedupFields(enabledVersion.dedupFields) : parseDedupFields(silverRow['去重字段'])
  const newDedup = newVersion.dedupFields
  const dedupChanged = oldDedup.join('|') !== newDedup.join('|')
  const oldFilter = (enabledVersion?.anomalyFilter ?? String(silverRow['异常过滤'] ?? '')).trim()
  const filterChanged = oldFilter !== newVersion.anomalyFilter
  const changedFields: string[] = []
  if (dedupChanged) {
    changedFields.push('去重字段')
  }
  if (filterChanged) {
    changedFields.push('异常过滤')
  }

  // 3. 只圈定包含变更字段的当前批次：
  //    去重字段变更 -> 批次去重字段命中变更字段集合；仅异常过滤变更 -> 本表全部当前批次。
  const changedFieldSet = new Set([...oldDedup, ...newDedup])
  const currentBatches = state.batches.filter(
    (batch) =>
      batch.silverRowId === silverRowId &&
      batch.status === '成功' &&
      (!enabledVersion || batch.ruleVersionId === enabledVersion.id),
  )
  const affectedBatches = currentBatches.filter((batch) => {
    if (!dedupChanged) {
      return true
    }
    return batch.dedupFields.some((field) => changedFieldSet.has(field))
  })

  // 4. 为重算创建新批次（计算中），旧批次原样保留。
  const silverCode = rowCode(silverRow, '表编号')
  const newBatchIds: number[] = []
  for (const oldBatch of affectedBatches) {
    const batch: CleaningBatch = {
      id: ++state.seq.batch,
      batchNo: `BATCH-${silverCode}-V${newVersionNo}-${oldBatch.partition}`,
      silverRowId,
      ruleVersionId: newVersion.id,
      ruleVersion: newVersionNo,
      partition: oldBatch.partition,
      dedupFields: [...newDedup],
      status: '计算中',
      recomputed: true,
      sourceBatchId: oldBatch.id,
      createdAt: now,
      finishedAt: null,
    }
    state.batches.push(batch)
    newBatchIds.push(batch.id)
  }

  // 5. 血缘影响：只让真正引用受影响结果的下游进入待校验。
  const downstreamSilverRows = input.silverRows.filter(
    (row) =>
      Number(row.id) !== silverRowId &&
      rowReferences(row, '上游清洗表', [silverCode]),
  )
  const impact = resolveImpactedRows(
    { silverRows: input.silverRows, goldRows: input.goldRows, qualityRows: input.qualityRows },
    silverRow,
    downstreamSilverRows,
  )

  const reason = `清洗规则变更（${changedFields.join('、')}），引用结果需重新校验`
  markPending(silverRow, reason)
  for (const id of impact.impactedSilverRowIds) {
    const row = input.silverRows.find((item) => Number(item.id) === id)
    if (row) {
      markPending(row, `上游清洗表 ${silverCode} 规则变更，引用结果需重新校验`)
    }
  }
  for (const id of impact.impactedGoldRowIds) {
    const row = input.goldRows.find((item) => Number(item.id) === id)
    if (row) {
      markPending(row, `上游清洗表 ${silverCode} 重算去重批次，聚合结果需重新校验`)
      // 数据新鲜度与已有指标结果不清空，保留到重算完成后只刷新受影响项。
    }
  }
  for (const id of impact.impactedQualityRowIds) {
    const row = input.qualityRows.find((item) => Number(item.id) === id)
    if (row) {
      markPending(row, `监控对象引用的清洗结果 ${silverCode} 发生规则变更`)
    }
  }

  // 6. 口径冲突裁决说明。
  const conflictNote = resolveConflictNote(input.silverRows, state, silverRow, now)

  // 7. 落变更记录与重算任务（无受影响批次时仍记录变更，但不建任务）。
  const change: RuleChangeRecord = {
    id: ++state.seq.change,
    silverRowId,
    fromVersionId: enabledVersion?.id ?? null,
    toVersionId: newVersion.id,
    changedFields,
    fingerprint,
    impactedSilverRowIds: impact.impactedSilverRowIds,
    impactedGoldRowIds: impact.impactedGoldRowIds,
    impactedQualityRowIds: impact.impactedQualityRowIds,
    conflictNote,
    createdAt: now,
  }
  state.changes.push(change)

  let taskId: number | null = null
  if (newBatchIds.length > 0) {
    const task: RecomputeTask = {
      id: ++state.seq.task,
      silverRowId,
      changeId: change.id,
      queuedBatchIds: newBatchIds,
      finishedBatchIds: [],
      failedBatchId: null,
      status: '进行中',
      lastSuccessPartition: null,
      startedAt: now,
      updatedAt: now,
    }
    state.tasks.push(task)
    taskId = task.id
  }

  // 8. 同步清洗表行上的规则口径字段（不动其他字段，不清空结果）。
  silverRow['去重字段'] = newDedup.join(',')
  silverRow['异常过滤'] = newVersion.anomalyFilter
  silverRow['规则版本'] = `V${newVersionNo}`

  return {
    deduped: false,
    message: `规则已升级到 V${newVersionNo}，${affectedBatches.length} 个包含变更字段的去重批次进入重算，其余批次与历史结果保留`,
    silverRowId,
    changeId: change.id,
    newVersion: newVersionNo,
    changedFields,
    impactedSilverRowIds: impact.impactedSilverRowIds,
    impactedGoldRowIds: impact.impactedGoldRowIds,
    impactedQualityRowIds: impact.impactedQualityRowIds,
    conflictNote,
    taskId,
    queuedBatchCount: newBatchIds.length,
  }
}

export type ResumeRecomputeInput = {
  state: CleaningState
  taskId: number
  silverRows: EntryRow[]
  goldRows: EntryRow[]
  qualityRows: EntryRow[]
  now: number
  /** 模拟失败：推进到该分区时批次置失败，用于演示/验证断点续跑。 */
  failPartition?: string
}

/**
 * 推进重算任务。已完成任务再次调用是空操作；失败任务从最后成功分区之后续跑，
 * 已完成批次与已刷新指标不会被二次处理。
 */
export function resumeRecompute(input: ResumeRecomputeInput): RecomputeReport {
  const { state, taskId, now } = input
  const task = state.tasks.find((item) => item.id === taskId)
  if (!task) {
    throw new Error(`没有找到编号为 ${taskId} 的重算任务`)
  }
  if (task.status === '已完成') {
    return {
      ok: true,
      message: '重算任务已完成，重复触发已忽略',
      taskId,
      status: task.status,
      progressedPartitions: [],
      finishedBatchIds: [...task.finishedBatchIds],
      failedBatchId: null,
      refreshedGoldRowIds: [],
      refreshedQualityRowIds: [],
    }
  }

  task.status = '进行中'
  const progressedPartitions: string[] = []
  // 续跑队列：剔除已成功分区，失败批次自然排在队首重试。
  const pendingIds = task.queuedBatchIds.filter((id) => !task.finishedBatchIds.includes(id))

  for (const batchId of pendingIds) {
    const batch = state.batches.find((item) => item.id === batchId)
    if (!batch) {
      continue
    }
    if (input.failPartition && batch.partition === input.failPartition) {
      batch.status = '失败'
      batch.finishedAt = now
      task.status = '已失败'
      task.failedBatchId = batch.id
      task.updatedAt = now
      return {
        ok: false,
        message: `分区 ${batch.partition} 重算失败，已保留前序 ${task.finishedBatchIds.length} 个成功分区，可从最后成功结果续跑`,
        taskId,
        status: task.status,
        progressedPartitions,
        finishedBatchIds: [...task.finishedBatchIds],
        failedBatchId: batch.id,
        refreshedGoldRowIds: [],
        refreshedQualityRowIds: [],
      }
    }

    batch.status = '成功'
    batch.finishedAt = now
    task.finishedBatchIds.push(batch.id)
    task.failedBatchId = null
    task.lastSuccessPartition = batch.partition
    progressedPartitions.push(batch.partition)
  }

  // 全部成功：收尾并只刷新真正受影响的下游项。
  // 直接取触发本任务的变更记录里固化的影响清单，不依赖待校验原因文本，
  // 避免同一下游被多张清洗表变更时原因被覆盖而漏刷新。
  task.status = '已完成'
  task.updatedAt = now

  const change = state.changes.find((item) => item.id === task.changeId)
  const refreshedAt = todayText(now)

  const refreshedGoldRowIds: number[] = []
  for (const id of change?.impactedGoldRowIds ?? []) {
    const row = input.goldRows.find((item) => Number(item.id) === id)
    if (!row) {
      continue
    }
    // 只更新受影响聚合视图的数据新鲜度与指标结果时间，状态仍由值班人员显式校验。
    row['数据新鲜度'] = refreshedAt
    row['指标结果更新时间'] = refreshedAt
    refreshedGoldRowIds.push(id)
  }

  const refreshedQualityRowIds: number[] = []
  for (const id of change?.impactedQualityRowIds ?? []) {
    const row = input.qualityRows.find((item) => Number(item.id) === id)
    if (!row) {
      continue
    }
    row['指标结果更新时间'] = refreshedAt
    refreshedQualityRowIds.push(id)
  }

  return {
    ok: true,
    message: `重算完成，共推进 ${progressedPartitions.length} 个分区，历史批次与未受影响指标保持不变`,
    taskId,
    status: task.status,
    progressedPartitions,
    finishedBatchIds: [...task.finishedBatchIds],
    failedBatchId: null,
    refreshedGoldRowIds,
    refreshedQualityRowIds,
  }
}

/** 按去重字段 / 分区 / 状态 / 规则版本筛选清洗批次；历史批次默认一并保留展示。 */
export function listBatches(state: CleaningState, filter: BatchFilter = {}): CleaningBatch[] {
  const task = filter.taskId === undefined ? null : state.tasks.find((item) => item.id === filter.taskId) ?? null
  return state.batches
    .filter((batch) => {
      if (task && !task.queuedBatchIds.includes(batch.id)) {
        return false
      }
      if (filter.silverRowId !== undefined && batch.silverRowId !== filter.silverRowId) {
        return false
      }
      if (filter.dedupField && filter.dedupField.trim() !== '') {
        const keyword = filter.dedupField.trim()
        if (!batch.dedupFields.some((field) => field.includes(keyword))) {
          return false
        }
      }
      if (filter.partition && filter.partition.trim() !== '' && !batch.partition.includes(filter.partition.trim())) {
        return false
      }
      if (filter.status && batch.status !== filter.status) {
        return false
      }
      if (filter.ruleVersion !== undefined && filter.ruleVersion > 0 && batch.ruleVersion !== filter.ruleVersion) {
        return false
      }
      if (filter.includeHistory === false && isHistoricalBatch(state, batch)) {
        return false
      }
      return true
    })
    .sort((a, b) => {
      if (a.silverRowId !== b.silverRowId) {
        return a.silverRowId - b.silverRowId
      }
      if (a.partition !== b.partition) {
        return b.partition.localeCompare(a.partition)
      }
      return b.id - a.id
    })
}
