/**
 * dsh-plugin-dictdb — host half.
 *
 * Registers three READ-ONLY tools backed by the local `dictdb` CLI (a
 * pure-stdlib Python wordlist manager):
 *
 *   dictdb_search — find dictionaries, return absolute paths for ffuf/dirsearch
 *   dictdb_show   — preview a dictionary's contents (bounded)
 *   dictdb_info   — full metadata for one entry
 *
 * Write operations (add / update / delete / git pull) are deliberately NOT
 * exposed: `link`-mode entries can mutate the user's original files. Humans
 * keep those commands.
 *
 * ── Why a subprocess and not a reimplementation ────────────────────────────
 * dictdb already owns the field projection, the selector syntax and the JSON
 * envelope. Re-deriving that here would silently drift from the Python side
 * (stale results, no error). The subprocess boundary keeps one source of truth.
 *
 * ── Why stdio is redirected to files instead of piped ──────────────────────
 * Under the confined sandbox a child process cannot open named pipes, so
 * `spawn(..., { stdio: 'pipe' })` fails with EPERM before the child even
 * starts. Verified empirically — see scripts/probe-stdio.mjs. Redirecting
 * stdout/stderr to temp files works in every sandbox mode.
 */
import { spawn } from 'node:child_process'
import {
	mkdtempSync, openSync, closeSync, readFileSync, rmSync, existsSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dictdb'
export const inject = ['tools']

/**
 * Single source for both the schema defaults and the runtime fallback below.
 * Every field has a default, so an empty config is valid.
 *
 * No machine-specific path is baked in: `dictdbPath` defaults to empty and is
 * resolved from the environment instead (see resolveDictdbPath). A hardcoded
 * default would be wrong on every machine but the author's.
 */
const DEFAULTS = {
	/**
	 * dictdb project root — the directory containing the `dictdb/` package.
	 * Empty = resolve from DICTDB_PATH, then DICTDB_HOME.
	 */
	dictdbPath: '',
	/** Explicit interpreter. Empty = auto-detect, then fall back to PATH. */
	pythonPath: '',
	/** dictdb data root (DICTDB_HOME). Empty = DICTDB_HOME env, then dictdbPath. */
	dataHome: '',
	/** Hard ceiling for one dictdb invocation. */
	timeoutMs: 30000,
	/** Rows returned by dictdb_show when the model does not ask for a count. */
	defaultHead: 20,
	/** Absolute ceiling for dictdb_show's head, enforced plugin-side. */
	maxHead: 200,
}

export const Config = Schema.object({
	dictdbPath: Schema.string().default(DEFAULTS.dictdbPath),
	pythonPath: Schema.string().default(DEFAULTS.pythonPath),
	dataHome: Schema.string().default(DEFAULTS.dataHome),
	timeoutMs: Schema.number().default(DEFAULTS.timeoutMs),
	defaultHead: Schema.number().default(DEFAULTS.defaultHead),
	maxHead: Schema.number().default(DEFAULTS.maxHead),
})

// ───────────────────────────── configuration ─────────────────────────────

/**
 * Locate the dictdb project root.
 *
 * Order: explicit config, then DICTDB_PATH, then DICTDB_HOME. The last one is
 * dictdb's own data-root variable and in its default single-directory layout it
 * points at the project root as well, so an existing dictdb user usually needs
 * no plugin config at all.
 *
 * @returns {string|null} the resolved path, or null when nothing is set.
 */
function resolveDictdbPath(cfg) {
	return cfg.dictdbPath || process.env.DICTDB_PATH || process.env.DICTDB_HOME || null
}

/**
 * Resolve configuration or fail with an actionable message.
 *
 * These are deployment faults, not model mistakes, so they throw: the harness
 * marks the call as failed and the human who can actually fix it sees the exact
 * remedy, instead of the model burning turns retrying a misconfiguration.
 */
function requireDictdbPath(cfg) {
	const path = resolveDictdbPath(cfg)
	if (!path) {
		throw new Error(
			'dictdb 插件尚未配置：找不到 dictdb 项目根目录。'
			+ '请在 profile 的 cordis.patch.yml 中设置 config.dictdbPath，'
			+ '或设置 DICTDB_PATH / DICTDB_HOME 环境变量。',
		)
	}
	if (!existsSync(path)) {
		throw new Error(`dictdb 插件配置有误：dictdbPath 不存在 —— ${path}`)
	}
	return path
}

// ───────────────────────────── interpreter ─────────────────────────────

function resolvePython(cfg, dictdbPath) {
	if (cfg.pythonPath) return cfg.pythonPath
	const onWindows = process.platform === 'win32'
	const candidates = onWindows
		? [join(dictdbPath, '.venv', 'Scripts', 'python.exe')]
		: [join(dictdbPath, '.venv', 'bin', 'python')]
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate
	}
	return onWindows ? 'python' : 'python3'
}

