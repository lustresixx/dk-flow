/**
 * Browser client bundle for dsh-ace-harness, mirroring the DeepSeek Harness
 * `clientBundle` protocol (packages/client/tsdown.client.ts):
 *
 * - CJS closure-factory artifact: `window.__ModuleLoader__.load({ id,
 *   factory: (require) => ... })`; externals resolve through the loader
 *   module table (platform seed entries + the runtime store exemption).
 * - CSS Modules compiled by lightningcss into hashed class maps; the css
 *   text auto-injects a `<style data-plugin>` tag at factory execution.
 * - Every other @deepseek-ai value import is a build error (purity gate):
 *   cross-plugin value imports would either inline a duplicate runtime
 *   instance or require a specifier the frozen module table cannot answer.
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, resolve as resolvePath, sep } from 'node:path'
import { transform } from 'lightningcss'
import { defineConfig, type UserConfig } from 'tsdown'

/** Platform seed entries the browser module table answers (external). */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

/** Runtime store engine: documented exemption, external at runtime. */
const RUNTIME_STORE_EXEMPTION = '@deepseek-ai/dsh-client-runtime/client'

/** Externals resolved from the loader module table. */
const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES, RUNTIME_STORE_EXEMPTION]

/** Wire/type layers a client bundle may inline (no shared runtime identity). */
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|session|llm|tools|brand)(\/|$)/

/** Vendored framework libraries (no cross-plugin runtime identity). */
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/

/** Generated descriptor/codec contributions (no shared runtime identity). */
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

/** Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline. */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/**
 * Browser shim definitions prepended to the bundle. Inlined dependencies
 * (yaml) end up as CJS `require("process")` / `require("buffer")`; rolldown
 * resolves node builtins before alias hooks, so the rewrite happens at
 * renderChunk time: the definitions land in the intro and the bare requires
 * are replaced with these namespace objects.
 */
const PROCESS_PRELUDE = `var __dshProcessShim = (function () {
  var p = (typeof globalThis !== 'undefined' && globalThis.process) || {};
  var env = p.env || {};
  function noop() {}
  function cwd() { return '/'; }
  function nextTick(fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    (globalThis.queueMicrotask || function (cb) { Promise.resolve().then(cb); })(function () { fn.apply(null, args); });
  }
  return { default: p, env: env, platform: 'browser', browser: true, version: '', versions: {}, emitWarning: noop, cwd: cwd, nextTick: nextTick, __esModule: true };
})();`
const BUFFER_PRELUDE = `var __dshBufferShim = (function () {
  var te = new TextEncoder();
  var td = new TextDecoder();
  function bytesToBase64(u8) {
    var s = '';
    for (var i = 0; i < u8.length; i += 0x8000) { s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); }
    return btoa(s);
  }
  function base64ToBytes(b64) {
    var s = atob(b64);
    var u8 = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  }
  var BufferShim = class extends Uint8Array {
    constructor(input, enc) {
      if (typeof input === 'string') super(enc === 'base64' ? base64ToBytes(input) : te.encode(input));
      else if (input instanceof Uint8Array) super(input);
      else super(input ?? 0);
    }
    toString(enc) {
      if (enc === 'base64') return bytesToBase64(this);
      if (enc === 'hex') return Array.from(this).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
      return td.decode(this);
    }
    static from(value, enc) { return new BufferShim(value, enc); }
    static alloc(size) { return new BufferShim(size); }
    static isBuffer(value) { return value instanceof Uint8Array; }
    static byteLength(value) { return typeof value === 'string' ? te.encode(value).length : (value == null ? 0 : value.length); }
    static concat(list) {
      var total = list.reduce(function (sum, item) { return sum + item.length; }, 0);
      var out = new BufferShim(total);
      var offset = 0;
      for (var i = 0; i < list.length; i++) { out.set(list[i], offset); offset += list[i].length; }
      return out;
    }
  };
  return { default: BufferShim, Buffer: BufferShim, __esModule: true };
})();`

/**
 * Module id this bundle registers under via `__ModuleLoader__.load`. The host
 * looks the bundle up by the plugin's package name, so this must BE the
 * package name — read it from package.json rather than restating it.
 */
const PLUGIN_ID: string = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).name

const config: UserConfig = {
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'lib/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  plugins: [{
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.includes(source)) return null
      if (VENDORED_LIBRARY.test(source)) return null
      if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null
      throw new Error(
        `client bundle purity: "${source}" is not a platform module (CLIENT_EXTERNALS), an inline-safe wire layer, or a generated /remote contribution — `
        + 'cross-plugin value imports are forbidden; collaborate through cordis services (type-only imports are erased and never reach this gate)',
      )
    },
  }, {
    name: 'dsh-node-shim-rewrite',
    renderChunk(code) {
      const needsProcess = code.includes('require("process")')
      const needsBuffer = code.includes('require("buffer")')
      if (!needsProcess && !needsBuffer) return null
      const prelude = [
        needsProcess ? PROCESS_PRELUDE : '',
        needsBuffer ? BUFFER_PRELUDE : '',
      ].filter((part) => part !== '').join('\n')
      const rewritten = code
        .replaceAll('require("process")', '__dshProcessShim')
        .replaceAll('require("buffer")', '__dshBufferShim')
      return { code: `${prelude}\n${rewritten}`, map: null }
    },
  }, {
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.css')) return null
      const abs = importer !== undefined ? resolveCssPath(source, importer) : source
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = readFileSync(fileId)
      const isModule = fileId.endsWith('.module.css')
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: isModule ? { pattern: '[hash]_[local]' } : undefined,
        minify: true,
      })
      const styleInjection = [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(`${PLUGIN_ID}/${basename(fileId)}`)};`,
        'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
        '  const tag = document.createElement(\'style\');',
        `  tag.dataset.plugin = ${JSON.stringify(PLUGIN_ID)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
      ].join('\n')
      if (!isModule) {
        return [`${styleInjection}`, 'export default {};'].join('\n')
      }
      // Sorted so the emitted map is byte-stable: lightningcss does not promise
      // an export order, and an unstable one rewrites lib/client.js on every
      // build, producing diff noise.
      const classMap: Record<string, string> = {}
      const sorted = Object.entries(cssExports ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      for (const [local, exp] of sorted) classMap[local] = exp.name
      return [`${styleInjection}`, `export default ${JSON.stringify(classMap)};`].join('\n')
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

/** Resolve an emitted JS asset import against its source-tree counterpart. */
function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolvePath(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  // tsc output mirrors `src/` under `lib/`; the css sources live in `src/`.
  const marker = `${sep}lib${sep}`
  const srcIndex = emitted.indexOf(marker)
  if (srcIndex !== -1) {
    const srcPath = `${emitted.slice(0, srcIndex)}${sep}src${sep}${emitted.slice(srcIndex + marker.length)}`
    if (existsSync(srcPath)) return srcPath
  }
  return source
}

/** Resolve a css specifier: relative paths against the importer, bare package
 *  specifiers (e.g. `@xyflow/react/dist/style.css`) through node resolution. */
function resolveCssPath(source: string, importer: string): string {
  if (source.startsWith('.')) return sourceAssetPath(source, importer)
  try {
    return createRequire(importer).resolve(source)
  } catch {
    return source
  }
}

export default config
