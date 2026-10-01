/**
 * inkBrush.js — 水墨笔触工具（Day 12 · 2026-10-01）
 *
 * 起因：终局仪式里的门与楼阁原本是「模糊矩形 / 多边形拼接」（brush + pagoda 两个函数），
 * 用户看过之后判定为「简笔矢量图形拼接」，要求改成水墨画。
 *
 * 按用户拍板拆成两半：
 *   ① 远景山水楼阁 → 用生成的**水墨山水画**作底（见 QuizCeremony 里的 landscape 层）
 *   ② 门          → 本文件用「一笔墨」重画
 *
 * 「一笔墨」的四个要点（缺一个就会退回简笔感）：
 *   · 弧长重采样 —— 控制点先平滑再按固定间距摊匀，墨点才不会「串珠」
 *   · 笔宽包络   —— 起笔顿、中段铺开、收笔提细，线才有笔锋而不是等宽矩形
 *   · 边缘抖动   —— 每点位置与落墨浓度都带扰动，边缘才毛而不僵
 *   · 飞白       —— 随机断墨（两端更易飞白），才有干笔的透气感
 *
 * 全部**离屏预渲染一次**（resize 时重建），主循环只做 drawImage + 变换 ——
 * 所以可以画得很细而不掉帧（门是静态的，没必要每帧重算上千个墨点）。
 */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

/** 种子随机（mulberry32）：同一种子每次重建结果一致，不像每次刷新都换一张画 */
export function makeRng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Catmull-Rom 采样：控制点 → 平滑点列（曲线过控制点，不会有 Catmull 的抖动感） */
export function samplePath(ctrl, per = 16) {
  const n = ctrl.length
  if (n < 2) return ctrl.map((p) => [p[0], p[1]])
  const out = []
  for (let i = 0; i < n - 1; i++) {
    const p0 = ctrl[Math.max(0, i - 1)]
    const p1 = ctrl[i]
    const p2 = ctrl[i + 1]
    const p3 = ctrl[Math.min(n - 1, i + 2)]
    const last = i === n - 2
    const steps = last ? per : per - 1
    for (let s = 0; s <= steps; s++) {
      const t = s / per
      const t2 = t * t
      const t3 = t2 * t
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ])
    }
  }
  return out
}

/** 弧长重采样：按固定间距把点列摊匀（间距取笔宽的一部分，墨点才连成线而不是串珠） */
function resample(pts, step) {
  const out = [pts[0]]
  let acc = 0
  let cx = pts[0][0]
  let cy = pts[0][1]
  for (let i = 1; i < pts.length; i++) {
    let dx = pts[i][0] - cx
    let dy = pts[i][1] - cy
    let d = Math.hypot(dx, dy)
    while (acc + d >= step && d > 1e-6) {
      const k = (step - acc) / d
      cx += dx * k
      cy += dy * k
      out.push([cx, cy])
      dx = pts[i][0] - cx
      dy = pts[i][1] - cy
      d = Math.hypot(dx, dy)
      acc = 0
    }
    acc += d
    cx = pts[i][0]
    cy = pts[i][1]
  }
  const last = pts[pts.length - 1]
  if (Math.hypot(last[0] - out[out.length - 1][0], last[1] - out[out.length - 1][1]) > step * 0.35) out.push(last)
  return out
}

/**
 * 平滑起伏：几个随机相位的低频正弦叠加，返回 t∈[0,1] → 约 [-1,1] 的函数。
 * 笔缘的「毛」靠它 —— 用白噪声抖会得到锯齿（相邻两点差出整个幅度），
 * 用这个才是一条抖的线。
 */
export function mkWave(rng = Math.random) {
  const f = [1.6 + rng() * 1.5, 3.1 + rng() * 2.2, 5.9 + rng() * 3.6]
  const ph = [rng() * 6.283, rng() * 6.283, rng() * 6.283]
  const am = [0.52, 0.32, 0.16]
  return (t) =>
    Math.sin(t * f[0] + ph[0]) * am[0] + Math.sin(t * f[1] + ph[1]) * am[1] + Math.sin(t * f[2] + ph[2]) * am[2]
}

