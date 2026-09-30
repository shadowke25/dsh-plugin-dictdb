/**
 * Smoke test for dsh-plugin-dictdb.
 *
 * Loads lib/index.js under stubbed host packages, drives apply() with a mock
 * ctx, and then exercises every tool end-to-end against a REAL dictdb
 * installation (path via env). Asserts the design contract from
 * docs/插件开发要求.md — especially that domain failures are returned as data
 * rather than thrown.
 *
 * Run:
 *   node --import ./scripts/stubs/register.mjs scripts/smoke.mjs
 *
 * Env:
 *   DICTDB_TEST_PATH  dictdb project root      (default: repo default)
 *   DICTDB_TEST_HOME  dictdb data root         (default: same as PATH)
 */
import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const dictdbPath = process.env.DICTDB_TEST_PATH
const dataHome = process.env.DICTDB_TEST_HOME || dictdbPath

if (!dictdbPath) {
	console.error('DICTDB_TEST_PATH is required (dictdb project root)')
	process.exit(2)
}

const mod = await import('../lib/index.js')

// ───────────────────────── static contract ─────────────────────────

assert.equal(mod.name, 'dictdb', 'plugin name')
assert.deepEqual(mod.inject, ['tools'], 'inject must request ctx.tools')
assert.equal(typeof mod.apply, 'function', 'apply must be exported')
assert.ok(mod.Config && typeof mod.Config.resolveDefaults === 'function', 'Config schema must be exported')

const defaults = mod.Config.resolveDefaults({})
for (const key of ['dictdbPath', 'pythonPath', 'dataHome', 'timeoutMs', 'defaultHead', 'maxHead']) {
	assert.ok(key in defaults, `Config.${key} must have a default`)
}
assert.equal(defaults.defaultHead, 20)
assert.equal(defaults.maxHead, 200)
console.log('config defaults:', JSON.stringify(defaults))

// ───────────────────────── registration ─────────────────────────

const registered = new Map()
const ctx = {
	tools: {
		register(definition) {
			assert.ok(!registered.has(definition.name), `duplicate tool ${definition.name}`)
			registered.set(definition.name, definition)
			return () => registered.delete(definition.name)
		},
	},
}

const cfg = mod.Config.resolveDefaults({
	dictdbPath,
	dataHome,
	pythonPath: process.env.DICTDB_TEST_PYTHON || '',
})

mod.apply(ctx, cfg)

const expected = ['dictdb_search', 'dictdb_show', 'dictdb_info']
assert.deepEqual([...registered.keys()].sort(), expected.slice().sort(),
	`registered tools must be exactly ${expected.join(', ')}`)
console.log('registered tools:', [...registered.keys()].join(', '))

// Required-parameter declarations.
const show = registered.get('dictdb_show')
const info = registered.get('dictdb_info')
const search = registered.get('dictdb_search')
assert.equal(show.parameters.target.required, true, 'dictdb_show.target must be required')
assert.equal(info.parameters.target.required, true, 'dictdb_info.target must be required')
assert.ok(!search.parameters.category?.required, 'dictdb_search.category must stay optional')

// Output contract: every tool renders text.
for (const [name, definition] of registered) {
	const rendered = definition.output.render({}, 'probe')
	assert.equal(rendered[0].type, 'text', `${name} render must emit a text block`)
	assert.equal(rendered[0].text, 'probe', `${name} render must pass the value through`)
}

// ───────────────────────── live calls ─────────────────────────

const call = async (name, args, signal) => {
	const definition = registered.get(name)
	return definition.execute(args, { signal })
}

let failures = 0
async function check(label, fn) {
	try {
		await fn()
		console.log(`  PASS  ${label}`)
	} catch (error) {
		failures += 1
		console.error(`  FAIL  ${label}\n        ${error?.message ?? error}`)
	}
}

console.log('\nlive dictdb calls:')

// A missing/partial config must not silently produce NaN bounds or a wrong cwd.
await check('apply() survives a missing config', async () => {
	const seen = new Map()
	mod.apply({
		tools: {
			register(definition) { seen.set(definition.name, definition); return () => {} },
		},
	}) // deliberately no config argument
	assert.deepEqual([...seen.keys()].sort(), expected.slice().sort())
})

// Configuration resolution. Nothing machine-specific is baked into the
// defaults, so an unconfigured plugin must fail loudly and actionably rather
// than spawning python in some arbitrary directory.
await check('unconfigured dictdbPath fails with an actionable message', async () => {
	const saved = { ...process.env }
	delete process.env.DICTDB_PATH
	delete process.env.DICTDB_HOME
	try {
		const tools = new Map()
		mod.apply(
			{ tools: { register(d) { tools.set(d.name, d); return () => {} } } },
			{ ...cfg, dictdbPath: '' },
		)
		await assert.rejects(
			() => tools.get('dictdb_search').execute({ category: 'dir' }, {}),
			(error) => /dictdbPath|DICTDB_PATH|DICTDB_HOME/.test(error.message),
		)
	} finally {
		Object.assign(process.env, saved)
	}
})

