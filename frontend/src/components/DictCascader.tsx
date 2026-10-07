// src/components/DictCascader.tsx —— 字典树的级联下拉，广场筛选和发布表单共用一个实现。
//
// 为什么不是「一个大下拉框列出全部叶子」：地点三级、分类两级，拍平之后
// 「图书馆」下面和「教三」下面会混成一锅，用户找不到自己学校那栋楼。
//
// ⚠ 关键约束：**只有叶子才是筛选值**。
// 后端 #14 的 category_id / location_id 是 `i.category_id = $n` 精确匹配（repo/item.go buildItemWhere），
// **不含子级**。而帖子里存的永远是最细那一层的 id（§3.2），所以「只选到大类」必然返回 0 条 ——
// 那不是「没有结果」，那是「这个筛选条件根本没生效」。所以这里的规则是：
// 中间层的选择只用来收窄下一层的选项，不产生 value；选到没有子节点的那一项才算选中。
// 顺带这也解释了为什么地点树里的「其他」（level=1 的叶子）只渲染一个下拉框 ——
// 它本来就是可选中的终点，不是「还得再选一层」。
import { useMemo, useRef, useState } from 'react'

/** 分类树和地点树的公共形状：两者都有这三个字段，
 *  差别只在地点多一个 is_freeform、层数不同 —— 这个组件不关心那两点。 */
export interface CascaderNode {
  id: number
  name: string
  children: CascaderNode[]
}

interface Props {
  /** 用来给每层 select 生成 id，label 才连得上（测试也靠 label 找控件） */
  idPrefix: string
  tree: CascaderNode[]
  /** 当前选中的叶子 id；undefined = 不限 */
  value?: number
  /** 第一层下拉框的 label 文案，例如「分类」。
   *  每层都有可见 label 而不是只给 aria-label：级联的「上一层选了谁」是
   *  这一层选项的来源，把它写在 label 上用户才知道第二个框为什么变了。 */
  firstLabel: string
  /** 第一层那个「还没选」的选项写什么。广场上是筛选，不选就是「不限」；
   *  发布表单里分类和地点是必填项，那里得写「请选择」——
   *  一个必填框显示着「不限」，用户会以为自己已经做了选择。 */
  firstPlaceholder?: string
  onChange: (leafId?: number) => void
}

/** findPath 从根走到目标叶子，返回 root→target 的链条；找不到返回空数组。 */
function findPath(tree: CascaderNode[], leafId: number): CascaderNode[] {
  for (const n of tree) {
    if (n.id === leafId) return [n]
    const deeper = findPath(n.children, leafId)
    if (deeper.length) return [n, ...deeper]
  }
  return []
}

export default function DictCascader({
  idPrefix,
  tree,
  value,
  firstLabel,
  firstPlaceholder = '不限',
  onChange,
}: Props) {
  // 选中路径是**内部状态**，不是 value 的派生值。这一点被测试逼出来的，理由值得留着：
  // 用户选完大类时组件发出去的是 undefined（大类不是值），如果路径也从 value 派生，
  // 那这一次 undefined 会立刻把刚选的大类抹掉 —— 第二个下拉框闪一下就没了，
  // 表现为「这个筛选框坏了」，而代码看起来完全自洽。
  const [path, setPath] = useState<CascaderNode[]>(() =>
    value === undefined ? [] : findPath(tree, value),
  )
  const [lastValue, setLastValue] = useState(value)
  // true 表示「value 这次的变化是我自己发出去的」，此时**不要**重算路径。
  const selfChange = useRef(false)

  if (value !== lastValue) {
    setLastValue(value)
    if (selfChange.current) {
      selfChange.current = false
    } else {
      // 外部改动：刷新、点浏览器后退、或打开一条分享来的链接。
      // 这时 URL 里的那个叶子 id 才是唯一真相，路径必须跟着它重算，
      // 否则会剩下「框里显示着选中项、实际没在筛选」这种自相矛盾的状态。
      setPath(value === undefined ? [] : findPath(tree, value))
    }
  }

  const levels = useMemo(() => {
    const out: CascaderNode[][] = []
    let options = tree
    for (;;) {
      if (!options.length) break
      out.push(options)
      const chosen = path[out.length - 1]
      if (!chosen || !chosen.children.length) break
      options = chosen.children
    }
    return out
  }, [tree, path])

  function pick(level: number, raw: string) {
    const node = levels[level].find((n) => String(n.id) === raw)
    // raw 是 ''（选了「不限」或「请选择」）时 node 是 undefined：这时只砍掉这一层及其以下，
    // 上一级仍然留着 —— 否则在第二层点「请选择」会把用户的第一层一起抹掉。
    const next = node ? [...path.slice(0, level), node] : path.slice(0, level)
    selfChange.current = true
    setPath(next)
    onChange(node && node.children.length ? undefined : node?.id)
  }

  return (
    <div className="cascader">
      {levels.map((options, i) => {
        const labelText = i === 0 ? firstLabel : `${path[i - 1]?.name ?? ''}里的下一级`
        return (
          <div className="cascader-part" key={`${idPrefix}-${i}`}>
            <label htmlFor={`${idPrefix}-${i}`}>{labelText}</label>
            <select
              id={`${idPrefix}-${i}`}
              value={path[i]?.id ?? ''}
              onChange={(e) => pick(i, e.target.value)}
            >
              {/* 每一层都要有一个「还没选」的那一项，哪怕它文案不同：
                  少了它，浏览器会把**第一个真实选项**显示成已选中 ——
                  框里写着「背包书包」、下面的结果却一条都没筛，
                  而「只有叶子才产生 value」这条规则恰恰意味着中间层本来就没有选中值。
                  第一层默认叫「不限」（筛选场景里它就是个有效结论），必填场景由调用方改成「请选择」；
                  更深的层一律叫「请选择」，因为它只是还没走完，不是一个答案。 */}
              <option value="">{i === 0 ? firstPlaceholder : '请选择'}</option>
              {options.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </select>
          </div>
        )
      })}
    </div>
  )
}