// ───────────────────────────── subprocess ─────────────────────────────

function abortError() {
	const error = new Error('dictdb: 调用已取消')
	error.name = 'AbortError'
	return error
}

function tail(text, limit = 600) {
	const trimmed = String(text).trim()
	return trimmed.length > limit ? `…${trimmed.slice(-limit)}` : trimmed
}

/**
 * Run `python -m dictdb <args> --json` and parse the envelope.
 *
 * Resolves for BOTH ok:true and ok:false envelopes — a domain failure such as
 * NOT_FOUND is data the model should see and react to, not an infrastructure
 * fault. Rejects only when the subprocess could not produce a usable envelope
 * (spawn failure, timeout, abort, unparseable output).
 *
 * @returns {Promise<{ envelope: object, exitCode: number|null, stderr: string }>}
 */
function runDictdb(cfg, args, signal) {
	return new Promise((resolve, reject) => {
		let dictdbPath
		try {
			dictdbPath = requireDictdbPath(cfg)
		} catch (error) {
			reject(error)
			return
		}

		const python = resolvePython(cfg, dictdbPath)
		const dataHome = cfg.dataHome || process.env.DICTDB_HOME || dictdbPath

		let dir
		try {
			dir = mkdtempSync(join(tmpdir(), 'dsh-dictdb-'))
		} catch (error) {
			reject(new Error(`dictdb: 无法创建临时目录：${error?.message ?? error}`))
			return
		}

		const outPath = join(dir, 'stdout.json')
		const errPath = join(dir, 'stderr.txt')
		const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } }

		let outFd
		let errFd
		try {
			outFd = openSync(outPath, 'w')
			errFd = openSync(errPath, 'w')
		} catch (error) {
			cleanup()
			reject(new Error(`dictdb: 无法创建输出文件：${error?.message ?? error}`))
			return
		}

		let child
		try {
			child = spawn(python, ['-m', 'dictdb', ...args, '--json'], {
				cwd: dictdbPath,
				env: {
					...process.env,
					DICTDB_HOME: dataHome,
					DICTDB_LANG: 'en',
					PYTHONIOENCODING: 'utf-8',
				},
				// NOT 'pipe' — see the file header. 'ignore' for stdin also makes
				// the child non-interactive, so it can never block on a confirm.
				stdio: ['ignore', outFd, errFd],
				windowsHide: true,
			})
		} catch (error) {
			closeSync(outFd)
			closeSync(errFd)
			cleanup()
			reject(new Error(`dictdb: 无法启动解释器 ${python}：${error?.message ?? error}`))
			return
		}

		// The child holds its own handles; the parent's copies are no longer needed.
		closeSync(outFd)
		closeSync(errFd)

		let settled = false
		let timedOut = false
		let timer
		const onAbort = () => { try { child.kill() } catch { /* already gone */ } }

		const finish = (settle, value) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			if (signal) signal.removeEventListener('abort', onAbort)
			cleanup()
			settle(value)
		}

		timer = setTimeout(() => { timedOut = true; onAbort() }, cfg.timeoutMs)
		if (signal) {
			if (signal.aborted) onAbort()
			else signal.addEventListener('abort', onAbort, { once: true })
		}

		child.on('error', (error) => {
			finish(reject, new Error(`dictdb: 解释器启动失败（${python}）：${error?.message ?? error}`))
		})

		child.on('close', (exitCode) => {
			if (signal?.aborted) { finish(reject, abortError()); return }
			if (timedOut) {
				finish(reject, new Error(`dictdb: 调用超时（${cfg.timeoutMs}ms）：dictdb ${args.join(' ')}`))
				return
			}

			let stdout = ''
			let stderr = ''
			try { stdout = readFileSync(outPath, 'utf8') } catch { /* missing */ }
			try { stderr = readFileSync(errPath, 'utf8') } catch { /* missing */ }

			if (!stdout.trim()) {
				const detail = stderr.trim() ? `：${tail(stderr)}` : ''
				finish(reject, new Error(`dictdb: 无输出（exit=${exitCode}）${detail}`))
				return
			}

			let envelope
			try {
				envelope = JSON.parse(stdout)
			} catch (error) {
				finish(reject, new Error(
					`dictdb: 输出不是合法 JSON（exit=${exitCode}）：${error?.message ?? error}\n${tail(stdout)}`))
				return
			}

			finish(resolve, { envelope, exitCode, stderr })
		})
	})
}