/** 一个软墨点（苔点 / 墨积 / 笔触的基本单元） */
export function inkDot(c, x, y, r, rgb, a) {
  if (a <= 0.005 || r <= 0) return
  const g = c.createRadialGradient(x, y, 0, x, y, r)
  g.addColorStop(0, `rgba(${rgb}, ${a})`)
  g.addColorStop(0.42, `rgba(${rgb}, ${a * 0.82})`)
  g.addColorStop(0.74, `rgba(${rgb}, ${a * 0.3})`)
  g.addColorStop(1, `rgba(${rgb}, 0)`)
  c.fillStyle = g
  c.beginPath()
  c.arc(x, y, r, 0, Math.PI * 2)
  c.fill()
}

/** 笔宽包络：中段铺开、两端按 taper 收势（taper 越大收得越尖） */
const envelope = (t, taper) => Math.pow(Math.sin(Math.PI * clamp(t, 0.004, 0.996)), taper)

/**
 * 一笔墨：沿控制点画一条有笔锋的墨线。
 *
 * **为什么不是「沿路撒墨点」**：撒点的做法每点都是独立的软圆，
 * 无论怎么调都会留下串珠感（试过，被自己否掉）。这里改成 —
 * 先按笔宽包络在路径两侧算出左右两条边界，连成一个**封闭带**填掉（这一层是「湿墨」，连续、有笔锋），
 * 再用 `destination-out` 在带上啃出飞白（这一层是「枯笔」）。
 * 湿墨打底 + 枯笔破边，才是宣纸上的那一道。
 *
 *   w      笔宽
 *   taper  收势：小=粗头粗尾（梁柱），约 1 是正常起收，大=撇捺式尖收（翘角、枝）
 *   wob    边界抖动幅度（相对笔宽）—— 给边缘毛刺感，别调太大
 *   dry    飞白强度（0~1）：带端更容易被啃透
 *   blur   洇边像素
 *   grain  落墨浓淡起伏
 */
