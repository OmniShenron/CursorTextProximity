import * as THREE from 'three'
import { EffectComposer }  from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass }      from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass }      from 'three/examples/jsm/postprocessing/OutputPass.js'

/* ════════════════════════════════════════════════════════════════
   QUANTUM TEXT  —  production particle word
   ┌─────────────────────────────────────────────────────────────┐
   │  • Word morphing   particles flow between 5 words          │
   │  • Post-process bloom  real luminous glow (UnrealBloom)    │
   │  • Custom cursor   spring-lag ring, proximity expansion    │
   │  • ±Charged field  attract/repel around cursor             │
   │  • Scroll rotation 3D Y-axis pivot, springs back           │
   │  • Camera parallax mouse tilts 3D depth                    │
   │  • Fibonacci sphere  intro + explode target               │
   │  • Visibility fix  correct perspective px size + alpha     │
   └─────────────────────────────────────────────────────────────┘
════════════════════════════════════════════════════════════════ */

const WORDS = ['QUANTUM', 'DESIGN', 'CREATE', 'EVOLVE', 'IGNITE']

// ── Vertex shader ─────────────────────────────────────────────
const VERT = `
  attribute vec3  aOriginA;   // current word  target
  attribute vec3  aOriginB;   // next word target
  attribute vec3  aSphere;    // sphere (intro + explode)
  attribute float aSize;      // base size (world units)
  attribute float aCharge;    // +1 repel / -1 attract
  attribute float aDelay;     // intro stagger 0..1
  attribute float aHue;       // per-particle hue shift
  attribute float aPhase;     // breathing phase

  uniform float uTime;
  uniform float uIntro;       // 0→1 : sphere → text
  uniform float uMorphT;      // 0→1 : word A → word B
  uniform float uExplode;     // 0→1 : text → sphere scatter
  uniform vec2  uMouse;       // NDC -1..1
  uniform float uScrollRot;   // Y rotation (radians)
  uniform vec2  uRes;

  varying float vProx;
  varying float vHue;
  varying float vAlpha;

  // Hash-based value noise (lighter than snoise)
  float h21(vec2 p){ p=fract(p*vec2(234.34,435.345)); p+=dot(p,p+34.23); return fract(p.x*p.y); }
  float vnoise(vec2 p){
    vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
    return mix(mix(h21(i),h21(i+vec2(1,0)),f.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x),f.y);
  }

  float easeOutExpo(float x){ return x>=1.?1.:1.-pow(2.,-10.*x); }
  float easeInOutCubic(float x){ return x<.5?4.*x*x*x:1.-pow(-2.*x+2.,3.)/2.; }

  void main(){
    // ── Staggered intro ───────────────────────────────────
    float si    = clamp((uIntro - aDelay*0.38)/0.62, 0.,1.);
    float intro = easeOutExpo(si);

    // ── Morph: blend between word A and word B ────────────
    float morphE = easeInOutCubic(clamp(uMorphT,0.,1.));
    vec3  origin = mix(aOriginA, aOriginB, morphE);

    // ── Scroll Y-rotation applied to the blended origin ───
    float cr=cos(uScrollRot), sr=sin(uScrollRot);
    vec3 rotOrigin = vec3(
      origin.x*cr - origin.z*sr,
      origin.y,
      origin.x*sr + origin.z*cr
    );

    // ── Position: sphere→text (intro), text→sphere (explode)
    vec3 pos = mix(aSphere, rotOrigin, intro);
    pos       = mix(pos, aSphere*1.45, easeInOutCubic(uExplode));

    // ── Organic drift when settled ────────────────────────
    float settled = intro * (1.-uExplode) * (1.-morphE);
    float noise   = vnoise(origin.xy*1.1 + vec2(uTime*.13, uTime*.10)) - 0.5;
    pos.x += noise * .013 * settled;
    pos.y += noise * .009 * settled;

    // ── Cursor proximity force ────────────────────────────
    vec4  proj   = projectionMatrix * modelViewMatrix * vec4(pos,1.);
    vec2  ndc    = proj.xy/proj.w;
    float aspect = uRes.x/uRes.y;
    vec2  diff   = vec2((ndc.x-uMouse.x)*aspect, ndc.y-uMouse.y);
    float md     = length(diff);
    float prox   = max(0.,1.-md/0.36) * intro * (1.-uExplode*.9) * (1.-morphE*.7);

    // Charge: push or pull, hard-clamped
    float mag  = aCharge * prox*prox * 0.058;
    float clampedMag = clamp(abs(mag),0.,.044)*sign(mag);
    pos += normalize(vec3(diff/aspect, prox*.18)) * clampedMag;

    vProx = prox;

    // ── Camera parallax ───────────────────────────────────
    pos.x += uMouse.x * pos.z * .036;
    pos.y += uMouse.y * pos.z * .022;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;

    // ── Point size — calibrated for fov=45, cam z=4.8 ────
    // projMatrix[1][1] = 1/tan(fov/2) = 2.414 for fov=45
    // target px = aSize * projMatrix[1][1] * res.y*0.5 / (-mv.z)
    // aSize=0.012 → ~2.7px at z=4.8  ✓
    float swell = 1.0 + prox*1.25 + .14*sin(uTime*1.75+aPhase)*intro*(1.-morphE*.5);
    gl_PointSize = aSize * swell * 2.414 * uRes.y * 0.5 / (-mv.z);

    vHue   = aHue;
    // Alpha: calibrated so 10 overlap → ~0.90 brightness (just below white)
    // Single particle visible at base 0.08
    vAlpha = intro * (0.08 + prox*0.22) * (1.0 - morphE*0.3);
  }
`

