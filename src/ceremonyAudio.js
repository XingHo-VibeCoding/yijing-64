/**
 * ceremonyAudio.js — 终局仪式音效（Day 12 · 2026-10-01 · 用户要求「加音效」）
 *
 * 全部**程序化合成**，不引入任何音频文件：
 *   · 古琴   —— Karplus-Strong 拨弦（噪声激励 + 延迟线衰减）
 *   · 清铃   —— 几个不成整数倍的正弦泛音，各自不同衰减速率
 *   · 风声   —— 白噪声 → 带通 → 低通，再用一个慢 LFO 让它一呼一吸
 *
 * 零资源 = 零加载等待、零体积、也不会被静态托管的 MIME 坑绊住。
 *
 * 自动播放：仪式前必然已经点过「提交」，页面早已获得 sticky user activation，
 * 所以挂载时直接 resume 就能出声；万一还是 suspended，挂一个一次性的首次交互兜底。
 */

const MUTE_KEY = 'yijing.audio.muted.v1'

let actx = null
let master = null
let wind = null // { src, gain, lfo }
let muted = false
try {
  muted = localStorage.getItem(MUTE_KEY) === '1'
} catch {
  muted = false
}

const MASTER = 0.72 // 比原来的 0.9 低：湿声会叠加响度，留出余量才不吵

/**
 * 程序生成一段「大空间」脉冲响应：指数衰减的噪声尾巴 + 22ms 预延迟。
 * 空灵的第一要素就是**混响** —— 干声永远显得「近、吵」；
 * 而空灵要的是「长而柔」，所以尾巴衰减得慢（2.8 次幂）而不是「啪」地断掉。
 */
function makeIR(a, seconds = 3.8, decay = 2.8) {
  const sr = a.sampleRate
  const len = Math.max(1, Math.round(sr * seconds))
  const buf = a.createBuffer(2, len, sr)
  const pre = Math.round(sr * 0.022)
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch)
    for (let i = 0; i < len; i++) {
      if (i < pre) {
        d[i] = 0
        continue
      }
      const t = (i - pre) / (len - pre)
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay)
    }
  }
  return buf
}

let broken = false // 一旦建不起来就彻底放弃，别再反复试（无头 / 无音频设备的环境）
const supported = () =>
  !broken && typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext)

/** 懒创建音频上下文（浏览器要求必须在用户手势链路里创建 / 恢复） */
function ctx() {
  if (!supported()) return null
  try {
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext
      actx = new AC()
      master = actx.createGain()
      master.gain.value = muted ? 0 : MASTER
      // 干 / 湿两条支路。混响不是「加效果」，是把声音从「贴脸」推到「远处」——
      // 用户说的「嘈杂」，一半是干声太近造成的。
      const dry = actx.createGain()
      dry.gain.value = 0.6
      const wet = actx.createGain()
      wet.gain.value = 0.45
      const conv = actx.createConvolver()
      conv.buffer = makeIR(actx)
      const damp = actx.createBiquadFilter()
      damp.type = 'lowpass'
      damp.frequency.value = 7000 // 削掉混响尾巴里最刺的那点高频
      master.connect(dry)
      dry.connect(actx.destination)
      master.connect(wet)
      wet.connect(conv)
      conv.connect(damp)
      damp.connect(actx.destination)
    }
    if (actx.state === 'suspended') actx.resume().catch(() => {})
  } catch {
    // 没有音频输出设备（无头浏览器、服务器）时不能让整个仪式崩掉 —— 静默降级
    broken = true
    actx = null
    master = null
    return null
  }
  return actx
}

export function isMuted() {
  return muted
}

export function setMuted(m) {
  muted = !!m
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0')
  } catch {
    /* 隐私模式下忽略 */
  }
  if (master && actx) {
    master.gain.cancelScheduledValues(actx.currentTime)
    master.gain.linearRampToValueAtTime(muted ? 0 : MASTER, actx.currentTime + 0.25)
  }
}

