// src/pages/admin/DictTab.tsx —— #9–#12：字典的新增与删除。
//
// 这一页只有两个动作，而且**故意不做第三个**：改名和停用后端没有开端点
// （计划 §14-15 明写低频走数据库；locations/categories 那两列 is_active 在全
// backend/internal 里没有任何生产代码写过）。所以这里不许出现「改名」按钮，
// 也不许拿「删了重加」充当改名 —— 那会换掉编号，而历史帖子认的是编号。
//
// 删除那一侧的真实风险不是误删，而是**删不掉**：还有子节点、或还有帖子在引用，
// 后端就回 409 CATEGORY_IN_USE，并且把两个数数给人看。那两种情况管理员接下来要做的事
// 是相反的（先删子节点 vs 先去处理帖子），所以这里必须把后端那句话原样显示出来，
// 不能糊成一句「删除失败」。
import { useCallback, useEffect, useState } from 'react'
import { getCategories, getLocations } from '../../api/dicts'
import {
  CATEGORY_MAX_LEVEL,
  LOCATION_MAX_LEVEL,
  MAX_CATEGORY_NAME_RUNES,
  MAX_LOCATION_NAME_RUNES,
  createCategory,
  createLocation,
  deleteCategory,
  deleteLocation,
  dictNameProblem,
  reasonProblem,
} from '../../api/admin'
import { errorText, requestIdOf } from '../../api/errorText'
import { runeLen } from '../../lib/runes'
import { Alert, ReasonField } from './parts'
import type { CategoryNode, DictResult, LocationNode } from '../../api/types'
import type { NewDictEntry } from '../../api/admin'

/** 两张字典在页面上的公共形状。LocationNode 比它多一列 is_freeform，
 *  结构化类型下直接能当 TreeRow 用 —— 为了这一列写两份组件不值得。 */
interface TreeRow {
  id: number
  name: string
  level: number
  sort_order: number
  children: readonly TreeRow[]
  is_freeform?: boolean
}

interface Flat {
  node: TreeRow
  /** 从根到这一行的名字。列表必须是平铺的（树里同名的条目真的存在），
   *  所以「一楼」这种名字只有带上路径才认得出点的是哪一条。 */
  path: string
}

function flatten(nodes: readonly TreeRow[], prefix: string[]): Flat[] {
  const out: Flat[] = []
  for (const node of nodes) {
    const path = [...prefix, node.name]
    out.push({ node, path: path.join(' / ') })
    out.push(...flatten(node.children, path))
  }
  return out
}

interface PaneProps {
  title: string
  /** 那句「为什么要加这一条」的提示里要说清是在往哪张表里加 */
  what: string
  nodes: readonly TreeRow[]
  maxLevel: number
  nameMax: number
  /** 只有地点表有 is_freeform 这一列 */
  hasFreeform: boolean
  create: (entry: NewDictEntry) => Promise<DictResult>
  remove: (id: number, reason: string) => Promise<null>
  reload: () => void
}

