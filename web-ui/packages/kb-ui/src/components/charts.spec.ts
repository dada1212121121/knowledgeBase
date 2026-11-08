// 三个图表组件的行为:环形图的图例就是数据表、折线图的键盘与读屏表、横向条的配额线与读屏文字。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import KbDonut from './KbDonut.vue'
import KbHBars from './KbHBars.vue'
import KbLineChart from './KbLineChart.vue'

describe('KbDonut', () => {
  const items = [
    { name: '笔记', value: 30 },
    { name: '原件', value: 60 },
    { name: '其它', value: 10, other: true },
  ]

  it('环是装饰,真实数据在图例里:每行名字、数值、占比', () => {
    const wrapper = mount(KbDonut, { props: { items, label: '存储构成' } })
    expect(wrapper.find('svg').attributes('aria-hidden')).toBe('true')
    const rows = wrapper.findAll('.kb-donut-row').map((row) => row.text())
    expect(rows).toHaveLength(3)
    expect(rows[1]).toContain('原件')
    expect(rows[1]).toContain('60')
    expect(rows[1]).toContain('60%')
    expect(wrapper.attributes('aria-label')).toBe('存储构成,共 100')
  })

  it('环中间默认显示总数,也可以自己指定', () => {
    expect(mount(KbDonut, { props: { items, label: 'x' } }).find('.kb-donut-value').text()).toBe('100')
    expect(mount(KbDonut, { props: { items, label: 'x', center: '3 项', caption: '共' } }).find('.kb-donut-value').text()).toBe('3 项')
  })

  it('「其它」用中性灰,不占分类色,换了顺序颜色也不变', () => {
    const wrapper = mount(KbDonut, { props: { items, label: 'x' } })
    const swatches = wrapper.findAll('.kb-donut-sw').map((node) => node.attributes('style') ?? '')
    expect(swatches[0]).toContain('--viz-1')
    expect(swatches[1]).toContain('--viz-2')
    expect(swatches[2]).toContain('--viz-other')
  })

  it('值为 0 的项不画弧,但图例仍然列出(数据是 0 也是信息)', () => {
    const wrapper = mount(KbDonut, { props: { items: [{ name: 'a', value: 5 }, { name: 'b', value: 0 }], label: 'x' } })
    expect(wrapper.findAll('.kb-donut-arc')).toHaveLength(1)
    expect(wrapper.findAll('.kb-donut-row')).toHaveLength(2)
  })

  it('没有数据:显示空状态文字,不画图例,中间是破折号', () => {
    const wrapper = mount(KbDonut, { props: { items: [], label: '存储构成', emptyText: '还没有统计' } })
    expect(wrapper.find('.kb-donut-legend').exists()).toBe(false)
    expect(wrapper.text()).toContain('还没有统计')
    expect(wrapper.find('.kb-donut-value').text()).toBe('—')
    expect(wrapper.attributes('aria-label')).toBe('存储构成:还没有统计')
  })
})