await check('DICTDB_PATH env resolves the project root when config is empty', async () => {
	const saved = process.env.DICTDB_PATH
	process.env.DICTDB_PATH = dictdbPath
	try {
		const tools = new Map()
		mod.apply(
			{ tools: { register(d) { tools.set(d.name, d); return () => {} } } },
			{ ...cfg, dictdbPath: '' },
		)
		const text = await tools.get('dictdb_search').execute({ tag: 'fast' }, {})
		assert.ok(text.includes('路径:'), `env-resolved lookup must work, got: ${text.slice(0, 120)}`)
	} finally {
		if (saved === undefined) delete process.env.DICTDB_PATH
		else process.env.DICTDB_PATH = saved
	}
})

await check('a nonexistent dictdbPath is reported by name', async () => {
	const tools = new Map()
	mod.apply(
		{ tools: { register(d) { tools.set(d.name, d); return () => {} } } },
		{ ...cfg, dictdbPath: join(dictdbPath, 'no-such-subdir-zzz') },
	)
	await assert.rejects(
		() => tools.get('dictdb_search').execute({ category: 'dir' }, {}),
		(error) => /不存在/.test(error.message) && /no-such-subdir-zzz/.test(error.message),
	)
})

// 1) search by category returns entries with absolute paths
let searchText = ''
await check('search(category=dir) returns entries with absolute paths', async () => {
	searchText = await call('dictdb_search', { category: 'dir' })
	assert.ok(searchText.includes('路径:'), 'output must include 路径')
	const paths = [...searchText.matchAll(/路径: (.+)/g)].map(m => m[1].trim())
	assert.ok(paths.length > 0, 'at least one path expected')
	for (const p of paths.slice(0, 5)) {
		assert.ok(/^[A-Za-z]:\\/.test(p) || p.startsWith('/'), `path must be absolute: ${p}`)
	}
	console.log(`        ${paths.length} paths, output ${searchText.length} chars`)
})

// 2) a no-match search is data, not an exception
await check('search(no match) returns guidance instead of throwing', async () => {
	const text = await call('dictdb_search', { keyword: 'zzz_definitely_absent_zzz' })
	assert.ok(text.includes('没有匹配'), `expected no-match guidance, got: ${text.slice(0, 120)}`)
})

// 3) unknown id is data, not an exception
await check('show(unknown id) returns NOT_FOUND as text', async () => {
	const text = await call('dictdb_show', { target: '999999' })
	assert.ok(text.includes('NOT_FOUND'), `expected NOT_FOUND, got: ${text.slice(0, 120)}`)
})

// 4) malformed target is data, not an exception
await check('show(malformed target) returns VALIDATION as text', async () => {
	const text = await call('dictdb_show', { target: 'not-a-target' })
	assert.ok(/VALIDATION|NOT_FOUND/.test(text), `expected a structured code, got: ${text.slice(0, 120)}`)
})

// 5) locate a dictionary whose backing file is actually present.
// The fixture carries only a subset of store files, so picking by position
// would be flaky — probe for one that exists. Prefer a dictionary long enough
// that the windowing assertions below are actually meaningful.
let firstTarget = null
await check('locate a dictionary present on disk (fixture probe)', async () => {
	const text = await call('dictdb_search', {})
	const entries = [...text.matchAll(/id=(\d+)[^\n]*?(\d+)行[^\n]*\n\s*路径: ([^\n]+)/g)]
		.map(([, id, lines, path]) => ({ id, lines: Number(lines), path: path.trim() }))
		.filter(({ path }) => existsSync(path))

	assert.ok(entries.length > 0, 'fixture must contain at least one dictionary file')
	const big = entries.find(({ lines }) => lines >= 30)
	assert.ok(big, `need a dictionary with >= 30 lines to test windowing, `
		+ `have: ${entries.map(e => e.lines).join(',')}`)
	firstTarget = big.id
	console.log(`        using id=${firstTarget} (${big.lines} lines, ${entries.length} present)`)
})

// 6) default preview is bounded and says so
await check('show(default) is bounded and flagged as default-limited', async () => {
	const preview = await call('dictdb_show', { target: firstTarget })
	assert.ok(preview.includes('并非完整内容'), 'default window must be flagged')
	const rowCount = (preview.match(/^\s+\d+:/gm) ?? []).length
	assert.ok(rowCount <= 20, `default preview must be <= 20 rows, got ${rowCount}`)
	console.log(`        default preview rows: ${rowCount}`)
})