export function inkStroke(c, ctrl, o = {}) {
  const {
    w = 10,
    rgb = '52, 48, 43',
    a = 1,
    taper = 1,
    wob = 0.16,
    dry = 0,
    blur = 0,
    grain = 0.22,
    rng = Math.random,
  } = o
  if (a <= 0.005 || w <= 0) return
  const pts = resample(samplePath(ctrl, o.per || 18), Math.max(1, w * 0.13))
  const n = pts.length
  if (n < 2) return

  // ① 左右边界：沿法线偏移半个笔宽，边界自身带起伏 → 边缘才毛（起伏见 mkWave 的注释）
  const waveL = mkWave(rng)
  const waveR = mkWave(rng)

  const L = []
  const R = []
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1)
    const hw = w * 0.5 * (0.26 + 0.74 * envelope(t, taper))
    const p0 = pts[Math.max(0, i - 1)]
    const p1 = pts[Math.min(n - 1, i + 1)]
    let dx = p1[0] - p0[0]
    let dy = p1[1] - p0[1]
    const len = Math.hypot(dx, dy) || 1
    dx /= len
    dy /= len
    // 两条边各自起伏 → 带子整体微微一扭，像手腕的摆动
    const jl = waveL(t) * w * wob
    const jr = waveR(t) * w * wob
    L.push([pts[i][0] - dy * (hw + jl), pts[i][1] + dx * (hw + jl)])
    R.push([pts[i][0] + dy * (hw + jr), pts[i][1] - dx * (hw + jr)])
  }

  c.save()
  if (blur > 0) {
    try {
      c.filter = `blur(${blur.toFixed(2)}px)`
    } catch {
      /* 不支持就退化为硬边 */
    }
  }

  // ② 湿墨带：整条一次填掉（分段填会在接缝处露出「竹节」，反而假）
  c.globalAlpha = a
  c.fillStyle = `rgb(${rgb})`
  c.beginPath()
  c.moveTo(L[0][0], L[0][1])
  for (let i = 1; i < n; i++) c.lineTo(L[i][0], L[i][1])
  for (let i = n - 1; i >= 0; i--) c.lineTo(R[i][0], R[i][1])
  c.closePath()
  c.fill()

  // ③ 浓淡：沿路撒一点更浓的墨，让墨色不匀（一笔里本来就不可能匀）
  if (grain > 0) {
    for (let i = 0; i < n; i += 2) {
      const t = i / (n - 1)
      const hw = w * 0.5 * (0.26 + 0.74 * envelope(t, taper))
      if (rng() > grain) continue
      inkDot(c, pts[i][0] + (rng() - 0.5) * hw, pts[i][1] + (rng() - 0.5) * hw * 0.6, hw * (0.7 + rng() * 0.6), rgb, a * 0.5)
    }
  }

  // ④ 飞白：在本层啃掉（层是透明的，啃完就透出后面的东西 —— 正好是枯笔的意思）
  //    要点是**成簇**：干笔是「这儿擦过一段、那儿又实了」，
  //    均匀撒洞只会得到一张筛子（试过，屋顶变得像顶了一头雪花）。
  if (dry > 0) {
    c.globalAlpha = 1
    c.globalCompositeOperation = 'destination-out'
    const clusters = Math.max(1, Math.round(dry * 4))
    for (let q = 0; q < clusters; q++) {
      const i = 1 + Math.floor(rng() * (n - 2))
      const t = i / (n - 1)
      const env = envelope(t, taper)
      if (rng() > 0.35 + 0.65 * (1 - env)) continue // 两端更容易飞白（提笔）
      const hw = w * 0.5 * (0.26 + 0.74 * env)
      const cxp = pts[i][0]
      const cyp = pts[i][1]
      const cnt = 2 + Math.floor(rng() * 4)
      for (let k = 0; k < cnt; k++) {
        // 沿笔画方向拉长一点 → 像一笔擦过去，而不是一个个圆孔
        const hx = cxp + (rng() - 0.5) * hw * 1.5
        const hy = cyp + (rng() - 0.5) * w * 2.2
        const r = w * (0.05 + rng() * 0.11)
        const g = c.createRadialGradient(hx, hy, 0, hx, hy, r)
        g.addColorStop(0, `rgba(0,0,0,${0.3 + rng() * 0.4})`)
        g.addColorStop(0.65, `rgba(0,0,0,${0.1 + rng() * 0.12})`)
        g.addColorStop(1, 'rgba(0,0,0,0)')
        c.fillStyle = g
        c.beginPath()
        c.arc(hx, hy, r, 0, Math.PI * 2)
        c.fill()
      }
    }
    c.globalCompositeOperation = 'source-over'
  }
  c.restore()
}

/**
 * 竖扫笔：给一块横向起伏的面（屋面、台基、山影）上墨。
 * 逐列画竖笔，落笔位置与浓淡都带扰动 → 面的边缘自然、内部有笔痕，不是一块平涂。
 *   topFn / botFn 给 x 处的上下边界
 */
