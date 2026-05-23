import * as THREE from 'three'
import { EffectComposer }  from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass }      from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass }      from 'three/examples/jsm/postprocessing/OutputPass.js'

/* ═══════════════════════════════════════════════════════════════════
   PRODUCTION PARTICLE TEXT
   ─────────────────────────────────────────────────────────────────
   SCROLL  → physically drag morphT 0→1 (release snaps fwd or back)
   CLICK   → instant morph to next word
   AUTO    → fires after 5s of no interaction
   BLOOM   → UnrealBloomPass — particles glow like real light
   CURSOR  → spring-lag ring, expands near text, pulses on click
   MORPH   → particles physically flow between words in vertex shader
   CHARGED → ±polarity per particle → attract / repel cursor
   PARALLAX→ camera tilts with mouse, reveals true Z depth
   SHOCKWAVE → CSS ring fires on every morph complete
   PER-WORD COLOUR → each word has own hue family + bloom tint
═══════════════════════════════════════════════════════════════════ */

// ── Word config ───────────────────────────────────────────────
// Change words HERE — all caps only
const WORDS = ['CURIOUS', 'BOLD', 'THOUGHTFUL', 'RESILIENT', 'DRIVEN']
// Per-word identity hue (0–360) — drives particle colour + bloom colour
const WORD_HUES = [235, 355, 172, 44, 288]   // indigo, red-pink, teal, amber, violet

// ════════════════════════════════════════════════════════════════
//  GLSL — VERTEX
// ════════════════════════════════════════════════════════════════
const VERT = `
  attribute vec3  aOriginA;    // current word world pos
  attribute vec3  aOriginB;    // next word world pos
  attribute vec3  aSphere;     // fibonacci sphere (intro + explode)
  attribute float aSize;       // base size (calibrated world units)
  attribute float aCharge;     // +1 repel cursor  |  -1 attract
  attribute float aDelay;      // intro stagger 0..1
  attribute float aHue;        // per-particle hue offset 0..1
  attribute float aPhase;      // breathing phase

  uniform float uTime;
  uniform float uIntro;        // 0→1: sphere collapses into word
  uniform float uMorphT;       // 0→1: word A → word B (scroll/click)
  uniform float uExplode;      // reserved (0 in this build)
  uniform vec2  uMouse;        // NDC mouse -1..1
  uniform float uScrollRot;    // Y-axis rotation from scroll (radians)
  uniform vec2  uRes;
  uniform float uWordHueA;     // current word hue 0..1
  uniform float uWordHueB;     // next word hue 0..1

  varying float vProx;
  varying float vHue;
  varying float vAlpha;
  varying float vWordHue;

  // ── Value noise (lightweight) ─────────────────────────
  float h21(vec2 p){ p=fract(p*vec2(234.34,435.345)); p+=dot(p,p+34.23); return fract(p.x*p.y); }
  float vnoise(vec2 p){
    vec2 i=floor(p),f=fract(p); f=f*f*(3.-2.*f);
    return mix(mix(h21(i),h21(i+vec2(1,0)),f.x),
               mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x),f.y);
  }

  float easeOutExpo(float x){ return x>=1.?1.:1.-pow(2.,-10.*x); }
  float easeInOutCubic(float x){ return x<.5?4.*x*x*x:1.-pow(-2.*x+2.,3.)/2.; }
  float easeOutBack(float x){
    float c1=1.70158, c3=c1+1.;
    return 1.+c3*pow(x-1.,3.)+c1*pow(x-1.,2.);
  }

  void main(){
    // ── Staggered intro ──────────────────────────────────
    float si    = clamp((uIntro - aDelay*0.36)/0.64, 0.,1.);
    float intro = easeOutExpo(si);

    // ── Morph blend A→B ─────────────────────────────────
    float mt     = easeInOutCubic(clamp(uMorphT,0.,1.));
    vec3  origin = mix(aOriginA, aOriginB, mt);

    // ── Scroll Y-rotation on origin ──────────────────────
    float cr=cos(uScrollRot), sr=sin(uScrollRot);
    vec3 rotO = vec3(
      origin.x*cr - origin.z*sr,
      origin.y,
      origin.x*sr + origin.z*cr
    );

    // ── Sphere → text (intro) ────────────────────────────
    // During morph: add mid-flight arc — particles lift in Z then drop
    float arcZ = sin(mt*3.14159) * 0.35 * (1.0 - abs(mt-0.5)*1.8);
    vec3  morphOffset = vec3(0., sin(mt*3.14159)*0.10, arcZ);
    vec3  pos = mix(aSphere, rotO + morphOffset, intro);

    // ── Organic micro-drift when fully settled ───────────
    float settled = intro * (1.-mt) * (1.-uExplode);
    float n = vnoise(origin.xy*1.05 + vec2(uTime*.12,uTime*.09)) - 0.5;
    pos.x += n*.012*settled;
    pos.y += n*.008*settled;

    // ── Cursor proximity (charged field) ─────────────────
    vec4  proj   = projectionMatrix * modelViewMatrix * vec4(pos,1.);
    vec2  ndc    = proj.xy/proj.w;
    float aspect = uRes.x/uRes.y;
    vec2  diff   = vec2((ndc.x-uMouse.x)*aspect, ndc.y-uMouse.y);
    float md     = length(diff);
    float prox   = max(0.,1.-md/0.38) * intro * (1.-mt*0.75);

    // Clamp force so particles stay legible
    float fMag   = aCharge * prox*prox * 0.056;
    float fClamp = clamp(abs(fMag),0.,.042)*sign(fMag);
    pos += normalize(vec3(diff/aspect, prox*.16)) * fClamp;
    vProx = prox;

    // ── Camera parallax ──────────────────────────────────
    pos.x += uMouse.x * pos.z * .034;
    pos.y += uMouse.y * pos.z * .020;

    vec4 mv = modelViewMatrix * vec4(pos,1.);
    gl_Position = projectionMatrix * mv;

    // ── Point size ───────────────────────────────────────
    // Calibrated: aSize(0.010–0.016) × 2.414 × H×0.5 / (-mv.z)
    // → 2–4px at cam z=4.8, H=900
    float swell = 1.0 + prox*1.20 + .12*sin(uTime*1.75+aPhase)*intro*(1.-mt*.6);
    gl_PointSize = aSize * swell * 2.414 * uRes.y * 0.5 / (-mv.z);

    // ── Varyings ─────────────────────────────────────────
    vHue     = aHue;
    vWordHue = mix(uWordHueA, uWordHueB, mt);
    // Alpha: base 0.08 → ~10 overlap = 0.80 brightness (visible, not white)
    vAlpha   = intro * (0.08 + prox*0.20);
  }
`

