import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { applyRuleChange, listBatches, parseDedupFields, resumeRecompute, ruleFingerprint } from '../src/domain/cleaning/engine'
import { buildCleaningSeed } from '../src/data/cleaning-seed'
import type { CleaningState } from '../src/domain/cleaning/types'
import type { EntryRow } from '../src/data/types'

const NOW = Date.parse('2026-11-15T01:00:00Z')

function silverRows(): EntryRow[] {
  return [
    {
      id: 1, status: '已启用', pending: false, abnormal: false,
      表编号: 'SILV-0001', 上游原始表: 'BRON-0001', 上游清洗表: '',
      异常过滤: "order_status != 'TEST'", 去重字段: 'order_id,tenant_id',
      输出路径: 'lake://silver/orders', 规则版本: 'V1',
    },
    {
      id: 2, status: '已启用', pending: false, abnormal: false,
      表编号: 'SILV-0002', 上游原始表: 'BRON-0002', 上游清洗表: '',
      异常过滤: 'amount > 0', 去重字段: 'payment_id',
      输出路径: 'lake://silver/payments', 规则版本: 'V1',
    },
    {
      id: 3, status: '已启用', pending: false, abnormal: false,
      表编号: 'SILV-0003', 上游原始表: 'BRON-0003', 上游清洗表: '',
      异常过滤: 'is_deleted = 0', 去重字段: 'user_id',
      输出路径: 'lake://silver/users', 规则版本: 'V1',
    },
    {
      id: 4, status: '已启用', pending: false, abnormal: false,
      表编号: 'SILV-0004', 上游原始表: 'BRON-0001', 上游清洗表: 'SILV-0001',
      异常过滤: "order_status != 'TEST'", 去重字段: 'order_id,tenant_id,sku_id',
      输出路径: 'lake://silver/orders_enriched', 规则版本: 'V1',
    },
    {
      id: 5, status: '草稿', pending: true, abnormal: false,
      表编号: 'SILV-0005', 上游原始表: 'BRON-0001', 上游清洗表: 'SILV-0001',
      异常过滤: 'x', 去重字段: 'order_id', 输出路径: 'lake://silver/draft', 规则版本: 'V1',
    },
  ] as EntryRow[]
}

function goldRows(): EntryRow[] {
  return [
    { id: 1, status: '已启用', pending: false, abnormal: false, 视图编号: 'GOLD-0001', 上游清洗表: 'SILV-0001', 数据新鲜度: '2026-11-14', 指标结果更新时间: '2026-11-14' },
    { id: 2, status: '已启用', pending: false, abnormal: false, 视图编号: 'GOLD-0002', 上游清洗表: 'SILV-0002', 数据新鲜度: '2026-11-14', 指标结果更新时间: '2026-11-14' },
    { id: 4, status: '已启用', pending: false, abnormal: false, 视图编号: 'GOLD-0004', 上游清洗表: 'SILV-0004,SILV-0001', 数据新鲜度: '2026-11-14', 指标结果更新时间: '2026-11-14' },
    { id: 6, status: '已停用', pending: false, abnormal: false, 视图编号: 'GOLD-0006', 上游清洗表: 'SILV-0001', 数据新鲜度: '2026-11-10', 指标结果更新时间: '2026-11-10' },
  ] as EntryRow[]
}

function qualityRows(): EntryRow[] {
  return [
    { id: 1, status: '已启用', pending: false, abnormal: false, 指标编号: 'QUAL-0001', 监控对象: 'SILV-0001', 指标结果更新时间: '2026-11-14' },
    { id: 2, status: '已启用', pending: false, abnormal: false, 指标编号: 'QUAL-0002', 监控对象: 'GOLD-0001', 指标结果更新时间: '2026-11-14' },
    { id: 3, status: '已启用', pending: false, abnormal: false, 指标编号: 'QUAL-0003', 监控对象: 'SILV-0003', 指标结果更新时间: '2026-11-14' },
  ] as EntryRow[]
}

function context() {
  return { state: buildCleaningSeed(), silver: silverRows(), gold: goldRows(), quality: qualityRows() }
}

describe('规则指纹与去重字段解析', () => {
  it('去重字段按集合比较，顺序与重复不影响指纹', () => {
    assert.equal(
      ruleFingerprint({ dedupFields: 'a,b', anomalyFilter: 'f' }),
      ruleFingerprint({ dedupFields: ' b ,a,a', anomalyFilter: 'f' }),
    )
    assert.deepEqual(parseDedupFields(' b, a ,a，c'), ['a', 'b', 'c'])
  })
})

