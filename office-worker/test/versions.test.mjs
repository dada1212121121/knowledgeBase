// 服务端副本和浏览器必须是同一版本的引擎:CRDT 的结构、初始状态的生成规则只在同一版本之间保证一致。
// 升级引擎时 web-ui 和这里要一起升,这条测试保证不会只升了一边。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const lock = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')).packages

test('office-worker 与 web-ui 锁定的引擎版本完全一致', () => {
  const worker = lock('../package-lock.json')
  const web = lock('../../web-ui/package-lock.json')
  for (const name of ['xlsx', 'pptx', 'docx']) {
    const key = `node_modules/@betteroffice/${name}`
    assert.ok(worker[key]?.version, `office-worker 锁定了 ${key}`)
    assert.equal(worker[key].version, web[key]?.version, `${key}:office-worker ${worker[key].version} ≠ web-ui ${web[key]?.version}`)
    assert.equal(worker[key].integrity, web[key].integrity, `${key} 的包内容一致`)
  }
})