// ════════════════════════════════════════════════════════════════
//  GLSL — FRAGMENT
// ════════════════════════════════════════════════════════════════
const FRAG = `
  precision highp float;
  uniform float uTime;
  varying float vProx;
  varying float vHue;
  varying float vAlpha;
  varying float vWordHue;

  vec3 hsl2rgb(float h,float s,float l){
    vec3 c=clamp(abs(mod(h*6.+vec3(0,4,2),6.)-3.)-1.,0.,1.);
    return l+s*(c-.5)*(1.-abs(2.*l-1.));
  }

  void main(){
    vec2  uv = gl_PointCoord-.5;
    float d  = length(uv)*2.;

    // Hard circle — individual dots visible at letter edges
    // Bloom pass adds the luminous halo; NO fake soft halo here
    float circ = 1.-smoothstep(0.30, 0.85, d);
    if(circ < 0.015) discard;

    // Colour driven by word hue family + per-particle shift + time drift
    float hue = mod(vWordHue + vHue*0.08 + uTime*0.006, 1.0);
    float sat = 0.85 - vProx*0.20;
    float lit = 0.48 + vProx*0.30;   // 0.48 base → bloom lifts luminance

    vec3 col = hsl2rgb(hue, sat, lit);

    // Tight proximity electric core (very centre only)
    float core = max(0., 1.-d*2.5) * vProx * 0.55;
    col += mix(vec3(0.2,0.4,1.0), vec3(1.0,0.8,0.4), vWordHue) * core;

    gl_FragColor = vec4(col, circ * vAlpha);
  }
`