describe('KbHBars', () => {
  const rows = [
    { key: 'a', label: '张三', sub: '@zs', segments: [{ name: '笔记', value: 3 }, { name: '原件', value: 70 }], limit: 100 },
    { key: 'b', label: '林一', segments: [{ name: '笔记', value: 60 }, { name: '原件', value: 50 }], limit: 100 },
  ]

  it('同名分段在每一行颜色一致,图例对得上', () => {
    const wrapper = mount(KbHBars, { props: { rows, label: '各人存储', legend: true } })
    const legend = wrapper.findAll('.kb-hbars-legend li').map((li) => li.text())
    expect(legend).toEqual(['笔记', '原件'])
    const firstRow = wrapper.findAll('.kb-hbars-row')[0]!.findAll('.kb-hbars-seg').map((seg) => seg.attributes('style') ?? '')
    const secondRow = wrapper.findAll('.kb-hbars-row')[1]!.findAll('.kb-hbars-seg').map((seg) => seg.attributes('style') ?? '')
    expect(firstRow[0]).toContain('--viz-1')
    expect(secondRow[1]).toContain('--viz-2')
  })

  it('分段自己给了颜色时,图例用同一个颜色', () => {
    const colored = [{ key: 'a', label: '搜索', segments: [{ name: '成功', value: 9, color: 'var(--viz-2)' }, { name: '失败', value: 1, color: 'var(--viz-6)' }] }]
    const wrapper = mount(KbHBars, { props: { rows: colored, label: 'x', legend: true } })
    const swatches = wrapper.findAll('.kb-hbars-legend li i').map((node) => node.attributes('style') ?? '')
    expect(swatches[0]).toContain('--viz-2')
    expect(swatches[1]).toContain('--viz-6')
  })

  it('总和达到上限的行标红(is-over),没到的不标', () => {
    const wrapper = mount(KbHBars, { props: { rows, label: 'x' } })
    const flags = wrapper.findAll('.kb-hbars-row').map((row) => row.classes().includes('is-over'))
    expect(flags).toEqual([false, true])
  })

  it('配额线画在上限的位置;所有行共用一把尺子', () => {
    const wrapper = mount(KbHBars, { props: { rows, label: 'x' } })
    // 第二行总和 110 超过上限 100,共用的尺子放大到 110:配额线在 100/110,第一行的 70 占 70/110
    const limit = wrapper.findAll('.kb-hbars-limit')[0]!.attributes('style') ?? ''
    expect(Number.parseFloat(limit.match(/left:\s*([\d.]+)%/)![1]!)).toBeCloseTo((100 / 110) * 100, 3)
    const seg = wrapper.findAll('.kb-hbars-seg')[1]!.attributes('style') ?? ''
    expect(Number.parseFloat(seg.match(/width:\s*([\d.]+)%/)![1]!)).toBeCloseTo((70 / 110) * 100, 3)
    // 两行的配额线在同一个位置:尺子是共用的
    const limits = wrapper.findAll('.kb-hbars-limit').map((node) => node.attributes('style'))
    expect(new Set(limits).size).toBe(1)
  })

  it('条超过上限时尺子放大,配额线不会被推出图外', () => {
    const wrapper = mount(KbHBars, { props: { rows: [{ key: 'z', label: '王五', segments: [{ name: '原件', value: 200 }], limit: 100 }], label: 'x' } })
    expect(wrapper.find('.kb-hbars-limit').attributes('style')).toContain('left: 50%')
  })

  it('条是装饰,每行另有读屏文字写明拆分和上限', () => {
    const wrapper = mount(KbHBars, { props: { rows, label: 'x' } })
    expect(wrapper.find('.kb-hbars-track').attributes('aria-hidden')).toBe('true')
    const spoken = wrapper.findAll('.kb-sr')[0]!.text()
    expect(spoken).toContain('笔记 3')
    expect(spoken).toContain('原件 70')
    expect(spoken).toContain('上限 100')
  })

  it('没有上限、没有数据、总数文字自定义都能处理', () => {
    const plain = mount(KbHBars, { props: { rows: [{ key: 'k', label: '第 1 名', segments: [{ name: '', value: 4 }], totalText: '4 条 · 40%' }], label: 'x' } })
    expect(plain.find('.kb-hbars-limit').exists()).toBe(false)
    expect(plain.find('.kb-hbars-total').text()).toBe('4 条 · 40%')
    const empty = mount(KbHBars, { props: { rows: [], label: 'x', emptyText: '没有任务' } })
    expect(empty.text()).toContain('没有任务')
  })
})