// ───────────────────────────── formatting ─────────────────────────────

/**
 * Domain-level failure rendered for the model. Never thrown — see runDictdb.
 */
function renderEnvelopeError(envelope, command) {
	const code = envelope.error?.code ?? 'UNKNOWN'
	const message = envelope.error?.message ?? '（无错误信息）'
	const hint = code === 'NOT_FOUND'
		? '\n提示：该 id / @序号 不存在。先用 dictdb_search 取得有效条目。'
		: code === 'VALIDATION'
			? '\n提示：参数不合法，请修正后重试。'
			: ''
	return `dictdb ${command} 失败：[${code}] ${message}${hint}`
}

function renderSearch(envelope) {
	const items = Array.isArray(envelope.data) ? envelope.data : []
	if (items.length === 0) {
		return '没有匹配的字典。\n'
			+ '提示：放宽条件重试 —— 去掉 tag/category 只留关键词，或换用 category=dir|password|username|subdomain|param|api|fuzz。'
	}

	const lines = items.map((item) => {
		const tags = Array.isArray(item.tags) && item.tags.length ? item.tags.join(',') : '-'
		const instructions = item.instructions ? String(item.instructions) : '-'
		return `[${item.index ?? '-'}] id=${item.id} | ${item.name} | ${item.category || '-'} | 标签:${tags} | ${item.lines ?? '?'}行 | ${instructions}\n    路径: ${item.path}`
	})

	return `${items.length} 条结果：\n\n${lines.join('\n')}\n\n`
		+ '取「路径」直接作为 ffuf / dirsearch / hydra 的 -w 参数。'
		+ '后续可用 @序号 引用（如 dictdb_show target="@1"）。'
}

/**
 * @param {object} envelope
 * @param {boolean} callerChoseWindow
 *   Whether the model asked for a specific range (head) or filter (grep).
 *   The plugin ALWAYS passes `--head` — see execute() — so dictdb's own
 *   `default_limited` flag stays false and cannot be the only signal. Without
 *   this the model reads a 20-row preview as the whole dictionary.
 */
