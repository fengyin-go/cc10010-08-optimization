/**
 * 测试入口：用 esbuild 把 tests/ 下的 *.test.ts（含 @ 路径别名）逐个打成 ESM，
 * 再交给 Node 内置 node:test 运行，避免引入额外测试框架。
 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readdirSync } from 'node:fs'

const ROOT = process.cwd()
const entries = readdirSync(join(ROOT, 'tests'))
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => join(ROOT, 'tests', name))

const OUT_DIR = join(tmpdir(), `cleaning-tests-${process.pid}`)

async function main() {
  await build({
    entryPoints: entries,
    bundle: true,
    platform: 'node',
    format: 'esm',
    outdir: OUT_DIR,
    alias: { '@': join(ROOT, 'src') },
    logLevel: 'silent',
  })
  try {
    for (const name of entries.map((file) => file.split('/').pop()!.replace(/\.ts$/, '.js'))) {
      await import(pathToFileURL(join(OUT_DIR, name)).href)
    }
  } finally {
    rmSync(OUT_DIR, { recursive: true, force: true })
  }
}

main().catch((error) => {
  // node:test 自身会打印失败用例；这里兜底处理构建期错误。
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
  rmSync(OUT_DIR, { recursive: true, force: true })
})
