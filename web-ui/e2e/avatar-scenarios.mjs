// 多人编辑的头像:有上传头像的同事显示他的照片,没有的显示首字母,游客统一用固定的游客头像;
// 没头像的人不会产生图片请求(也就没有 404 刷控制台)。由 viewer-shots.mjs 引入。
// 回归自真机反馈:协作头像永远只画首字母,没取用户上传的头像。
import { BOB, GREEN, collabFixture, roomOf, startEditing, waitStatus } from './collab-scenarios.mjs'

const COLLECTION = 'knowledgeBase%2Finsights'
const DOC = `/kb?collection=${COLLECTION}&item=ins_8f21`
const GUEST = { id: 'guest:访客1234#7', name: '访客1234' }

export const AVATAR_SCENARIOS = {
  'collab-avatar-photos': {
    // Green 有上传的头像,Bob 没有,还有一个游客
    route: DOC,
    ready: '[data-testid=doc-share]',
    fixture: { ...collabFixture(), __userAvatars: { [GREEN.id]: `${GREEN.id}-photo.png` } },
    settle: 500,
    assert: async (tab) => {
      const issues = []
      await startEditing(tab)
      await waitStatus(tab, 'synced')
      const room = roomOf(tab)
      room.addPeer(GREEN, { cursor: { at: 2 } })
      room.addPeer(BOB)
      room.addPeer(GUEST)
      await tab.locator('[data-testid=collab-peers] [data-peer]').nth(3).waitFor({ timeout: 8000 }).catch(() => issues.push('头像堆里应有 4 个人(我 + Green + Bob + 游客)'))
      // 头像是先批量问清、再给有头像的人取图的,等图片请求落地
      await tab.waitForTimeout(800)

      const cells = await tab.evaluate(() =>
        [...document.querySelectorAll('[data-testid=collab-peers] [data-peer]')].map((el) => ({
          id: el.getAttribute('data-peer'),
          img: el.querySelector('img')?.getAttribute('src') ?? null,
          initial: el.querySelector('.kb-avatar-initial')?.textContent ?? null,
          guest: !!el.querySelector('[data-testid=avatar-guest]'),
        })),
      )
      const by = Object.fromEntries(cells.map((cell) => [cell.id, cell]))
      if (!by[GREEN.id]?.img?.startsWith(`/api/v1/users/${GREEN.id}/avatar?v=${GREEN.id}-photo.png`)) issues.push(`Green 应显示他上传的头像(带文件名作版本),实际 ${JSON.stringify(by[GREEN.id])}`)
      if (by[BOB.id]?.img || !by[BOB.id]?.initial) issues.push(`Bob 没有头像,应画首字母,实际 ${JSON.stringify(by[BOB.id])}`)
      if (!by[GUEST.id]?.guest || by[GUEST.id]?.img || by[GUEST.id]?.initial) issues.push(`游客应画固定的游客头像,实际 ${JSON.stringify(by[GUEST.id])}`)

      // 请求记录:查头像只发一次批量请求,不含游客;没头像的人没有图片请求(没有 404)
      const log = await tab.evaluate(() => fetch('/api/v1/__fixture/avatar-log').then((response) => response.json()).then((body) => body.data.log))
      const batches = log.filter((entry) => entry.kind === 'batch')
      const images = log.filter((entry) => entry.kind === 'image')
      if (!batches.length) issues.push('应先批量问谁有头像')
      if (batches.some((entry) => entry.ids.some((id) => id.startsWith('guest:')))) issues.push('游客没有头像,不该出现在批量查询里')
      const failed = images.filter((entry) => entry.status !== 200)
      if (failed.length) issues.push(`不该请求没有头像的人的图片(会刷 404):${failed.map((entry) => entry.id).join('、')}`)
      if (!images.some((entry) => entry.id === GREEN.id && entry.status === 200)) issues.push('Green 的头像图片应该被取到')

      // 点开「正在编辑」名单:同样的头像
      await tab.locator('[data-testid=collab-stack] button').first().click()
      await tab.waitForSelector('[data-testid=collab-list]', { timeout: 5000 }).catch(() => issues.push('点开头像堆应出现「正在编辑」名单'))
      const listed = await tab.evaluate(() =>
        [...document.querySelectorAll('[data-testid=collab-list] [data-peer]')].map((el) => ({
          id: el.getAttribute('data-peer'),
          img: !!el.querySelector('img'),
          guest: !!el.querySelector('[data-testid=avatar-guest]'),
        })),
      )
      const row = (id) => listed.find((entry) => entry.id === id)
      if (!row(GREEN.id)?.img) issues.push('名单里 Green 也应显示头像图片')
      if (!row(GUEST.id)?.guest) issues.push('名单里游客也应是固定的游客头像')
      return issues
    },
  },
}
