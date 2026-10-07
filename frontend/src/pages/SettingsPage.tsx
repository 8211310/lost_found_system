// src/pages/SettingsPage.tsx —— #4 PUT /api/auth/me（改资料）+ #5 POST /api/auth/change-password（改密码）。
//
// 两个表单的提交语义都不止是「把输入框发过去」，两处各有一条必须照做的契约：
//
// ① #4 的三个字段是**指针**：不传 = 保持原值，传空串 = 清空（nickname 除外，它清空会吃 VALIDATION）。
//    所以这里只提交**改动过的那几个**，而不是把三个框的当前值一起发过去 ——
//    一起发等于前端替用户把没碰过的那两列也重写一遍，而后端对 phone/email 的
//    处理是「空串即清空」，用户只想改昵称时，空着的邮箱框就真的会被清掉。
//
// ② #5 对非本地账号返回 FORBIDDEN（那种账号的密码在杭电助手那边，我们既没有也不该有）。
//    这一条不是「报错也还行」：给一个注定失败的表单比不提供更糟，
//    所以整个卡片按 auth_source 条件渲染，而不是发给后端再看它拒绝。
//
// 两个表单各自是一个内部组件，状态从 props 的**初始值**里来而不是从 useEffect 里灌：
// 后者会先渲染出一帧空的输入框，而 #3 的结果在那一帧之后才落到 state ——
// 手快的人（和 user-event）可以在同一刻开始输入，接着被那次灌入的 effect 覆盖掉打过的字。
// 这不是假设，这一版测试就是这么红的。
//
// 保存成功后调 refresh() 重新读一次 #3，而不是把 #4 的响应塞进 auth state：
// #3 是全站唯一的身份来源（见 AuthContext 顶部），多一个写入点就多一处可能不一致的地方。
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { changePassword, updateMe, type UpdateProfileInput } from '../api/auth'
import { ApiError } from '../api/client'
import { errorText, requestIdOf } from '../api/errorText'
import { useAuth } from '../auth/AuthContext'
import type { UserView } from '../api/types'

/** diff 只在「和后端现在存的不一样」时给值，其余一律不出现这个键（= 保持原值）。
 *  空串是**有效值**（清空 phone / email），所以这里不能写成 `if (v)`。 */
function profileInput(me: UserView, form: { nickname: string; phone: string; email: string }): UpdateProfileInput {
  const input: UpdateProfileInput = {}
  if (form.nickname !== me.nickname) input.nickname = form.nickname
  if (form.phone !== me.phone) input.phone = form.phone
  if (form.email !== me.email) input.email = form.email
  return input
}

/** 一句提示 + 一句错误：两个表单各有一份，不共用。
 *  共用出现过一次真实的困惑——改密码失败的红色横幅显示在资料卡下面，
 *  而资料卡上那句「已保存」也还亮着。 */
function Feedback({ error, errorId, notice }: { error: string; errorId: string; notice: string }) {
  return (
    <>
      {error && (
        <p className="alert" role="alert">
          {error}
          {errorId && <span className="req-id">（请求编号 {errorId}）</span>}
        </p>
      )}
      {notice && <p className="notice">{notice}</p>}
    </>
  )
}