function renderShow(envelope, callerChoseWindow) {
	const data = envelope.data
	if (!data || typeof data !== 'object') return 'dictdb show 未返回内容。'

	const rows = Array.isArray(data.lines) ? data.lines : []
	const body = rows.map(row => `${String(row.n).padStart(8)}: ${row.text}`).join('\n')
	const parts = [`字典 [${data.id}] ${data.name}（共 ${data.total_lines} 行）\n路径: ${data.path}\n`]

	const defaultWindow = data.default_limited === true || callerChoseWindow !== true
	if (defaultWindow) {
		parts.push(`（以下为默认前 ${rows.length} 行，并非完整内容。）`)
	}
	parts.push('', body)

	if (defaultWindow) {
		parts.push('', '提示：需要更多内容时用 head 参数指定行数（上限受配置限制），或用 grep 参数做关键词过滤。')
	} else if (data.truncated) {
		parts.push('', '提示：grep 结果已截断，请用更精确的关键词缩小范围。')
	}
	return parts.join('\n')
}

function renderInfo(envelope) {
	const rec = envelope.data
	if (!rec || typeof rec !== 'object') return 'dictdb info 未返回内容。'

	const lines = [
		`id=${rec.id}  名称=${rec.name}`,
		`分类=${rec.category || '-'}  标签=${Array.isArray(rec.tags) && rec.tags.length ? rec.tags.join(',') : '-'}`,
		`说明=${rec.instructions || '-'}`,
		`来源=${rec.source || '-'}`,
		`存储模式=${rec.storage_mode}  行数=${rec.lines}  大小=${rec.size} 字节`,
		`路径=${rec.path}`,
	]
	if (rec.original_path) lines.push(`原始路径=${rec.original_path}`)
	if (rec.md5) lines.push(`md5=${rec.md5}`)
	if (rec.git) {
		lines.push(`git=${rec.git.url ?? '-'} @ ${rec.git.branch || '-'} ${String(rec.git.commit ?? '').slice(0, 8)}`)
	}
	lines.push(`创建=${rec.created_at}  更新=${rec.updated_at}`)
	return lines.join('\n')
}

// ───────────────────────────── tools ─────────────────────────────

const SEARCH_DESCRIPTION = `检索本地渗透测试字典库（wordlist），返回可直接使用的绝对路径。

选字典依据：
- category: dir(目录爆破) / password(密码) / username(用户名) / subdomain(子域) / param(参数) / api(接口) / fuzz(模糊测试)
- 常用 tag: fast(Top1000级快速版) / classic(经典必备) / service(66个服务弱口令对) / device(安全设备默认凭据) / 403bypass / upload / jwt / chinese / company

按场景：
- 目录爆破主力 → category=dir（含 dirsearch、raft-large、top7000 等大表）
- 子域枚举 → category=subdomain；公司资产相关加 tag=company
- 密码爆破 → category=password；快速验证加 tag=fast
- 服务弱口令 → tag=service（MySQL/SSH/RDP/SMB 等，user/pass 成对）
- 安全设备 → tag=device（深信服/天融信/H3C/山石等默认凭据）
- 403 绕过 → tag=403bypass

返回中的「路径」是绝对路径，直接作为 ffuf / dirsearch / hydra 的 -w 参数。
无法确定用哪个时，先按 category 列出来再选规模合适的，不要凭名字猜。`

