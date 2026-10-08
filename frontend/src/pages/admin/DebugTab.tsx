// src/pages/admin/DebugTab.tsx —— #39 运行时配置（只读，而且**只在开发环境存在**）。
//
// 这一页存在的理由很具体：§9 那条「调参先看是哪个信号不对」要求
// 「现在跑的展示线到底是 0.55 还是 0.60」能在界面上一眼问到，而不是去翻 .env 或者猜加载了哪一份。
//
// 三个坑决定这一页长这样：
// ① 生产环境里这条路由**压根没注册**（router.go 那句 `if !cfg.IsProd()`），拿到的是 404 不是 403。
//    所以「这一页显示不出来」必须分成两句不同的话说清楚，混成一句「加载失败」就变成假故障。
// ② 后端 config.Redacted() 是唯一一处打码的出口，`***` 和 `(未配置)` 是它写出来的结果。
//    前端这里**不再打一遍码**（两份「哪些键算敏感」迟早会不一致），也不许把它显示成空。
// ③ 匹配那四个参数后端全吐（时间容差是 2026-10-08 才补进那份 map 的）。所以这一页少一个数
//    就是这一张表少写了一行，而不是后端没给 —— 兜住这件事的是下面的 leftovers()，
//    它读的是接口里**这份声明不认识**的那些键。
import { useCallback, useEffect, useState } from 'react'
import { getDebugConfig } from '../../api/admin'
import { ApiError } from '../../api/client'
import { Code } from '../../api/codes'
import { errorText, requestIdOf } from '../../api/errorText'
import { Alert } from './parts'
import type { DebugConfig } from '../../api/types'

interface Row {
  key: keyof DebugConfig
  label: string
  /** 能改它的那个环境变量名。只有匹配那一组写得出，因为调参就是冲着它们去的。 */
  env?: string
  /** 后端已经打过码的那几列：值不是内容，是「配了没配」。 */
  masked?: boolean
}

const GROUPS: { title: string; rows: Row[] }[] = [
  {
    title: '运行环境',
    rows: [
      { key: 'env', label: '当前环境' },
      { key: 'port', label: '监听端口' },
      { key: 'log_level', label: '日志级别' },
    ],
  },
  {
    title: '匹配（这一页主要就是为这四个数存在的）',
    rows: [
      { key: 'match_show_threshold', label: '展示线', env: 'MATCH_SHOW_THRESHOLD' },
      { key: 'match_notify_threshold', label: '通知线', env: 'MATCH_NOTIFY_THRESHOLD' },
      { key: 'match_decay_days', label: '衰减天数', env: 'MATCH_DECAY_DAYS' },
      { key: 'match_time_tolerance_hours', label: '时间容差（小时）', env: 'MATCH_TIME_TOLERANCE_HOURS' },
    ],
  },
  {
    title: '数据库',
    rows: [
      { key: 'db_host', label: '主机' },
      { key: 'db_port', label: '端口' },
      { key: 'db_user', label: '用户' },
      { key: 'db_name', label: '库名' },
      { key: 'db_password', label: '密码', masked: true },
    ],
  },
  {
    title: '登录态',
    rows: [
      { key: 'jwt_expire_hours', label: 'token 有效期（小时）' },
      { key: 'jwt_secret', label: '签发密钥', masked: true },
    ],
  },
  {
    title: '上传',
    rows: [{ key: 'upload_dir', label: '图片目录' }],
  },
  {
    title: '杭电助手 SSO（M8，现在多半全是「未配置」）',
    rows: [
      { key: 'hduhelp_app_id', label: 'App ID', masked: true },
      { key: 'hduhelp_app_secret', label: 'App Secret', masked: true },
      { key: 'sso_state_key', label: 'state 加密密钥', masked: true },
    ],
  },
]

/** 这一页还没归组的键。后端 Redacted() 加一列而这里没跟上时，
 *  宁可把它摊在「没归组」那一栏，也不要让人以为「页面上没有 = 后端没吐」。
 *  所以这里绕过了 DebugConfig 那层类型：读的正是**这个接口不认识的那几个键**，
 *  它们能不能显示出来，不该由前端这份声明说了算。 */
