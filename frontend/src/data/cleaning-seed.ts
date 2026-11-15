import type { CleaningState } from '@/domain/cleaning/types'

// 固定基准时间，保证示例数据在任何环境下都一致。
const BASE = Date.parse('2026-11-14T01:00:00Z')
const HOUR = 3600 * 1000

type SilverSeed = { rowId: number; code: string; dedupFields: string[]; anomalyFilter: string; partitions: string[] }

const SILVER_SEEDS: SilverSeed[] = [
  { rowId: 1, code: 'SILV-0001', dedupFields: ['order_id', 'tenant_id'], anomalyFilter: "order_status != 'TEST'", partitions: ['2026-11-12', '2026-11-13', '2026-11-14'] },
  { rowId: 2, code: 'SILV-0002', dedupFields: ['payment_id'], anomalyFilter: 'amount > 0', partitions: ['2026-11-13', '2026-11-14'] },
  { rowId: 3, code: 'SILV-0003', dedupFields: ['user_id'], anomalyFilter: 'is_deleted = 0', partitions: ['2026-11-14'] },
  { rowId: 4, code: 'SILV-0004', dedupFields: ['order_id', 'sku_id', 'tenant_id'], anomalyFilter: "order_status != 'TEST'", partitions: ['2026-11-13', '2026-11-14'] },
]

/**
 * 清洗影响域的初始状态：每张清洗表一个 V1 规则版本，
 * 每个已产出分区对应一个绑定 V1 的成功去重批次（历史批次的保留基准）。
 */
export function buildCleaningSeed(): CleaningState {
  const state: CleaningState = {
    ruleVersions: [],
    batches: [],
    tasks: [],
    changes: [],
    seq: { ruleVersion: 0, batch: 0, task: 0, change: 0 },
  }

  SILVER_SEEDS.forEach((seed, tableIndex) => {
    const versionId = ++state.seq.ruleVersion
    state.ruleVersions.push({
      id: versionId,
      silverRowId: seed.rowId,
      version: 1,
      dedupFields: [...seed.dedupFields],
      anomalyFilter: seed.anomalyFilter,
      enabled: true,
      createdAt: BASE - HOUR * 24 + tableIndex * HOUR,
    })

    seed.partitions.forEach((partition, partitionIndex) => {
      state.batches.push({
        id: ++state.seq.batch,
        batchNo: `BATCH-${seed.code}-V1-${partition}`,
        silverRowId: seed.rowId,
        ruleVersionId: versionId,
        ruleVersion: 1,
        partition,
        dedupFields: [...seed.dedupFields],
        status: '成功',
        recomputed: false,
        sourceBatchId: null,
        createdAt: BASE + partitionIndex * HOUR,
        finishedAt: BASE + partitionIndex * HOUR + 30 * 60 * 1000,
      })
    })
  })

  return state
}
