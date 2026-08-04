// AI Code Conductor animated boot splash (adapted from the brand asset
// package, 2026-08-04). Integration changes vs the source asset:
//  - three.js r160 (MIT) is imported from a vendored file beside this one and
//    the Montserrat subset is a local @font-face — no CDN/network at boot.
//  - The brand SVG is read from the inert <script id="logoSrc"> block in
//    index.html; fetch() is not available on file:// pages.
//  - The 7 s preview timeline plays at SPEED (~2.9 s wall clock) — the main
//    process holds the window for SPLASH_MIN_MS >= that, then fades it out.
//  - Preview-harness hooks (Replay chip, seek events, screen labels) removed.
//  - If anything in init throws (e.g. WebGL unavailable), body gets .nofx and
//    CSS shows the static mark + drives the loading bar instead.
import * as THREE from './three.module.min.js';

const SPEED = 2.4; // 7 s authored timeline -> ~2.9 s on screen

document.body.classList.remove('nojs');

// Backdrop HUD artifacts (deterministic, independent of WebGL).
{
  let sd = 7; const rnd = () => { sd = (sd * 1664525 + 1013904223) >>> 0; return sd / 4294967296; };
  const bg = document.getElementById('bg');
  const tickAt = (x, y) => { const d = document.createElement('div'); d.className = 'tick'; d.style.left = 'calc(' + x + ' - 6px)'; d.style.top = 'calc(' + y + ' - 6px)'; bg.appendChild(d); };
  tickAt('26px', '26px'); tickAt('100% - 26px', '26px'); tickAt('26px', '100% - 26px'); tickAt('100% - 26px', '100% - 26px');
  const dotAt = (x, y) => { const d = document.createElement('div'); d.className = 'dot'; d.style.left = 'calc(' + x + ' - 2px)'; d.style.top = 'calc(' + y + ' - 2px)'; bg.appendChild(d); };
  dotAt('50%', '26px'); dotAt('50%', '100% - 26px'); dotAt('26px', '50%'); dotAt('100% - 26px', '50%');
  for (const id of ['colL', 'colR']) {
    const svg = document.getElementById(id); let h = '';
    for (let r = 0; r < 26; r++) {
      let x = 0; const y = r * 16;
      const n = 3 + (rnd() * 5 | 0);
      for (let k = 0; k < n; k++) { const w = 6 + rnd() * 26; h += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="3" rx="1.5" fill="rgba(150,180,235,' + (0.05 + rnd() * 0.08).toFixed(3) + '"></rect>'; x += w + 7; if (x > 130) break; }
    }
    svg.innerHTML = h;
  }
  const bars = document.getElementById('bars'); let bh = '';
  for (let k = 0; k < 16; k++) { const v = 6 + rnd() * 52; bh += '<rect x="' + (k * 8) + '" y="' + (70 - v) + '" width="4" height="' + v + '" fill="rgba(150,180,235,' + (0.06 + rnd() * 0.07).toFixed(3) + '"></rect>'; }
  bars.innerHTML = bh;
}

try {
  await init();
} catch (err) {
  console.error('[splash] init failed, falling back to static mark:', err);
  document.body.classList.add('nofx');
}

async function init() {
  const N = 14000, DUR = 7;
  const stage = document.getElementById('stage');
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  stage.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);

  function sample(draw) {
    const c = document.createElement('canvas'); c.width = 1400; c.height = 700;
    const ctx = c.getContext('2d');
    draw(ctx);
    const d = ctx.getImageData(0, 0, 1400, 700).data, pts = [];
    let guard = 0;
    while (pts.length < N && guard < N * 400) {
      guard++;
      const px = Math.random() * 1400, py = Math.random() * 700;
      const i = ((py | 0) * 1400 + (px | 0)) * 4;
      if (d[i + 3] > 100) {
        const isB = d[i] < 200 && d[i + 2] > 200;
        pts.push([(px - 700) * (4.6 / 1400), (350 - py) * (4.6 / 1400), (Math.random() - 0.5) * 0.05, isB ? 0.10 : d[i] / 255 * 0.82, isB ? 0.33 : d[i + 1] / 255 * 0.82, isB ? 0.78 : d[i + 2] / 255 * 0.82]);
      }
    }
    while (pts.length < N) pts.push(pts[(Math.random() * pts.length) | 0]);
    return pts;
  }
  function drawAI(ctx) {
    ctx.font = 'italic bold 620px "Segoe UI", Arial, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const chars = [{ ch: 'A', col: '#2F9BFF' }, { ch: 'I', col: '#e0e0e0' }];
    const gap = 42;
    let tw = gap; for (const q of chars) tw += ctx.measureText(q.ch).width;
    let x = (1400 - tw) / 2;
    for (const q of chars) { ctx.fillStyle = q.col; ctx.fillText(q.ch, x, 350); x += ctx.measureText(q.ch).width + gap; }
  }
  function drawBrackets(ctx) {
    ctx.font = 'bold 560px "Segoe UI", Arial, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const chars = [{ ch: '<', col: '#2F9BFF' }, { ch: '/', col: '#e0e0e0' }, { ch: '>', col: '#2F9BFF' }];
    let tw = 0; for (const q of chars) tw += ctx.measureText(q.ch).width;
    let x = (1400 - tw) / 2;
    for (const q of chars) { ctx.fillStyle = q.col; ctx.fillText(q.ch, x, 350); x += ctx.measureText(q.ch).width; }
  }
  const ptsA = sample(drawAI), ptsB = sample(drawBrackets);
  // ---- real brand SVG: A + I become particle targets; ring + ONDUCTOR reveal as crisp vector ----
  const svgText = document.getElementById('logoSrc').textContent;
  const dLight = svgText.match(/<path d="([^"]+)"/)[1];
  const dBlue = svgText.match(/<path d="([^"]+)"[^>]*fill="#2F9BFF"/)[1];
  const iS = dLight.indexOf('M 206 165');
  let iE = dLight.indexOf('M ', iS + 2); if (iE < 0) iE = dLight.length;
  const dI = dLight.slice(iS, iE), dRest = (dLight.slice(0, iS) + dLight.slice(iE)).trim();
  // split remaining subpaths into ring (C) vs word (ONDUCTOR) by x position
  let dRing = '', dWord = '';
  for (const sp of dRest.split(/(?=M )/)) {
    if (!sp.trim()) continue;
    (parseFloat(sp.slice(2)) < 265 ? dRing += sp : dWord += sp);
  }
  document.getElementById('ringWrap').innerHTML = '<svg viewBox="0 0 810 331" width="810" height="331"><defs><linearGradient id="cg" x1="0%" y1="92%" x2="85%" y2="8%"><stop offset="0%" stop-color="#2F9BFF"></stop><stop offset="52%" stop-color="#8fb8e6"></stop><stop offset="100%" stop-color="#d9dbe0"></stop></linearGradient></defs><path id="pRing" d="' + dRing + '" fill="url(#cg)" fill-rule="evenodd"></path></svg>';
  document.getElementById('wordWrap').innerHTML = '<svg viewBox="0 0 810 331" width="810" height="331"><path id="pWord" d="' + dWord + '" fill="#d9dbe0" fill-rule="evenodd"></path></svg>';
  const rb = document.getElementById('pRing').getBBox();
  const RCY = rb.y + rb.height / 2, RCR = rb.height / 2, RCX = rb.x + RCR; // C is a circle open on the right
  const wb = document.getElementById('pWord').getBBox();
  // replace traced word with real type (smooth, slight italic), fitted to the same slot
  await document.fonts.load('italic 600 100px Montserrat');
  document.getElementById('wordWrap').innerHTML = '<div id="ondt" style="position:absolute;white-space:nowrap;font-family:Montserrat,sans-serif;font-style:italic;font-weight:600;color:#d9dbe0;letter-spacing:0.05em;transform-origin:0 50%;">ONDUCTOR</div>';
  const ondt = document.getElementById('ondt');
  ondt.style.fontSize = (wb.height * 1.36) + 'px';
  ondt.style.left = wb.x + 'px';
  ondt.style.top = (wb.y + wb.height / 2) + 'px';
  ondt.style.transform = 'translateY(-54%) scaleX(1)';
  const kx = wb.width / Math.max(1, ondt.offsetWidth);
  ondt.style.transform = 'translateY(-54%) scaleX(' + kx + ')';
  const WPU = 5.9 / 810, K3 = 1.38, MS = 0.74, MDX = 27; // final monogram: 26% smaller, nudged toward the word
  function sampleMono() {
    const c = document.createElement('canvas'); c.width = 1620; c.height = 662;
    const ctx = c.getContext('2d'); ctx.scale(2, 2);
    ctx.fillStyle = '#e0e0e0'; ctx.fill(new Path2D(dI));
    ctx.fillStyle = '#2F9BFF'; ctx.fill(new Path2D(dBlue), 'evenodd');
    const d = ctx.getImageData(0, 0, 1620, 662).data, pts = [];
    let guard = 0;
    while (pts.length < N && guard < N * 400) {
      guard++;
      const px = Math.random() * 1620, py = Math.random() * 662;
      const i = ((py | 0) * 1620 + (px | 0)) * 4;
      if (d[i + 3] > 100) {
        // pre-compensate azure for additive blending (overlap shifts hue toward cyan/white)
        const isB = d[i] < 200 && d[i + 2] > 200;
        pts.push([px / 2, py / 2, isB ? 0.10 : d[i] / 255 * 0.82, isB ? 0.33 : d[i + 1] / 255 * 0.82, isB ? 0.78 : d[i + 2] / 255 * 0.82]);
      }
    }
    while (pts.length < N) pts.push(pts[(Math.random() * pts.length) | 0]);
    return pts;
  }
  const ptsM = sampleMono();
  const isWM = q => q[2] > 0.6 && q[3] > 0.6 && q[4] > 0.6;
  const wM = ptsM.filter(isWM), bM = ptsM.filter(q => !isWM(q));
  let wmi = 0, bmi = 0;
  // bucket stage-1 points by tone so each particle keeps ONE color across formations
  const isW = q => q[3] > 0.6 && q[4] > 0.6 && q[5] > 0.6;
  const wA = ptsA.filter(isW), bA = ptsA.filter(q => !isW(q));
  let wi = 0, bi = 0;
  // stage-3 targets: the real monogram A + I from the brand SVG
  const geo = new THREE.BufferGeometry();
  const start = new Float32Array(N * 3), target = new Float32Array(N * 3), target2 = new Float32Array(N * 3),
    target3 = new Float32Array(N * 3), target4 = new Float32Array(N * 3), col = new Float32Array(N * 3), seed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const r = 2.6 * Math.pow(Math.random(), 0.5), th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
    start[i * 3] = r * Math.sin(ph) * Math.cos(th); start[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th) * 0.7; start[i * 3 + 2] = r * Math.cos(ph) * 0.5;
    const fin = ptsB[i];
    const a = isW(fin) ? (wA.length ? wA[(wi++) % wA.length] : fin) : (bA.length ? bA[(bi++) % bA.length] : fin);
    target[i * 3] = a[0]; target[i * 3 + 1] = a[1]; target[i * 3 + 2] = a[2];
    target2[i * 3] = fin[0]; target2[i * 3 + 1] = fin[1]; target2[i * 3 + 2] = fin[2];
    const mpt = isW(fin) ? (wM.length ? wM[(wmi++) % wM.length] : null) : (bM.length ? bM[(bmi++) % bM.length] : null);
    if (mpt) {
      // centered monogram first (bigger), then the final brand position
      target3[i * 3] = (mpt[0] - RCX) * WPU * K3; target3[i * 3 + 1] = (RCY - mpt[1]) * WPU * K3; target3[i * 3 + 2] = (Math.random() - 0.5) * 0.04;
      target4[i * 3] = ((RCX + MDX + (mpt[0] - RCX) * MS) - 405) * WPU; target4[i * 3 + 1] = (165.5 - (RCY + (mpt[1] - RCY) * MS)) * WPU; target4[i * 3 + 2] = (Math.random() - 0.5) * 0.03;
    } else { target3[i * 3] = 0; target3[i * 3 + 1] = 0; target3[i * 3 + 2] = 0; target4[i * 3] = 0; target4[i * 3 + 1] = 0; target4[i * 3 + 2] = 0; }
    col[i * 3] = fin[3]; col[i * 3 + 1] = fin[4]; col[i * 3 + 2] = fin[5];
    seed[i] = Math.random();
  }
  geo.setAttribute('position', new THREE.BufferAttribute(start.slice(), 3));
  geo.setAttribute('aStart', new THREE.BufferAttribute(start, 3));
  geo.setAttribute('aTarget', new THREE.BufferAttribute(target, 3));
  geo.setAttribute('aTarget2', new THREE.BufferAttribute(target2, 3));
  geo.setAttribute('aTarget3', new THREE.BufferAttribute(target3, 3));
  geo.setAttribute('aTarget4', new THREE.BufferAttribute(target4, 3));
  geo.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const uni = { uT: { value: 0 }, uPr: { value: renderer.getPixelRatio() }, uColA: { value: new THREE.Color('#f0a05c') }, uColB: { value: new THREE.Color('#e0673f') } };
  const mat = new THREE.ShaderMaterial({
    uniforms: uni, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `
    attribute vec3 aStart,aTarget,aTarget2,aTarget3,aTarget4,aCol; attribute float aSeed;
    uniform float uT,uPr;
    varying float vA,vMix,vF,vF2; varying vec3 vC;
    float ss(float a,float b,float x){ x=clamp((x-a)/(b-a),0.,1.); return x*x*x*(x*(x*6.-15.)+10.); }
    void main(){
      float t=uT, s=aSeed;
      // chaotic drift while free
      vec3 p=aStart;
      p+=vec3(sin(t*(0.7+1.1*fract(s*13.7))+s*40.), cos(t*(0.8+0.9*fract(s*7.7))+s*80.), sin(t*(0.6+0.8*fract(s*5.3))+s*60.))*0.3;
      // fly straight in: migration starts immediately, light stagger
      float m=ss(0.15+s*0.4, 0.95+s*0.4, t);
      float sgn=sign(fract(s*7.0)-0.5);
      vec3 tr=aTarget-p;
      vec3 q=mix(p,aTarget,m);
      q+=normalize(vec3(-tr.y,tr.x,0.001))*sgn*sin(m*3.14159)*min(0.3,0.1*length(tr))*(0.4+0.6*fract(s*11.3));
      // stage 2: AI flows into </>
      float m2=ss(1.7+s*0.25, 2.45+s*0.25, t);
      vec3 tr2=aTarget2-aTarget;
      q=mix(q,aTarget2,m2);
      q+=normalize(vec3(-tr2.y,tr2.x,0.001))*sgn*sin(m2*3.14159)*min(0.24,0.09*length(tr2))*(0.4+0.6*fract(s*17.7));
      // stage 3: </> flies into the CENTERED monogram A I (the logo moment)
      float m3=ss(3.3+s*0.22, 4.2+s*0.22, t);
      vec3 tr3=aTarget3-aTarget2;
      q=mix(q,aTarget3,m3);
      q+=normalize(vec3(-tr3.y,tr3.x,0.001))*sgn*sin(m3*3.14159)*min(0.24,0.09*length(tr3))*(0.4+0.6*fract(s*23.3));
      // stage 4: the assembled mark glides as one unit into the brand lockup
      float m4=ss(5.6, 6.3, t);
      vec3 tr4=aTarget4-aTarget3;
      q=mix(q,aTarget4,m4);
      q+=normalize(vec3(-tr4.y,tr4.x,0.001))*sin(m4*3.14159)*0.06;
      // settled: gentle shimmer only
      // some particles evaporate during the final glide (lighter finished mark)
      float kill=step(0.55,fract(s*4.71));
      float st=max(max(m,m2),max(m3,m4));
      q+=vec3(sin(t*5.+s*41.),cos(t*4.+s*57.),0.)*0.006*st;
      vMix=fract(s*3.77); vF=m; vF2=st; vC=aCol;
      vec4 mv=modelViewMatrix*vec4(q,1.);
      gl_PointSize=(1.6+2.6*fract(s*5.19))*(1.+0.12*st)*uPr*(6.0/-mv.z);
      vA=smoothstep(0.02,0.65,m)*(0.55+0.12*st)*(0.55+0.45*fract(s*9.13))*(1.-smoothstep(0.,0.25,m4)*kill);
      gl_Position=projectionMatrix*mv;
    }`,
    fragmentShader: `
    uniform vec3 uColA,uColB; varying float vA,vMix,vF,vF2; varying vec3 vC;
    void main(){
      vec2 uv=gl_PointCoord-0.5; float d=length(uv);
      float a=smoothstep(0.5,0.08,d)*vA;
      if(a<0.01) discard;
      vec3 c=vC*(0.95+0.12*vF2);
      gl_FragColor=vec4(c,a);
    }`});
  scene.add(new THREE.Points(geo, mat));

  let clock = 0, last = performance.now();
  const logo = document.getElementById('logo'), ringWrap = document.getElementById('ringWrap'), wordWrap = document.getElementById('wordWrap');
  function render(t) {
    uni.uT.value = t;
    const mEx = Math.min(1, Math.max(0, (t - 5.6) / 0.7)), me = mEx * mEx * mEx * (mEx * (mEx * 6 - 15) + 10);
    const zb = fit(2.9, 2.2) + (fit(3.35, 1.5) - fit(2.9, 2.2)) * me;
    camera.position.set(0, 0, zb * (1.025 - 0.0055 * Math.min(t, DUR))); // slow cinematic push-in
    camera.lookAt(0, 0, 0);
    // overlay: ring sweeps on around the centered monogram, then the mark glides left as ONDUCTOR wipes in
    logo.style.opacity = t > 4.5 ? 1 : 0;
    if (t > 4.5) {
      const W = stage.clientWidth, H = stage.clientHeight;
      // ring: centered@K3 -> final (smaller, nudged right), its own transform
      const Sr = WPU * (K3 + (MS - K3) * me);
      const ax = ((RCX + MDX - 405) * WPU) * me, ay = ((165.5 - RCY) * WPU) * me;
      const cwx = ax - RCX * Sr, cwy = ay + RCY * Sr;
      const v = new THREE.Vector3(cwx, cwy, 0).project(camera);
      const v2 = new THREE.Vector3(cwx + 1, cwy, 0).project(camera);
      const pxPerWorld = Math.abs(v2.x - v.x) / 2 * W;
      ringWrap.style.transform = 'translate(' + ((v.x + 1) / 2 * W) + 'px,' + ((1 - v.y) / 2 * H) + 'px) scale(' + (pxPerWorld * Sr) + ')';
      // word: static final mapping
      const v3 = new THREE.Vector3(-405 * WPU, 165.5 * WPU, 0).project(camera);
      wordWrap.style.transform = 'translate(' + ((v3.x + 1) / 2 * W) + 'px,' + ((1 - v3.y) / 2 * H) + 'px) scale(' + (pxPerWorld * WPU) + ')';
      // C ring: gradient vector, conic sweep reveal around its own center
      ringWrap.style.opacity = Math.min(1, Math.max(0, (t - 4.55) * 4));
      const de = Math.min(1, Math.max(0, (t - 4.6) / 0.85));
      const ang = (de * de * (3 - 2 * de)) * 372;
      const rmk = 'conic-gradient(from -100deg at ' + (RCX / 810 * 100) + '% ' + (RCY / 331 * 100) + '%, #000 ' + (ang - 2) + 'deg, transparent ' + (ang + 14) + 'deg)';
      ringWrap.style.webkitMaskImage = rmk; ringWrap.style.maskImage = rmk;
      // ONDUCTOR: wipes in as the mark arrives
      wordWrap.style.opacity = Math.min(1, Math.max(0, (t - 5.75) * 3));
      const wp = Math.min(1, Math.max(0, (t - 5.75) / 0.95));
      const wpe = wp * wp * (3 - 2 * wp);
      const we = wpe * 130;
      ondt.style.letterSpacing = (0.05 + 0.09 * (1 - wpe)) + 'em'; // tracking-in
      const wmk = 'linear-gradient(90deg,#000 ' + (we - 16) + '%,transparent ' + we + '%)';
      wordWrap.style.webkitMaskImage = wmk; wordWrap.style.maskImage = wmk;
    }
    const lp = 1 - Math.pow(1 - Math.min(1, Math.max(0, t / DUR)), 1.6);
    document.getElementById('lfill').style.width = (lp * 100) + '%';
    document.getElementById('glowline').style.opacity = 0.55 + 0.2 * Math.sin(t * 1.7);
    renderer.render(scene, camera);
  }
  function fit(needW, needH) {
    const fov = camera.fov * Math.PI / 180;
    return Math.max(needH / Math.tan(fov / 2), needW / (Math.tan(fov / 2) * camera.aspect)) + 0.6;
  }
  function loop(now) {
    requestAnimationFrame(loop);
    const dt = (now - last) / 1000; last = now;
    clock += dt * SPEED; render(clock);
  }
  function resize() {
    renderer.setSize(stage.clientWidth, stage.clientHeight, false);
    camera.aspect = stage.clientWidth / stage.clientHeight; camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize);
  resize(); render(0); requestAnimationFrame(loop);
}