describe('applyRuleChange 精准影响计算', () => {
  it('只重算包含变更去重字段的当前批次，历史批次原样保留', () => {
    const ctx = context()
    const beforeBatches = ctx.state.batches.length
    const report = applyRuleChange({
      state: ctx.state,
      silverRowId: 1,
      nextRule: { dedupFields: 'order_id,tenant_id,biz_line', anomalyFilter: "order_status != 'TEST'" },
      silverRows: ctx.silver, goldRows: ctx.gold, qualityRows: ctx.quality, now: NOW,
    })

    assert.equal(report.deduped, false)
    assert.deepEqual(report.changedFields, ['去重字段'])
    // SILV-0001 有 3 个当前成功批次，全部含 order_id/tenant_id，因此 3 个进入重算。
    assert.equal(report.queuedBatchCount, 3)
    assert.equal(ctx.state.batches.length, beforeBatches + 3)

    const oldBatches = ctx.state.batches.filter((b) => b.silverRowId === 1 && b.recomputed === false)
    const newBatches = ctx.state.batches.filter((b) => b.silverRowId === 1 && b.recomputed === true)
    assert.equal(oldBatches.length, 3)
    assert.equal(newBatches.length, 3)
    // 旧批次不改写：仍绑定 V1、状态成功。
    for (const old of oldBatches) {
      assert.equal(old.ruleVersion, 1)
      assert.equal(old.status, '成功')
    }
    for (const next of newBatches) {
      assert.equal(next.ruleVersion, 2)
      assert.equal(next.status, '计算中')
      assert.ok(next.sourceBatchId !== null)
    }
  })

  it('未命中变更字段的批次不重算：仅异常过滤变更时才全表当前批次重算', () => {
    const ctx = context()
    // SILV-0004 批次含 order_id/tenant_id/sku_id；改成只换一个无关字段组合外的场景用异常过滤验证。
    const report = applyRuleChange({
      state: ctx.state,
      silverRowId: 2,
      nextRule: { dedupFields: 'payment_id,channel_id', anomalyFilter: 'amount > 0' },
      silverRows: ctx.silver, goldRows: ctx.gold, qualityRows: ctx.quality, now: NOW,
    })
    // SILV-0002 两个批次都含 payment_id，均命中。
    assert.equal(report.queuedBatchCount, 2)

    const filterOnly = applyRuleChange({
      state: buildCleaningSeed(),
      silverRowId: 3,
      nextRule: { dedupFields: 'user_id', anomalyFilter: 'is_deleted = 0 AND user_id IS NOT NULL' },
      silverRows: silverRows(), goldRows: goldRows(), qualityRows: qualityRows(), now: NOW,
    })
    assert.deepEqual(filterOnly.changedFields, ['异常过滤'])
    // SILV-0003 只有 1 个当前批次。
    assert.equal(filterOnly.queuedBatchCount, 1)
  })

  it('只让真正引用受影响结果的下游进入待校验，且不清空新鲜度与指标结果', () => {
    const ctx = context()
    const report = applyRuleChange({
      state: ctx.state,
      silverRowId: 1,
      nextRule: { dedupFields: 'order_id,tenant_id,biz_line', anomalyFilter: "order_status != 'TEST'" },
      silverRows: ctx.silver, goldRows: ctx.gold, qualityRows: ctx.quality, now: NOW,
    })

    // 上游清洗表：SILV-0004 引用 SILV-0001；草稿 SILV-0005 不参与。
    assert.deepEqual(report.impactedSilverRowIds, [4])
    assert.equal(String(ctx.silver.find((r) => r.id === 4)!.status), '待校验')
    assert.equal(String(ctx.silver.find((r) => r.id === 5)!.status), '草稿')

    // 聚合视图：GOLD-0001 与 GOLD-0004 引用；GOLD-0002 不引用；已停用 GOLD-0006 不参与。
    assert.deepEqual(report.impactedGoldRowIds.sort(), [1, 4])
    assert.equal(String(ctx.gold.find((r) => r.id === 2)!.status), '已启用')
    assert.equal(String(ctx.gold.find((r) => r.id === 6)!.status), '已停用')
    // 数据新鲜度与已有指标结果保留，不被清空。
    assert.equal(ctx.gold.find((r) => r.id === 1)!['数据新鲜度'], '2026-11-14')
    assert.equal(ctx.gold.find((r) => r.id === 1)!['指标结果更新时间'], '2026-11-14')

    // 跨模块质量指标：监控 SILV-0001 与 GOLD-0001 的两条受影响，SILV-0003 的不动。
    assert.deepEqual(report.impactedQualityRowIds.sort(), [1, 2])
    assert.equal(String(ctx.quality.find((r) => r.id === 3)!.status), '已启用')
  })

  it('同一变更连续触发只生效一次（指纹幂等）', () => {
    const ctx = context()
    const first = applyRuleChange({
      state: ctx.state,
      silverRowId: 1,
      nextRule: { dedupFields: 'order_id,tenant_id,biz_line', anomalyFilter: "order_status != 'TEST'" },
      silverRows: ctx.silver, goldRows: ctx.gold, qualityRows: ctx.quality, now: NOW,
    })
    const versionCountAfterFirst = ctx.state.ruleVersions.length
    const second = applyRuleChange({
      state: ctx.state,
      silverRowId: 1,
      nextRule: { dedupFields: 'biz_line, order_id, tenant_id', anomalyFilter: "order_status != 'TEST'" },
      silverRows: ctx.silver, goldRows: ctx.gold, qualityRows: ctx.quality, now: NOW + 1000,
    })

    assert.equal(first.deduped, false)
    assert.equal(second.deduped, true)
    assert.equal(second.queuedBatchCount, 0)
    assert.equal(ctx.state.ruleVersions.length, versionCountAfterFirst)
    assert.equal(ctx.state.changes.length, 1)
  })

  it('重算未完成时拒绝再次变更，避免在途批次与新版本交错', () => {
    const ctx = context()
    applyRuleChange({
      state: ctx.state,
      silverRowId: 1,
      nextRule: { dedupFields: 'order_id,tenant_id,biz_line', anomalyFilter: "order_status != 'TEST'" },
      silverRows: ctx.silver, goldRows: ctx.gold, qualityRows: ctx.quality, now: NOW,
    })
    const task = ctx.state.tasks[0]
    // 让任务停在失败态。
    const queued = ctx.state.batches.filter((b) => b.ruleVersion === 2 && b.silverRowId === 1)
    resumeRecompute({
      state: ctx.state, taskId: task.id, silverRows: ctx.silver, goldRows: ctx.gold,
      qualityRows: ctx.quality, now: NOW + 1000, failPartition: queued[0].partition,
    })

    assert.throws(
      () => applyRuleChange({
        state: ctx.state,
        silverRowId: 1,
        nextRule: { dedupFields: 'order_id,tenant_id,biz_line,region', anomalyFilter: "order_status != 'TEST'" },
        silverRows: ctx.silver, goldRows: ctx.gold, qualityRows: ctx.quality, now: NOW + 2000,
      }),
      /未完成的重算任务/,
    )

    // 续跑完成后允许再次变更。
    resumeRecompute({
      state: ctx.state, taskId: task.id, silverRows: ctx.silver, goldRows: ctx.gold,
      qualityRows: ctx.quality, now: NOW + 3000,
    })
    const next = applyRuleChange({
      state: ctx.state,
      silverRowId: 1,
      nextRule: { dedupFields: 'order_id,tenant_id,biz_line,region', anomalyFilter: "order_status != 'TEST'" },
      silverRows: ctx.silver, goldRows: ctx.gold, qualityRows: ctx.quality, now: NOW + 4000,
    })
    assert.equal(next.deduped, false)
    assert.equal(next.newVersion, 3)
  })

  it('同一输出路径口径冲突时由最新已启用清洗表裁决并给出说明', () => {    const ctx = context()
    // 给 SILV-0002 改成与 SILV-0001 相同输出路径，制造已启用表口径冲突。
    ctx.silver.find((r) => r.id === 2)!['输出路径'] = 'lake://silver/orders'
    const report = applyRuleChange({
      state: ctx.state,
      silverRowId: 1,
      nextRule: { dedupFields: 'order_id,tenant_id,biz_line', anomalyFilter: "order_status != 'TEST'" },
      silverRows: ctx.silver, goldRows: ctx.gold, qualityRows: ctx.quality, now: NOW,
    })
    assert.match(report.conflictNote, /最新已启用清洗表/)
    assert.match(report.conflictNote, /SILV-0001/)
  })
})

