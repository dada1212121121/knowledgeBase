// AI 修改 / 读取的规则(直接在真实引擎的副本上跑)
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { openReplica } from '../src/engines.mjs'
import { agentEdit, agentRead } from '../src/agent.mjs'

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)))
const open = (format, name) => openReplica(format, fixture(name), { clientId: 4242, generation: 'kb:test' })

test('xlsx:按格子里存的值替换,数字照样解析成数字;同一格改两次、找不到都整批不改', async () => {
  const replica = await open('xlsx', 'sheet.xlsx')
  assert.equal(await agentEdit(replica, [{ old: '6379', new: '7379' }, { old: 'DEMO2026010043', new: 'PRJ-43' }]), 2)
  const text = agentRead(replica)
  assert.match(text, /A4=7379\t/)
  assert.match(text, /B3=PRJ-43\t/)
  // 只核对:能定位就返回处数,但不改
  assert.equal(await agentEdit(replica, [{ old: 'DEMO2026010047', new: 'z' }], 'AI', { dry: true }), 1)
  assert.match(agentRead(replica), /B7=DEMO2026010047\t/)
  await assert.rejects(agentEdit(replica, [{ old: 'DEMO2026010045', new: 'a' }, { old: '6010045', new: 'b' }]), /同一个格子/)
  await assert.rejects(agentEdit(replica, [{ old: 'DEMO2026010046', new: 'x' }, { old: '不存在', new: 'y' }]), /没找到/)
  assert.match(agentRead(replica), /B6=DEMO2026010046\t/, '整批没改')
  // 不唯一(C、D 两列都有「示例项目04」):不改
  await assert.rejects(agentEdit(replica, [{ old: '示例项目04', new: 'x' }]), /2 处/)
  // 公式格子不能按文字替换(读出来写成 `A5==公式`)
  assert.equal(await agentEdit(replica, [{ old: '6380', new: '=1000*7' }]), 1)
  assert.match(agentRead(replica), /A5==1000\*7\t/)
  await assert.rejects(agentEdit(replica, [{ old: '7000', new: '8000' }]), /是公式/)
})

test('docx / pptx:原文要唯一;读出来的文本能直接拿来当原文', async () => {
  for (const [format, name] of [['docx', 'small.docx'], ['pptx', 'deck.pptx']]) {
    const replica = await open(format, name)
    const lines = agentRead(replica).split('\n').filter((line) => line.length > 6 && !line.startsWith('## '))
    const target = lines.find((line) => agentRead(replica).split(line).length === 2)
    assert.ok(target, `${format} 有唯一的一段`)
    assert.equal(await agentEdit(replica, [{ old: target, new: `${target}(改)` }]), 1)
    assert.ok(agentRead(replica).includes(`${target}(改)`))
    await assert.rejects(agentEdit(replica, [{ old: '', new: 'x' }]), /不能为空/)
    // 不唯一:docx 里「命令」出现在好几段,pptx 里「批次」出现在三段
    await assert.rejects(agentEdit(replica, [{ old: format === 'docx' ? '命令' : '批次', new: 'x' }]), /处,不知道改哪一处/)
  }
})
