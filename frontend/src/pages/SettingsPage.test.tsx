// src/pages/SettingsPage.test.tsx —— #4 改资料 + #5 改密码：这个文件的主线是「发出去的那几个键」。
//
// #4 的三个字段在后端是**指针**：键缺失 = 保持原值，传空串 = 清空（昵称除外）。
// 于是「把三个框的当前值一起发过去」这种写法会真的毁数据 —— 用户只想改昵称时，
// 那两个他没碰过的框如果是空的，邮箱和手机号就被清掉了。而这个 bug 在界面上完全看不出来：
// 保存成功、昵称也变了，只有邮箱在下次刷新时消失。所以这里的断言全部落在 request body 上。
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import SettingsPage from './SettingsPage'
import { renderRouted } from '../test/render'
import { server } from '../test/server'
import { BASE, envelope, ok, sampleUser } from '../test/helpers'
import { setToken, getToken } from '../api/session'
import type { UserView } from '../api/types'

/** 装上 #3 / #4 / #5。
 *  @param me     这一次读到的用户；默认是一个**填过邮箱和手机号**的本地账号，
 *                这样「只改昵称」时那两个键该不该出现才有意义可验。
 *  @returns      bodies 记 #4 的请求体，meTimes 记 #3 被读了几次（refresh 的证据）。 */
function mockAuth(me: UserView = sampleUser({ phone: '13800000000', email: 'a@b.c' })) {
  const seen: { bodies: Record<string, unknown>[]; meTimes: number; pwTimes: number } = {
    bodies: [],
    meTimes: 0,
    pwTimes: 0,
  }
  setToken('jwt.me')
  server.use(
    http.get(`${BASE}/api/auth/me`, () => {
      seen.meTimes += 1
      return HttpResponse.json(ok(me))
    }),
    http.put(`${BASE}/api/auth/me`, async ({ request }) => {
      seen.bodies.push((await request.json()) as Record<string, unknown>)
      return HttpResponse.json(ok(me))
    }),
    http.post(`${BASE}/api/auth/change-password`, async () => {
      seen.pwTimes += 1
      return HttpResponse.json(ok(null))
    }),
  )
  return seen
}