// ── Fragment shader ───────────────────────────────────────────
const FRAG = `
  precision highp float;
  uniform float uTime;
  varying float vProx;
  varying float vHue;
  varying float vAlpha;

  vec3 hsl2rgb(float h,float s,float l){
    vec3 c=clamp(abs(mod(h*6.+vec3(0,4,2),6.)-3.)-1.,0.,1.);
    return l+s*(c-.5)*(1.-abs(2.*l-1.));
  }

  void main(){
    vec2  uv = gl_PointCoord - .5;
    float d  = length(uv)*2.;

    // Hard-edged circle — visible as individual dots at low density
    // Bloom pass will add the soft luminous halo; no fake halo here
    float circ = 1.-smoothstep(0.35, 0.80, d);
    if(circ < 0.015) discard;

    // Colour: indigo–violet–cyan family only
    float hue = mod(0.638 + vHue*0.085 + uTime*0.007, 1.0);
    float sat = 0.82 - vProx*0.18;
    float lit = 0.50 + vProx*0.32;    // 0.50 base → bloom will lift it

    vec3 col = hsl2rgb(hue, sat, lit);

    // Tight proximity core — electric white-blue centre
    float core = max(0., 1.-d*2.4) * vProx * 0.60;
    col += vec3(0.25,0.45,1.0) * core;

    // Output: standard alpha — let THREE.AdditiveBlending stack naturally
    gl_FragColor = vec4(col, circ * vAlpha);
  }
`

// ═══════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════

// Sample 2D canvas text → world positions
function sampleRaw(text) {
  const W=1400, H=360, RES=5
  const cvs=Object.assign(document.createElement('canvas'),{width:W,height:H})
  const ctx=cvs.getContext('2d')
  ctx.font='900 188px "Bebas Neue",Impact,sans-serif'
  ctx.textAlign='center'; ctx.textBaseline='middle'
  ctx.fillStyle='#fff'
  ctx.fillText(text,W/2,H/2)
  const data=ctx.getImageData(0,0,W,H).data
  const SX=5.0/W, SY=(5.0*H/W)/H
  const pts=[]
  for(let y=0;y<H;y+=RES)
    for(let x=0;x<W;x+=RES)
      if(data[(y*W+x)*4+3]>110)
        pts.push((x-W/2)*SX, -(y-H/2)*SY, (Math.random()-.5)*.40)
  return pts
}

// Pad/truncate to exact count N
// (extra particles repeat random existing ones with tiny jitter)
function padToN(pts, N) {
  const srcN = pts.length/3
  const out  = new Float32Array(N*3)
  // copy as many as we have
  const copy = Math.min(srcN, N)
  for(let i=0;i<copy*3;i++) out[i]=pts[i]
  // pad remainder by repeating random samples
  for(let i=copy;i<N;i++){
    const s=Math.floor(Math.random()*srcN)*3
    out[i*3]   = pts[s]   + (Math.random()-.5)*.04
    out[i*3+1] = pts[s+1] + (Math.random()-.5)*.04
    out[i*3+2] = pts[s+2]
  }
  return out
}

