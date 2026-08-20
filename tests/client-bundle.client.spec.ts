// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const requireNode = createRequire(import.meta.url)

/**
 * Regresses the "require(\"process\") missed the module table" failure: the
 * bundle factory is executed under the loader protocol with only the
 * platform seed modules available, so any bare node builtin or cross-plugin
 * require fails loudly.
 */
describe('client bundle factory', () => {
  it('executes under the module-loader protocol with platform seeds only', () => {
    const modules = new Map<string, unknown>()
    const windowAny = window as unknown as {
      __ModuleLoader__: {
        load(entry: { id: string; factory: (req: (name: string) => unknown) => unknown }): void
      }
    }
    windowAny.__ModuleLoader__ = {
      load(entry) {
        const req = (name: string): unknown => {
          if (!modules.has(name)) {
            throw new Error(`missed the module table: ${name}`)
          }
          return modules.get(name)
        }
        modules.set(entry.id, entry.factory(req))
      },
    }
    modules.set('react', requireNode('react'))
    modules.set('react/jsx-runtime', requireNode('react/jsx-runtime'))
    modules.set('react-dom', requireNode('react-dom'))
    modules.set('react-dom/client', requireNode('react-dom/client'))

    const code = readFileSync(join(process.cwd(), 'lib', 'client.js'), 'utf8')
    expect(code).not.toContain('require("process")')
    expect(code).not.toContain('require("buffer")')
    expect(() => {
      // eslint-disable-next-line no-new-func
      new Function(code)()
    }).not.toThrow()
    expect(modules.has('dsh-ace-harness')).toBe(true)
  })
})