describe('resumeRecompute 断点续跑', () => {
  it('中途失败后从最后成功分区续跑，已完成分区与指标结果不变', () => {
    const ctx = context()
    const change = applyRuleChange({
      state: ctx.state,
      silverRowId: 1,
      nextRule: { dedupFields: 'order_id,tenant_id,biz_line', anomalyFilter: "order_status != 'TEST'" },
      silverRows: ctx.silver, goldRows: ctx.gold, qualityRows: ctx.quality, now: NOW,
    })
    const taskId = change.taskId!
    const newBatches = ctx.state.batches.filter((b) => b.recomputed && b.silverRowId === 1)
    const failPartition = newBatches[1].partition

    const failed = resumeRecompute({
      state: ctx.state, taskId, silverRows: ctx.silver, goldRows: ctx.gold, qualityRows: ctx.quality,
      now: NOW + 1000, failPartition,
    })
    assert.equal(failed.ok, false)
    assert.equal(failed.progressedPartitions.length, 1)
    assert.equal(failed.status, '已失败')

    // 失败时下游不刷新，指标结果时间保持原值。
    assert.equal(ctx.gold.find((r) => r.id === 1)!['指标结果更新时间'], '2026-11-14')
    const finishedSnapshot = [...failed.finishedBatchIds]

    // 再次续跑：从失败分区继续，不重复已成功分区。
    const resumed = resumeRecompute({
      state: ctx.state, taskId, silverRows: ctx.silver, goldRows: ctx.gold, qualityRows: ctx.quality,
      now: NOW + 2000,
    })
    assert.equal(resumed.ok, true)
    assert.equal(resumed.status, '已完成')
    // 本次只推进剩余 2 个分区，第 1 个成功分区没有被重算。
    assert.equal(resumed.progressedPartitions.length, 2)
    assert.deepEqual(resumed.finishedBatchIds.slice(0, finishedSnapshot.length), finishedSnapshot)

    // 收尾只刷新受影响聚合视图与质量指标，未引用方不动。
    assert.deepEqual(resumed.refreshedGoldRowIds.sort(), [1, 4])
    assert.deepEqual(resumed.refreshedQualityRowIds.sort(), [1, 2])
    assert.equal(ctx.gold.find((r) => r.id === 1)!['数据新鲜度'], '2026-11-15')
    assert.equal(ctx.gold.find((r) => r.id === 2)!['数据新鲜度'], '2026-11-14')
    assert.equal(ctx.quality.find((r) => r.id === 3)!['指标结果更新时间'], '2026-11-14')
    // 待校验状态仍保留，等待人工重新启用确认。
    assert.equal(String(ctx.gold.find((r) => r.id === 1)!.status), '待校验')

    // 已完成任务重复触发是空操作。
    const again = resumeRecompute({
      state: ctx.state, taskId, silverRows: ctx.silver, goldRows: ctx.gold, qualityRows: ctx.quality, now: NOW + 3000,
    })
    assert.equal(again.ok, true)
    assert.equal(again.progressedPartitions.length, 0)
  })
})

