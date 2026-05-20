/* ═══════════════════════════════════════════════════════════════════
   FusionText — production-ready, all-in-one canvas

   STATES
   ──────
   intro     particles fly in from random positions, spring to text
   idle      particles breathe + slow hue drift; fully visible
   hover     spotlight reveals vivid glow; charged ±field repels/attracts
   scroll    wave distortion — amplitude ∝ wheel velocity
   explode   radial scatter with stagger; click again to reform

   FIXES over previous iterations
   ──────────────────────────────
   • Spotlight: overlay with destination-out hole — REVEALS not darkens
   • DPR: setTransform() on every resize, never stacks
   • Force: clamped so particles never escape letter bounding box
   • Wheel: impulse-based, decays cleanly per frame
   • Palette: single 3-stop gradient family (indigo→cyan→white)
   • Intro: particles spawn off-screen, spring to origins over 1.4s
═══════════════════════════════════════════════════════════════════ */

const TAU = Math.PI * 2

/* ── Colour system: one coherent family ─────────────────────── */
// Base hues: deep indigo, violet, electric cyan — no random rainbow
const BASE_HUES = [235, 255, 275, 195, 215]

function hsl(h: number, s: number, l: number, a = 1): string {
  return `hsla(${h | 0},${(s * 100) | 0}%,${(l * 100) | 0}%,${a.toFixed(3)})`
}

/* ── Ease ───────────────────────────────────────────────────── */
function easeOutExpo(x: number): number {
  return x === 1 ? 1 : 1 - Math.pow(2, -10 * x)
}

/* ── Particle ───────────────────────────────────────────────── */
interface P {
  x:  number; y:  number   // current position
  ox: number; oy: number   // text-origin (never changes after sample)
  tx: number; ty: number   // spring target
  vx: number; vy: number   // velocity
  r:      number           // base radius
  charge: 1 | -1           // +1 repels cursor, -1 attracts
  hi:     number           // hue index
  phase:  number           // breathing phase
  delay:  number           // intro stagger 0..1
}

/* ── Main class ─────────────────────────────────────────────── */
export class FusionText {
  private cvs: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private dpr: number
  private W = 0; private H = 0

  private pts: P[] = []
  private exploded = false

  // State machine
  private state: 'intro' | 'idle' | 'hover' | 'explode' = 'intro'
  private introProgress = 0  // 0 → 1 over ~1.4 seconds

  // Mouse — raw & spring-smoothed
  private mx  = -9999; private my  = -9999
  private smx = -9999; private smy = -9999
  private vmx = 0;     private vmy = 0

  // Spotlight — spring radius
  private spotR  = 0
  private spotVR = 0
  private readonly SPOT_TARGET = 150

  // Wheel distortion
  private waveAmp   = 0   // current wave amplitude (px)
  private waveTarget = 0  // target amp driven by wheel

  // Time
  private t    = 0
  private prev = performance.now()
  private raf  = 0

  // Config
  private readonly TEXT     = 'FUSION'
  private readonly RES      = 5      // sample gap px (lower = more particles)
  private readonly EXPL_R   = 240    // explode scatter radius
  private readonly FORCE_R  = 120    // cursor field radius
  private readonly FORCE_MAX = 38    // max displacement from origin (px)

  constructor(canvas: HTMLCanvasElement) {
    this.cvs = canvas
    this.ctx = canvas.getContext('2d')!
    this.dpr = Math.min(devicePixelRatio ?? 1, 2)
    this._resize()
    this._bind()
    this._raf()
  }