// Fibonacci sphere
function makeSphere(N, r=1.85){
  const a=new Float32Array(N*3), P=Math.PI*(1+Math.sqrt(5))
  for(let i=0;i<N;i++){
    const phi=Math.acos(1-(2*(i+.5))/N), th=P*i
    const ri=r*(.5+Math.random()*.6)
    a[i*3]  =ri*Math.sin(phi)*Math.cos(th)
    a[i*3+1]=ri*Math.sin(phi)*Math.sin(th)
    a[i*3+2]=ri*Math.cos(phi)
  }
  return a
}

// ═══════════════════════════════════════════════════════════════
// Custom Cursor
// ═══════════════════════════════════════════════════════════════
class Cursor {
  constructor(){
    this.x=-200; this.y=-200
    this.rx=-200; this.ry=-200
    this.rvx=0; this.rvy=0
    this.visible=false
    this.dot  = document.getElementById('cur-dot')
    this.ring = document.getElementById('cur-ring')
  }

  setPos(x,y){
    this.x=x; this.y=y
    if(!this.visible){ this.visible=true; this.rx=x; this.ry=y }
  }

  hide(){ this.x=-200; this.y=-200 }

  // Call every frame with dt in seconds
  update(dt, nearText){
    const SP=0.14, DP=0.72
    this.rvx = this.rvx*DP + (this.x - this.rx)*SP
    this.rvy = this.rvy*DP + (this.y - this.ry)*SP
    this.rx += this.rvx
    this.ry += this.rvy

    // Dot snaps exactly to mouse
    this.dot.style.transform  = `translate(calc(${this.x}px - 50%), calc(${this.y}px - 50%))`
    // Ring lags behind
    this.ring.style.transform = `translate(calc(${this.rx}px - 50%), calc(${this.ry}px - 50%))`

    // Proximity expansion
    this.ring.classList.toggle('near', nearText > 0.05)
  }

  click(){
    this.ring.classList.add('clicking')
    setTimeout(()=>this.ring.classList.remove('clicking'), 200)
  }
}

