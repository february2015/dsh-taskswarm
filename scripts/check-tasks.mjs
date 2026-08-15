#!/usr/bin/env node
/**
 * Standalone TaskSwarm task-packet validator — fast feedback without booting
 * DSH: parse status, structure warnings, and the wave plan for a tasks root.
 *
 * Usage:   node scripts/check-tasks.mjs [tasksRoot]   (default: ./tasks)
 * Requires `npm run build` first (imports from lib/, like the tests).
 *
 * Exit codes: 0 = all packets parse (warnings allowed); 1 = at least one
 * parse failure; 2 = tasks root not found.
 */
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { scanTasks, scanTaskFailures, buildWaves, formatWavePlan } from '../lib/core/discover.js'
import { checkPacketQuality } from '../lib/core/task.js'

const root = resolve(process.argv[2] ?? 'tasks')
if (!existsSync(root)) {
  console.error(`tasks root not found: ${root}`)
  process.exit(2)
}

const failures = scanTaskFailures(root)
const tasks = scanTasks(root, true)
const lines = [`Task packet check (${root}): ${tasks.length} parse OK${failures.length > 0 ? `, ${failures.length} FAILED` : ''}`]

if (failures.length > 0) {
  lines.push('', '✖ Parse failures (silently skipped by the engine — must fix):')
  for (const f of failures) lines.push(`  - ${f.folder}: ${f.reason}`)
}
const warnings = []
for (const t of tasks) {
  for (const w of checkPacketQuality(t.task)) warnings.push(`  - ${t.task.id} (${t.task.name}): ${w}`)
}
if (warnings.length > 0) {
  lines.push('', '! Structure warnings (parse OK, but worth fixing):')
  lines.push(...warnings)
}
if (tasks.length > 0) {
  lines.push('', formatWavePlan(buildWaves(tasks.map((t) => t.task))))
}

console.log(lines.join('\n'))
process.exitCode = failures.length > 0 ? 1 : 0