function leftovers(data: DebugConfig): { key: string; value: string }[] {
  const listed = new Set<string>(GROUPS.flatMap((g) => g.rows.map((r) => r.key as string)))
  const raw = data as unknown as Record<string, unknown>
  return Object.keys(raw)
    .filter((k) => !listed.has(k))
    .map((k) => ({ key: k, value: String(raw[k]) }))
}

export default function DebugTab() {
  const [data, setData] = useState<DebugConfig | null>(null)
  const [error, setError] = useState('')
  const [errorId, setErrorId] = useState('')
  const [gate, setGate] = useState<'none' | 'no-route' | 'forbidden'>('none')
  const [seq, setSeq] = useState(0)

  const load = useCallback(() => {
    let dead = false
    getDebugConfig()
      .then((res) => {
        if (dead) return
        setData(res)
        setError('')
        setGate('none')
      })
      .catch((err) => {
        if (dead) return
        setData(null)
        // 404 和 403 是两件不同的事，必须说两句不同的话：
        // 404 是「这条路由在这个环境里不存在」（正常，生产环境就该这样），
        // 403 是「路由在，但身份或环境这一关没过」（handler 里那道 prod 闸，或角色不对）。
        if (err instanceof ApiError && err.code === Code.NOT_FOUND) setGate('no-route')
        else if (err instanceof ApiError && err.code === Code.FORBIDDEN) setGate('forbidden')
        else setError(errorText(err))
        setErrorId(requestIdOf(err))
      })
    return () => {
      dead = true
    }
  }, [])

  // seq 是「重读一次」的扳机：load 不读它，读的是**它的变化**，而那件事只有 effect 的依赖表表达得了。
  useEffect(() => {
    load()
  }, [load, seq])

  return (
    <>
      <Alert error={error} errorId={errorId} />

      {gate === 'no-route' && (
        <p className="hint">
          这一条端点<strong>只在开发环境注册</strong>（后端 router.go 那句 `if !cfg.IsProd()`）。
          生产环境里它不存在，所以你拿到的是 404 而不是 403 ——
          这一页在生产环境永远显示这句话，那不是坏了，那正是「少一条路由就少一个攻击面」的样子。
        </p>
      )}

      {gate === 'forbidden' && (
        <p className="hint">
          这条路由注册了，但这一关没过：它既要管理员身份，handler 里还有一道「生产环境直接关闭」的闸。
          如果你确实在开发环境、角色也确实是管理员，那这两道闸里有一道配错了，值得去查。
        </p>
      )}

      {data && (
        <>
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h2>{g.title}</h2>
              <dl className="kv">
                {g.rows.map((r) => (
                  <div className="kv-pair" key={r.key}>
                    <dt>
                      {r.label}
                      {r.env && <span className="muted">（{r.env}）</span>}
                    </dt>
                    <dd>
                      {String(data[r.key])}
                      {r.masked && <span className="muted">　后端打码后的样子，不是内容</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}

          {leftovers(data).length > 0 && (
            <section>
              <h2>这一页还没归组的键</h2>
              <dl className="kv">
                {leftovers(data).map(({ key, value }) => (
                  <div className="kv-pair" key={key}>
                    <dt>{key}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="muted">
                这几列是后端吐出来、但这份表还没列进去的。它们是真的生效着，只是这里没人给它们起中文名 ——
                别把「这一页没写」当成「后端没有这一项」。
              </p>
            </section>
          )}

          <p className="adm-actions">
            <button className="btn" type="button" onClick={() => setSeq((n) => n + 1)}>
              重读一次
            </button>
          </p>

          <p className="hint">
            这一页没有任何写入的按钮：配置进的是环境变量，改完要重启进程才生效，
            而这一条只是把<strong>已经生效的那一份</strong>念给你听。
            匹配的那四个数各自对应一个环境变量，改哪一个都先回这里看一眼现在是多少。
          </p>
        </>
      )}

      {!data && gate === 'none' && !error && <p className="muted">正在加载…</p>}
    </>
  )
}
