import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  batchIsHistorical,
  changeCleaningRule,
  getCurrentRule,
  getDedupOptions,
  goldRowCode,
  listRecomputeTasks,
  listRuleChanges,
  qualityRowCode,
  queryCleaningBatches,
  resetCleaningDomain,
  resumeCleaningTask,
} from '@/api/cleaning-service'
import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import type { CleaningBatch, RecomputeTask, RuleChangeReport } from '@/domain/cleaning/types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('silver')
const columns = [
  '表编号',
  '上游原始表',
  '上游清洗表',
  '清洗脚本',
  '格式校验',
  '异常过滤',
  '去重字段',
  '输出路径',
  '调度周期',
]
const actions = ['提交校验', '启用清洗', '停用清洗']
const statuses = ['草稿', '待校验', '已启用', '已停用']

type BatchQuery = {
  silverRowId: string
  dedupField: string
  partition: string
  status: string
  includeHistory: boolean
}

const EMPTY_QUERY: BatchQuery = {
  silverRowId: '',
  dedupField: '',
  partition: '',
  status: '',
  includeHistory: true,
}

export default function SilverView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [infoMessage, setInfoMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [report, setReport] = useState<RuleChangeReport | null>(null)
  const [batchQuery, setBatchQuery] = useState<BatchQuery>(EMPTY_QUERY)
  const [batches, setBatches] = useState<CleaningBatch[]>([])
  const [tasks, setTasks] = useState<RecomputeTask[]>([])
  const [changes, setChanges] = useState(() => listRuleChanges())
  const [draftRule, setDraftRule] = useState<Record<number, { dedupFields: string; anomalyFilter: string }>>({})
  const filterFields = useMemo(() => ['表编号', '上游原始表', '上游清洗表'], [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
      setBatches(
        queryCleaningBatches({
          silverRowId: batchQuery.silverRowId ? Number(batchQuery.silverRowId) : undefined,
          dedupField: batchQuery.dedupField,
          partition: batchQuery.partition,
          status: (batchQuery.status as CleaningBatch['status']) || '',
          includeHistory: batchQuery.includeHistory,
        }),
      )
      setTasks(listRecomputeTasks())
      setChanges(listRuleChanges())
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '清洗层管理列表读取失败')
    }
    // batchQuery 是筛选条件，变化时也要重新查批次；reload 由下方 effect 统一驱动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, batchQuery])

  useEffect(() => {
    reload()
  }, [reload])

  function ruleDraft(row: EntryRow) {
    const existing = draftRule[Number(row.id)]
    if (existing) {
      return existing
    }
    const current = getCurrentRule(Number(row.id))
    return {
      dedupFields: current ? current.dedupFields.join(',') : String(row['去重字段'] ?? ''),
      anomalyFilter: current ? current.anomalyFilter : String(row['异常过滤'] ?? ''),
    }
  }

  function updateDraft(rowId: number, patch: Partial<{ dedupFields: string; anomalyFilter: string }>) {
    setDraftRule((prev) => {
      const current = getCurrentRule(rowId)
      const fallback = prev[rowId] ?? {
        dedupFields: current ? current.dedupFields.join(',') : '',
        anomalyFilter: current ? current.anomalyFilter : '',
      }
      return { ...prev, [rowId]: { ...fallback, ...patch } }
    })
  }

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    setInfoMessage('')
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    reload()
  }

  function submitRuleChange(row: EntryRow) {
    setErrorMessage('')
    setInfoMessage('')
    const draft = ruleDraft(row)
    try {
      const result = changeCleaningRule({
        silverRowId: Number(row.id),
        dedupFields: draft.dedupFields,
        anomalyFilter: draft.anomalyFilter,
      })
      setReport(result)
      if (result.deduped) {
        setInfoMessage(result.message)
      } else {
        setInfoMessage(result.message)
      }
      reload()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '规则变更提交失败')
    }
  }

  function continueTask(task: RecomputeTask, failPartition?: string) {
    setErrorMessage('')
    setInfoMessage('')
    try {
      const result = resumeCleaningTask(task.id, failPartition)
      setInfoMessage(result.message)
      reload()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '重算续跑失败')
    }
  }

  function resetAll() {
    resetCleaningDomain()
    setReport(null)
    setInfoMessage('已重置清洗影响域与相关模块示例数据')
    setErrorMessage('')
    setBatchQuery(EMPTY_QUERY)
    setDraftRule({})
    reload()
  }

  const stats = [
    { label: '清洗表总数', value: rows.length },
    { label: '已启用表', value: rows.filter((row) => String(row.status) === '已启用').length },
    { label: '待校验表', value: rows.filter((row) => String(row.status) === '待校验').length },
  ]
  const dedupOptions = getDedupOptions(batchQuery.silverRowId ? Number(batchQuery.silverRowId) : undefined)
  const silverName = (rowId: number) => rows.find((row) => Number(row.id) === rowId)?.['表编号'] ?? `#${rowId}`

  return (
    <section className="page" data-module="silver">
      <header className="page-head">
        <div>
          <h2>清洗层管理管理</h2>
          <p className="page-desc">
            维护清洗规则与去重批次：规则变更只重算包含变更字段的批次，历史批次按规则版本保留，下游仅真正引用方进入待校验。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出清洗层管理清单
          </button>
          <button className="btn ghost" type="button" onClick={resetAll}>
            重置示例数据
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <p className="status-legend">
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      {infoMessage && <p className="info-banner">{infoMessage}</p>}
      {errorMessage && <p className="error-text">{errorMessage}</p>}
      {report && !report.deduped && (
        <div className="impact-panel">
          <strong>最近一次规则变更影响清单（{silverName(report.silverRowId)} → V{report.newVersion}）</strong>
          <ul>
            <li>变更字段：{report.changedFields.join('、')}；进入重算的去重批次：{report.queuedBatchCount} 个</li>
            <li>
              待校验上游清洗表：
              {report.impactedSilverRowIds.length ? report.impactedSilverRowIds.map(silverName).join('、') : '无'}
            </li>
            <li>
              待校验聚合视图：
              {report.impactedGoldRowIds.length ? report.impactedGoldRowIds.map(goldRowCode).join('、') : '无'}
            </li>
            <li>
              跨模块受影响质量指标：
              {report.impactedQualityRowIds.length ? report.impactedQualityRowIds.map(qualityRowCode).join('、') : '无'}
            </li>
            {report.conflictNote && <li>{report.conflictNote}</li>}
          </ul>
        </div>
      )}

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>当前状态</th>
            <th>规则版本</th>
            <th>待校验原因</th>
            <th>规则变更与动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const draft = ruleDraft(row)
            const current = getCurrentRule(Number(row.id))
            return (
              <tr key={String(row.id)}>
                {columns.map((column) => <td key={column}>{row[column] === '' || row[column] === undefined ? '—' : row[column]}</td>)}
                <td>{row.status}</td>
                <td>{current ? `V${current.version}` : row['规则版本'] ?? '—'}</td>
                <td>{row['待校验原因'] ?? '—'}</td>
                <td className="row-actions rule-editor">
                  <label className="editor-field">
                    <span>去重字段</span>
                    <input
                      value={draft.dedupFields}
                      placeholder="逗号分隔，如 order_id,tenant_id"
                      onChange={(event) => updateDraft(Number(row.id), { dedupFields: event.target.value })}
                    />
                  </label>
                  <label className="editor-field">
                    <span>异常过滤</span>
                    <input
                      value={draft.anomalyFilter}
                      placeholder="过滤表达式"
                      onChange={(event) => updateDraft(Number(row.id), { anomalyFilter: event.target.value })}
                    />
                  </label>
                  <button className="btn primary" type="button" onClick={() => submitRuleChange(row)}>
                    提交规则变更
                  </button>
                  {actions.map((action) => (
                    <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                      {action}
                    </button>
                  ))}
                </td>
              </tr>
            )
          })}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 4}>暂无清洗层管理数据</td>
            </tr>
          )}
        </tbody>
      </table>

      <section className="sub-panel">
        <h3>去重批次（按去重字段筛选，历史批次按规则版本保留）</h3>
        <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
          <label className="filter-item">
            <span>清洗表</span>
            <select value={batchQuery.silverRowId} onChange={(event) => setBatchQuery((prev) => ({ ...prev, silverRowId: event.target.value }))}>
              <option value="">全部清洗表</option>
              {rows.map((row) => (
                <option key={String(row.id)} value={String(row.id)}>{String(row['表编号'])}</option>
              ))}
            </select>
          </label>
          <label className="filter-item">
            <span>去重字段</span>
            <input
              value={batchQuery.dedupField}
              placeholder="按去重字段筛选批次"
              onChange={(event) => setBatchQuery((prev) => ({ ...prev, dedupField: event.target.value }))}
            />
          </label>
          <label className="filter-item">
            <span>分区</span>
            <input
              value={batchQuery.partition}
              placeholder="如 2026-11-14"
              onChange={(event) => setBatchQuery((prev) => ({ ...prev, partition: event.target.value }))}
            />
          </label>
          <label className="filter-item">
            <span>批次状态</span>
            <select value={batchQuery.status} onChange={(event) => setBatchQuery((prev) => ({ ...prev, status: event.target.value }))}>
              <option value="">全部状态</option>
              <option value="计算中">计算中</option>
              <option value="成功">成功</option>
              <option value="失败">失败</option>
            </select>
          </label>
          <label className="filter-item checkbox-item">
            <input
              type="checkbox"
              checked={batchQuery.includeHistory}
              onChange={(event) => setBatchQuery((prev) => ({ ...prev, includeHistory: event.target.checked }))}
            />
            <span>包含历史批次</span>
          </label>
          <button className="btn" type="submit">查询批次</button>
          <button className="btn ghost" type="button" onClick={() => setBatchQuery(EMPTY_QUERY)}>重置批次条件</button>
        </form>
        {dedupOptions.length > 0 && (
          <p className="quick-tags">
            可选去重字段：
            {dedupOptions.map((field) => (
              <button
                key={field}
                className="link"
                type="button"
                onClick={() => setBatchQuery((prev) => ({ ...prev, dedupField: field }))}
              >
                {field}
              </button>
            ))}
          </p>
        )}
        <table className="data-table">
          <thead>
            <tr>
              <th>批次编号</th>
              <th>清洗表</th>
              <th>规则版本</th>
              <th>分区</th>
              <th>去重字段</th>
              <th>状态</th>
              <th>重算来源</th>
              <th>历史标记</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((batch) => (
              <tr key={batch.id}>
                <td>{batch.batchNo}</td>
                <td>{silverName(batch.silverRowId)}</td>
                <td>V{batch.ruleVersion}</td>
                <td>{batch.partition}</td>
                <td>{batch.dedupFields.join(',')}</td>
                <td>{batch.status}</td>
                <td>{batch.recomputed ? `重算自批次#${batch.sourceBatchId}` : '原始批次'}</td>
                <td>{batchIsHistorical(batch) ? '历史保留' : '当前口径'}</td>
              </tr>
            ))}
            {batches.length === 0 && (
              <tr>
                <td className="empty-state" colSpan={8}>没有符合条件的去重批次</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="sub-panel">
        <h3>重算任务（失败后从最后成功分区续跑，已完成分区与指标结果不动）</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>任务#</th>
              <th>清洗表</th>
              <th>状态</th>
              <th>已完成分区</th>
              <th>最后成功分区</th>
              <th>待重算批次</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => {
              const pendingCount = task.queuedBatchIds.length - task.finishedBatchIds.length
              // 用任务自身的队列查下一批次，不受页面批次筛选条件影响。
              const taskBatches = queryCleaningBatches({ taskId: task.id })
              const nextBatch = taskBatches.find((batch) => !task.finishedBatchIds.includes(batch.id))
              return (
                <tr key={task.id}>
                  <td>#{task.id}</td>
                  <td>{silverName(task.silverRowId)}</td>
                  <td>{task.status}</td>
                  <td>{task.finishedBatchIds.length}</td>
                  <td>{task.lastSuccessPartition ?? '—'}</td>
                  <td>{pendingCount}</td>
                  <td className="row-actions">
                    <button
                      className="btn primary"
                      type="button"
                      disabled={task.status === '已完成'}
                      onClick={() => continueTask(task)}
                    >
                      {task.status === '已失败' ? '从断点续跑' : '推进重算'}
                    </button>
                    <button
                      className="btn"
                      type="button"
                      disabled={task.status === '已完成' || !nextBatch}
                      title="模拟下一个分区重算失败，验证断点续跑"
                      onClick={() => continueTask(task, nextBatch?.partition)}
                    >
                      模拟下一分区失败
                    </button>
                  </td>
                </tr>
              )
            })}
            {tasks.length === 0 && (
              <tr>
                <td className="empty-state" colSpan={7}>暂无重算任务，提交规则变更后自动生成</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="sub-panel">
        <h3>规则变更记录（同一变更连续触发只生效一次）</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>变更#</th>
              <th>清洗表</th>
              <th>变更字段</th>
              <th>版本走向</th>
              <th>待校验清洗表</th>
              <th>待校验聚合视图</th>
              <th>受影响质量指标</th>
              <th>口径冲突说明</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((change) => (
              <tr key={change.id}>
                <td>#{change.id}</td>
                <td>{silverName(change.silverRowId)}</td>
                <td>{change.changedFields.join('、')}</td>
                <td>{change.fromVersionId ? `V 旧#${change.fromVersionId}` : 'V1'} → V 新#{change.toVersionId}</td>
                <td>{change.impactedSilverRowIds.map(silverName).join('、') || '无'}</td>
                <td>{change.impactedGoldRowIds.map(goldRowCode).join('、') || '无'}</td>
                <td>{change.impactedQualityRowIds.map(qualityRowCode).join('、') || '无'}</td>
                <td>{change.conflictNote || '—'}</td>
              </tr>
            ))}
            {changes.length === 0 && (
              <tr>
                <td className="empty-state" colSpan={8}>暂无规则变更记录</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <footer className="page-foot">
        <span>共 {total} 条清洗层管理记录；规则版本、批次与重算任务持久化在浏览器本地存储</span>
      </footer>
    </section>
  )
}