  /* ── Bind events ────────────────────────────────────────────── */
  private _bind() {
    window.addEventListener('resize', () => this._resize())

    window.addEventListener('mousemove', (e: MouseEvent) => {
      this.mx = e.clientX; this.my = e.clientY
      if (this.state === 'intro' || this.state === 'idle') this.state = 'hover'
      // Fade hint
      const h = document.getElementById('hint')
      if (h) h.style.opacity = '0'
    })

    window.addEventListener('mouseleave', () => {
      this.mx = -9999; this.my = -9999
      if (this.state === 'hover') this.state = 'idle'
    })

    window.addEventListener('wheel', (e: WheelEvent) => {
      const f = e.deltaMode === 1 ? 28 : e.deltaMode === 2 ? 500 : 1
      // Clamp so extreme scroll doesn't break everything
      const delta = Math.max(-220, Math.min(220, e.deltaY * f * 0.30))
      this.waveTarget = Math.max(-80, Math.min(80, this.waveTarget + delta * 0.18))
    }, { passive: true })

    this.cvs.addEventListener('click', () => {
      if (this.state === 'intro') return
      this.exploded ? this._reform() : this._scatter()
    })

    window.addEventListener('touchmove', (e: TouchEvent) => {
      const t = e.touches[0]
      this.mx = t.clientX; this.my = t.clientY
      if (this.state === 'idle' || this.state === 'intro') this.state = 'hover'
    }, { passive: true })

    this.cvs.addEventListener('touchend', () => {
      if (this.state !== 'intro') this.exploded ? this._reform() : this._scatter()
    })
  }

  /* ── Resize — FIX: setTransform prevents stacking ──────────── */
  private _resize() {
    this.W = window.innerWidth
    this.H = window.innerHeight
    const dpr = this.dpr

    this.cvs.width  = this.W * dpr
    this.cvs.height = this.H * dpr
    this.cvs.style.width  = this.W + 'px'
    this.cvs.style.height = this.H + 'px'

    // ★ FIX: reset transform before setting — never stacks
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    this._sample()
    if (this.exploded) this._scatter()
  }

  /* ── Sample text → particles ────────────────────────────────── */
  private _sample() {
    const W = this.W; const H = this.H
    // Medium size: ~13vw capped at 200px
    const fs = Math.min(W * 0.13, H * 0.28, 200)

    const off = document.createElement('canvas')
    off.width = W; off.height = H
    const oc = off.getContext('2d')!
    oc.font          = `900 ${fs}px 'Bebas Neue', Impact, sans-serif`
    oc.textAlign     = 'center'
    oc.textBaseline  = 'middle'
    oc.fillStyle     = '#fff'
    oc.fillText(this.TEXT, W / 2, H / 2)

    const data = oc.getImageData(0, 0, W, H).data
    const res  = this.RES
    const pts: P[] = []

    for (let y = 0; y < H; y += res) {
      for (let x = 0; x < W; x += res) {
        if (data[(y * W + x) * 4 + 3] > 100) {
          // Intro: spawn from random off-screen position
          const angle  = Math.random() * TAU
          const dist   = Math.max(W, H) * (0.6 + Math.random() * 0.5)
          const introX = W / 2 + Math.cos(angle) * dist
          const introY = H / 2 + Math.sin(angle) * dist

          pts.push({
            x: introX, y: introY,
            ox: x, oy: y,
            tx: x, ty: y,
            vx: 0, vy: 0,
            r:      1.4 + Math.random() * 1.0,
            charge: Math.random() < 0.38 ? -1 : 1,
            hi:     Math.floor(Math.random() * BASE_HUES.length),
            phase:  Math.random() * TAU,
            delay:  Math.random(),   // stagger for intro
          })
        }
      }
    }
    this.pts = pts
    // Reset intro
    this.state        = 'intro'
    this.introProgress = 0
  }

  /* ── Explode ────────────────────────────────────────────────── */
  private _scatter() {
    this.exploded = true
    this.state    = 'explode'
    const cx = this.W / 2; const cy = this.H / 2

    this.pts.forEach(p => {
      // Scatter direction from text centre + randomness
      const baseAngle = Math.atan2(p.oy - cy, p.ox - cx)
      const angle     = baseAngle + (Math.random() - 0.5) * 1.4
      const d         = this.EXPL_R * (0.5 + Math.random() * 0.9)
      p.tx = cx + Math.cos(angle) * d
      p.ty = cy + Math.sin(angle) * d
    })

    // Hint update
    const h = document.getElementById('hint')
    if (h) { h.textContent = 'click to reform'; h.style.opacity = '1' }
  }

