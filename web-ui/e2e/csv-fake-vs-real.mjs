#!/usr/bin/env node
// 假服务端 vs 真实守护进程的差分验证。
//
// e2e 里的 CSV 门禁用 csv-server-fake.mjs 代替服务端,它「逐字节往返」的结论只有在假服务端的行为和
// crates/kb-extract/src/csv_edit.rs 一致时才成立。这个脚本把同一份字节、同一组操作分别交给真实守护进程的
// csv_read / csv_edit 和假服务端,逐项比对:读到的行 / 列数 / 格式 / 哈希、写回的字节、是否拒绝、是否改动。
// 改了假服务端或服务端的 CSV 编辑逻辑后跑一遍。
//
// 需要一个正在运行的真实守护进程(任何带 csv_read / csv_edit 的构建都行):
//   KB_BASE=http://127.0.0.1:18999            守护进程地址
//   KB_PASSWORD=...                           Web 登录密码(kb auth set-password 设的)
//   KB_COLLECTION=proj_proj                   一个项目 collection 的名字
//   KB_DIR=/path/to/project/root              这个 collection 对应的项目根目录(脚本会在里面写测试文件,跑完恢复)
// 用法:node e2e/csv-fake-vs-real.mjs
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { FakeCsvServer } from './csv-server-fake.mjs'
import { CSV_FILES } from './csv-fixtures.mjs'