describe('KbLineChart', () => {
  const labels = ['06-01', '06-02', '06-03', '06-04']
  const series = [
    { name: '命中率', values: [0.7, 0.9, 0.85, null], flags: [2], flagNote: '比上一次低' },
    { name: '得分', values: [0.5, 0.6, 0.7, 0.8] },
  ]
  const props = { labels, series, label: '评测指标趋势', format: (value: number) => `${(value * 100).toFixed(0)}%`, floor: 0, ceil: 1 }

  it('图是装饰,完整数据是读屏用的逐期文字;缺数据写「没有数据」,回落写明', () => {
    const wrapper = mount(KbLineChart, { props })
    expect(wrapper.find('svg').attributes('aria-hidden')).toBe('true')
    const lines = wrapper.findAll('.kb-sr li').map((item) => item.text())
    expect(lines).toHaveLength(4)
    expect(lines[0]).toBe('时间 06-01:命中率 70%;得分 50%')
    expect(lines[2]).toContain('命中率 85%(比上一次低)')
    expect(lines[3]).toContain('命中率 没有数据')
    expect(wrapper.find('.kb-sr p').text()).toBe('评测指标趋势')
  })

  it('读屏文字不用 <table>(手机上全局样式会把 table 拆散,结构就没了)', () => {
    expect(mount(KbLineChart, { props }).find('table').exists()).toBe(false)
  })

  it('每条线的点形不同,图例里也一样', () => {
    const wrapper = mount(KbLineChart, { props })
    const paths = wrapper.findAll('.kb-line-legend .kb-mark path').map((node) => node.attributes('d'))
    expect(new Set(paths).size).toBe(2)
  })

  it('缺数据的点不画点,线在那里断开', () => {
    const wrapper = mount(KbLineChart, { props })
    const first = wrapper.findAll('.kb-line-path')[0]!.attributes('d') ?? ''
    expect((first.match(/M/g) ?? []).length).toBe(1)
    const withGap = mount(KbLineChart, { props: { ...props, series: [{ name: 'a', values: [1, null, 2, 3] }] } })
    expect((withGap.find('.kb-line-path').attributes('d')?.match(/M/g) ?? []).length).toBe(2)
  })

  it('回落的点画红圈,图例里解释它', () => {
    const wrapper = mount(KbLineChart, { props })
    expect(wrapper.findAll('svg.kb-line-svg .kb-line-flag')).toHaveLength(1)
    expect(wrapper.find('.kb-line-legend').text()).toContain('比前一期低')
  })

  it('键盘:聚焦时停在最后一期,方向键逐期移动,Home/End 到首尾,Esc 收起', async () => {
    const wrapper = mount(KbLineChart, { props, attachTo: document.body })
    await wrapper.trigger('focus')
    expect(wrapper.find('.kb-line-tip-title').text()).toBe('06-04')
    await wrapper.trigger('keydown', { key: 'ArrowLeft' })
    expect(wrapper.find('.kb-line-tip-title').text()).toBe('06-03')
    await wrapper.trigger('keydown', { key: 'Home' })
    expect(wrapper.find('.kb-line-tip-title').text()).toBe('06-01')
    await wrapper.trigger('keydown', { key: 'ArrowLeft' })
    expect(wrapper.find('.kb-line-tip-title').text()).toBe('06-01')
    await wrapper.trigger('keydown', { key: 'End' })
    expect(wrapper.find('.kb-line-tip-title').text()).toBe('06-04')
    await wrapper.trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('.kb-line-tip').exists()).toBe(false)
    wrapper.unmount()
  })

  it('提示气泡不用全局的 .tip 类(components.css 在手机上把 .tip 整个藏掉,手机上就看不到数了)', async () => {
    const wrapper = mount(KbLineChart, { props })
    await wrapper.findAll('svg rect')[1]!.trigger('pointerenter')
    const tip = wrapper.find('.kb-line-tip')
    expect(tip.exists()).toBe(true)
    expect(tip.classes()).not.toContain('tip')
  })

  it('提示气泡里写出每条线的值,回落那期写明原因', async () => {
    const wrapper = mount(KbLineChart, { props })
    await wrapper.findAll('svg rect')[2]!.trigger('pointerenter')
    const tip = wrapper.find('.kb-line-tip').text()
    expect(tip).toContain('06-03')
    expect(tip).toContain('85%')
    expect(tip).toContain('比上一次低')
  })

  it('比例类指标的轴不超出 0–100%', () => {
    const wrapper = mount(KbLineChart, { props: { ...props, series: [{ name: 'a', values: [0.95, 0.99, 1] }], labels: ['1', '2', '3'] } })
    const ticks = wrapper.findAll('text.kb-line-tick').map((node) => node.text()).filter((text) => text.endsWith('%'))
    expect(ticks.every((text) => Number.parseInt(text, 10) <= 100)).toBe(true)
  })

  it('没有数据:显示空状态文字,不可聚焦', () => {
    const wrapper = mount(KbLineChart, { props: { labels: [], series: [], label: '趋势', emptyText: '至少要两次记录' } })
    expect(wrapper.text()).toContain('至少要两次记录')
    expect(wrapper.attributes('tabindex')).toBeUndefined()
    expect(wrapper.find('svg').exists()).toBe(false)
  })

  it('只有一期数据也能画(居中一个点),不报错', () => {
    const wrapper = mount(KbLineChart, { props: { labels: ['今天'], series: [{ name: 'a', values: [5] }], label: '趋势' } })
    expect(wrapper.find('svg').exists()).toBe(true)
    expect(wrapper.findAll('.kb-line-dot')).toHaveLength(1)
  })
})

