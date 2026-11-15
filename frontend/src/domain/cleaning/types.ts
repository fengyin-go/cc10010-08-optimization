/**
 * 清洗规则变更影响域的公共类型。
 *
 * 这一层只描述「清洗规则版本 / 清洗批次 / 重算任务 / 影响清单」的领域模型，
 * 不依赖 localStorage 与 React，保证影响计算逻辑可以脱离页面独立测试。
 */

/** 清洗规则的两个可变更口径：去重字段、异常过滤规则。 */
export type RuleSpec = {
  /** 去重字段，顺序无意义，按集合比较。 */
  dedupFields: string[]
  /** 异常过滤规则表达式。 */
  anomalyFilter: string
}

/** 清洗规则版本：历史批次按当时的规则版本保留。 */
export type CleaningRuleVersion = RuleSpec & {
  id: number
  /** 归属清洗表的模块行 id（silver 模块的 EntryRow.id）。 */
  silverRowId: number
  /** 规则版本号，从 1 开始递增。 */
  version: number
  /** 同一张清洗表同一时间只有一个已启用版本，旧版本保留但停用。 */
  enabled: boolean
  /** 版本落库时间（毫秒时间戳）。 */
  createdAt: number
}

/** 去重批次：一次清洗结果按分区落地，每个批次绑定当时的规则版本。 */
export type CleaningBatch = {
  id: number
  /** 批次编号，页面展示用，例如 BATCH-SILV-0001-V2-20261101。 */
  batchNo: string
  silverRowId: number
  /** 产出该批次时使用的规则版本 id；历史批次永不改写。 */
  ruleVersionId: number
  ruleVersion: number
  /** 批次分区，例如 2026-11-01；续跑按分区推进。 */
  partition: string
  /** 参与去重的字段快照，用于「按去重字段筛选清洗批次」。 */
  dedupFields: string[]
  /** 批次状态：计算中 / 成功 / 失败。历史成功批次长期保留。 */
  status: '计算中' | '成功' | '失败'
  /** 该批次是否由规则变更触发的重算产生。 */
  recomputed: boolean
  /** 来源批次 id：重算批次指向被替换的旧批次，旧批次本身保留。 */
  sourceBatchId: number | null
  createdAt: number
  finishedAt: number | null
}

/** 重算任务：规则变更后按受影响批次逐个重算，支持失败续跑。 */
export type RecomputeTask = {
  id: number
  silverRowId: number
  /** 触发该任务的规则变更记录 id。 */
  changeId: number
  /** 待重算的批次 id 队列，保持原批次顺序。 */
  queuedBatchIds: number[]
  /** 已经重算成功的新批次 id（保留已完成分区与指标结果）。 */
  finishedBatchIds: number[]
  /** 最近一次重算失败的新批次 id。 */
  failedBatchId: number | null
  status: '进行中' | '已失败' | '已完成'
  /** 最近一次推进到的分区，失败后续跑从这里的下一个分区开始。 */
  lastSuccessPartition: string | null
  startedAt: number
  updatedAt: number
}

/** 规则变更记录：同一张表同一份口径连续提交只落一条。 */
export type RuleChangeRecord = {
  id: number
  silverRowId: number
  fromVersionId: number | null
  toVersionId: number
  changedFields: string[]
  /** 变更口径指纹，连续相同指纹直接幂等跳过。 */
  fingerprint: string
  /** 进入待校验的下游清洗表行 id。 */
  impactedSilverRowIds: number[]
  /** 进入待校验的聚合视图行 id。 */
  impactedGoldRowIds: number[]
  /** 仅更新受影响项的跨模块质量指标行 id。 */
  impactedQualityRowIds: number[]
  /** 同一输出路径存在多个已启用清洗表、口径冲突由最新表裁决时的说明。 */
  conflictNote: string
  createdAt: number
}

/** 清洗影响域的完整持久化状态。 */
export type CleaningState = {
  ruleVersions: CleaningRuleVersion[]
  batches: CleaningBatch[]
  tasks: RecomputeTask[]
  changes: RuleChangeRecord[]
  seq: {
    ruleVersion: number
    batch: number
    task: number
    change: number
  }
}

/** 规则变更的计算结果，页面据此渲染影响清单与提示。 */
export type RuleChangeReport = {
  deduped: boolean
  message: string
  silverRowId: number
  changeId: number | null
  newVersion: number | null
  changedFields: string[]
  impactedSilverRowIds: number[]
  impactedGoldRowIds: number[]
  impactedQualityRowIds: number[]
  conflictNote: string
  taskId: number | null
  queuedBatchCount: number
}

/** 重算推进结果。 */
export type RecomputeReport = {
  ok: boolean
  message: string
  taskId: number
  status: RecomputeTask['status']
  /** 本次调用实际推进的分区。 */
  progressedPartitions: string[]
  finishedBatchIds: number[]
  failedBatchId: number | null
  /** 成功收尾时联动刷新的聚合视图 / 质量指标。 */
  refreshedGoldRowIds: number[]
  refreshedQualityRowIds: number[]
}

/** 清洗批次的筛选条件。 */
export type BatchFilter = {
  silverRowId?: number
  /** 按去重字段筛选：批次去重字段包含该字段即命中。 */
  dedupField?: string
  partition?: string
  status?: CleaningBatch['status'] | ''
  ruleVersion?: number
  /** 传入任务 id 时，只返回该任务队列内的批次。 */
  taskId?: number
  includeHistory?: boolean
}