describe('listBatches 按去重字段筛选与历史保留', () => {
  it('支持按清洗表/去重字段/分区/状态筛选，并能排除历史批次', () => {
    const ctx = context()
    applyRuleChange({
      state: ctx.state,
      silverRowId: 1,
      nextRule: { dedupFields: 'order_id,tenant_id,biz_line', anomalyFilter: "order_status != 'TEST'" },
      silverRows: ctx.silver, goldRows: ctx.gold, qualityRows: ctx.quality, now: NOW,
    })

    const onlyPayment = listBatches(ctx.state, { dedupField: 'payment_id' })
    assert.ok(onlyPayment.length > 0)
    assert.ok(onlyPayment.every((b) => b.dedupFields.includes('payment_id')))

    const silverOneCurrent = listBatches(ctx.state, { silverRowId: 1, includeHistory: false })
    // 排除历史后只剩 V2 的 3 个计算中批次。
    assert.equal(silverOneCurrent.length, 3)
    assert.ok(silverOneCurrent.every((b) => b.ruleVersion === 2))

    const withHistory = listBatches(ctx.state, { silverRowId: 1, includeHistory: true })
    assert.equal(withHistory.length, 6)

    const failedStatus = listBatches(ctx.state, { status: '计算中' })
    assert.ok(failedStatus.every((b) => b.status === '计算中'))
  })
})