describe('KbLineChart · 面积 / 堆叠 / 入场 / 实时', () => {
  const labels = ['10:00', '10:10', '10:20', '10:30']
  const base = { labels, label: '任务吞吐', height: 160 }

  it('单条线 area=true 是渐变面积(defs 里有渐变);多条线 area=true 不画面积,area="gradient" 才每条都画', () => {
    const single = mount(KbLineChart, { props: { ...base, series: [{ name: '完成', values: [1, 3, 2, 4] }], area: true } })
    expect(single.find('linearGradient').exists()).toBe(true)
    expect(single.find('.kb-line-area').attributes('style')).toContain('url(#kb-line-grad-')
    const two = [{ name: '完成', values: [1, 3, 2, 4] }, { name: '失败', values: [0, 1, 0, 1] }]
    expect(mount(KbLineChart, { props: { ...base, series: two, area: true } }).find('.kb-line-area').exists()).toBe(false)
    expect(mount(KbLineChart, { props: { ...base, series: two, area: 'gradient' } }).findAll('.kb-line-area')).toHaveLength(2)
  })

  it('堆叠面积:纵轴按累计值算,每层夹在上一层和本层之间,提示里补一行合计', async () => {
    const series = [{ name: '完成', values: [10, 20, 30, 40] }, { name: '失败', values: [1, 2, null, 4] }]
    const wrapper = mount(KbLineChart, { props: { ...base, series, area: 'stacked' } })
    expect(wrapper.classes()).toContain('is-stacked')
    expect(wrapper.findAll('.kb-line-area.is-band')).toHaveLength(2)
    // 累计最大值是 44,轴要装得下(刻度最高不低于它)
    const ticks = wrapper.findAll('.kb-line-tick').map((tick) => tick.text())
    expect(ticks.some((text) => Number(text.replace(/,/g, '')) >= 44)).toBe(true)
    await wrapper.find('figure').trigger('keydown', { key: 'End' })
    const tip = wrapper.find('.kb-line-tip').text().replace(/\s+/g, '')
    expect(tip).toContain('完成40')
    expect(tip).toContain('失败4')
    expect(tip).toContain('合计44')
    // 缺的那一期(失败 null)在堆叠里按 0 算,合计就是完成那层
    await wrapper.find('figure').trigger('keydown', { key: 'Home' })
    await wrapper.find('figure').trigger('keydown', { key: 'ArrowRight' })
    await wrapper.find('figure').trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.find('.kb-line-tip').text().replace(/\s+/g, '')).toContain('合计30')
  })

  it('非堆叠没有合计行;读屏文字仍是每期每条线自己的值', async () => {
    const series = [{ name: '完成', values: [10, 20, 30, 40] }]
    const wrapper = mount(KbLineChart, { props: { ...base, series } })
    await wrapper.find('figure').trigger('keydown', { key: 'End' })
    expect(wrapper.find('.kb-line-tip-total').exists()).toBe(false)
    expect(wrapper.find('.kb-sr').text()).toContain('10:30:完成 40')
  })

  it('入场:没有 IntersectionObserver(单测 / 不支持的浏览器)时直接是最终状态', async () => {
    const wrapper = mount(KbLineChart, { props: { ...base, series: [{ name: '完成', values: [1, 2, 3, 4] }] } })
    await nextTick()
    expect(wrapper.classes()).toContain('is-in')
    expect(wrapper.find('.kb-line-path').attributes('pathLength')).toBe('1')
  })

  it('live:最新一个点带光圈,在最后一个有数据的位置;不开就没有', () => {
    const series = [{ name: '处理器', values: [0.2, 0.3, 0.4, null] }]
    expect(mount(KbLineChart, { props: { ...base, series } }).find('.kb-line-now').exists()).toBe(false)
    const live = mount(KbLineChart, { props: { ...base, series, live: true } })
    expect(live.find('.kb-line-now').exists()).toBe(true)
    // 光圈在第 3 个点上(下标 2),不在没有数据的第 4 个
    const dot = live.findAll('.kb-line-dot')[2]!.attributes('d')!
    const cx = Number(live.find('.kb-line-now').attributes('cx'))
    const first = Number(dot.match(/M([\d.]+)/)![1])
    expect(Math.abs(cx - first)).toBeLessThan(6)
  })

  it('integer:数据很小时刻度只取整数(没有 0.5、1.5)', () => {
    const series = [{ name: '排队中', values: [0, 1, 2, 1] }]
    const ticks = (integer: boolean) => mount(KbLineChart, { props: { labels, series, label: '排队深度', area: true, integer, floor: 0 } }).findAll('.kb-line-tick').map((tick) => tick.text()).filter((text) => /^[\d.]+$/.test(text) && !labels.includes(text))
    expect(ticks(false).some((text) => text.includes('.'))).toBe(true)
    expect(ticks(true).every((text) => Number.isInteger(Number(text)))).toBe(true)
    expect(ticks(true)).toEqual(['0', '1', '2'])
  })

  it('堆叠面积超过 3 层时不用虚线(每层有自己的色块);非堆叠的多条线仍用虚线区分', () => {
    const four = ['a', 'b', 'c', 'd'].map((name) => ({ name, values: [1, 2, 3, 4] }))
    const stackedChart = mount(KbLineChart, { props: { labels, series: four, label: 'x', area: 'stacked' } })
    expect(stackedChart.findAll('.kb-line-path.is-dash')).toHaveLength(0)
    const lines = mount(KbLineChart, { props: { labels, series: four, label: 'x' } })
    expect(lines.findAll('.kb-line-path.is-dash')).toHaveLength(3)
  })
})
