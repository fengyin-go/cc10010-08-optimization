import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'

import {
  changeCleaningRule,
  getDedupOptions,
  listRecomputeTasks,
  queryCleaningBatches,
  resetCleaningDomain,
  resumeCleaningTask,
} from '../src/api/cleaning-service'
import { listRows } from '../src/data/local-store'

describe('cleaning-service 端到端本地持久化流程', () => {
  beforeEach(() => {
    // Node 环境没有 localStorage，两个 store 走内存缓存；每个用例先回到示例口径。
    resetCleaningDomain()
  })

  it('规则变更 -> 幂等 -> 失败 -> 断点续跑 的完整链路只影响受影响项', () => {
    const initialBatches = queryCleaningBatches({ silverRowId: 1 }).length
    assert.equal(initialBatches, 3)

    // 1. 提交去重字段变更。
    const first = changeCleaningRule({
      silverRowId: 1,
      dedupFields: 'order_id,tenant_id,biz_line',
      anomalyFilter: "order_status != 'TEST'",
    })
    assert.equal(first.deduped, false)
    assert.equal(first.queuedBatchCount, 3)
    assert.deepEqual(first.impactedGoldRowIds.sort(), [1, 4])

    // 清洗表行口径字段已同步，状态进入待校验。
    const silver = listRows('silver')
    const changed = silver.find((row) => Number(row.id) === 1)!
    assert.equal(String(changed['去重字段']), 'biz_line,order_id,tenant_id')
    assert.equal(String(changed.status), '待校验')
    assert.ok(String(changed['待校验原因']).includes('去重字段'))

    // 只有引用方进入待校验，GOLD-0002（引用 SILV-0002）保持已启用，新鲜度不清空。
    const gold = listRows('gold')
    assert.equal(String(gold.find((row) => Number(row.id) === 2)!.status), '已启用')
    assert.equal(gold.find((row) => Number(row.id) === 2)!['数据新鲜度'], '2026-11-14')
    assert.equal(String(gold.find((row) => Number(row.id) === 1)!.status), '待校验')
    assert.equal(gold.find((row) => Number(row.id) === 1)!['数据新鲜度'], '2026-11-14')

    // 2. 连续相同口径提交只生效一次。
    const again = changeCleaningRule({
      silverRowId: 1,
      dedupFields: 'biz_line,tenant_id,order_id',
      anomalyFilter: "order_status != 'TEST'",
    })
    assert.equal(again.deduped, true)
    assert.equal(listRecomputeTasks().length, 1)

    // 3. 按去重字段筛选批次。
    const tenantBatches = queryCleaningBatches({ dedupField: 'tenant_id' })
    assert.ok(tenantBatches.length > 0)
    assert.ok(tenantBatches.every((batch) => batch.dedupFields.includes('tenant_id')))
    assert.ok(getDedupOptions().includes('payment_id'))

    // 4. 推进重算时模拟第二分区失败。
    const task = listRecomputeTasks()[0]
    const queued = queryCleaningBatches({ silverRowId: 1, status: '计算中' })
    const failPartition = queued[1].partition
    const failed = resumeCleaningTask(task.id, failPartition)
    assert.equal(failed.ok, false)
    assert.equal(failed.status, '已失败')
    assert.equal(failed.progressedPartitions.length, 1)
    // 失败阶段下游指标时间保持不变。
    assert.equal(listRows('gold').find((row) => Number(row.id) === 1)!['指标结果更新时间'], '2026-11-14')

    // 5. 从最后成功分区续跑至完成，已完成分区不重算。
    const resumed = resumeCleaningTask(task.id)
    assert.equal(resumed.ok, true)
    assert.equal(resumed.progressedPartitions.length, 2)
    assert.deepEqual(resumed.refreshedGoldRowIds.sort(), [1, 4])
    assert.deepEqual(resumed.refreshedQualityRowIds.sort(), [1, 2])

    // 受影响项的结果时间被刷新，未受影响项保持原值。
    const goldAfter = listRows('gold')
    assert.equal(goldAfter.find((row) => Number(row.id) === 1)!['指标结果更新时间'], new Date().toISOString().slice(0, 10))
    assert.equal(goldAfter.find((row) => Number(row.id) === 2)!['指标结果更新时间'], '2026-11-14')
    const qualityAfter = listRows('quality')
    assert.equal(qualityAfter.find((row) => Number(row.id) === 3)!['指标结果更新时间'], '2026-11-14')

    // 6. 历史批次保留：含历史 6 条，当前口径 3 条。
    assert.equal(queryCleaningBatches({ silverRowId: 1, includeHistory: true }).length, 6)
    assert.equal(queryCleaningBatches({ silverRowId: 1, includeHistory: false }).length, 3)
  })
})