export function sweepColumns(c, x0, x1, topFn, botFn, o = {}) {
  const { w = 8, rgb = '52, 48, 43', a = 1, rng = Math.random, dry = 0, blur = 1.4, wob = 0.22 } = o
  if (a <= 0.005 || x1 <= x0) return
  const steps = Math.max(10, Math.round((x1 - x0) / Math.max(2, w * 0.5)))
  const waveT = mkWave(rng) // 上下边界用平滑起伏，不是白噪声（否则整片墨长出一排尖齿）
  const waveB = mkWave(rng)
  const top = []
  const bot = []
  for (let i = 0; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps
    const t = i / steps
    top.push([x, topFn(x) + waveT(t) * w * wob])
    bot.push([x, botFn(x) + waveB(t) * w * wob])
  }

  c.save()
  if (blur > 0) {
    try {
      c.filter = `blur(${blur.toFixed(2)}px)`
    } catch {
      /* 忽略 */
    }
  }
  // ① 整片填掉（上下边界各自抖动）—— 一片墨，不是一排排线
  c.globalAlpha = a * 0.82
  c.fillStyle = `rgb(${rgb})`
  c.beginPath()
  c.moveTo(top[0][0], top[0][1])
  for (let i = 1; i <= steps; i++) c.lineTo(top[i][0], top[i][1])
  for (let i = steps; i >= 0; i--) c.lineTo(bot[i][0], bot[i][1])
  c.closePath()
  c.fill()

  // ② 笔痕：随机疏密、随机浓淡的竖条（一列一列「扫」过去，不是等距的排线）
  c.globalAlpha = 1
  for (let i = 0; i <= steps; i += 2) {
    if (rng() > 0.62) continue
    const [x, yt] = top[i]
    const yb = bot[i][1]
    if (yb - yt <= 1) continue
    const aa = a * (0.1 + rng() * 0.3)
    const ww = w * (0.5 + rng() * 0.8)
    const g = c.createLinearGradient(x, yt, x, yb)
    g.addColorStop(0, `rgba(${rgb}, ${aa * 0.25})`)
    g.addColorStop(0.22, `rgba(${rgb}, ${aa})`)
    g.addColorStop(0.82, `rgba(${rgb}, ${aa})`)
    g.addColorStop(1, `rgba(${rgb}, ${aa * 0.35})`)
    c.fillStyle = g
    c.beginPath()
    c.ellipse(x, (yt + yb) / 2, ww * 0.5, (yb - yt) / 2, 0, 0, Math.PI * 2)
    c.fill()
  }

  // ③ 飞白：同样成簇（均匀撒洞会让整片墨变成筛子）
  if (dry > 0) {
    c.globalCompositeOperation = 'destination-out'
    const clusters = Math.max(1, Math.round(dry * 3.5))
    for (let q = 0; q < clusters; q++) {
      const i = Math.floor(rng() * (steps + 1))
      const cxp = top[i][0]
      const ytc = top[i][1]
      const h = Math.max(1, bot[i][1] - ytc)
      const cnt = 3 + Math.floor(rng() * 5)
      for (let k = 0; k < cnt; k++) {
        const x = cxp + (rng() - 0.5) * w * 1.6
        const y = ytc + rng() * h
        const r = w * (0.14 + rng() * 0.3)
        const g = c.createRadialGradient(x, y, 0, x, y, r)
        g.addColorStop(0, `rgba(0,0,0,${0.26 + rng() * 0.36})`)
        g.addColorStop(0.7, `rgba(0,0,0,${0.08 + rng() * 0.1})`)
        g.addColorStop(1, 'rgba(0,0,0,0)')
        c.fillStyle = g
        c.beginPath()
        c.arc(x, y, r, 0, Math.PI * 2)
        c.fill()
      }
    }
    c.globalCompositeOperation = 'source-over'
  }
  c.restore()
}

/* ---------------- 门：一次性画好，缓存成一张位图 ---------------- */

/** 水墨调色（与 QuizCeremony 的 C 同源，刻意避纯黑） */
const G = {
  inkSoft: '84, 79, 71',
  ink1: '52, 48, 43',
  ink2: '34, 31, 28',
  red: '150, 62, 48',
}

/**
 * 预渲染「水墨门」。
 * 造型沿用原来那套构图（两柱 + 楣梁 + 飞檐 + 台基，比例不变，进门运镜的感觉才一致），
 * 但每一处都改成毛笔笔触：柱是竖笔（带亮心与柱脚墨积）、梁是横笔、屋面是竖扫笔、
 * 两端是撇捺式翘角，另有瓦垄、门框细笔、一点朱红与几粒苔点。
 * 全部顶点落在几何位置上，随机只作用在**笔意**（抖动、飞白、浓淡）上 —— 所以远看形准、近看是画的。
 */