export function toggleMuted() {
  setMuted(!muted)
  return muted
}

/** 挂载仪式时调用一次：把上下文建起来，并处理「还没被允许自动播放」的兜底 */
export function primeCeremonyAudio() {
  const a = ctx()
  if (!a) return
  if (a.state !== 'running') {
    const kick = () => {
      if (actx && actx.state === 'suspended') actx.resume().catch(() => {})
      window.removeEventListener('pointerdown', kick)
      window.removeEventListener('keydown', kick)
    }
    window.addEventListener('pointerdown', kick)
    window.addEventListener('keydown', kick)
  }
}

/* ---------------- 合成基元 ---------------- */

/** Karplus-Strong 拨弦：噪声激励跑一遍平均衰减的延迟线，出来就是拨弦音 */
function pluckBuffer(a, freq, dur) {
  const sr = a.sampleRate
  const N = Math.max(2, Math.round(sr / freq))
  const len = Math.max(1, Math.round(sr * dur))
  const buf = a.createBuffer(1, len, sr)
  const d = buf.getChannelData(0)
  const ring = new Float32Array(N)
  // 激励用**低通白噪声**：纯白噪声的起音是「嚓」的一声，很吵；滤过之后才是「拨」
  let lp = 0
  for (let i = 0; i < N; i++) {
    lp = lp * 0.68 + (Math.random() * 2 - 1) * 0.32
    ring[i] = lp
  }
  let idx = 0
  for (let i = 0; i < len; i++) {
    const cur = ring[idx]
    const nxt = ring[(idx + 1) % N]
    ring[idx] = (cur + nxt) * 0.5 * 0.998 // 0.9965 → 0.998：余韵更长、散得更开
    d[i] = cur
    idx = (idx + 1) % N
  }
  return buf
}

/** 一声古琴：拨弦 + 琴体低通 + 缓慢起音，听感是「泛音在雾里散开」 */
export function pluck(freq, gain = 0.5, dur = 3.4, delay = 0) {
  const a = ctx()
  if (!a || muted) return
  const t0 = a.currentTime + delay
  const src = a.createBufferSource()
  src.buffer = pluckBuffer(a, freq, dur)
  const lp = a.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = Math.min(4000, freq * 9) // 收掉高频：音色从「近」变「远」
  lp.Q.value = 0.4
  const hp = a.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = Math.max(60, freq * 0.5)
  const g = a.createGain()
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012) // 极快起音 = 拨弦的「触」
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  src.connect(hp)
  hp.connect(lp)
  lp.connect(g)
  g.connect(master)
  src.start(t0)
  src.stop(t0 + dur + 0.05)
}

/** 一声清铃：三个不成整数倍的正弦叠加，各自不同衰减 → 金属的「涣」 */
export function bell(base = 1180, gain = 0.22, dur = 3.2, delay = 0) {
  const a = ctx()
  if (!a || muted) return
  const t0 = a.currentTime + delay
  // 去掉最高那层（5.27×）—— 它就是「叮」得刺耳、听着吵的来源
  const parts = [
    [1, 1, dur],
    [2.41, 0.34, dur * 0.55],
    [3.86, 0.13, dur * 0.32],
  ]
  for (const [mul, amp, d] of parts) {
    const o = a.createOscillator()
    o.type = 'sine'
    o.frequency.value = base * mul
    const g = a.createGain()
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(gain * amp, t0 + 0.006)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + d)
    o.connect(g)
    g.connect(master)
    o.start(t0)
    o.stop(t0 + d + 0.05)
  }
}

/* ---------------- 环境风声 ---------------- */