  /* ── Reform ─────────────────────────────────────────────────── */
  private _reform() {
    this.exploded = false
    this.state    = this.mx > 0 ? 'hover' : 'idle'
    this.pts.forEach(p => { p.tx = p.ox; p.ty = p.oy })

    const h = document.getElementById('hint')
    if (h) h.style.opacity = '0'
  }

  /* ── rAF loop ───────────────────────────────────────────────── */
  private _raf() {
    const tick = (now: number) => {
      const dt = Math.min((now - this.prev) / 1000, 0.05)
      this.prev = now; this.t += dt
      this._update(dt)
      this._draw()
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  /* ── Physics ────────────────────────────────────────────────── */
  private _update(dt: number) {
    // ── Intro progress ──────────────────────────────────────────
    if (this.state === 'intro') {
      this.introProgress = Math.min(this.introProgress + dt / 1.4, 1)
      if (this.introProgress >= 1) this.state = 'idle'
    }

    // ── Spring-smooth mouse ─────────────────────────────────────
    const SP = 0.14; const DP = 0.72
    this.vmx = this.vmx * DP + (this.mx - this.smx) * SP
    this.vmy = this.vmy * DP + (this.my - this.smy) * SP
    this.smx += this.vmx
    this.smy += this.vmy

    // ── Spotlight spring ────────────────────────────────────────
    const cursorOnScreen = this.mx > 0 && this.mx < this.W
    const tR = (cursorOnScreen && !this.exploded) ? this.SPOT_TARGET : 0
    this.spotVR = this.spotVR * 0.80 + (tR - this.spotR) * 0.095
    this.spotR += this.spotVR

    // ── Wave amplitude spring ───────────────────────────────────
    // Target decays toward 0 naturally
    this.waveTarget  *= 0.88
    this.waveAmp      = this.waveAmp * 0.82 + this.waveTarget * 0.18

    // ── Per-particle ────────────────────────────────────────────
    const mx = this.smx; const my = this.smy
    const FR = this.FORCE_R; const FR2 = FR * FR
    const t  = this.t

    this.pts.forEach(p => {
      let targetX = p.tx
      let targetY = p.ty

      // Intro override: ease toward origin over introProgress
      if (this.state === 'intro' || this.introProgress < 1) {
        const ease   = easeOutExpo(Math.max(0, this.introProgress - p.delay * 0.3))
        targetX = p.ox * ease + p.x * (1 - ease) // will naturally spring
        targetY = p.oy * ease + p.y * (1 - ease)
        if (this.state === 'intro') {
          targetX = p.ox
          targetY = p.oy
        }
      }

      // Wave distortion from scroll (sin wave per column position)
      let waveX = 0
      if (!this.exploded && Math.abs(this.waveAmp) > 0.5) {
        const col   = (p.ox - this.W / 2) / (this.W * 0.15)  // normalised col
        const phase = col * 2.5 + t * 4.5
        waveX = Math.sin(phase) * this.waveAmp * 0.55
        // Slight vertical flutter too
        const waveY = Math.cos(phase * 0.7 + p.phase) * Math.abs(this.waveAmp) * 0.12
        targetY = p.ty + waveY
      }

      // ★ FIX: Charged cursor field — CLAMPED to FORCE_MAX from origin
      let fx = 0; let fy = 0
      if (!this.exploded && cursorOnScreen) {
        const cdx = p.ox - mx; const cdy = p.oy - my  // from ORIGIN not current pos
        const cd2 = cdx * cdx + cdy * cdy
        if (cd2 < FR2 && cd2 > 0.01) {
          const cd  = Math.sqrt(cd2)
          const n   = 1 - cd / FR
          const mag = p.charge * n * n * 55

          // Calculate unclamped displacement
          const dispX = cdx / cd * mag
          const dispY = cdy / cd * mag

          // Clamp total displacement from origin so particles stay in letter
          const totX = dispX + waveX
          const totY = dispY
          const tot  = Math.sqrt(totX * totX + totY * totY)
          if (tot > this.FORCE_MAX) {
            const scale = this.FORCE_MAX / tot
            fx = totX * scale - waveX   // subtract wave since it's added separately
            fy = totY * scale
          } else {
            fx = dispX
            fy = dispY
          }
        }
      }

      // Spring stiffness depends on state
      const isResting = this.state === 'idle' || this.state === 'hover'
      const STIFF = this.exploded ? 0.052 : (this.state === 'intro' ? 0.07 : 0.082)
      const DAMP  = this.exploded ? 0.80  : 0.73

      const finalTargetX = (targetX + waveX + fx)
      const finalTargetY = (targetY + fy)

      p.vx += (finalTargetX - p.x) * STIFF
      p.vy += (finalTargetY - p.y) * STIFF
      p.vx *= DAMP; p.vy *= DAMP
      p.x  += p.vx; p.y  += p.vy
    })
  }

  /* ── Draw ───────────────────────────────────────────────────── */
  private _draw() {
    const ctx = this.ctx
    const W = this.W; const H = this.H
    const t  = this.t
    const mx = this.smx; const my = this.smy
    const r  = Math.max(0, this.spotR)

    // 1. Black background
    ctx.fillStyle = '#050508'
    ctx.fillRect(0, 0, W, H)

    // 2. Particles (drawn BEFORE overlay — overlay punches hole over them)
    this._drawParticles(mx, my, r, t)

    // 3. Polarity arcs (subtle, drawn before overlay)
    if (r > 20 && this.state === 'hover') {
      this._drawFieldArcs(mx, my, r, t)
    }

    // 4. ★ FIX: Overlay = dark layer with destination-out hole → REVEALS particles
    this._drawRevealOverlay(mx, my, r, t)

    // 5. Film grain
    this._drawGrain()
  }

  /* Particles ────────────────────────────────────────────────── */
  private _drawParticles(mx: number, my: number, r: number, t: number) {
    const ctx = this.ctx

    this.pts.forEach(p => {
      // Distance to cursor (for glow, not force)
      const dx   = p.x - mx; const dy = p.y - my
      const dist = Math.sqrt(dx * dx + dy * dy)
      const prox = r > 0 ? Math.max(0, 1 - dist / r) : 0

      // ── Colour ────────────────────────────────────────────
      // Drift hue slowly over time; proximity adds warm shift
      const baseH = BASE_HUES[p.hi]
      const hue   = (baseH + t * 8 + prox * 65) % 360
      const sat   = 0.70 + prox * 0.22
      const lit   = 0.58 + prox * 0.25   // always above 0.58 — never dark

      // ── Alpha ─────────────────────────────────────────────
      // ★ FIX: ALWAYS visible, proximity just adds extra brightness
      const introFade = this.introProgress < 1 ? easeOutExpo(this.introProgress) : 1
      const baseAlpha = 0.75 * introFade
      const alpha     = Math.min(baseAlpha + prox * 0.25, 1.0)

      // ── Size ──────────────────────────────────────────────
      const breath = 1 + 0.18 * Math.sin(t * 1.8 + p.phase)
      const swell  = 1 + prox * 1.4
      const rad    = Math.max(0.5, p.r * breath * swell)

      // ── Glow (only near cursor) ───────────────────────────
      if (prox > 0.04) {
        ctx.shadowColor = hsl(hue, sat, lit + 0.15)
        ctx.shadowBlur  = 3 + prox * 10
      } else {
        ctx.shadowBlur  = 0
      }

      ctx.globalAlpha = alpha
      ctx.fillStyle   = hsl(hue, sat, lit)
      ctx.beginPath()
      ctx.arc(p.x, p.y, rad, 0, TAU)
      ctx.fill()
    })

    ctx.shadowBlur  = 0
    ctx.globalAlpha = 1
  }

  /* ★ FIX: Reveal overlay — dark layer with destination-out hole ─ */
  private _drawRevealOverlay(mx: number, my: number, r: number, t: number) {
    const ctx = this.ctx
    const W = this.W; const H = this.H

    ctx.save()

    if (r > 4 && this.state === 'hover') {
      // Step 1: draw dark semi-transparent overlay
      ctx.globalAlpha       = 0.72
      ctx.fillStyle         = '#050508'
      ctx.fillRect(0, 0, W, H)
      ctx.globalAlpha       = 1

      // Step 2: cut a soft circular hole — this REVEALS bright particles
      ctx.globalCompositeOperation = 'destination-out'
      const hole = ctx.createRadialGradient(mx, my, 0, mx, my, r)
      // Centre fully erases overlay → particles below fully visible
      hole.addColorStop(0.00, 'rgba(0,0,0,1.00)')
      hole.addColorStop(0.55, 'rgba(0,0,0,0.90)')
      hole.addColorStop(0.82, 'rgba(0,0,0,0.40)')
      hole.addColorStop(1.00, 'rgba(0,0,0,0.00)')
      ctx.fillStyle = hole
      ctx.fillRect(0, 0, W, H)
      ctx.globalCompositeOperation = 'source-over'

      // Step 3: iridescent ring RIGHT at boundary (tight, not giant circle)
      const hue  = (t * 38) % 360
      const hue2 = (hue + 75) % 360
      const ring = ctx.createRadialGradient(mx, my, r - 6, mx, my, r + 7)
      ring.addColorStop(0.00, 'rgba(0,0,0,0)')
      ring.addColorStop(0.30, hsl(hue, 0.90, 0.72, 0.55))
      ring.addColorStop(0.60, hsl(hue2, 0.90, 0.72, 0.38))
      ring.addColorStop(1.00, 'rgba(0,0,0,0)')
      ctx.fillStyle = ring
      ctx.fillRect(0, 0, W, H)

    } else {
      // No cursor: gentle vignette only (edges, not centre)
      const vig = ctx.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, H * 0.72)
      vig.addColorStop(0, 'rgba(5,5,8,0.00)')
      vig.addColorStop(1, 'rgba(5,5,8,0.55)')
      ctx.fillStyle = vig
      ctx.fillRect(0, 0, W, H)
    }

    ctx.restore()
  }

  /* Field arcs — soft, only 5 lines ─────────────────────────── */
  private _drawFieldArcs(mx: number, my: number, r: number, t: number) {
    const ctx = this.ctx
    ctx.save()
    for (let i = 0; i < 5; i++) {
      const a0 = (i / 5) * TAU + t * 0.25
      const ar = r * 0.50 + Math.sin(t * 1.0 + i * 1.2) * r * 0.08
      const ax = mx + Math.cos(a0) * ar
      const ay = my + Math.sin(a0) * ar
      const bx = mx + Math.cos(a0 + Math.PI * 0.45) * ar * 0.35
      const by = my + Math.sin(a0 + Math.PI * 0.45) * ar * 0.35
      const hue = (i / 5 * 360 + t * 20) % 360
      const g   = ctx.createLinearGradient(ax, ay, bx, by)
      g.addColorStop(0,   `hsla(${hue | 0},80%,65%,0)`)
      g.addColorStop(0.5, `hsla(${hue | 0},80%,65%,0.14)`)
      g.addColorStop(1,   `hsla(${hue | 0},80%,65%,0)`)
      ctx.strokeStyle = g
      ctx.lineWidth   = 0.6
      ctx.beginPath()
      ctx.moveTo(ax, ay)
      ctx.quadraticCurveTo(mx, my, bx, by)
      ctx.stroke()
    }
    ctx.restore()
  }

  /* Film grain ───────────────────────────────────────────────── */
  private _drawGrain() {
    const ctx = this.ctx
    ctx.save()
    ctx.globalAlpha = 0.014
    ctx.fillStyle   = '#fff'
    const n = ((this.W * this.H) / 560) | 0
    for (let i = 0; i < n; i++) {
      ctx.fillRect(Math.random() * this.W, Math.random() * this.H, 1, 1)
    }
    ctx.restore()
  }

  destroy() { cancelAnimationFrame(this.raf) }
}