// ════════════════════════════════════════════════════════════════
//  UTILITIES
// ════════════════════════════════════════════════════════════════
function sampleRaw(text) {
  const W=1500, H=380, RES=5
  const cvs = Object.assign(document.createElement('canvas'),{width:W,height:H})
  const ctx  = cvs.getContext('2d')
  ctx.font          = '900 192px "Bebas Neue",Impact,sans-serif'
  ctx.textAlign     = 'center'
  ctx.textBaseline  = 'middle'
  ctx.fillStyle     = '#fff'
  ctx.fillText(text, W/2, H/2)
  const data = ctx.getImageData(0,0,W,H).data
  const SX   = 5.2/W, SY=(5.2*H/W)/H
  const pts  = []
  for(let y=0;y<H;y+=RES)
    for(let x=0;x<W;x+=RES)
      if(data[(y*W+x)*4+3]>110)
        pts.push((x-W/2)*SX, -(y-H/2)*SY, (Math.random()-.5)*.42)
  return pts
}

function padToN(pts, N) {
  const src = pts.length/3
  const out = new Float32Array(N*3)
  for(let i=0; i<Math.min(src,N)*3; i++) out[i]=pts[i]
  for(let i=src; i<N; i++){
    const s = Math.floor(Math.random()*src)*3
    out[i*3]   = pts[s]   + (Math.random()-.5)*.06
    out[i*3+1] = pts[s+1] + (Math.random()-.5)*.06
    out[i*3+2] = pts[s+2]
  }
  return out
}

function makeSphere(N, r=1.90){
  const a=new Float32Array(N*3), P=Math.PI*(1+Math.sqrt(5))
  for(let i=0;i<N;i++){
    const phi=Math.acos(1-(2*(i+.5))/N), th=P*i
    const ri=r*(.45+Math.random()*.65)
    a[i*3]  =ri*Math.sin(phi)*Math.cos(th)
    a[i*3+1]=ri*Math.sin(phi)*Math.sin(th)
    a[i*3+2]=ri*Math.cos(phi)
  }
  return a
}

// ════════════════════════════════════════════════════════════════
//  CURSOR
// ════════════════════════════════════════════════════════════════
class Cursor {
  constructor(){
    this.x=-400; this.y=-400
    this.rx=-400; this.ry=-400
    this.rvx=0;   this.rvy=0
    this.dot  = document.getElementById('cur-dot')
    this.ring = document.getElementById('cur-ring')
  }
  move(x,y){ this.x=x; this.y=y }
  hide(){ this.x=-400; this.y=-400 }
  update(dt, nearPct){
    const SP=0.13, DP=0.70
    this.rvx=this.rvx*DP+(this.x-this.rx)*SP
    this.rvy=this.rvy*DP+(this.y-this.ry)*SP
    this.rx+=this.rvx; this.ry+=this.rvy
    this.dot.style.transform =`translate(calc(${this.x}px - 50%),calc(${this.y}px - 50%))`
    this.ring.style.transform=`translate(calc(${this.rx}px - 50%),calc(${this.ry}px - 50%))`
    this.ring.classList.toggle('near', nearPct>0.08)
  }
  click(){
    this.ring.classList.add('click')
    setTimeout(()=>this.ring.classList.remove('click'),180)
  }
}

// ════════════════════════════════════════════════════════════════
//  SHOCKWAVE
// ════════════════════════════════════════════════════════════════
function fireShockwave(){
  const el = document.getElementById('shock')
  el.classList.remove('fire')
  void el.offsetWidth   // reflow to restart animation
  el.classList.add('fire')
}

