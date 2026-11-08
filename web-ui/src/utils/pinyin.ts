/**
 * 插入菜单（斜杠菜单）的拼音 / 首字母搜索用的小拼音表。
 *
 * 为什么不用拼音库：通用拼音库带全量字典（几百 KB），而这里只需要给几十个菜单项的中文名配拼音。
 * 表里只收菜单文案和关键词里出现的字（外加编辑器里常见的操作用字），多音字按菜单里的读法定
 * （「行内」的行读 xing，「重要」的重读 zhong，「模板」的模读 mu）。
 * 表里没有的字不参与拼音匹配（中文原文照样能搜到）；builtin.spec 会检查内置菜单项的名字都能转成拼音，
 * 新加菜单项时漏了字会直接报出来。
 */
const TABLE: Record<string, string> = {
  正: 'zheng', 文: 'wen', 一: 'yi', 二: 'er', 三: 'san', 四: 'si', 五: 'wu', 六: 'liu', 级: 'ji', 标: 'biao', 题: 'ti',
  引: 'yin', 用: 'yong', 无: 'wu', 序: 'xu', 有: 'you', 列: 'lie', 表: 'biao', 任: 'ren', 务: 'wu', 格: 'ge', 代: 'dai',
  码: 'ma', 块: 'kuai', 流: 'liu', 程: 'cheng', 图: 'tu', 时: 'shi', 公: 'gong', 式: 'shi', 行: 'xing', 内: 'nei',
  笔: 'bi', 记: 'ji', 件: 'jian', 模: 'mu', 板: 'ban', 附: 'fu', 提: 'ti', 示: 'shi', 说: 'shuo', 明: 'ming',
  重: 'zhong', 要: 'yao', 注: 'zhu', 意: 'yi', 警: 'jing', 告: 'gao', 分: 'fen', 割: 'ge', 线: 'xian', 片: 'pian',
  快: 'kuai', 捷: 'jie', 键: 'jian', 览: 'lan', 插: 'cha', 入: 'ru', 链: 'lian', 接: 'jie', 双: 'shuang', 查: 'cha',
  找: 'zhao', 替: 'ti', 换: 'huan', 源: 'yuan', 大: 'da', 纲: 'gang', 目: 'mu', 录: 'lu', 加: 'jia', 粗: 'cu',
  斜: 'xie', 体: 'ti', 删: 'shan', 除: 'chu', 字: 'zi', 颜: 'yan', 色: 'se', 背: 'bei', 景: 'jing', 底: 'di',
  清: 'qing', 刷: 'shua', 视: 'shi', 段: 'duan', 落: 'luo', 上: 'shang', 传: 'chuan', 宋: 'song', 黑: 'hei',
  楷: 'kai', 仿: 'fang', 等: 'deng', 宽: 'kuan', 待: 'dai', 办: 'ban', 勾: 'gou', 选: 'xuan', 框: 'kuang', 数: 'shu',
  学: 'xue', 嵌: 'qian', 照: 'zhao', 相: 'xiang', 机: 'ji', 拍: 'pai', 打: 'da', 招: 'zhao', 呼: 'hu', 容: 'rong',
}

const HAN = /\p{Script=Han}/u

/** 一段文字的拼音形态：全拼（无空格无声调）和首字母；非汉字原样保留（转小写），表里没有的汉字跳过 */
export function pinyinForms(text: string): { full: string; initials: string } {
  let full = ''
  let initials = ''
  for (const char of text) {
    if (HAN.test(char)) {
      const py = TABLE[char]
      if (!py) continue
      full += py
      initials += py[0]
      continue
    }
    if (/[a-z0-9]/i.test(char)) {
      const lower = char.toLowerCase()
      full += lower
      initials += lower
    }
  }
  return { full, initials }
}

/** 文字里有没有拼音表认不出的汉字（单测用：内置菜单项的名字必须全部认得） */
export function missingPinyin(text: string): string[] {
  return [...text].filter((char) => HAN.test(char) && !TABLE[char])
}