const BASE = process.env.KB_BASE
const PASSWORD = process.env.KB_PASSWORD
const COLLECTION = process.env.KB_COLLECTION
const DIR = process.env.KB_DIR
if (!BASE || !PASSWORD || !COLLECTION || !DIR) {
  console.error('缺少 KB_BASE / KB_PASSWORD / KB_COLLECTION / KB_DIR(见文件头说明)')
  process.exit(2)
}
// 夹具文件:五种编码各一份 + 末行没有换行的小文件
const FILES = ['file_csv_gbk', 'file_csv_gb18030', 'file_csv_u16le', 'file_csv_u16be', 'file_csv_bom'].map((id) => CSV_FILES[id].path).concat('评测明细.csv')
for (const id of ['file_csv_gbk', 'file_csv_gb18030', 'file_csv_u16le', 'file_csv_u16be', 'file_csv_bom']) writeFileSync(`${DIR}/${CSV_FILES[id].path}`, CSV_FILES[id].make())
writeFileSync(`${DIR}/评测明细.csv`, '编号,查询,命中名次,耗时(ms)\nq001,"UDS 断线, 第 1 次",1,40\nq002,"UDS 断线, 第 2 次",2,53\nq003,x,3,66')
let cookie = ''
{
  const res = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) })
  cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
  assert.ok(res.ok, `login ${res.status}`)
}
async function call(name, args) {
  const res = await fetch(`${BASE}/api/v1/capabilities/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kb-csrf': '1', cookie }, body: JSON.stringify(args) })
  const body = await res.json()
  return { status: res.status, ok: body.ok, data: body.data, error: body.error }
}
const OPSETS = {
  '改一格': [{ op: 'set_cell', row: 1, col: 3, value: '改了' }],
  '改一格(含逗号和引号)': [{ op: 'set_cell', row: 2, col: 1, value: '含,逗号 和 "引号"' }],
  '补列': [{ op: 'set_cell', row: 1, col: 6, value: '远' }],
  '删中间一行': [{ op: 'delete_row', row: 2 }],
  '删最后一行': [{ op: 'delete_row', row: 40 }],
  '删首尾': [{ op: 'delete_row', row: 0 }, { op: 'delete_row', row: 40 }],
  '删最后两行': [{ op: 'delete_row', row: 39 }, { op: 'delete_row', row: 40 }],
  '插在最前': [{ op: 'insert_row', at: 0, values: ['新', '头'] }],
  '插在中间(两条同位置)': [{ op: 'insert_row', at: 2, values: ['甲'] }, { op: 'insert_row', at: 2, values: ['乙', ''] }],
  '加在最后': [{ op: 'insert_row', at: 41, values: ['末', '尾', ''] }],
  '组合': [{ op: 'set_cell', row: 5, col: 0, value: 'Q5' }, { op: 'delete_row', row: 6 }, { op: 'insert_row', at: 7, values: ['插'] }, { op: 'insert_row', at: 41, values: ['最后'] }],
  '删光再没东西可插(删全部)': Array.from({ length: 41 }, (_, row) => ({ op: 'delete_row', row })),
  '空操作': [],
  '改成一样的值': [{ op: 'set_cell', row: 1, col: 0, value: 'q001' }],
  '含 NUL(应拒绝)': [{ op: 'set_cell', row: 1, col: 0, value: 'a\0b' }],
  '行越界(应拒绝)': [{ op: 'set_cell', row: 99, col: 0, value: 'x' }],
  '改又删(应拒绝)': [{ op: 'set_cell', row: 1, col: 0, value: 'x' }, { op: 'delete_row', row: 1 }],
}
let checks = 0
const fake = new FakeCsvServer()
for (const file of FILES) {
  const original = readFileSync(`${DIR}/${file}`)
  // 读:第一页的内容、格式、列数、行数
  const real = await call('csv_read', { collection: COLLECTION, path: file, offset: 0, limit: 60 })
  assert.ok(real.ok, `${file} csv_read: ${JSON.stringify(real.error)}`)
  fake.addFile(file, original)
  const mine = fake.read({ path: file, offset: 0, limit: 60 })
  for (const key of ['total_rows', 'columns', 'rows', 'offset', 'format']) assert.deepEqual(mine[key], real.data[key], `${file} 读 ${key}`)
  assert.equal(mine.sha256, real.data.sha256, `${file} sha256`)
  checks += 6
  for (const [name, ops] of Object.entries(OPSETS)) {
    const noOps = file === '评测明细.csv' && !['空操作', '改成一样的值'].includes(name) && ops.some((o) => (o.row ?? 0) > 2 || (o.at ?? 0) > 3)
    if (noOps) continue // 小文件只有 4 行,大行号的用例换成专用用例
    writeFileSync(`${DIR}/${file}`, original)
    const before = await call('csv_read', { collection: COLLECTION, path: file, offset: 0, limit: 1 })
    const realRes = await call('csv_edit', { collection: COLLECTION, path: file, ops, expected_version: before.data.version, expected_sha256: before.data.sha256 })
    const realBytes = readFileSync(`${DIR}/${file}`)
    fake.addFile(file, original)
    let fakeRes
    try {
      fakeRes = { ok: true, data: fake.edit({ path: file, ops, expected_version: 1, expected_sha256: fake.files.get(file).sha256 }) }
    } catch (error) {
      fakeRes = { ok: false, error }
    }
    assert.equal(fakeRes.ok, realRes.ok, `${file} / ${name}:成功与否不同(真:${JSON.stringify(realRes.error)},假:${fakeRes.error?.message})`)
    if (realRes.ok) {
      assert.ok(fake.bytes(file).equals(realBytes), `${file} / ${name}:写回的字节不同`)
      assert.equal(fakeRes.data.changed, realRes.data.changed, `${file} / ${name}:changed 不同`)
    } else {
      assert.ok(readFileSync(`${DIR}/${file}`).equals(original), `${file} / ${name}:被拒绝却改了文件`)
    }
    checks += 3
  }
}
// 小文件(4 行,最后一行无换行)专用用例
for (const [name, ops] of Object.entries({
  '删最后一行(无结尾换行)': [{ op: 'delete_row', row: 3 }],
  '加在最后(无结尾换行)': [{ op: 'insert_row', at: 4, values: ['z', 'y'] }],
  '末行补列并在后面加一行': [{ op: 'set_cell', row: 3, col: 5, value: 'e' }, { op: 'insert_row', at: 4, values: ['w'] }],
  '删光': [0, 1, 2, 3].map((row) => ({ op: 'delete_row', row })),
  '删后两行': [{ op: 'delete_row', row: 2 }, { op: 'delete_row', row: 3 }],
})) {
  const file = '评测明细.csv'
  const original = readFileSync(`${DIR}/${file}`)
  const before = await call('csv_read', { collection: COLLECTION, path: file, offset: 0, limit: 1 })
  const realRes = await call('csv_edit', { collection: COLLECTION, path: file, ops, expected_version: before.data.version, expected_sha256: before.data.sha256 })
  const realBytes = readFileSync(`${DIR}/${file}`)
  fake.addFile(file, original)
  const fakeRes = fake.edit({ path: file, ops, expected_version: 1, expected_sha256: fake.files.get(file).sha256 })
  assert.ok(realRes.ok, JSON.stringify(realRes.error))
  assert.ok(fake.bytes(file).equals(realBytes), `${name}:写回的字节不同\n真:${JSON.stringify(realBytes.toString())}\n假:${JSON.stringify(fake.bytes(file).toString())}`)
  assert.equal(fakeRes.changed, realRes.data.changed)
  writeFileSync(`${DIR}/${file}`, original)
  checks += 2
}
// 乐观锁的错误形状
{
  const file = '评测明细-gbk.csv'
  const original = readFileSync(`${DIR}/${file}`)
  const before = await call('csv_read', { collection: COLLECTION, path: file, offset: 0, limit: 1 })
  const wrongVersion = await call('csv_edit', { collection: COLLECTION, path: file, ops: [{ op: 'set_cell', row: 1, col: 0, value: 'x' }], expected_version: before.data.version + 5, expected_sha256: before.data.sha256 })
  console.log('版本不对 →', wrongVersion.status, JSON.stringify(wrongVersion.error))
  assert.equal(wrongVersion.status, 409)
  assert.equal(wrongVersion.error.code, 'conflict')
  const wrongSha = await call('csv_edit', { collection: COLLECTION, path: file, ops: [{ op: 'set_cell', row: 1, col: 0, value: 'x' }], expected_version: before.data.version, expected_sha256: 'deadbeef' })
  console.log('哈希不对 →', wrongSha.status, JSON.stringify(wrongSha.error))
  assert.equal(wrongSha.status, 400)
  // 前端 utils/csvRemoteBackend.ts 靠这句话把它当成乐观锁冲突
  assert.ok(wrongSha.error.message.includes('在你打开之后已被改动'))
  assert.ok(readFileSync(`${DIR}/${file}`).equals(original))
}
console.log(`✓ 真实 Rust 服务端与假服务端一致:${checks} 项比对全部通过`)