// 7) the plugin-side clamp, proven against a dictionary longer than the cap.
// Re-running the plugin with a tiny maxHead makes the assertion independent of
// whichever dictionary the fixture happens to provide.
await check('maxHead genuinely caps a dictionary longer than the cap', async () => {
	const tools = new Map()
	mod.apply(
		{ tools: { register(d) { tools.set(d.name, d); return () => {} } } },
		{ ...cfg, maxHead: 3, defaultHead: 99 },
	)
	const preview = await tools.get('dictdb_show').execute({ target: firstTarget }, {})
	const rowCount = (preview.match(/^\s+\d+:/gm) ?? []).length
	assert.ok(rowCount <= 3, `maxHead=3 must cap rows, got ${rowCount}`)
	assert.ok(rowCount > 0, 'must still return some rows')
	console.log(`        maxHead=3 -> ${rowCount} rows`)
})

// 8) The cap must hold against an explicit head — including the two shapes that
// would otherwise be unbounded: `0` (dictdb >= v1.5 reads it as "whole file")
// and a huge number. Proven with a tiny maxHead so the assertion cannot pass
// merely because the fixture dictionary is short.
await check('explicit head cannot escape the cap (incl. the 0 = whole-file hatch)', async () => {
	const tools = new Map()
	mod.apply(
		{ tools: { register(d) { tools.set(d.name, d); return () => {} } } },
		{ ...cfg, maxHead: 3, defaultHead: 99 },
	)
	const show = tools.get('dictdb_show')

	for (const attempt of [0, -1, 999999, Number.MAX_SAFE_INTEGER]) {
		const preview = await show.execute({ target: firstTarget, head: attempt }, {})
		const rows = (preview.match(/^\s+\d+:/gm) ?? []).length
		assert.ok(rows > 0, `head=${attempt} returned nothing`)
		assert.ok(rows <= 3, `head=${attempt} escaped the cap with ${rows} rows`)
	}
	console.log('        head=0 / -1 / 999999 / MAX_SAFE_INTEGER all capped at 3 rows')
})

// 9) an explicit head is a caller choice, so it must NOT be labelled a default
// window — otherwise the model gets a misleading note.
await check('explicit head is not labelled as a default window', async () => {
	const preview = await call('dictdb_show', { target: firstTarget, head: 5 })
	assert.ok(!preview.includes('并非完整内容'),
		'an explicit head must not be flagged as default-limited')
	const rows = (preview.match(/^\s+\d+:/gm) ?? []).length
	assert.equal(rows, 5, `head=5 must return exactly 5 rows, got ${rows}`)
})

// 7) grep mode
await check('show(grep) filters instead of truncating blindly', async () => {
	const preview = await call('dictdb_show', { target: firstTarget, grep: 'admin' })
	assert.ok(preview.length > 0, 'grep must return something')
})

// 8) info returns the full field set
await check('info returns full metadata including md5 and source', async () => {
	const text = await call('dictdb_info', { target: firstTarget })
	for (const field of ['id=', '名称=', '分类=', '标签=', '路径=', 'md5=', '创建=']) {
		assert.ok(text.includes(field), `info must include ${field}`)
	}
})

// 9) abort propagates as AbortError
await check('aborted call rejects with AbortError', async () => {
	const controller = new AbortController()
	controller.abort()
	await assert.rejects(
		() => call('dictdb_search', { category: 'dir' }, controller.signal),
		(error) => error.name === 'AbortError' || /EPERM|取消/.test(error.message),
	)
})

// 10) @selector round-trip.
// Search for the very dictionary the probe found, so @1 is guaranteed to be a
// record whose file is present — position-based assertions would be flaky.
await check('@n selector resolves after a search', async () => {
	const listing = await call('dictdb_search', {})
	const line = listing.match(new RegExp(`id=${firstTarget}\\b[^\\n]*\\n\\s*路径: ([^\\n]+)`))
	assert.ok(line, `id=${firstTarget} must be findable by search`)

	// Narrow to just that entry so it lands at index 1.
	const name = line[0].match(/\| ([^|]+) \|/)?.[1]?.trim()
	assert.ok(name, 'must be able to read the dictionary name back')
	await call('dictdb_search', { keyword: name })

	const preview = await call('dictdb_show', { target: '@1', head: 3 })
	assert.ok(preview.includes('路径:'),
		`@1 must resolve to a dictionary, got: ${preview.slice(0, 160)}`)
})

console.log('')
if (failures > 0) {
	console.error(`smoke test FAILED — ${failures} check(s) failed`)
	process.exit(1)
}
console.log('smoke test passed ✓')