describe('#4 只提交改动过的那几个字段', () => {
  it('一个都没改时不发请求，只说一句没有改动', async () => {
    const user = userEvent.setup()
    const seen = mockAuth()

    renderRouted('/me/settings', <SettingsPage />, '/me/settings')
    await screen.findByLabelText('昵称')

    await user.click(screen.getByRole('button', { name: '保存改动' }))

    await waitFor(() => expect(seen.bodies).toHaveLength(0))
    expect(await screen.findByText('没有需要保存的改动。')).toBeInTheDocument()
  })

  it('只改昵称 → body 里只有 nickname，手机号和邮箱的键根本不出现', async () => {
    const user = userEvent.setup()
    const seen = mockAuth()

    renderRouted('/me/settings', <SettingsPage />, '/me/settings')
    const nickname = await screen.findByLabelText('昵称')
    await user.clear(nickname)
    await user.type(nickname, '小李同学')
    await user.click(screen.getByRole('button', { name: '保存改动' }))

    await waitFor(() => expect(seen.bodies).toHaveLength(1))
    // 这一条是这一屏的存亡线：keys 只有 nickname。
    // 一起发三个框的值在这台夹具上看不出问题（发的是同样的值），
    // 但只要后端哪天把「空串」当清空，没碰过的那两列就会在用户不知情时被抹掉。
    expect(seen.bodies[0]).toEqual({ nickname: '小李同学' })
    expect(await screen.findByText('已保存。')).toBeInTheDocument()
  })

  it('清空邮箱发的是 email:""，不是缺这个键 —— 空串和「不动」在后端是两件事', async () => {
    const user = userEvent.setup()
    const seen = mockAuth()

    renderRouted('/me/settings', <SettingsPage />, '/me/settings')
    const email = await screen.findByLabelText('邮箱')
    await user.clear(email)
    await user.click(screen.getByRole('button', { name: '保存改动' }))

    await waitFor(() => expect(seen.bodies).toHaveLength(1))
    expect(Object.keys(seen.bodies[0])).toEqual(['email'])
    expect(seen.bodies[0].email).toBe('')
  })

  it('保存成功后重新读一次 #3：顶栏的昵称靠它跟上，而不是把 #4 的响应塞进 state', async () => {
    const user = userEvent.setup()
    const seen = mockAuth()

    renderRouted('/me/settings', <SettingsPage />, '/me/settings')
    const nickname = await screen.findByLabelText('昵称')
    await user.clear(nickname)
    await user.type(nickname, '改名了')
    await user.click(screen.getByRole('button', { name: '保存改动' }))

    await waitFor(() => expect(seen.bodies).toHaveLength(1))
    // 一次是首屏恢复身份，一次是保存后的 refresh。#3 是全站唯一的身份来源这一点，
    // 在代码里看不出来，在这里数得出来。
    await waitFor(() => expect(seen.meTimes).toBe(2))
  })

  it('昵称太长吃 VALIDATION 时，那句具体原因显示在昵称那一格下面', async () => {
    const user = userEvent.setup()
    setToken('jwt.me')
    server.use(
      http.get(`${BASE}/api/auth/me`, () => HttpResponse.json(ok(sampleUser()))),
      http.put(
        `${BASE}/api/auth/me`,
        () =>
          HttpResponse.json(
            envelope('VALIDATION', '昵称最长 32 个字符', 400, {
              errors: [{ field: 'nickname', msg: '最多 32 个字符' }],
            }).body,
            { status: 400 },
          ),
      ),
    )

    renderRouted('/me/settings', <SettingsPage />, '/me/settings')
    const nickname = await screen.findByLabelText('昵称')
    await user.clear(nickname)
    await user.type(nickname, '一'.repeat(40))
    await user.click(screen.getByRole('button', { name: '保存改动' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('昵称最长 32 个字符')
    // 字段级定位走的是 ApiError.errorFor(field)，那条路径决定了「该改哪一格」。
    const box = nickname.closest('.field')!
    expect(within(box as HTMLElement).getByText('最多 32 个字符')).toBeInTheDocument()
  })
})

describe('#5 改密码', () => {
  it('本地账号才给这个表单；杭电助手账号连框都不出现', async () => {
    mockAuth(sampleUser({ auth_source: 'hduhelp' }))

    renderRouted('/me/settings', <SettingsPage />, '/me/settings')

    await screen.findByLabelText('昵称')
    expect(screen.queryByLabelText('原密码')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '修改密码' })).not.toBeInTheDocument()
    // 来源那一行要显示对：这一页唯一能让人确认「我登录的是哪个号」的就是它。
    expect(screen.getByText('杭电助手')).toBeInTheDocument()
  })

  it('原密码不对时显示「原密码不正确」，而且这个码不会把人踢出登录', async () => {
    const user = userEvent.setup()
    mockAuth()
    // 这条测试要的是「那个码之后发生了什么」，所以 #5 的 handler 在这里现装：
    // server.use 后装的优先，mockAuth 里那个成功分支这一屏不该走到。
    let pwTimes = 0
    server.use(
      http.post(
        `${BASE}/api/auth/change-password`,
        () => {
          pwTimes += 1
          return HttpResponse.json(
            envelope('OLD_PASSWORD_WRONG', '原密码不正确', 401, {
              errors: [{ field: 'old_password', msg: '原密码不正确' }],
            }).body,
            { status: 401 },
          )
        },
      ),
    )

    renderRouted('/me/settings', <SettingsPage />, '/me/settings')
    await screen.findByLabelText('原密码')
    await user.type(screen.getByLabelText('原密码'), 'wrong-one')
    await user.type(screen.getByLabelText('新密码'), 'a-good-12345')
    await user.click(screen.getByRole('button', { name: '修改密码' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('原密码不正确')
    expect(pwTimes).toBe(1)
    // 这个码不在 client.ts 的 DEAD_SESSION_CODES 里：猜错旧密码不该清掉当前会话，
    // 人还在这页上，改对了再提交一次。哪天有人把 401 一律当成「掉线」处理，这条会红。
    expect(getToken()).toBe('jwt.me')
  })

  it('改成功后清空两个框，不把旧密码留在输入框里', async () => {
    const user = userEvent.setup()
    mockAuth()

    renderRouted('/me/settings', <SettingsPage />, '/me/settings')
    await user.type(await screen.findByLabelText('原密码'), 'old-12345')
    await user.type(screen.getByLabelText('新密码'), 'new-12345')
    await user.click(screen.getByRole('button', { name: '修改密码' }))

    expect(await screen.findByText('密码已更新。')).toBeInTheDocument()
    expect(screen.getByLabelText('原密码')).toHaveValue('')
    expect(screen.getByLabelText('新密码')).toHaveValue('')
  })
})