export function apply(ctx, config) {
	// The loader validates through Config and fills schema defaults, so config
	// normally arrives complete. Merging here anyway because the failure mode of
	// a missing field is silent and ugly: an undefined dictdbPath becomes a wrong
	// cwd, and an undefined defaultHead becomes `--head NaN`.
	const cfg = { ...DEFAULTS, ...(config ?? {}) }

	ctx.tools.register(defineTool({
		name: 'dictdb_search',
		description: SEARCH_DESCRIPTION,
		parameters: {
			category: {
				type: 'string',
				description: '分类过滤：dir | password | username | subdomain | param | api | fuzz | other。中文别名（目录/密码/子域等）会被自动转换。',
			},
			tag: {
				type: 'string',
				description: '单个标签过滤，如 fast、service、403bypass、device、classic。',
			},
			keyword: {
				type: 'string',
				description: '对名称/说明/来源/分类/标签做模糊匹配；多个关键词用空格分隔，按 AND 组合。',
			},
		},
		output: {
			schema: { type: 'string' },
			render: (_args, value) => [{ type: 'text', text: value }],
		},
		async execute(args, exec) {
			const argv = ['select']
			if (args.keyword) argv.push(String(args.keyword))
			if (args.category) argv.push('--category', String(args.category))
			if (args.tag) argv.push('--tag', String(args.tag))

			const { envelope } = await runDictdb(cfg, argv, exec?.signal)
			if (envelope.ok !== true) return renderEnvelopeError(envelope, 'select')
			return renderSearch(envelope)
		},
	}))

	ctx.tools.register(defineTool({
		name: 'dictdb_show',
		description: `查看某条字典的实际内容，用于确认它是否符合当前任务需求。

默认只返回前若干行（由配置决定，通常 20），以免超大字典撑爆上下文。需要更多时用 head 指定行数；想找特定条目用 grep 过滤，比拉大段内容更省。

target 用 dictdb_search 返回的 id（写 "7"）或序号（写 "@1"）。`,
		parameters: {
			target: {
				type: 'string',
				required: true,
				description: '主键 id（如 "7"）或最近一次搜索的序号（如 "@1"）。',
			},
			head: {
				type: 'number',
				description: '返回前 N 行。省略则用配置默认值；上限由配置强制（通常 200）。',
			},
			grep: {
				type: 'string',
				description: '大小写不敏感的关键词过滤，只返回匹配行。',
			},
		},
		output: {
			schema: { type: 'string' },
			render: (_args, value) => [{ type: 'text', text: value }],
		},
		async execute(args, exec) {
			const target = String(args.target ?? '').trim()
			if (!target) return 'dictdb_show 需要 target 参数：主键 id 或 @序号。'

			// Two independent bounds, both required:
			//   1. dictdb's own default window, for the case where we pass nothing;
			//   2. this clamp, which is the only thing that can stop an explicit
			//      head=999999 (dictdb's default cannot).
			// We ALWAYS pass --head rather than leaning on dictdb's default: an
			// older dictdb without that default would dump the entire file, and
			// dictionaries here reach hundreds of thousands of lines.
			const callerChoseWindow = Number.isFinite(args.head) || Boolean(args.grep)
			const requested = Number.isFinite(args.head) ? Math.floor(args.head) : cfg.defaultHead
			const head = Math.max(1, Math.min(requested, cfg.maxHead))

			const argv = ['show', target, '--head', String(head)]
			if (args.grep) argv.push('--grep', String(args.grep))

			const { envelope } = await runDictdb(cfg, argv, exec?.signal)
			if (envelope.ok !== true) return renderEnvelopeError(envelope, 'show')
			return renderShow(envelope, callerChoseWindow)
		},
	}))

	ctx.tools.register(defineTool({
		name: 'dictdb_info',
		description: `查看某条字典的完整元数据：全文说明、来源 URL、git 版本锚点、md5、原始路径、时间戳。

dictdb_search 返回的说明会被截断到约 50 字；当那条说明看起来相关但不足以判断，或需要来源/版本信息时，用这个工具取全文。`,
		parameters: {
			target: {
				type: 'string',
				required: true,
				description: '主键 id（如 "7"）或最近一次搜索的序号（如 "@1"）。',
			},
		},
		output: {
			schema: { type: 'string' },
			render: (_args, value) => [{ type: 'text', text: value }],
		},
		async execute(args, exec) {
			const target = String(args.target ?? '').trim()
			if (!target) return 'dictdb_info 需要 target 参数：主键 id 或 @序号。'

			const { envelope } = await runDictdb(cfg, ['info', target], exec?.signal)
			if (envelope.ok !== true) return renderEnvelopeError(envelope, 'info')
			return renderInfo(envelope)
		},
	}))
}