// ═══════════════════════════════════════════════════════════════
// Bootstrap
// ═══════════════════════════════════════════════════════════════
async function init(){
  // Wait for Bebas Neue
  try{ await document.fonts.load('900 188px "Bebas Neue"') }catch(e){}
  await new Promise(r=>setTimeout(r,100))

  // ── Sample all words ───────────────────────────────────
  console.log('[Quantum] Sampling words...')
  const rawWords = WORDS.map(w=>sampleRaw(w))
  const N = Math.round(Math.max(...rawWords.map(r=>r.length/3)) * 1.05)
  const wordPositions = rawWords.map(r=>padToN(r,N))
  console.log(`[Quantum] ${N} particles, ${WORDS.length} words`)

  // ── Three.js setup ─────────────────────────────────────
  const canvas = document.getElementById('c')
  const W=()=>window.innerWidth, H=()=>window.innerHeight
  const DPR=Math.min(devicePixelRatio??1,2)

  const renderer = new THREE.WebGLRenderer({canvas, antialias:false, alpha:false, powerPreference:'high-performance'})
  renderer.setSize(W(),H())
  renderer.setPixelRatio(DPR)
  renderer.setClearColor(0x04040a,1)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.0

  const scene  = new THREE.Scene()
  scene.fog    = new THREE.FogExp2(0x04040a, 0.16)

  const cam = new THREE.PerspectiveCamera(45, W()/H(), 0.1, 20)
  cam.position.set(0,0,4.8)
  const camBase = cam.position.clone()

  // ── Post-processing: Bloom ─────────────────────────────
  const composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene, cam))

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(W()*DPR, H()*DPR),
    1.35,   // strength  — luminous but not blinding
    0.55,   // radius    — soft spread
    0.10    // threshold — picks up even dim particles
  )
  composer.addPass(bloomPass)
  composer.addPass(new OutputPass())

  // ── Particle geometry ──────────────────────────────────
  const geo = new THREE.BufferGeometry()
  const spherePos = makeSphere(N)

  const aSize  = new Float32Array(N)
  const aChg   = new Float32Array(N)
  const aDel   = new Float32Array(N)
  const aHue   = new Float32Array(N)
  const aPh    = new Float32Array(N)

  for(let i=0;i<N;i++){
    // ★ Key visibility fix: aSize in world units calibrated to ~2-4px at cam z=4.8
    // Formula: px = aSize * 2.414 * H*0.5 / 4.8
    // Target 3px → aSize = 3 * 4.8 / (2.414 * H*0.5) ≈ 0.012 at H=900
    aSize[i] = 0.010 + Math.random()*0.006   // 0.010–0.016 → ~2–4px
    aChg[i]  = Math.random()<.38?-1:1
    aDel[i]  = Math.random()
    aHue[i]  = Math.random()
    aPh[i]   = Math.random()*Math.PI*2
  }

  // Start: originA = word 0, originB = word 0 (no morph yet)
  geo.setAttribute('position', new THREE.BufferAttribute(spherePos.slice(),3))
  geo.setAttribute('aOriginA', new THREE.BufferAttribute(wordPositions[0].slice(),3))
  geo.setAttribute('aOriginB', new THREE.BufferAttribute(wordPositions[0].slice(),3))
  geo.setAttribute('aSphere',  new THREE.BufferAttribute(spherePos,3))
  geo.setAttribute('aSize',    new THREE.BufferAttribute(aSize,1))
  geo.setAttribute('aCharge',  new THREE.BufferAttribute(aChg,1))
  geo.setAttribute('aDelay',   new THREE.BufferAttribute(aDel,1))
  geo.setAttribute('aHue',     new THREE.BufferAttribute(aHue,1))
  geo.setAttribute('aPhase',   new THREE.BufferAttribute(aPh,1))

  const uniforms = {
    uTime:      {value:0},
    uIntro:     {value:0},
    uMorphT:    {value:0},
    uExplode:   {value:0},
    uMouse:     {value:new THREE.Vector2(0,0)},
    uScrollRot: {value:0},
    uRes:       {value:new THREE.Vector2(W(),H())},
  }

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, uniforms,
    blending:    THREE.AdditiveBlending,
    depthWrite:  false, depthTest: false,
    transparent: true,
  })

  const points = new THREE.Points(geo, mat)
  scene.add(points)

  // ── State ──────────────────────────────────────────────
  let wordIdx    = 0       // current word (A side)
  let nextWordIdx= 1       // next word (B side)
  let morphing   = false
  let morphT     = 0       // 0→1

  let introC     = 0
  let scrollRaw  = 0, scrollS = 0
  let mouse      = new THREE.Vector2(0,0)
  let mouseS     = new THREE.Vector2(0,0)
  let hasMoved   = false
  let prev       = performance.now()
  let t          = 0
  let globalProx = 0       // for cursor proximity ring

  // Auto-morph timer
  let autoMorphTimer = 0
  const AUTO_MORPH_INTERVAL = 4.0 // seconds

  // ── Cursor ─────────────────────────────────────────────
  const cursor = new Cursor()

  // ── UI refs ────────────────────────────────────────────
  const hintEl     = document.getElementById('hint')
  const labelEl    = document.getElementById('word-label')
  const counterEl  = document.getElementById('word-counter')
  const progressEl = document.getElementById('progress')

  function updateUI(){
    const n = String(wordIdx+1).padStart(2,'0')
    const t = String(WORDS.length).padStart(2,'0')
    counterEl.textContent = `${n} / ${t}`
    labelEl.textContent   = WORDS[wordIdx]
  }
  updateUI()

  // ── Start a morph to a specific word index ─────────────
  function startMorph(toIdx){
    if(morphing) return
    nextWordIdx = toIdx
    // Set aOriginA = current settled A, aOriginB = next word
    // First bake the current (morphed) position into A:
    const curBlend = uniforms.uMorphT.value
    const posA = wordPositions[wordIdx]
    const posB = wordPositions[nextWordIdx]
    const baked = new Float32Array(N*3)
    for(let i=0;i<N*3;i++) baked[i] = posA[i]*(1-curBlend) + posB[i]*curBlend

    geo.attributes.aOriginA.array.set(baked)
    geo.attributes.aOriginA.needsUpdate = true
    geo.attributes.aOriginB.array.set(wordPositions[nextWordIdx])
    geo.attributes.aOriginB.needsUpdate = true

    morphT = 0
    uniforms.uMorphT.value = 0
    morphing = true
    autoMorphTimer = 0
  }

  function morphNext(){ startMorph((wordIdx+1) % WORDS.length) }

  // ── Events ─────────────────────────────────────────────
  window.addEventListener('mousemove',e=>{
    mouse.x=(e.clientX/W())*2-1
    mouse.y=-(e.clientY/H())*2+1
    cursor.setPos(e.clientX, e.clientY)
    if(!hasMoved){
      hasMoved=true
      hintEl.classList.add('gone')
    }
  })
  window.addEventListener('mouseleave',()=>{
    mouse.set(0,0); cursor.hide()
  })
  window.addEventListener('touchmove',e=>{
    const t0=e.touches[0]
    mouse.x=(t0.clientX/W())*2-1
    mouse.y=-(t0.clientY/H())*2+1
    cursor.setPos(t0.clientX,t0.clientY)
  },{passive:true})
  window.addEventListener('wheel',e=>{
    const f=e.deltaMode===1?28:e.deltaMode===2?500:1
    scrollRaw=Math.max(-Math.PI/1.5,Math.min(Math.PI/1.5,scrollRaw+e.deltaY*f*.00046))
  },{passive:true})
  canvas.addEventListener('click',()=>{
    cursor.click()
    if(!morphing) morphNext()
    if(!hasMoved){ hasMoved=true; hintEl.classList.add('gone') }
  })
  window.addEventListener('resize',()=>{
    renderer.setSize(W(),H())
    composer.setSize(W(),H())
    bloomPass.resolution.set(W()*DPR,H()*DPR)
    cam.aspect=W()/H(); cam.updateProjectionMatrix()
    uniforms.uRes.value.set(W(),H())
  })

  // ── Render loop ────────────────────────────────────────
  ;(function tick(){
    requestAnimationFrame(tick)
    const now=performance.now()
    const dt =Math.min((now-prev)/1000,.05)
    prev=now; t+=dt

    // Intro spring
    introC += (1-introC)*Math.min(dt*.62,.04)
    uniforms.uIntro.value = Math.min(introC,1)

    // Morph progress
    if(morphing){
      morphT += dt * 0.55    // ~1.8s full morph
      if(morphT >= 1){
        morphT   = 1
        morphing = false
        wordIdx  = nextWordIdx
        // Bake completed morph into A, reset B=A
        geo.attributes.aOriginA.array.set(wordPositions[wordIdx])
        geo.attributes.aOriginA.needsUpdate=true
        geo.attributes.aOriginB.array.set(wordPositions[wordIdx])
        geo.attributes.aOriginB.needsUpdate=true
        uniforms.uMorphT.value=0
        updateUI()
        autoMorphTimer=0
      } else {
        uniforms.uMorphT.value = morphT
      }
    }

    // Progress bar (shows auto-morph countdown)
    if(!morphing){
      autoMorphTimer += dt
      const pct = Math.min(autoMorphTimer/AUTO_MORPH_INTERVAL*100,100)
      progressEl.style.width = pct+'%'
      if(autoMorphTimer >= AUTO_MORPH_INTERVAL) morphNext()
    } else {
      progressEl.style.width = (morphT*100)+'%'
    }

    // Mouse smooth
    mouseS.lerp(mouse, 1-Math.pow(.025,dt))
    uniforms.uMouse.value.copy(mouseS)

    // Scroll spring-back
    scrollRaw *= .974
    scrollS   += (scrollRaw-scrollS)*Math.min(dt*3.,.12)
    uniforms.uScrollRot.value = scrollS

    // Camera parallax
    cam.position.x += (camBase.x + mouseS.x*.12 - cam.position.x)*.05
    cam.position.y += (camBase.y + mouseS.y*.07 - cam.position.y)*.05
    cam.lookAt(0,0,0)

    uniforms.uTime.value = t

    // Global proximity estimate for cursor ring
    // Approximate: if mouse NDC is within text bounding rect
    const mx=mouseS.x, my=mouseS.y
    const inTextArea = Math.abs(mx)<0.75 && Math.abs(my)<0.22
    globalProx += ((inTextArea?1:0) - globalProx)*Math.min(dt*4,.15)
    cursor.update(dt, globalProx)

    // Render via composer (bloom)
    composer.render()
  })()

  console.log('[Quantum] ✓ running — bloom + morph + cursor active')
}

init().catch(e=>console.error('[Quantum] Error:', e))
