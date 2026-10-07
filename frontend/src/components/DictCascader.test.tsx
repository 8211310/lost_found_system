// DictCascader 的行为测试。核心只有一件事：**只有叶子才是值**。
// 这条规则来自后端 buildItemWhere 的 `i.category_id = $n` 精确匹配（不含子级），
// 组件写错了不会报错，只会让用户以为「选了大类却没结果」。
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DictCascader from './DictCascader'
import { sampleCategories, sampleLocations } from '../test/helpers'
import type { CategoryNode, LocationNode } from '../api/types'

function setup(tree: CategoryNode[] | LocationNode[], value?: number) {
  const onChange = vi.fn()
  render(
    <DictCascader
      idPrefix="cat"
      firstLabel="分类"
      tree={tree}
      value={value}
      onChange={onChange}
    />,
  )
  return onChange
}

describe('只有叶子才是筛选值', () => {
  it('选中有子节点的大类时只回 undefined，不产生筛选值', async () => {
    const user = userEvent.setup()
    const onChange = setup(sampleCategories())

    await user.selectOptions(screen.getByLabelText('分类'), '20')

    expect(onChange).toHaveBeenCalledWith(undefined)
    // 第二层出现，并且 label 说的是上一轮选了谁 —— 用户得知道第二个框为什么变了。
    expect(screen.getByLabelText('衣物箱包里的下一级')).toBeInTheDocument()
  })

  it('选中没有子节点的小类时把它的 id 交出去', async () => {
    const user = userEvent.setup()
    const onChange = setup(sampleCategories())

    await user.selectOptions(screen.getByLabelText('分类'), '20')
    await user.selectOptions(screen.getByLabelText('衣物箱包里的下一级'), '21')

    expect(onChange).toHaveBeenLastCalledWith(21)
  })

  it('一级就是叶子（电子设备）时选它即生效，不需要第二层', async () => {
    const user = userEvent.setup()
    const onChange = setup(sampleCategories())

    await user.selectOptions(screen.getByLabelText('分类'), '30')

    expect(onChange).toHaveBeenCalledWith(30)
    expect(screen.queryByText('电子设备里的下一级')).not.toBeInTheDocument()
  })

  it('地点树里 level=1 的 freeform「其他」只渲染一层就能选中', async () => {
    const user = userEvent.setup()
    const onChange = setup(sampleLocations())

    // 「其他」在数据库里是 level=1 的叶子。若组件死板要求选到第三层，
    // 这一项就永远选不中，而它是发布表单和筛选都绕不开的一个出口。
    await user.selectOptions(screen.getByLabelText('分类'), '99')

    expect(onChange).toHaveBeenCalledWith(99)
  })
})

describe('中间层不能看起来像已经选了', () => {
  it('刚选完大类时第二层显示「请选择」，而不是把第一个真实选项显示成选中', () => {
    setup(sampleCategories(), 20)

    // 这一条看着像 cosmetics，其实是上一段规则的可见面：中间层不产生 value，
    // 所以它**必须**有一个「还没有选」的状态可显示。少了那一项时浏览器会显示
    // options 里的第一条（背包书包），用户看到的是一个并不存在的筛选条件。
    expect(screen.getByLabelText('衣物箱包里的下一级')).toHaveValue('')
  })

  it('在第二层点「请选择」只收回这一层，上一层的选择留着', async () => {
    const user = userEvent.setup()
    const onChange = setup(sampleCategories())

    await user.selectOptions(screen.getByLabelText('分类'), '20')
    await user.selectOptions(screen.getByLabelText('衣物箱包里的下一级'), '21')
    expect(onChange).toHaveBeenLastCalledWith(21)

    await user.selectOptions(screen.getByLabelText('衣物箱包里的下一级'), '')

    // 回到「不限」（没有叶子了），但路径只截到第一层：
    // 把大类一起抹掉的话，用户想换个小子类就得从头再选一遍。
    expect(onChange).toHaveBeenLastCalledWith(undefined)
    expect(screen.getByLabelText('分类')).toHaveValue('20')
  })
})

describe('从 value 还原选中路径', () => {
  it('深叶子的完整路径逐层预选，而不是显示「不限」', () => {
    setup(sampleLocations(), 31)

    expect(screen.getByLabelText('分类')).toHaveValue('10')
    expect(screen.getByLabelText('教学区里的下一级')).toHaveValue('30')
    expect(screen.getByLabelText('图书馆里的下一级')).toHaveValue('31')
  })

  it('value 指向一个树上没有的 id 时退回单层，不炸也不假装选中', () => {
    setup(sampleCategories(), 9999)

    // 分享出去的链接里 category_id 被手改成一个不存在的 id 是常态。
    // 这里必须安静地回到「不限」：树里找不到路径时任何预选状态都是撒谎。
    expect(screen.getByLabelText('分类')).toHaveValue('')
    expect(screen.queryByText('里的下一级')).not.toBeInTheDocument()
  })
})
