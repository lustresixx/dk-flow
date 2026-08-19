/**
 * E2E smoke runner (local dev only): resolves the user's DeepSeek credential
 * from the dsh settings store WITHOUT printing it, then boots the ace-headless
 * profile with DEEPSEEK_API_KEY exported so the agent can call workflow tools.
 * Usage: node scripts/smoke-headless.mjs "<task>"
 */
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'

const settingsPath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'settings.yaml')
let key = ''
try {
  const parsed = YAML.parse(readFileSync(settingsPath, 'utf8'))
  const walk = (value, path) => {
    if (value === null || typeof value !== 'object') return
    for (const [k, v] of Object.entries(value)) {
      if (/key|token|secret/i.test(k) && typeof v === 'string' && v.length > 20) {
        key = v
        return
      }
      walk(v, `${path}.${k}`)
    }
  }
  walk(parsed, '')
} catch {
  // No settings store: fall through and let dsh report MISSING_CREDENTIAL.
}

const task = process.argv[2] ?? '/workflow list'
const dshBin = join(
  process.env.APPDATA ?? homedir(),
  'npm',
  'node_modules',
  '@deepseek-ai',
  'dsh',
  'lib',
  'bin.js',
)
const result = spawnSync(process.execPath, [dshBin, '--profile', 'ace-headless', task], {
  env: { ...process.env, DEEPSEEK_API_KEY: key },
  stdio: 'inherit',
  windowsHide: true,
  timeout: 10 * 60 * 1000,
})
process.exit(result.status ?? 1)