function DictPane({ title, what, nodes, maxLevel, nameMax, hasFreeform, create, remove, reload }: PaneProps) {
  const [parent, setParent] = useState('')
  const [name, setName] = useState('')
  const [sort, setSort] = useState('0')
  const [freeform, setFreeform] = useState(false)
  const [reason, setReason] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [errorId, setErrorId] = useState('')
  const [busy, setBusy] = useState(false)
  const [target, setTarget] = useState<Flat | null>(null)
  const [delReason, setDelReason] = useState('')

  const rows = flatten(nodes, [])
  const parents = rows.filter((r) => r.node.level < maxLevel)

  const sortNum = Number(sort)
  const sortBad = sort.trim() === '' || !Number.isInteger(sortNum) ? '排序要填一个整数' : ''
  const nameBad = dictNameProblem(name, nameMax)
  const canCreate = !busy && !nameBad && !sortBad && !reasonProblem(reason)
  const delBad = reasonProblem(delReason)

  async function onCreate() {
    if (!canCreate) return
    setBusy(true)
    setError('')
    setErrorId('')
    // parent_id 不填时**整个键都不发**，而不是发 0：0 不是任何一行的 id，
    // 后端会在父节点点查那里报「上级不存在」，把一个正确请求判错。
    const entry: NewDictEntry = {
      name: name.trim(),
      sort_order: sortNum,
      reason: reason.trim(),
      ...(parent ? { parent_id: Number(parent) } : {}),
      ...(hasFreeform ? { is_freeform: freeform } : {}),
    }
    try {
      const res = await create(entry)
      setNotice(
        `#${res.id}「${res.name}」已经建好，是第 ${res.level} 级。` +
          '现在去发一条帖，那两个下拉框里就有它 —— 字典树不缓存，不用重启也不用等。',
      )
      setName('')
      setReason('')
      setTarget(null)
      reload()
    } catch (err) {
      setError(errorText(err))
      setErrorId(requestIdOf(err))
    } finally {
      setBusy(false)
    }
  }

  async function onDelete() {
    if (!target || delBad) return
    setBusy(true)
    setError('')
    setErrorId('')
    const row = target.node
    try {
      await remove(row.id, delReason.trim())
      setNotice(
        `#${row.id}「${row.name}」已经删掉，两份树都重读了一遍。` +
          '留痕是 dict_delete，里面带着被删那条的名字和级别，所以它删掉之后仍然查得出删的是什么。',
      )
      setTarget(null)
      setDelReason('')
      reload()
    } catch (err) {
      setError(errorText(err))
      setErrorId(requestIdOf(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <h2>{title}</h2>
      <p className="muted">
        这一张表只能<strong>新增</strong>和<strong>删除</strong>。改名和停用后端没有开端点，那种事要进数据库；
        而「删了重加」不能当改名用 —— 那会换掉编号，已经引用过旧编号的东西认的是编号。
      </p>

      <Alert error={error} errorId={errorId} />
      {notice && <p className="notice">{notice}</p>}

      <form
        className="filter-row"
        onSubmit={(e) => {
          e.preventDefault()
          void onCreate()
        }}
      >
        <div className="field">
          <label htmlFor={`parent-${what}`}>挂在哪一条下面</label>
          <select id={`parent-${what}`} value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">（不挂：直接建第 1 级）</option>
            {parents.map((p) => (
              <option key={p.node.id} value={String(p.node.id)}>
                {p.path}（第 {p.node.level} 级，新建的是第 {p.node.level + 1} 级）
              </option>
            ))}
          </select>
          <p className="muted">
            这张表最多 {maxLevel} 级，所以第 {maxLevel} 级的那些不在这个下拉框里 ——
            它们下面挂不了东西，硬发会得到一句 VALIDATION。
          </p>
        </div>

        <div className="field">
          <label htmlFor={`name-${what}`}>名字</label>
          <input
            id={`name-${what}`}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={what === '分类' ? '例如：学生证件' : '例如：体育馆二楼'}
          />
          <p className="item-meta">
            {runeLen(name.trim())} / {nameMax} 字
            {nameBad && <span className="field-error">　{nameBad}</span>}
          </p>
          <p className="muted">这个名字会原样出现在发帖表单的下拉框里。</p>
        </div>

        <div className="field">
          <label htmlFor={`sort-${what}`}>排序</label>
          <input id={`sort-${what}`} type="number" step="1" value={sort} onChange={(e) => setSort(e.target.value)} />
          <p className="muted">同级之间谁在前，小的在前。填重了不报错，只是并列。</p>
          {sortBad && <p className="field-error">{sortBad}</p>}
        </div>

        {hasFreeform && (
          <div className="field">
            <label htmlFor={`freeform-${what}`}>
              <input
                id={`freeform-${what}`}
                type="checkbox"
                checked={freeform}
                onChange={(e) => setFreeform(e.target.checked)}
              />
              选到这一条的人还能自己补一句具体位置
            </label>
            <p className="muted">全库现在只有那些叫「其他」的条目是勾着的。</p>
          </div>
        )}

        <ReasonField
          id={`reason-${what}`}
          label={`为什么要往${what}里加这一条（必填）`}
          value={reason}
          onChange={setReason}
          extra="这一句进的是操作日志，不发通知给任何人 —— 字典是全站共用的东西，没有「对方」可通知。"
        />

        <p className="adm-actions">
          <button className="btn btn-primary" type="submit" disabled={!canCreate}>
            {busy ? '正在写入…' : '新增'}
          </button>
        </p>
      </form>

      {rows.length === 0 ? (
        <p className="muted">这张表目前是空的。</p>
      ) : (
        <ul className="adm-list">
          {rows.map((r) => {
            const open = target?.node.id === r.node.id
            return (
              <li key={r.node.id} className="adm-row">
                <p className="adm-head">
                  <span className="adm-name">{r.path}</span>
                  <span className="tag">#{r.node.id}</span>
                  <span className="tag">第 {r.node.level} 级</span>
                  <span className="tag">排序 {r.node.sort_order}</span>
                  {r.node.is_freeform && <span className="tag tag-new">可补具体位置</span>}
                </p>
                <p className="adm-actions">
                  <button
                    className="link-btn"
                    type="button"
                    disabled={busy || (!!target && !open)}
                    onClick={() => {
                      setTarget(open ? null : r)
                      setDelReason('')
                      setError('')
                      setErrorId('')
                    }}
                  >
                    {open ? '先不删' : '删掉这一条'}
                  </button>
                </p>
                {open && (
                  <div className="adm-form">
                    <p className="hint">
                      删掉之后它马上从发帖表单和广场筛选里消失。这一步不可撤销：重新建一条是一个新编号。
                      还有子节点、或还有帖子在引用它的话，后端会拒绝，并且把是几个、几条数给你看。
                    </p>
                    <ReasonField
                      id={`delete-reason-${r.node.id}`}
                      label="为什么要删掉它（必填）"
                      value={delReason}
                      onChange={setDelReason}
                    />
                    <p className="adm-actions">
                      <button className="btn btn-danger" type="button" disabled={busy || !!delBad} onClick={() => void onDelete()}>
                        确认删除
                      </button>
                      <button className="btn" type="button" onClick={() => setTarget(null)}>
                        取消
                      </button>
                    </p>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

export default function DictTab() {
  const [cats, setCats] = useState<CategoryNode[]>([])
  const [locs, setLocs] = useState<LocationNode[]>([])
  const [loadError, setLoadError] = useState('')
  const [loadId, setLoadId] = useState('')
  const [seq, setSeq] = useState(0)

  const load = useCallback(() => {
    let dead = false
    Promise.all([getCategories(), getLocations()])
      .then(([c, l]) => {
        if (dead) return
        setCats(c)
        setLocs(l)
        setLoadError('')
      })
      .catch((err) => {
        if (dead) return
        // 这两棵树是公开的（#7/#8 不要登录），所以读到 401/403 基本只会是「后端没起来」，
        // 而那种情况下页面上留两片空白比说清失败更难查。
        setLoadError(errorText(err))
        setLoadId(requestIdOf(err))
      })
    return () => {
      dead = true
    }
  }, [])

  // seq 是「重读一次」的扳机：它不进 load 的身体（load 不读它），只在这里换掉 effect 的依赖。
  // 写成 useCallback([seq]) 的话 lint 会报那个依赖是多余的 —— 它确实不被读取，
  // 被读取的是**它的变化**，而那件事只有 effect 的依赖表能表达。
  useEffect(() => {
    load()
  }, [load, seq])

  return (
    <>
      <Alert error={loadError} errorId={loadId} />
      <DictPane
        title="物品分类（#7 的两级树）"
        what="分类"
        nodes={cats}
        maxLevel={CATEGORY_MAX_LEVEL}
        nameMax={MAX_CATEGORY_NAME_RUNES}
        hasFreeform={false}
        create={createCategory}
        remove={deleteCategory}
        reload={() => setSeq((n) => n + 1)}
      />
      <DictPane
        title="地点（#8 的三级树）"
        what="地点"
        nodes={locs}
        maxLevel={LOCATION_MAX_LEVEL}
        nameMax={MAX_LOCATION_NAME_RUNES}
        hasFreeform
        create={createLocation}
        remove={deleteLocation}
        reload={() => setSeq((n) => n + 1)}
      />
    </>
  )
}