function ProfileForm({ me }: { me: UserView }) {
  const { refresh } = useAuth()
  const [form, setForm] = useState({ nickname: me.nickname, phone: me.phone, email: me.email })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [errorId, setErrorId] = useState('')
  const [notice, setNotice] = useState('')
  // 字段级错误只有 #4 会带（apperr 把 FieldError 放在 data.errors 里），
  // 所以它单独存一份而不是拼进 error 那句人话里 —— 用户要看的是「哪一格该改」。
  const [fieldErr, setFieldErr] = useState<{ nickname?: string; phone?: string; email?: string }>({})

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const input = profileInput(me, form)
    if (Object.keys(input).length === 0) {
      setNotice('没有需要保存的改动。')
      setError('')
      return
    }
    setSaving(true)
    setError('')
    setNotice('')
    try {
      await updateMe(input)
      setNotice('已保存。')
      // refresh 只是让顶栏的昵称跟上，它失败不该把一次**已经成功**的保存报成错误：
      // 用户看到红字会再提交一次，而那次改的其实是他自己的资料。
      await refresh().catch(() => {
        /* 最坏情况是顶栏显示旧昵称，刷新页面后 #3 仍然是唯一的真相来源。 */
      })
    } catch (err) {
      setError(errorText(err))
      setErrorId(requestIdOf(err))
      setFieldErr(
        err instanceof ApiError
          ? {
              nickname: err.errorFor('nickname'),
              phone: err.errorFor('phone'),
              email: err.errorFor('email'),
            }
          : {},
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="nickname">昵称</label>
        <input id="nickname" value={form.nickname} onChange={(e) => setForm({ ...form, nickname: e.target.value })} />
        {fieldErr.nickname && <p className="field-error">{fieldErr.nickname}</p>}
      </div>
      <div className="field">
        <label htmlFor="phone">手机号</label>
        <input
          id="phone"
          value={form.phone}
          placeholder="留空表示不显示"
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
        />
        {fieldErr.phone && <p className="field-error">{fieldErr.phone}</p>}
      </div>
      <div className="field">
        <label htmlFor="email">邮箱</label>
        <input
          id="email"
          value={form.email}
          placeholder="留空表示不显示"
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
        {fieldErr.email && <p className="field-error">{fieldErr.email}</p>}
      </div>

      <p className="hint">
        手机号和邮箱是给人看的展示信息，系统不发短信也不发邮件，所以格式后端不校验 ——
        想填什么填什么，但填了就等于公开给看到你帖子的人。
      </p>

      <button className="btn btn-primary" type="submit" disabled={saving}>
        {saving ? '正在保存…' : '保存改动'}
      </button>

      <Feedback error={error} errorId={errorId} notice={notice} />
    </form>
  )
}

function PasswordForm() {
  const [pw, setPw] = useState({ old_password: '', new_password: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [errorId, setErrorId] = useState('')
  const [notice, setNotice] = useState('')

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await changePassword(pw)
      // 成功之后清空两个框：密码这种字段留在输入框里，下次有人借用这台电脑就看到它。
      setPw({ old_password: '', new_password: '' })
      setNotice('密码已更新。')
    } catch (err) {
      setError(errorText(err))
      setErrorId(requestIdOf(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="old_password">原密码</label>
        <input
          id="old_password"
          type="password"
          autoComplete="current-password"
          value={pw.old_password}
          onChange={(e) => setPw({ ...pw, old_password: e.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor="new_password">新密码</label>
        <input
          id="new_password"
          type="password"
          autoComplete="new-password"
          value={pw.new_password}
          onChange={(e) => setPw({ ...pw, new_password: e.target.value })}
        />
      </div>
      <button className="btn" type="submit" disabled={busy}>
        {busy ? '正在提交…' : '修改密码'}
      </button>

      <Feedback error={error} errorId={errorId} notice={notice} />
    </form>
  )
}

export default function SettingsPage() {
  const { user } = useAuth()

  if (!user) return <p className="muted">正在加载…</p>
  const isLocal = user.auth_source === 'local'

  return (
    <>
      <section className="card">
        <h1>账号设置</h1>
        <p className="muted">
          <Link to="/me">回我的</Link>
        </p>

        <dl className="kv">
          <dt>用户名</dt>
          {/* 用户名不可改：注册时它是登录凭据，改了以后所有历史记录里显示的
              还是当初那串。后端压根没给这个字段留入口（UpdateProfileInput 只有三个键），
              所以这里显示成只读文本而不是一个 disabled 的输入框。 */}
          <dd>{user.username}</dd>
          <dt>身份来源</dt>
          <dd>{isLocal ? '本地账号密码' : '杭电助手'}</dd>
        </dl>

        <ProfileForm me={user} />
      </section>

      {/* 杭电助手账号没有本地密码可改（#5 对那种账号返回 FORBIDDEN），所以整张卡片不出现。
          这里不给一句「去杭电助手改」的指引：M8 之前那个第三方系统怎么改密码不是本系统知道的事。 */}
      {isLocal && (
        <section className="card">
          <h2>修改密码</h2>
          <PasswordForm />
        </section>
      )}
    </>
  )
}