export function buildGateLayer(W, H, S, opts = {}) {
  const RS = opts.rs || 1.6
  const cv = document.createElement('canvas')
  cv.width = Math.max(1, Math.round(W * RS))
  cv.height = Math.max(1, Math.round(H * RS))
  const c = cv.getContext('2d')
  c.setTransform(RS, 0, 0, RS, 0, 0)
  const rng = makeRng(opts.seed || 0x9e3779b9)

  const cx = W / 2
  const cy = H * 0.58
  const doorW = Math.min(W * 0.3, 380 * S)
  const doorH = Math.min(H * 0.46, 470 * S)
  const oyTop = cy - doorH * 0.3
  const oyBot = cy + doorH * 0.64

  const pw = doorW * 0.22 // 柱宽
  const hx = doorW * 0.8 // 屋顶半宽
  const roofH = doorH * 0.3 // 屋面高（0.19 时屋顶扁得像块板，压不住下面两根柱子）
  const eaveAmp = doorH * 0.068 // 檐口两端上翘量（0.13 时屋顶会翘成两把镰刀）

  // 檐口线：中间平、两端翘（中式飞檐的正面观）
  const eaveY = (u) => oyTop - doorH * 0.215 - eaveAmp * Math.pow(Math.abs(u * 2 - 1), 3.4)
  const roofU = (x) => clamp((x - (cx - hx)) / (2 * hx), 0, 1)

  /* ---- ① 台基（先落，柱子压在它上面）---- */
  inkStroke(
    c,
    [
      [cx - doorW * 0.92, oyBot + doorH * 0.13],
      [cx - doorW * 0.42, oyBot + doorH * 0.148],
      [cx, oyBot + doorH * 0.154],
      [cx + doorW * 0.42, oyBot + doorH * 0.148],
      [cx + doorW * 0.92, oyBot + doorH * 0.13],
    ],
    { w: doorH * 0.07, rgb: G.inkSoft, a: 0.5, taper: 0.12, wob: 0.28, dry: 0.7, blur: 1.2, rng }
  )
  // 台基下面的两级台阶（更淡，收边）
  for (let i = 1; i <= 2; i++) {
    const yy = oyBot + doorH * (0.155 + i * 0.052)
    const halfW = doorW * (0.82 - i * 0.1)
    inkStroke(
      c,
      [
        [cx - halfW, yy],
        [cx, yy + doorH * 0.006],
        [cx + halfW, yy],
      ],
      { w: doorH * 0.024, rgb: G.inkSoft, a: 0.26 - i * 0.06, taper: 0.28, wob: 0.4, dry: 0.5, rng }
    )
  }

  /* ---- ② 屋面：一坡两垂（正脊那段平，向两端落下去）---- */
  const roofTop = (x) => {
    const k = Math.abs(x - cx) / hx
    const flat = 0.34 // 正脊覆盖的宽度比例
    const drop = k <= flat ? 0 : Math.pow((k - flat) / (1 - flat), 0.85)
    return eaveY(roofU(x)) - roofH * (1 - drop)
  }
  const roofBot = (x) => eaveY(roofU(x))
  sweepColumns(c, cx - hx, cx + hx, roofTop, roofBot, { w: doorH * 0.075, rgb: G.ink1, a: 0.72, dry: 0.55, rng })
  // 左半再压一层浓墨（背光面）→ 屋面有明暗，不是一块平墨
  sweepColumns(c, cx - hx * 0.9, cx - hx * 0.26, (x) => roofTop(x) + roofH * 0.12, (x) => roofBot(x) - doorH * 0.008, {
    w: doorH * 0.055,
    rgb: G.ink2,
    a: 0.3,
    dry: 0.45,
    rng,
  })
  // 檐口：一条压住整个屋面的浓墨带（两端随飞檐上翘）
  {
    const ctrl = []
    for (let i = 0; i <= 16; i++) {
      const u = i / 16
      ctrl.push([cx - hx + 2 * hx * u, eaveY(u) + doorH * 0.004])
    }
    inkStroke(c, ctrl, { w: doorH * 0.06, rgb: G.ink2, a: 0.88, taper: 0.1, wob: 0.18, dry: 0.45, blur: 0.8, rng })
  }
  // 正脊：屋面顶端一条单独的横笔，两端收细
  inkStroke(
    c,
    [
      [cx - hx * 0.42, roofTop(cx - hx * 0.42) + roofH * 0.02],
      [cx, roofTop(cx) - doorH * 0.014],
      [cx + hx * 0.42, roofTop(cx + hx * 0.42) + roofH * 0.02],
    ],
    { w: doorH * 0.05, rgb: G.ink2, a: 0.88, taper: 0.42, wob: 0.16, dry: 0.35, rng }
  )
  /* ---- ③ 两端的翘角：撇捺式一笔，起笔重、收笔尖 ---- */
  for (const side of [-1, 1]) {
    const ux = cx + side * hx
    const uy = eaveY(side < 0 ? 0 : 1)
    inkStroke(
      c,
      [
        [ux - side * hx * 0.08, uy + doorH * 0.012],
        [ux + side * hx * 0.16, uy - doorH * 0.022],
        [ux + side * hx * 0.28, uy - doorH * 0.072],
      ],
      { w: doorH * 0.062, rgb: G.ink1, a: 0.8, taper: 1.2, wob: 0.18, dry: 0.4, rng }
    )
  }

  /* ---- ④ 楣梁：一横笔，两端略收 ---- */
  inkStroke(
    c,
    [
      [cx - doorW * 0.5 - pw * 1.5, oyTop - doorH * 0.124],
      [cx - doorW * 0.25, oyTop - doorH * 0.138],
      [cx, oyTop - doorH * 0.142],
      [cx + doorW * 0.25, oyTop - doorH * 0.138],
      [cx + doorW * 0.5 + pw * 1.5, oyTop - doorH * 0.124],
    ],
    { w: doorH * 0.092, rgb: G.ink1, a: 0.86, taper: 0.11, wob: 0.18, dry: 0.4, blur: 0.7, rng }
  )
  // 梁下的一线淡墨（梁的厚度）
  inkStroke(
    c,
    [
      [cx - doorW * 0.5 - pw * 1.2, oyTop - doorH * 0.072],
      [cx, oyTop - doorH * 0.078],
      [cx + doorW * 0.5 + pw * 1.2, oyTop - doorH * 0.072],
    ],
    { w: doorH * 0.024, rgb: G.inkSoft, a: 0.34, taper: 0.32, wob: 0.38, dry: 0.5, rng }
  )

  /* ---- ⑤ 左右立柱：竖笔 + 高光 + 柱脚墨积 ---- */
  for (const side of [-1, 1]) {
    const xc = cx + side * (doorW / 2 + pw / 2)
    const top = oyTop - doorH * 0.1
    const bot = oyBot + doorH * 0.155
    inkStroke(
      c,
      [
        [xc - side * pw * 0.05, top + doorH * 0.02],
        [xc + side * pw * 0.045, (top + bot) / 2],
        [xc - side * pw * 0.03, bot - doorH * 0.01],
      ],
      { w: pw * 1.05, rgb: G.ink1, a: 0.9, taper: 0.06, wob: 0.11, dry: 0.28, blur: 0.6, rng }
    )
    // 柱面高光：在本层擦出一道竖亮带 —— 柱子才是圆的。
    // （叠浅墨是没用的，越叠越黑；要让「亮」只能减墨）
    {
      const hcx = xc - side * pw * 0.12
      const hy0 = top + doorH * 0.07
      const hy1 = bot - doorH * 0.1
      c.save()
      c.globalCompositeOperation = 'destination-out'
      c.translate(hcx, (hy0 + hy1) / 2)
      c.scale(1, Math.max(1, (hy1 - hy0) / (pw * 1.1)))
      const rg = c.createRadialGradient(0, 0, 0, 0, 0, pw * 0.5)
      rg.addColorStop(0, 'rgba(0,0,0,0.26)')
      rg.addColorStop(0.5, 'rgba(0,0,0,0.17)')
      rg.addColorStop(1, 'rgba(0,0,0,0)')
      c.fillStyle = rg
      c.beginPath()
      c.arc(0, 0, pw * 0.5, 0, Math.PI * 2)
      c.fill()
      c.restore()
    }
    // 柱脚墨积（水在脚下积住的那一坨）
    inkDot(c, xc - side * pw * 0.08, bot - doorH * 0.032, pw * 1.15, G.ink2, 0.5)
    inkDot(c, xc + side * pw * 0.2, bot - doorH * 0.058, pw * 0.7, G.ink1, 0.36)
  }

  /* ---- ⑥ 门框内缘：两道细竖笔，交代门洞的纵深 ---- */
  for (const side of [-1, 1]) {
    const x = cx + side * (doorW / 2)
    inkStroke(
      c,
      [
        [x, oyTop - doorH * 0.03],
        [x + side * doorH * 0.006, (oyTop + oyBot) / 2],
        [x - side * doorH * 0.004, oyBot + doorH * 0.11],
      ],
      { w: doorH * 0.016, rgb: G.ink2, a: 0.4, taper: 0.18, wob: 0.4, dry: 0.4, rng }
    )
  }

  /* ---- ⑦ 一点朱红：楣下那一线，是全画唯一的暖色 ---- */
  inkStroke(
    c,
    [
      [cx - doorW * 0.48, oyTop + doorH * 0.012],
      [cx - doorW * 0.16, oyTop + doorH * 0.017],
      [cx + doorW * 0.16, oyTop + doorH * 0.017],
      [cx + doorW * 0.48, oyTop + doorH * 0.012],
    ],
    { w: doorH * 0.024, rgb: G.red, a: 0.52, taper: 0.2, wob: 0.3, dry: 0.5, rng }
  )

  /* ---- ⑧ 苔点：檐下与台基边点几粒，山水画里「醒笔」的作用 ---- */
  for (let i = 0; i < 16; i++) {
    const left = rng() < 0.5
    const x = cx + (left ? -1 : 1) * (doorW * (0.52 + rng() * 0.55))
    const y = oyBot + doorH * (0.02 + rng() * 0.16)
    inkDot(c, x, y, doorH * (0.008 + rng() * 0.012), G.ink2, 0.3 + rng() * 0.28)
  }

  return cv
}