/** 起风：白噪声过带通，LFO 让音量缓慢起伏（一呼一吸才是风，恒定噪声是电视雪花） */
export function windOn(level = 0.1, ramp = 2.5) {
  const a = ctx()
  if (!a || wind) return
  const sr = a.sampleRate
  const len = Math.round(sr * 4)
  const buf = a.createBuffer(1, len, sr)
  const d = buf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  const src = a.createBufferSource()
  src.buffer = buf
  src.loop = true
  const bp = a.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = 320
  bp.Q.value = 0.7
  const lp = a.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 620 // 1150 → 620：白噪声的「沙沙」全在 1k 以上，砍掉才不吵
  const g = a.createGain()
  g.gain.setValueAtTime(0.0001, a.currentTime)
  g.gain.linearRampToValueAtTime(level, a.currentTime + ramp)
  const lfo = a.createOscillator()
  lfo.type = 'sine'
  lfo.frequency.value = 0.085
  const lfoG = a.createGain()
  lfoG.gain.value = level * 0.55
  lfo.connect(lfoG)
  lfoG.connect(g.gain)
  // 再让带通频率缓慢漂移 —— 风的「呼吸」是频谱在动，不只是音量在动
  // （只起伏音量会变成呼吸机，频谱漂移才是风）
  const freqLfo = a.createOscillator()
  freqLfo.frequency.value = 0.047
  const freqG = a.createGain()
  freqG.gain.value = 110
  freqLfo.connect(freqG)
  freqG.connect(bp.frequency)
  src.connect(bp)
  bp.connect(lp)
  lp.connect(g)
  g.connect(master)
  src.start()
  lfo.start()
  freqLfo.start()
  wind = { src, gain: g, lfo, freqLfo }
}

/** 风势：进门时扬起，收尾时退去 */
export function windTo(level, ramp = 1.4) {
  const a = ctx()
  if (!a || !wind) return
  wind.gain.gain.cancelScheduledValues(a.currentTime)
  wind.gain.gain.setValueAtTime(Math.max(0.0001, wind.gain.gain.value), a.currentTime)
  wind.gain.gain.linearRampToValueAtTime(Math.max(0.0001, level), a.currentTime + ramp)
}

/** 停风：淡出后断开（离开仪式时一定要停，否则噪声会一直跟着页面） */
export function windOff(ramp = 1.6) {
  const a = ctx()
  if (!a || !wind) return
  const w = wind
  wind = null
  w.gain.gain.cancelScheduledValues(a.currentTime)
  w.gain.gain.setValueAtTime(Math.max(0.0001, w.gain.gain.value), a.currentTime)
  w.gain.gain.linearRampToValueAtTime(0.0001, a.currentTime + ramp)
  setTimeout(() => {
    try {
      w.src.stop()
      w.lfo.stop()
      if (w.freqLfo) w.freqLfo.stop()
    } catch {
      /* 已经停了 */
    }
  }, (ramp + 0.4) * 1000)
}

/* ---------------- 仪式的几个「声音事件」 ---------------- */

/** 题字浮现：未达容错落在低音（劝慰、沉），达成落在高音（清、开）*/
export function sfxMotto(pass) {
  // 只留**纯五度**两个音：空五度没有三音，最空旷 —— 再加一记高铃就把「空」填满了
  if (pass) {
    pluck(392.0, 0.26, 4.8) // G4 散音
    pluck(587.33, 0.11, 3.8, 0.42) // D5（纯五度）
  } else {
    pluck(130.81, 0.3, 5.2) // C3
    pluck(196.0, 0.1, 4.2, 0.5) // G3（纯五度）
  }
}

/** 进门：风扬起，配一声上行泛音（推门而入的那口气） */
export function sfxDoor() {
  windTo(0.13, 1.8)
  pluck(293.66, 0.17, 4.2, 0.03) // D4
  bell(880, 0.08, 3.4, 0.85) // A5：低一档、软一些
}

/** 镀金卦象浮现：一记清铃收束，风退回背景 */
export function sfxReward() {
  windTo(0.06, 2.6)
  bell(987.77, 0.14, 4.4) // B5：1244.5 太亮太「叮」，降下八度的一半才配得上云气
  pluck(523.25, 0.16, 4.2, 0.05) // C5
}

/** 收尾：风退、一声远钟 */
export function sfxExit() {
  bell(659.25, 0.12, 5.0) // E5：远钟
  windOff(2.6)
}
