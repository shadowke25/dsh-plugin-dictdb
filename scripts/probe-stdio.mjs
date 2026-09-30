/**
 * 验证子进程 stdio 行为：这是插件方案最大的技术风险点。
 *
 * 背景：受限沙箱下，Node 的 child_process 用默认 stdio:'pipe' 捕获输出
 * 预期会 EPERM（命名管道不可用）。本脚本实测确认，并验证替代方案。
 */
import { spawn } from 'node:child_process'
import { openSync, closeSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PY = process.argv[2]
if (!PY) { console.error('usage: node probe-stdio.mjs <python-path>'); process.exit(2) }

const CODE = 'import json,sys; print(json.dumps({"ok":True,"msg":"hello"}))'

function runPipe() {
  return new Promise((resolve) => {
    let out = '', err = '', settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    try {
      const p = spawn(PY, ['-c', CODE], { stdio: ['ignore', 'pipe', 'pipe'] })
      p.stdout.on('data', d => out += d)
      p.stderr.on('data', d => err += d)
      p.on('error', e => done({ mode: 'pipe', ok: false, stage: 'error-event', code: e.code, message: e.message }))
      p.on('close', c => done({ mode: 'pipe', ok: c === 0, code: c, len: out.length, stdout: out.slice(0, 80), stderr: err.slice(0, 200) }))
    } catch (e) {
      done({ mode: 'pipe', ok: false, stage: 'throw', code: e.code, message: e.message })
    }
  })
}

function runFile(dir) {
  return new Promise((resolve) => {
    const o = join(dir, 'out.txt'), e = join(dir, 'err.txt')
    let fo, fe
    try {
      fo = openSync(o, 'w'); fe = openSync(e, 'w')
    } catch (ex) {
      return resolve({ mode: 'file', ok: false, stage: 'open', code: ex.code, message: ex.message })
    }
    let settled = false
    const done = (v) => { if (!settled) { settled = true; closeSync(fo); closeSync(fe); resolve(v) } }
    try {
      const p = spawn(PY, ['-c', CODE], { stdio: ['ignore', fo, fe] })
      p.on('error', ex => done({ mode: 'file', ok: false, stage: 'error-event', code: ex.code, message: ex.message }))
      p.on('close', c => {
        let body = '', errBody = ''
        try { body = readFileSync(o, 'utf8') } catch { }
        try { errBody = readFileSync(e, 'utf8') } catch { }
        done({ mode: 'file', ok: c === 0, code: c, stdout: body.slice(0, 80), stderr: errBody.slice(0, 200) })
      })
    } catch (ex) {
      done({ mode: 'file', ok: false, stage: 'throw', code: ex.code, message: ex.message })
    }
  })
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-probe-'))
console.log('python :', PY)
console.log('tmpdir :', dir)
console.log('---')

const r1 = await runPipe()
console.log('PIPE :', JSON.stringify(r1))

const r2 = await runFile(dir)
console.log('FILE :', JSON.stringify(r2))

console.log('---')
console.log('pipe usable :', r1.ok)
console.log('file usable :', r2.ok)

try { rmSync(dir, { recursive: true, force: true }) } catch { }