/* ---------------- 山水图：预渲染 + 四边羽化 ---------------- */

/**
 * 把生成的水墨山水画铺满画布并做**四边线性羽化**（destination-in 是累乘的，
 * 依次填四条边就得到平滑的中间实、四周透明），这样可以整层淡入淡出，
 * 与宣纸底之间不会出现一条直角硬边。
 */
export function buildLandscapeLayer(img, W, H, feather = 0.16) {
  const cv = document.createElement('canvas')
  cv.width = Math.max(1, Math.round(W))
  cv.height = Math.max(1, Math.round(H))
  const c = cv.getContext('2d')
  const iw = img.naturalWidth || img.width
  const ih = img.naturalHeight || img.height
  if (!iw || !ih) return cv
  // cover：铺满画布，多余部分居中裁掉
  const sc = Math.max(W / iw, H / ih)
  const dw = iw * sc
  const dh = ih * sc
  c.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh)
  // 四边线性羽化。这里必须用 **destination-out**（源的不透明度 = 要擦掉的程度），
  // 四条边带各自「外缘全擦、内缘不擦」，叠起来就是中间实、四周渐透。
  //
  // ⚠️ 不能用 destination-in —— 它是「源没盖到的地方一律清空」，
  // 而四条边带盖不到的恰好是画面正中间，结果是整张山水被擦得只剩四个角（踩过一次）。
  c.globalCompositeOperation = 'destination-out'
  const fx = W * feather
  const fy = H * feather
  // [填充区 rect, 渐变起止点]  —— 渐变 stop0 落在画布最外缘
  const bands = [
    [[0, 0, W, fy], [0, 0, 0, fy]], // 上
    [[0, H - fy, W, fy], [0, H, 0, H - fy]], // 下
    [[0, 0, fx, H], [0, 0, fx, 0]], // 左
    [[W - fx, 0, fx, H], [W, 0, W - fx, 0]], // 右
  ]
  for (const [[rx, ry, rw, rh], [gx0, gy0, gx1, gy1]] of bands) {
    const g = c.createLinearGradient(gx0, gy0, gx1, gy1)
    g.addColorStop(0, 'rgba(0,0,0,1)') // 最外缘：擦干净
    g.addColorStop(1, 'rgba(0,0,0,0)') // 内缘：不动
    c.fillStyle = g
    c.fillRect(rx, ry, rw, rh)
  }
  c.globalCompositeOperation = 'source-over'
  return cv
}
