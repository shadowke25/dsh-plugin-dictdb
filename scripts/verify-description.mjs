/**
 * Verifies every claim the tool description makes about tags and categories.
 *
 * The description is the model's only decision input, so a tag that yields
 * nothing sends it down a dead end. This checks the real consumer path
 * (dictdb_search with a tag filter), not a hand-rolled aggregation.
 *
 * Run: node --import ./scripts/stubs/register.mjs scripts/verify-description.mjs
 */
import { strict as assert } from 'node:assert'

const dictdbPath = process.env.DICTDB_TEST_PATH
const dataHome = process.env.DICTDB_TEST_HOME || dictdbPath
if (!dictdbPath) { console.error('DICTDB_TEST_PATH is required'); process.exit(2) }

const mod = await import('../lib/index.js')
const tools = new Map()
mod.apply(
	{ tools: { register(d) { tools.set(d.name, d); return () => {} } } },
	mod.Config.resolveDefaults({ dictdbPath, dataHome }),
)
const search = tools.get('dictdb_search')

const call = (args) => search.execute(args, {})

/** Number of entries the rendered output reports. */
function hitCount(text) {
	const match = text.match(/^(\d+) 条结果/m)
	return match ? Number(match[1]) : 0
}

// Tags the description tells the model to use.
const TAGS = [
	['fast', 'Top1000级快速版'],
	['classic', '经典必备'],
	['service', '66个服务弱口令对'],
	['device', '安全设备默认凭据'],
	['403bypass', '403 绕过'],
	['upload', '文件上传'],
	['jwt', 'JWT Secret'],
	['chinese', '中文用户名'],
	['company', '公司资产'],
]

// Categories the description names.
const CATEGORIES = ['dir', 'password', 'username', 'subdomain', 'param', 'api', 'fuzz']

let missingTags = []
console.log('tag claims in the tool description:')
for (const [tag, claim] of TAGS) {
	const text = await call({ tag })
	const n = hitCount(text)
	const mark = n > 0 ? 'OK  ' : 'DEAD'
	if (n === 0) missingTags.push(tag)
	console.log(`  ${mark} tag=${tag.padEnd(10)} ${String(n).padStart(4)} 条   (${claim})`)
}

console.log('\ncategory claims:')
let missingCategories = []
for (const category of CATEGORIES) {
	const n = hitCount(await call({ category }))
	const mark = n > 0 ? 'OK  ' : 'DEAD'
	if (n === 0) missingCategories.push(category)
	console.log(`  ${mark} category=${category.padEnd(10)} ${String(n).padStart(4)} 条`)
}

// The description also names concrete big tables for the dir category.
console.log('\nnamed lookup examples (keyword search):')
for (const keyword of ['dirsearch', 'raft', 'top7000']) {
	const n = hitCount(await call({ keyword }))
	console.log(`  ${n > 0 ? 'OK  ' : 'DEAD'} keyword=${keyword.padEnd(10)} ${String(n).padStart(4)} 条`)
}

console.log('')
if (missingTags.length || missingCategories.length) {
	console.error(`description references dead filters — tags: [${missingTags.join(', ')}] `
		+ `categories: [${missingCategories.join(', ')}]`)
	process.exit(1)
}
console.log('every tag/category named in the tool description returns results ✓')