// ════════════════════════════════════════════════════════════════
//  MAIN
// ════════════════════════════════════════════════════════════════
async function init(){
  try{ await document.fonts.load('900 192px "Bebas Neue"') }catch(e){}
  await new Promise(r=>setTimeout(r,80))

  const W=()=>window.innerWidth, H=()=>window.innerHeight
  const DPR=Math.min(devicePixelRatio??1,2)

  // ── Sample all words upfront ────────────────────────────
  console.log('[FX] Sampling words...')
  const rawWords = WORDS.map(w => sampleRaw(w))
  const N = Math.round(Math.max(...rawWords.map(r=>r.length/3)) * 1.08)
  const wordPos = rawWords.map(r => padToN(r,N))
  console.log(`[FX] ${N} particles, ${WORDS.length} words`)

  // ── Renderer ────────────────────────────────────────────
  const canvas = document.getElementById('c')
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias:false, alpha:false, powerPreference:'high-performance'
  })
  renderer.setSize(W(),H())
  renderer.setPixelRatio(DPR)
  renderer.setClearColor(0x030308,1)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05

  const scene = new THREE.Scene()
  scene.fog   = new THREE.FogExp2(0x030308, 0.15)

  const cam = new THREE.PerspectiveCamera(45,W()/H(),0.1,20)
  cam.position.set(0,0,4.8)
  const camBase = cam.position.clone()

  // ── Post-processing bloom ───────────────────────────────
  const composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene,cam))
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(W()*DPR,H()*DPR),
    1.25,   // strength — luminous, not blinding
    0.52,   // radius
    0.08    // threshold — catches even dim particles
  )
  composer.addPass(bloom)
  composer.addPass(new OutputPass())

  // ── Geometry ────────────────────────────────────────────
  const geo       = new THREE.BufferGeometry()
  const spherePos = makeSphere(N)
  const aSize     = new Float32Array(N)
  const aChg      = new Float32Array(N)
  const aDel      = new Float32Array(N)
  const aHue      = new Float32Array(N)
  const aPh       = new Float32Array(N)

  for(let i=0;i<N;i++){
    aSize[i] = 0.010 + Math.random()*0.006  // → ~2–4px at cam z=4.8
    aChg[i]  = Math.random()<.38 ? -1 : 1
    aDel[i]  = Math.random()
    aHue[i]  = Math.random()
    aPh[i]   = Math.random()*Math.PI*2
  }

  geo.setAttribute('position', new THREE.BufferAttribute(spherePos.slice(),3))
  geo.setAttribute('aOriginA', new THREE.BufferAttribute(wordPos[0].slice(),3))
  geo.setAttribute('aOriginB', new THREE.BufferAttribute(wordPos[0].slice(),3))
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
    uWordHueA:  {value: WORD_HUES[0]/360},
    uWordHueB:  {value: WORD_HUES[0]/360},
  }

  scene.add(new THREE.Points(geo, new THREE.ShaderMaterial({
    vertexShader:VERT, fragmentShader:FRAG, uniforms,
    blending:THREE.AdditiveBlending,
    depthWrite:false, depthTest:false, transparent:true,
  })))

  // ── State ────────────────────────────────────────────────
  let wordIdx   = 0       // A side (settled word)
  let nextIdx   = 1       // B side (target)
  let morphT    = 0       // 0..1 shader morph value
  let morphVel  = 0       // spring velocity for snap
  let morphMode = 'idle'  // idle | scroll | snap-fwd | snap-back | click | auto

  // Scroll state
  let scrollAccum    = 0          // accumulated wheel delta
  let scrollIdleTime = 0          // seconds since last wheel event
  const SCROLL_FULL  = 700        // wheel px to complete a full morph
  const SCROLL_IDLE_SNAP = 0.18   // seconds of no scroll before snap

  // Auto morph
  let autoTimer   = 0
  const AUTO_SEC  = 5.0

  let introC      = 0
  let scrollRaw   = 0, scrollS = 0
  let mouse       = new THREE.Vector2(0,0)
  let mouseS      = new THREE.Vector2(0,0)
  let hasMoved    = false
  let prev        = performance.now()
  let t           = 0
  let nearProxy   = 0

  const cursor    = new Cursor()
  const numEl     = document.getElementById('word-num')
  const nameEl    = document.getElementById('word-name')
  const scrubEl   = document.getElementById('scrub-bar')
  const accentEl  = document.getElementById('accent-bar')

  // Convert word hue → CSS hsl colour
  function hueToCSS(h){ return `hsl(${h},80%,62%)` }

  function updateUI(idx){
    numEl.textContent  = `${String(idx+1).padStart(2,'0')} / ${String(WORDS.length).padStart(2,'0')}`
    nameEl.textContent = WORDS[idx]
    // Accent bar colour
    accentEl.style.setProperty('--word-color', hueToCSS(WORD_HUES[idx]))
    accentEl.classList.add('show')
    // Bloom tint — slightly shift bloom hue per word
    const h = WORD_HUES[idx]/360
    uniforms.uWordHueA.value = h
    document.title = WORDS[idx]
  }

  // ── Bake current blend into A, set new B ────────────────
  function setMorphTargets(fromIdx, toIdx){
    const A = wordPos[fromIdx], B = wordPos[toIdx]
    const curMt = uniforms.uMorphT.value
    const baked = new Float32Array(N*3)
    for(let i=0;i<N*3;i++) baked[i]=A[i]*(1-curMt)+B[i]*curMt

    geo.attributes.aOriginA.array.set(baked)
    geo.attributes.aOriginA.needsUpdate=true
    geo.attributes.aOriginB.array.set(wordPos[toIdx])
    geo.attributes.aOriginB.needsUpdate=true
    uniforms.uMorphT.value=0
    uniforms.uWordHueB.value = WORD_HUES[toIdx]/360
    morphT=0; morphVel=0
    nextIdx=toIdx
  }

  // ── Morph complete callback ──────────────────────────────
  function onMorphComplete(){
    wordIdx = nextIdx
    nextIdx = (wordIdx+1) % WORDS.length
    // Bake completed word into A, reset B=same
    geo.attributes.aOriginA.array.set(wordPos[wordIdx])
    geo.attributes.aOriginA.needsUpdate=true
    geo.attributes.aOriginB.array.set(wordPos[wordIdx])
    geo.attributes.aOriginB.needsUpdate=true
    uniforms.uWordHueA.value = WORD_HUES[wordIdx]/360
    uniforms.uWordHueB.value = WORD_HUES[wordIdx]/360
    uniforms.uMorphT.value=0
    morphT=0; morphVel=0
    morphMode='idle'
    autoTimer=0
    scrollAccum=0
    updateUI(wordIdx)
    fireShockwave()
  }

  // ── Trigger morph programmatically ──────────────────────
  function triggerMorph(mode='click'){
    if(morphMode==='scroll') return  // let scroll finish
    const to=(wordIdx+1)%WORDS.length
    setMorphTargets(wordIdx, to)
    morphMode=mode
    autoTimer=0
  }

  updateUI(0)

  // ── Events ──────────────────────────────────────────────
  window.addEventListener('mousemove',e=>{
    mouse.x=(e.clientX/W())*2-1
    mouse.y=-(e.clientY/H())*2+1
    cursor.move(e.clientX,e.clientY)
    if(!hasMoved){ hasMoved=true; document.getElementById('hint').classList.add('gone') }
    // Reset auto timer on interaction
    if(morphMode==='idle'||morphMode==='auto') autoTimer=0
  })
  window.addEventListener('mouseleave',()=>{
    mouse.set(0,0); cursor.hide()
  })
  window.addEventListener('touchmove',e=>{
    const t0=e.touches[0]
    mouse.x=(t0.clientX/W())*2-1
    mouse.y=-(t0.clientY/H())*2+1
    cursor.move(t0.clientX,t0.clientY)
  },{passive:true})

  // ── WHEEL → physical scroll-drag morph ──────────────────
  window.addEventListener('wheel',e=>{
    e.preventDefault()
    const f=e.deltaMode===1?28:e.deltaMode===2?500:1
    const delta=e.deltaY*f

    // Scroll also tweaks rotation for visual feedback
    scrollRaw=Math.max(-Math.PI/1.6,Math.min(Math.PI/1.6,scrollRaw+delta*.00040))

    // If idle/auto, start a scroll morph
    if(morphMode==='idle'||morphMode==='auto'){
      setMorphTargets(wordIdx,(wordIdx+1)%WORDS.length)
      morphMode='scroll'
      scrollAccum=0
    }

    if(morphMode==='scroll'){
      scrollAccum=Math.max(0,Math.min(SCROLL_FULL,scrollAccum+Math.abs(delta)))
      morphT = scrollAccum/SCROLL_FULL
      uniforms.uMorphT.value=morphT
      scrollIdleTime=0
      autoTimer=0
    }
  },{passive:false})

  // ── CLICK → instant snap-forward morph ──────────────────
  canvas.addEventListener('click',()=>{
    cursor.click()
    if(morphMode==='idle'||morphMode==='auto'){
      triggerMorph('click')
    } else if(morphMode==='scroll'){
      // Force snap forward from wherever scroll is
      morphMode='snap-fwd'
    }
    if(!hasMoved){ hasMoved=true; document.getElementById('hint').classList.add('gone') }
    autoTimer=0
  })

  window.addEventListener('resize',()=>{
    renderer.setSize(W(),H())
    composer.setSize(W(),H())
    bloom.resolution.set(W()*DPR,H()*DPR)
    cam.aspect=W()/H()
    cam.updateProjectionMatrix()
    uniforms.uRes.value.set(W(),H())
  })

  // ════════════════════════════════════════════════════════
  //  RENDER LOOP
  // ════════════════════════════════════════════════════════
  ;(function tick(){
    requestAnimationFrame(tick)
    const now=performance.now()
    const dt=Math.min((now-prev)/1000,.05)
    prev=now; t+=dt

    // ── Intro spring ──────────────────────────────────────
    introC+=(1-introC)*Math.min(dt*.60,.04)
    uniforms.uIntro.value=Math.min(introC,1)

    // ── State machine ─────────────────────────────────────
    if(morphMode==='scroll'){
      scrollIdleTime+=dt
      // Update scrub bar
      scrubEl.style.width=(morphT*100)+'%'
      scrubEl.style.opacity='1'

      if(scrollIdleTime>SCROLL_IDLE_SNAP){
        // User stopped scrolling — snap decision
        morphMode = morphT>0.50 ? 'snap-fwd' : 'snap-back'
      }
    }

    else if(morphMode==='snap-fwd'){
      // Spring morphT toward 1
      const STIFF=0.18, DAMP=0.72
      morphVel = morphVel*DAMP + (1.0-morphT)*STIFF
      morphT   = Math.min(morphT+morphVel*dt*60, 1.0)
      uniforms.uMorphT.value=morphT
      scrubEl.style.width=(morphT*100)+'%'
      if(morphT>=0.999){ morphT=1; onMorphComplete(); scrubEl.style.opacity='0' }
    }

    else if(morphMode==='snap-back'){
      // Spring morphT toward 0
      const STIFF=0.18, DAMP=0.72
      morphVel = morphVel*DAMP + (0.0-morphT)*STIFF
      morphT   = Math.max(morphT+morphVel*dt*60, 0.0)
      uniforms.uMorphT.value=morphT
      scrubEl.style.width=(morphT*100)+'%'
      if(morphT<=0.001){
        morphT=0; morphVel=0; morphMode='idle'; scrollAccum=0
        scrubEl.style.opacity='0'
        // Revert B back to A (no morph)
        geo.attributes.aOriginB.array.set(wordPos[wordIdx])
        geo.attributes.aOriginB.needsUpdate=true
        uniforms.uWordHueB.value=WORD_HUES[wordIdx]/360
      }
    }

    else if(morphMode==='click'||morphMode==='auto'){
      // Smooth spring morph
      const STIFF=0.15, DAMP=0.75
      morphVel = morphVel*DAMP + (1.0-morphT)*STIFF
      morphT   = Math.min(morphT+morphVel*dt*60, 1.0)
      uniforms.uMorphT.value=morphT
      scrubEl.style.width=(morphT*100)+'%'
      scrubEl.style.opacity='1'
      if(morphT>=0.999){ morphT=1; onMorphComplete(); scrubEl.style.opacity='0' }
    }

    else if(morphMode==='idle'){
      autoTimer+=dt
      // Show auto-morph countdown in accent bar opacity
      const pct=Math.min(autoTimer/AUTO_SEC,1)
      scrubEl.style.width=(pct*100)+'%'
      scrubEl.style.opacity=String(0.08+pct*0.18)
      if(autoTimer>=AUTO_SEC){ triggerMorph('auto') }
    }

    // ── Mouse smooth ──────────────────────────────────────
    mouseS.lerp(mouse,1-Math.pow(.025,dt))
    uniforms.uMouse.value.copy(mouseS)

    // ── Scroll Y-rotation spring-back ─────────────────────
    scrollRaw*=.972
    scrollS  +=(scrollRaw-scrollS)*Math.min(dt*3.,.12)
    uniforms.uScrollRot.value=scrollS

    // ── Camera parallax ──────────────────────────────────
    cam.position.x+=(camBase.x+mouseS.x*.13-cam.position.x)*.05
    cam.position.y+=(camBase.y+mouseS.y*.08-cam.position.y)*.05
    cam.lookAt(0,0,0)

    // ── Proximity for cursor ring ─────────────────────────
    const inBox = Math.abs(mouseS.x)<0.70 && Math.abs(mouseS.y)<0.25
    nearProxy+=(((inBox?1:0)-nearProxy))*Math.min(dt*4,.15)
    cursor.update(dt, nearProxy)

    uniforms.uTime.value=t
    composer.render()
  })()

  console.log('[FX] ✓  bloom + morph + scroll-drag + cursor running')
}

init().catch(e=>console.error('[FX] Fatal:', e))
