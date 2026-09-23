// 3D 場地視角(three.js r169,離線可用)
// 介面:window.View3D = { mount, render, setCamera, project }
import * as THREE from './three.module.min.js';
import { GLTFLoader } from './GLTFLoader.js';
import { mergeGeometries } from './BufferGeometryUtils.js';
// 後製特效(2026-09-23,使用者要「GTA6 高級光影」):環境遮蔽 GTAO + 光暈 Bloom
import { EffectComposer } from './EffectComposer.js';
import { RenderPass } from './RenderPass.js';
import { GTAOPass } from './GTAOPass.js';
import { UnrealBloomPass } from './UnrealBloomPass.js';
import { OutputPass } from './OutputPass.js';
import { ShaderPass } from './ShaderPass.js';
import { CopyShader } from './CopyShader.js';

// ---- 常數 ----
const FW = 16.54, FH = 8.07;          // 場地大小(公尺)
const BALL_R = 0.075;                 // 球半徑(2026 FUEL 約 15cm 直徑)
const HELD_R = 0.075;                 // 機器裡的球
const WHEEL_R = 0.076;
const ARM_STOW = THREE.MathUtils.degToRad(80);     // 收起:朝上
const ARM_DEPLOY = Math.atan2(-0.22, 0.32);        // 放下:前方地板
const ARM_LEN = Math.hypot(0.32, 0.22);
const CAM_MODES = ['chase', 'fpv', 'top', 'broadcast'];
const CAM_FOV = { chase: 50, fpv: 60, top: 45, broadcast: 40 };   // 垂直 FOV

let renderer, scene, camera, container;
let W = 1, H = 1;
let camMode = 'chase', camInit = false, camBlend = 1, lastT = null, chaseYaw = null;
const camPos = new THREE.Vector3(), camTgt = new THREE.Vector3();
const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3();
let maxAniso = 4;

const R = {};              // 機器人零件
const hubs = [];           // 目標
const FIELD_CAP = 600;     // 場上球數上限
const SHOT_CAP = 300;      // 飛行球上限
let fieldInst, blobInst, shotInst;
let procG, arenaG, keyLight, debugCam = null, frameNo = 0;
let ballGeo, ballMat, blobTex, glowTex;
const colorCache = new Map();

// ---- 小工具 ----
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const wrapPi = a => Math.atan2(Math.sin(a), Math.cos(a));
function col(c) {
  if (!colorCache.has(c)) colorCache.set(c, new THREE.Color(c));
  return colorCache.get(c);
}
const stdCache = new Map();
function std(color, rough = 0.6, metal = 0, extra = {}) {
  // 沒有額外參數的材質共用同一個(方便合併 draw call)
  const plain = Object.keys(extra).length === 0 && typeof color === 'number';
  const key = plain && color + '|' + rough + '|' + metal;
  if (plain && stdCache.has(key)) return stdCache.get(key);
  const m = new THREE.MeshStandardMaterial(Object.assign({ color, roughness: rough, metalness: metal }, extra));
  if (plain) stdCache.set(key, m);
  return m;
}
function mesh(geo, mat, parent, x = 0, y = 0, z = 0, shadow = true) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = shadow;
  if (parent) parent.add(m);
  return m;
}
const box = (w, h, d, mat, p, x, y, z) => mesh(new THREE.BoxGeometry(w, h, d), mat, p, x, y, z);
function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAniso;
  return t;
}
function noiseCanvas(size, base, amp, tint = [0, 0, 0]) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const id = g.createImageData(size, size);
  for (let i = 0; i < id.data.length; i += 4) {
    const v = base + (Math.random() * 2 - 1) * amp;
    id.data[i] = v + tint[0]; id.data[i + 1] = v + tint[1]; id.data[i + 2] = v + tint[2]; id.data[i + 3] = 255;
  }
  g.putImageData(id, 0, 0);
  return c;
}
// 發光光暈(加法混色的 sprite)
function halo(color, size, opacity = 0.6) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color, transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  s.scale.setScalar(size);
  return s;
}

// ---- 環境反射(自製攝影棚,讓金屬有反光) ----
function makeEnvironment() {
  const env = new THREE.Scene();
  env.add(new THREE.Mesh(new THREE.BoxGeometry(40, 16, 40),
    new THREE.MeshBasicMaterial({ color: 0x1a1f27, side: THREE.BackSide })));
  const lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 5, 5.2) });
  for (let i = -2; i <= 2; i++) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(3, 26), lamp);
    p.rotation.x = Math.PI / 2; p.position.set(i * 6, 7.9, 0);
    env.add(p);
  }
  const blue = new THREE.Mesh(new THREE.PlaneGeometry(30, 3), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 0.8, 2.5) }));
  blue.position.set(0, 2, -19.9); env.add(blue);
  const red = new THREE.Mesh(new THREE.PlaneGeometry(30, 3), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.5, 0.5, 0.4) }));
  red.position.set(0, 2, 19.9); red.rotation.y = Math.PI; env.add(red);
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(env, 0.035).texture;
  pm.dispose();
  return tex;
}

// ---- 場地地毯貼圖(中灰地毯+細膠帶) ----
function makeFloorTexture() {
  const cw = 2048, ch = 1000, s = cw / FW;
  return canvasTex(cw, ch, (g) => {
    g.fillStyle = g.createPattern(noiseCanvas(256, 108, 12, [0, 2, 5]), 'repeat');
    g.fillRect(0, 0, cw, ch);
    // 地毯捲接縫(微微深淺)
    for (let i = 0; i * 3.66 < FH; i++) {
      g.fillStyle = i % 2 ? 'rgba(255,255,255,0.018)' : 'rgba(0,0,0,0.05)';
      g.fillRect(0, i * 3.66 * s, cw, 3.66 * s);
    }
    const lw = 0.05 * s;
    // 白色外框、中線
    g.strokeStyle = 'rgba(235,235,235,0.85)'; g.lineWidth = lw;
    g.strokeRect(lw / 2, lw / 2, cw - lw, ch - lw);
    g.fillStyle = 'rgba(235,235,235,0.85)';
    g.fillRect(FW / 2 * s - lw / 2, 0, lw, ch);
    // 聯盟線(清楚的藍/紅膠帶)
    g.fillStyle = '#1f6fe5'; g.fillRect(3.98 * s - lw / 2, 0, lw, ch);
    g.fillStyle = '#e5362f'; g.fillRect(12.56 * s - lw / 2, 0, lw, ch);
    // 聯盟區外框細膠帶
    g.lineWidth = lw * 0.6;
    g.strokeStyle = '#1f6fe5'; g.strokeRect(lw, lw, 3.98 * s - lw * 1.5, ch - lw * 2);
    g.strokeStyle = '#e5362f'; g.strokeRect(12.56 * s + lw / 2, lw, cw - 12.56 * s - lw * 1.5, ch - lw * 2);
    // 中央集球區(depot)的白框
    g.strokeStyle = 'rgba(235,235,235,0.6)'; g.lineWidth = lw * 0.6;
    g.strokeRect((FW / 2 - 0.9) * s, (FH / 2 - 2.6) * s, 1.8 * s, 5.2 * s);
    // 起始線小刻度
    g.fillStyle = 'rgba(235,235,235,0.5)';
    for (let y = 0.5; y < FH; y += 0.5) {
      g.fillRect(3.98 * s + lw, y * s - lw / 4, 0.12 * s, lw / 2);
      g.fillRect(12.56 * s - lw - 0.12 * s, y * s - lw / 4, 0.12 * s, lw / 2);
    }
  });
}

// ---- AprilTag 圖案(黑白方格) ----
function drawTag(g, x, y, size, id) {
  const c = size / 10;
  g.fillStyle = '#fff'; g.fillRect(x, y, size, size);
  g.fillStyle = '#000'; g.fillRect(x + c, y + c, c * 8, c * 8);
  let seed = id * 9301 + 49297;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.fillStyle = '#fff';
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) if (rnd() > 0.5) g.fillRect(x + c * (2 + i), y + c * (2 + j), c + 0.5, c + 0.5);
}
function tagTex(id, w = 256, h = 320) {
  return canvasTex(w, h, (g) => {
    g.fillStyle = '#e9ecef'; g.fillRect(0, 0, w, h);
    drawTag(g, 18, 18, w - 36, id);
    g.fillStyle = '#111'; g.font = `900 ${h - w - 8}px Arial, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(id), w / 2, w + (h - w) / 2 - 8);
  });
}

// 在兩點間放一根方管
function beam(a, b, t, mat, parent) {
  const d = new THREE.Vector3().subVectors(b, a), L = d.length();
  const m = mesh(new THREE.BoxGeometry(t, L, t), mat, parent);
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  return m;
}

// ---- 場地 ----
function buildField() {
  // 場外地板
  mesh(new THREE.PlaneGeometry(90, 70).rotateX(-Math.PI / 2), std(0x1a1d22, 0.9), scene, FW / 2, -0.005, FH / 2, false).receiveShadow = true;
  // 地毯(微微反光)
  const floor = mesh(new THREE.PlaneGeometry(FW, FH).rotateX(-Math.PI / 2),
    std(0xffffff, 0.72, 0, { map: makeFloorTexture() }), scene, FW / 2, 0, FH / 2, false);
  floor.receiveShadow = true;

  const alu = std(0xc3c8cf, 0.35, 0.9);
  const poly = new THREE.MeshStandardMaterial({
    color: 0xdbe8ff, transparent: true, opacity: 0.12, roughness: 0.05, metalness: 0,
    side: THREE.DoubleSide, depthWrite: false,
  });
  // 花紋鋼板(菱形紋)
  const diamond = canvasTex(128, 64, (g, w, h) => {
    g.fillStyle = '#9aa1a9'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#d9dee4'; g.lineWidth = 3;
    for (let i = 0; i < 8; i++) for (let j = 0; j < 4; j++) {
      const cx = i * 16 + (j % 2) * 8, cy = j * 16 + 8;
      g.beginPath(); g.moveTo(cx - 5, cy + 3); g.lineTo(cx + 5, cy - 3); g.stroke();
    }
  });
  diamond.wrapS = diamond.wrapT = THREE.RepeatWrapping;
  diamond.repeat.set(FW * 4, 1);
  const kick = std(0xffffff, 0.35, 0.85, { map: diamond });
  // 長邊護欄(y=0 與 y=FH)
  for (const y of [0, FH]) {
    const o = y === 0 ? -0.03 : 0.03;
    const panel = mesh(new THREE.PlaneGeometry(FW, 0.42), poly, scene, FW / 2, 0.36, y + o, false);
    panel.renderOrder = 2;
    box(FW, 0.15, 0.03, kick, scene, FW / 2, 0.075, y + o);
    box(FW, 0.045, 0.06, alu, scene, FW / 2, 0.57, y + o);
    for (let i = 0; i <= 10; i++) box(0.05, 0.6, 0.05, alu, scene, i * FW / 10, 0.3, y + o);
  }
  buildAllianceWall(0, '#1f6fe5', 'BLUE', 1);
  buildAllianceWall(FW, '#e5362f', 'RED', -1);
  buildTower(0.55, FH / 2 - 1.4, '#1f6fe5', 1);
  buildTower(FW - 0.55, FH / 2 + 1.4, '#e5362f', -1);
  // 場邊靜態物件不投影、也不收陰影(省效能),只留地毯
  scene.traverse(o => { if (o.isMesh) { o.castShadow = false; if (o !== floor) o.receiveShadow = false; } });
}

// 聯盟站牆:黑色實牆+上半窗
function buildAllianceWall(x, c, name, dir) {
  const g = new THREE.Group();
  g.position.x = x - dir * 0.05;
  scene.add(g);
  const dark = std(0x0c0e11, 0.6, 0.2);
  const alu = std(0xc3c8cf, 0.35, 0.9);
  box(0.1, 0.95, FH + 0.1, dark, g, 0, 0.475, FH / 2);
  // 站位編號
  const tex = canvasTex(2048, 96, (ctx, w, h) => {
    ctx.fillStyle = '#0c0e11'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = c; ctx.fillRect(0, h - 10, w, 10);
    ctx.fillStyle = '#fff';
    ctx.font = '900 52px Arial, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = 0; i < 3; i++) ctx.fillText(`${name} ${i + 1}`, (i + 0.5) * w / 3, h / 2 - 4);
  });
  const bm = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.4, roughness: 0.6 });
  const banner = mesh(new THREE.PlaneGeometry(FH, 0.3), bm, g, dir * 0.052, 0.72, FH / 2, false);
  banner.rotation.y = dir * Math.PI / 2;
  // 聯盟色燈條
  const strip = new THREE.MeshBasicMaterial({ color: col(c).clone().multiplyScalar(2.2) });
  mesh(new THREE.BoxGeometry(0.03, 0.03, FH), strip, g, dir * 0.06, 0.93, FH / 2, false);
  // 窗戶
  const glass = new THREE.MeshStandardMaterial({
    color: 0xa9c4e8, transparent: true, opacity: 0.14, roughness: 0.05,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const win = mesh(new THREE.PlaneGeometry(FH, 1.02), glass, g, 0, 1.47, FH / 2, false);
  win.rotation.y = Math.PI / 2; win.renderOrder = 2;
  for (let i = 0; i <= 3; i++) box(0.09, 2.0, 0.09, alu, g, 0, 1.0, i * FH / 3);
  box(0.1, 0.07, FH, alu, g, 0, 1.98, FH / 2);
  box(0.1, 0.05, FH, alu, g, 0, 0.97, FH / 2);
  // 窗後的操作台
  for (let i = 0; i < 3; i++) {
    box(0.6, 0.9, 1.6, std(0x14181e, 0.8), g, -dir * 0.6, 0.45, (i + 0.5) * FH / 3);
    const scr = mesh(new THREE.PlaneGeometry(0.5, 0.3), new THREE.MeshBasicMaterial({ color: 0x5b8bd6 }), g, -dir * 0.45, 1.1, (i + 0.5) * FH / 3, false);
    scr.rotation.y = dir * Math.PI / 2;
  }
  // 大型計分螢幕(聯盟牆上方)
  const scrG = new THREE.Group();
  scrG.position.set(g.position.x - dir * 2.5, 4.6, FH / 2);
  arenaG.add(scrG);             // 螢幕屬於會場(官方模型載入後保留)
  box(0.25, 3.4, 7.8, std(0x111317, 0.6, 0.3), scrG, -dir * 0.13, 0, 0).castShadow = false;
  const board = mesh(new THREE.PlaneGeometry(7.6, 3.06), new THREE.MeshBasicMaterial({ map: boardTex, toneMapped: false }), scrG, dir * 0.005, 0, 0, false);
  board.rotation.y = dir * Math.PI / 2;
  for (const z of [-3, 3]) box(0.12, 3.0, 0.12, std(0x2a2e34, 0.5, 0.6), scrG, -dir * 0.2, -3.1, z);
}

// 計分螢幕內容(每秒重畫一次)
let boardTex, boardCtx;
const score = { blue: 0, red: 0, lastFlash: [], t0: null, sec: -1 };
function makeBoard() {
  boardTex = canvasTex(1024, 412, (g) => { boardCtx = g; });
}
function drawBoard(secLeft) {
  const g = boardCtx, w = 1024, h = 412;
  g.fillStyle = '#05070a'; g.fillRect(0, 0, w, h);
  // 左藍右紅
  const gb = g.createLinearGradient(0, 0, 0, h); gb.addColorStop(0, '#1f6fe5'); gb.addColorStop(1, '#0b2c66');
  const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#e5362f'); gr.addColorStop(1, '#5c1210');
  g.fillStyle = gb; g.fillRect(0, 110, 340, 302);
  g.fillStyle = gr; g.fillRect(w - 340, 110, 340, 302);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  // 標題
  g.fillStyle = '#f3c615'; g.font = 'italic 900 84px Arial Black, Arial, sans-serif';
  g.fillText('REBUILT', w / 2, 60);
  g.fillStyle = '#9aa4b2'; g.font = '700 30px Arial, sans-serif';
  g.fillText('FRC 2026  ·  QUALIFICATION 42', w / 2, 128);
  // 時間
  const m = Math.floor(secLeft / 60), sct = secLeft % 60;
  g.fillStyle = '#ffffff'; g.font = '900 150px Arial, sans-serif';
  g.fillText(`${m}:${String(sct).padStart(2, '0')}`, w / 2, 262);
  g.fillStyle = '#3fb950'; g.font = '700 30px Arial, sans-serif';
  g.fillText('TELEOP', w / 2, 370);
  // 分數
  g.fillStyle = '#fff'; g.font = '900 150px Arial, sans-serif';
  g.fillText(String(score.blue), 170, 270);
  g.fillText(String(score.red), w - 170, 270);
  g.font = '700 30px Arial, sans-serif';
  g.fillText('BLUE', 170, 150); g.fillText('RED', w - 170, 150);
  boardTex.needsUpdate = true;
}
function updateBoard(s, t) {
  (s.hubs || []).forEach((hb, i) => {
    const f = hb.flash || 0, prev = score.lastFlash[i] || 0;
    if (f > prev + 0.05) {                        // 閃光開始 = 進一球
      const blue = /2f81f7|1f6fe5|blue/i.test(hb.c || '') || i === 0;
      if (blue) score.blue++; else score.red++;
    }
    score.lastFlash[i] = f;
  });
  if (score.t0 === null) score.t0 = t;
  const left = 135 - Math.floor((t - score.t0) / 1000) % 136;
  if (left !== score.sec) { score.sec = left; drawBoard(left); }
}

// 觀眾席
function buildStands() {
  const stepMat = std(0x4a1519, 0.85);
  const crowdGeo = new THREE.BoxGeometry(0.34, 0.45, 0.3);
  const crowdMat = std(0xffffff, 0.9);
  const seats = [];
  for (const side of [-1, 1]) {
    const y0 = side < 0 ? -3.2 : FH + 9;
    for (let r = 0; r < 6; r++) {
      const yy = y0 + side * r * 0.9, hh = 0.5 + r * 0.45;
      box(FW + 10, hh, 0.9, stepMat, scene, FW / 2, hh / 2, yy).castShadow = false;
      for (let x = -4; x < FW + 4; x += 0.55) {
        if (Math.random() < 0.3) continue;
        seats.push([x + Math.random() * 0.2, hh + 0.25, yy + (Math.random() - 0.5) * 0.2]);
      }
    }
  }
  const crowd = new THREE.InstancedMesh(crowdGeo, crowdMat, seats.length);
  const m = new THREE.Matrix4(), c = new THREE.Color();
  const pal = [0x2f81f7, 0xf85149, 0xe6e6e6, 0x444a55, 0xf2c12e, 0x2f3640, 0x6e7681];
  seats.forEach((p, i) => {
    m.makeTranslation(p[0], p[1], p[2]);
    crowd.setMatrixAt(i, m);
    crowd.setColorAt(i, c.setHex(pal[(Math.random() * pal.length) | 0]).multiplyScalar(0.38));
  });
  scene.add(crowd);
}

// 會場:白色帳篷天花板、桁架、點光、牆上藍紅旗幟
let _beamGeo = null, _beamMat = null;
const beamGeo = () => _beamGeo || (_beamGeo = new THREE.ConeGeometry(2.4, 11, 32, 1, true));
function beamMat() {
  if (_beamMat) return _beamMat;
  _beamMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    uniforms: { strength: { value: 0.05 } },
    vertexShader: `varying float vY; varying vec3 vN; varying vec3 vV;
      void main() { vY = uv.y; vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float strength; varying float vY; varying vec3 vN; varying vec3 vV;
      void main() { float edge = pow(abs(dot(vN, vV)), 1.6);          // 正對鏡頭的中間亮、邊緣淡
        float a = strength * pow(vY, 1.8) * edge;                      // 靠近燈(上面)亮,往下淡
        gl_FragColor = vec4(vec3(0.92, 0.96, 1.0) * a, a); }`,
  });
  return _beamMat;
}
function buildArena() {
  const cx = FW / 2, cz = FH / 2;
  // 帳篷天花板(微亮的白)
  const tent = mesh(new THREE.PlaneGeometry(70, 60).rotateX(Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0.42, 0.44, 0.47), fog: false }), scene, cx, 15, cz, false);
  tent.renderOrder = -1;
  // 滿天的小燈(體育館燈格)
  const dotGeo = new THREE.CircleGeometry(0.09, 10).rotateX(Math.PI / 2);
  const dots = new THREE.InstancedMesh(dotGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 6, 6.4), toneMapped: false, fog: false }), 22 * 12);
  let di = 0;
  const dm = new THREE.Matrix4();
  for (let i = 0; i < 22; i++) for (let j = 0; j < 12; j++) {
    dm.makeTranslation(cx + (i - 10.5) * 2.2, 14.9, cz + (j - 5.5) * 2.4);
    dots.setMatrixAt(di++, dm);
  }
  scene.add(dots);
  // 後牆
  const wallMat = std(0x16191e, 0.95);
  box(70, 15, 0.3, wallMat, scene, cx, 7.5, -16).castShadow = false;
  box(70, 15, 0.3, wallMat, scene, cx, 7.5, FH + 18).castShadow = false;
  box(0.3, 15, 40, wallMat, scene, -14, 7.5, cz).castShadow = false;
  box(0.3, 15, 40, wallMat, scene, FW + 14, 7.5, cz).castShadow = false;
  // 桁架
  const truss = std(0x2d3238, 0.5, 0.7);
  const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 4.2, 4.5) });
  for (const z of [cz - 6, cz, cz + 6]) {
    box(FW + 16, 0.25, 0.25, truss, scene, cx, 12.5, z).castShadow = false;
    box(FW + 16, 0.08, 0.08, truss, scene, cx, 12.1, z).castShadow = false;
    for (let i = 0; i < 7; i++) {
      const x = cx + (i - 3) * 3.6;
      mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.3, 12), std(0x222529, 0.5, 0.6), scene, x, 12.2, z, false);
      mesh(new THREE.CircleGeometry(0.17, 16).rotateX(Math.PI / 2), lampMat, scene, x, 12.04, z, false);
      const h = halo(0xeaf2ff, 3.2, 0.5);
      h.position.set(x, 12.0, z);
      scene.add(h);
      // 燈下面淡淡的光束(體育館有灰塵時看得到的那種),越往下越淡、邊緣淡
      const beam = new THREE.Mesh(beamGeo(), beamMat());
      beam.position.set(x, 12.0 - 5.5, z);
      beam.renderOrder = 3;
      scene.add(beam);
    }
  }
  for (let i = 0; i < 5; i++) box(0.2, 0.2, 14, truss, scene, cx + (i - 2) * 6.3, 12.6, cz).castShadow = false;
  // 牆上藍紅旗幟
  const mkBanner = (clr, txt) => canvasTex(256, 768, (g, w, h) => {
    const gg = g.createLinearGradient(0, 0, 0, h); gg.addColorStop(0, clr); gg.addColorStop(1, '#0a0c10');
    g.fillStyle = gg; g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff'; g.font = '900 64px Arial, sans-serif'; g.textAlign = 'center';
    g.save(); g.translate(w / 2 + 22, h / 2); g.rotate(-Math.PI / 2); g.fillText(txt, 0, 0); g.restore();
    g.fillStyle = '#f3c615'; g.fillRect(0, 0, w, 14);
  });
  const bBlue = new THREE.MeshBasicMaterial({ map: mkBanner('#1f6fe5', 'REBUILT'), fog: true });
  const bRed = new THREE.MeshBasicMaterial({ map: mkBanner('#e5362f', 'FRC 2026'), fog: true });
  const bg = new THREE.PlaneGeometry(2.4, 7);
  for (let i = 0; i < 8; i++) {
    const x = cx + (i - 3.5) * 5;
    mesh(bg, i % 2 ? bRed : bBlue, scene, x, 9, -15.8, false);
    const b2 = mesh(bg, i % 2 ? bBlue : bRed, scene, x, 9, FH + 17.8, false);
    b2.rotation.y = Math.PI;
  }
  for (let i = 0; i < 4; i++) {
    const z = cz + (i - 1.5) * 5;
    const b1 = mesh(bg, bBlue, scene, -13.8, 9, z, false); b1.rotation.y = Math.PI / 2;
    const b2 = mesh(bg, bRed, scene, FW + 13.8, 9, z, false); b2.rotation.y = -Math.PI / 2;
  }
}

// ---- 目標(HUB):下半透明窗看得到球、上半淺色面板+AprilTag、頂上高高的透明框 ----
let hubTagId = 1, pileGeo = null;
const HUB = { hw: 0.6, low: 0.8, base: 1.3, top: 2.5 };
function makeHub(c) {
  const g = new THREE.Group();
  const { hw, low, base, top } = HUB;
  const light = '#' + col(c).clone().lerp(new THREE.Color(0xffffff), 0.55).getHexString();   // 淺聯盟色
  // 上半面板:淺色+兩個 AprilTag+編號
  const faceMats = [];
  for (let k = 0; k < 4; k++) {
    const a = hubTagId++, b = hubTagId++;
    const tex = canvasTex(512, 213, (x, w, h) => {
      x.fillStyle = '#eef0f2'; x.fillRect(0, 0, w, h);
      x.fillStyle = light; x.fillRect(0, 0, w, 10);
      x.fillStyle = 'rgba(0,0,0,0.12)'; x.fillRect(0, h - 10, w, 10);
      drawTag(x, 40, 22, 150, a);
      drawTag(x, w - 190, 22, 150, b);
      x.fillStyle = '#0d0f12'; x.font = '900 44px Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(String(a), 115, 195); x.fillText(String(b), w - 115, 195);
    });
    faceMats.push(std(0xffffff, 0.5, 0.05, { map: tex }));
  }
  const roof = std(0x2a2e34, 0.6, 0.3);
  mesh(new THREE.BoxGeometry(hw * 2, base - low, hw * 2), [faceMats[0], faceMats[1], roof, roof, faceMats[2], faceMats[3]], g, 0, (low + base) / 2, 0);
  // 下半:深色框+透明窗,裡面有球
  const dark = std(0x16191d, 0.5, 0.5);
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) box(0.07, low, 0.07, dark, g, sx * (hw - 0.035), low / 2, sz * (hw - 0.035));
  for (const s of [-1, 1]) {
    box(hw * 2, 0.08, 0.05, dark, g, 0, 0.04, s * (hw - 0.025));
    box(0.05, 0.08, hw * 2, dark, g, s * (hw - 0.025), 0.04, 0);
  }
  box(hw * 2 - 0.1, 0.02, hw * 2 - 0.1, dark, g, 0, 0.01, 0);
  const win = new THREE.MeshStandardMaterial({ color: 0xdfeaff, transparent: true, opacity: 0.14, roughness: 0.05, side: THREE.DoubleSide, depthWrite: false });
  // 下半面板:上段深色+REBUILT 標誌,下段透明窗(看得到裡面的球)
  const lowTex = canvasTex(512, 320, (x, w, h) => {
    x.clearRect(0, 0, w, h);
    x.fillStyle = '#121418'; x.fillRect(0, 0, w, 150);
    x.fillStyle = 'rgba(210,225,255,0.16)'; x.fillRect(0, 150, w, h - 150);
    x.fillStyle = 'rgba(255,255,255,0.35)'; x.fillRect(0, 150, w, 3);
    // 立方體圖示
    const cx0 = 92, cy0 = 76, r = 44;
    const face = (pts, c2) => { x.fillStyle = c2; x.beginPath(); pts.forEach(([u, v], i) => i ? x.lineTo(cx0 + u * r, cy0 + v * r) : x.moveTo(cx0 + u * r, cy0 + v * r)); x.fill(); };
    face([[0, -1], [0.87, -0.5], [0, 0], [-0.87, -0.5]], '#ffb02e');
    face([[-0.87, -0.5], [0, 0], [0, 1], [-0.87, 0.5]], '#f0642a');
    face([[0.87, -0.5], [0.87, 0.5], [0, 1], [0, 0]], '#c7321f');
    x.fillStyle = '#fff'; x.font = 'italic 900 64px Arial Black, Arial, sans-serif'; x.textBaseline = 'middle';
    x.fillText('REBUILT', 150, 80);
  });
  const lowMat = new THREE.MeshStandardMaterial({ map: lowTex, transparent: true, roughness: 0.35, side: THREE.DoubleSide, depthWrite: false });
  const winG = new THREE.PlaneGeometry(hw * 2 - 0.1, low - 0.1);
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2;
    const w = mesh(winG, lowMat, g, Math.sin(a) * (hw - 0.01), low / 2 + 0.03, Math.cos(a) * (hw - 0.01), false);
    w.rotation.y = a; w.renderOrder = 3;
  }
  // 聯盟色 LED 燈條(面板下緣一圈)
  const rimMat = std(0x111111, 0.4, 0.2, { emissive: col(c), emissiveIntensity: 2 });
  for (const [sx, sz, w, d] of [[0, hw + 0.012, hw * 2 + 0.04, 0.02], [0, -hw - 0.012, hw * 2 + 0.04, 0.02], [hw + 0.012, 0, 0.02, hw * 2], [-hw - 0.012, 0, 0.02, hw * 2]])
    mesh(new THREE.BoxGeometry(w, 0.04, d), rimMat, g, sx, low + 0.02, sz, false);
  // 裡面的球(從窗戶看得到)
  const pile = new THREE.InstancedMesh(pileGeo || (pileGeo = lumpySphere(12, 8)), ballMat, 60);
  const mm = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(BALL_R, BALL_R, BALL_R), e = new THREE.Euler();
  let n = 0;
  for (let ly = 0; ly < 3; ly++) for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) {
    if (n >= 60 || Math.random() < 0.45 + ly * 0.15) continue;
    q.setFromEuler(e.set(i, j, ly));
    mm.compose(tmpV.set(i * 0.155 + (ly % 2) * 0.07, 0.02 + BALL_R + ly * 0.13, j * 0.155 + (ly % 2) * 0.07), q, sc);
    pile.setMatrixAt(n++, mm);
  }
  pile.count = n;
  g.add(pile);
  // 頂上的高框(鋁框+透明板)
  const alu = std(0xc9ccd1, 0.3, 0.9);
  const tw = hw - 0.04;
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) box(0.045, top - base, 0.045, alu, g, sx * tw, (base + top) / 2, sz * tw);
  const edgeMat = new THREE.MeshBasicMaterial({ color: col(c) });
  for (const s of [-1, 1]) {
    box(tw * 2 + 0.045, 0.045, 0.045, alu, g, 0, top, s * tw);
    box(0.045, 0.045, tw * 2, alu, g, s * tw, top, 0);
    box(tw * 2, 0.03, 0.03, alu, g, 0, (base + top) / 2, s * tw);
    mesh(new THREE.BoxGeometry(tw * 2, 0.015, 0.05), edgeMat, g, 0, top + 0.03, s * tw, false);
    mesh(new THREE.BoxGeometry(0.05, 0.015, tw * 2), edgeMat, g, s * tw, top + 0.03, 0, false);
  }
  const upG = new THREE.PlaneGeometry(tw * 2, top - base);
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2;
    const w = mesh(upG, win, g, Math.sin(a) * tw, (base + top) / 2, Math.cos(a) * tw, false);
    w.rotation.y = a; w.renderOrder = 3;
  }
  // 斜的透明導流板(漏斗)
  const FT = 1.8, FW2 = 0.84;
  const fun = mesh(new THREE.CylinderGeometry(FW2 * Math.SQRT2, (hw - 0.02) * Math.SQRT2, FT - base, 4, 1, true), win, g, 0, (base + FT) / 2, 0, false);
  fun.rotation.y = Math.PI / 4; fun.renderOrder = 3;
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) beam(new THREE.Vector3(sx * (hw - 0.02), base, sz * (hw - 0.02)), new THREE.Vector3(sx * FW2, FT, sz * FW2), 0.03, alu, g);
  for (const sd of [-1, 1]) { box(FW2 * 2, 0.03, 0.03, alu, g, 0, FT, sd * FW2); box(0.03, 0.03, FW2 * 2, alu, g, sd * FW2, FT, 0); }
  // 開口發光
  const coreMat = new THREE.MeshBasicMaterial({ color: col(c), transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false });
  mesh(new THREE.PlaneGeometry(tw * 2, tw * 2).rotateX(-Math.PI / 2), coreMat, g, 0, base + 0.005, 0, false);
  const h = halo(col(c), 3.2, 0.2);
  h.position.y = top;
  g.add(h);
  // 兩側的 BUMP 與 TRENCH
  for (const side of [-1, 1]) buildBumpTrench(g, side, c);
  mergeStatic(g);
  scene.add(g);
  return { g, rimMat, coreMat, edgeMat, halo: h, c };
}

// 聯盟色地毯斜坡(BUMP)+ 紅色方管門架(TRENCH),掛在 Hub 群組裡
let bumpGeo;
const BUMP = { depth: 1.0, len: 1.8, h: 0.18, flat: 0.4 };
const carpetCache = new Map();
function buildBumpTrench(g, side, c) {
  if (!bumpGeo) {
    const s = new THREE.Shape(), d = BUMP.depth / 2, f = BUMP.flat / 2;
    s.moveTo(-d, 0); s.lineTo(-f, BUMP.h); s.lineTo(f, BUMP.h); s.lineTo(d, 0); s.lineTo(-d, 0);
    bumpGeo = new THREE.ExtrudeGeometry(s, { depth: BUMP.len, bevelEnabled: false });
    bumpGeo.translate(0, 0, -BUMP.len / 2);
  }
  if (!carpetCache.has(c)) {
    const t = new THREE.CanvasTexture(noiseCanvas(128, 200, 40));
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(12, 12); t.colorSpace = THREE.SRGBColorSpace;
    carpetCache.set(c, std(col(c).clone().multiplyScalar(0.75), 0.85, 0, { map: t }));
  }
  const zc = side * (HUB.hw + BUMP.len / 2 + 0.01);
  const bump = mesh(bumpGeo, carpetCache.get(c), g, 0, 0, zc);
  bump.receiveShadow = true;
  // 斜坡邊的鋁條
  const alu = std(0xb9bec5, 0.35, 0.85);
  for (const s of [-1, 1]) box(0.03, 0.03, BUMP.len, alu, g, s * BUMP.flat / 2, BUMP.h, zc);
  // TRENCH:紅色方管門架
  const red = std(0xb3201b, 0.45, 0.4);
  const z0 = side * (HUB.hw + BUMP.len + 0.08), z1 = side * (FH / 2 - 0.08);
  const zm = (z0 + z1) / 2, span = Math.abs(z1 - z0);
  const TH = 1.1, T = 0.1;
  for (const x of [-0.5, 0.5]) {
    box(T, TH, T, red, g, x, TH / 2, z0);
    box(T, TH, T, red, g, x, TH / 2, z1);
    box(T, T, span + T, red, g, x, TH - T / 2, zm);            // 上橫桿
    box(T * 0.7, T * 0.7, span, red, g, x, 0.86, zm);            // 中間橫桿
  }
  for (const z of [z0, z1]) box(1.0, T * 0.8, T * 0.8, red, g, 0, TH - T / 2, z);
  // 上方中央的 AprilTag 牌(兩面)
  const tg = tagTex(hubTagId++);
  for (const sx of [-1, 1]) {
    const p = mesh(new THREE.PlaneGeometry(0.22, 0.275), std(0xffffff, 0.6, 0, { map: tg }), g, sx * 0.556, TH + 0.14, zm, false);
    p.rotation.y = sx * Math.PI / 2;
  }
  box(0.1, 0.3, 0.26, red, g, 0.5, TH + 0.14, zm);
  box(0.1, 0.3, 0.26, red, g, -0.5, TH + 0.14, zm);
}

// 爬升塔(梯子狀的藍/紅鋼架),靠近聯盟牆
function buildTower(x, y, c, dir) {
  const g = new THREE.Group();
  g.position.set(x, 0, y);
  scene.add(g);
  const paint = std(col(c).clone().multiplyScalar(0.8), 0.45, 0.5);
  const dark = std(0x1b1e22, 0.6, 0.4);
  box(0.9, 0.03, 1.2, dark, g, 0, 0.015, 0);                       // 底板
  for (const z of [-0.5, 0.5]) box(0.08, 2.0, 0.08, paint, g, 0, 1.0, z);   // 立柱
  for (let yy = 0.35; yy < 2.0; yy += 0.3) {                        // 橫桿(梯子)
    mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.0, 10).rotateX(Math.PI / 2), paint, g, 0, yy, 0);
  }
  box(0.08, 0.08, 1.08, paint, g, 0, 2.0, 0);
  for (const z of [-0.5, 0.5]) beam(new THREE.Vector3(-dir * 0.4, 0.03, z), new THREE.Vector3(0, 1.3, z), 0.06, paint, g);   // 斜撐
}

// ---- 機器人 ----
function buildRobot() {
  const robot = new THREE.Group();
  R.robot = robot;
  scene.add(robot);
  const alu = std(0xc9ccd1, 0.32, 0.9);
  const black = std(0x2b2f35, 0.45, 0.7);
  const rubber = std(0x17181a, 0.9);

  // 接觸陰影(假 AO)
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.2).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, opacity: 0.45, depthWrite: false, color: 0x000000 }));
  blob.position.y = 0.004; blob.renderOrder = 1;
  R.blob = blob;
  robot.add(blob);

  // 保險桿(圓角斷面擠出)
  const fabric = new THREE.CanvasTexture(noiseCanvas(128, 225, 30));
  fabric.wrapS = fabric.wrapT = THREE.RepeatWrapping;
  fabric.repeat.set(30, 30);
  fabric.colorSpace = THREE.SRGBColorSpace;
  const bumperMat = new THREE.MeshPhysicalMaterial({
    color: 0xc8102e, roughness: 0.8, map: fabric,
    sheen: 1, sheenRoughness: 0.45, sheenColor: new THREE.Color(0xff9aa6),   // 布料光澤
  });
  const bumperGeo = (len) => {
    const s = new THREE.Shape(), d = 0.09, h = 0.13, r = 0.035;
    s.moveTo(0, -h / 2);
    s.lineTo(d - r, -h / 2); s.quadraticCurveTo(d, -h / 2, d, -h / 2 + r);
    s.lineTo(d, h / 2 - r); s.quadraticCurveTo(d, h / 2, d - r, h / 2);
    s.lineTo(0, h / 2); s.lineTo(0, -h / 2);
    const g = new THREE.ExtrudeGeometry(s, { depth: len, bevelEnabled: false, curveSegments: 6 });
    g.rotateY(-Math.PI / 2);        // 斷面向外 = +Z,擠出方向 = -X
    g.translate(len / 2, 0, 0);
    return g;
  };
  const sideG = bumperGeo(0.68), endG = bumperGeo(0.86);
  const bR = mesh(sideG, bumperMat, robot, 0, 0.10, 0.34);
  const bL = mesh(sideG, bumperMat, robot, 0, 0.10, -0.34); bL.rotation.y = Math.PI;
  const bF = mesh(endG, bumperMat, robot, 0.34, 0.10, 0); bF.rotation.y = Math.PI / 2;
  const bB = mesh(endG, bumperMat, robot, -0.34, 0.10, 0); bB.rotation.y = -Math.PI / 2;
  // 隊號牌(左右兩側,朝外可讀)
  // 大大的白色隊號,幾乎填滿保險桿高度
  const numTex = canvasTex(640, 160, (g, w, h) => {
    g.font = '900 160px "Arial Black", Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#ffffff'; g.fillText('9427', w / 2, h / 2 + 8, w - 10);
  });
  const numMat = new THREE.MeshStandardMaterial({ map: numTex, transparent: true, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2 });
  R.numMat = numMat;
  const numGeo = new THREE.PlaneGeometry(0.56, 0.14);
  mesh(numGeo, numMat, robot, 0, 0.10, 0.432, false);
  mesh(numGeo, numMat, robot, 0, 0.10, -0.432, false).rotation.y = Math.PI;
  mesh(new THREE.PlaneGeometry(0.5, 0.125), numMat, robot, -0.432, 0.10, 0, false).rotation.y = -Math.PI / 2;   // 後面

  // 車架
  for (const z of [-0.33, 0.33]) box(0.66, 0.05, 0.025, alu, robot, 0, 0.1, z);
  for (const z of [-0.25, 0.25]) box(0.66, 0.05, 0.025, alu, robot, 0, 0.1, z);
  for (const x of [-0.315, 0.315]) box(0.03, 0.05, 0.68, alu, robot, x, 0.1, 0);
  box(0.62, 0.006, 0.5, std(0x8d949c, 0.5, 0.7), robot, 0, 0.074, 0);   // 底盤板

  // 輪子(每側 3 顆)
  const hubTex = canvasTex(128, 128, (g) => {
    g.fillStyle = '#b9bec5'; g.fillRect(0, 0, 128, 128);
    g.fillStyle = '#e8702a';
    g.beginPath(); g.arc(64, 64, 50, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#2a2d31';
    for (let i = 0; i < 5; i++) {
      const a = i * Math.PI * 2 / 5;
      g.beginPath(); g.arc(64 + Math.cos(a) * 30, 64 + Math.sin(a) * 30, 11, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = '#d7dbe0'; g.fillRect(56, 56, 16, 16);
  });
  const hubMat = std(0xffffff, 0.45, 0.3, { map: hubTex });
  const tireG = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.045, 28).rotateX(Math.PI / 2);
  const hubG = new THREE.CylinderGeometry(0.05, 0.05, 0.05, 24).rotateX(Math.PI / 2);
  R.wheels = [];
  for (const z of [-0.29, 0.29]) {
    for (const x of [-0.27, 0, 0.27]) {
      const w = new THREE.Group();
      w.position.set(x, WHEEL_R, z);
      mesh(tireG, rubber, w);
      mesh(hubG, [alu, hubMat, hubMat], w);
      robot.add(w);
      R.wheels.push({ g: w, right: z > 0 });
    }
  }

  // 電子零件
  box(0.17, 0.09, 0.18, std(0x111214, 0.5), robot, 0.22, 0.125, -0.13);             // 電池
  box(0.03, 0.02, 0.05, std(0xc8102e, 0.5), robot, 0.22, 0.18, -0.19);
  box(0.14, 0.035, 0.1, std(0xd7dbe0, 0.4, 0.3), robot, 0.23, 0.095, 0.14);          // roboRIO
  box(0.01, 0.005, 0.01, new THREE.MeshBasicMaterial({ color: 0x3fb950 }), robot, 0.2, 0.115, 0.12);
  box(0.12, 0.03, 0.16, std(0x1e2126, 0.5), robot, -0.25, 0.09, 0.0);               // PDH

  // RSL 燈
  box(0.02, 0.5, 0.02, black, robot, -0.41, 0.4, 0.31);
  R.rslMat = std(0x331600, 0.4, 0, { emissive: 0xff8a1a, emissiveIntensity: 3 });
  mesh(new THREE.BoxGeometry(0.06, 0.05, 0.05), R.rslMat, robot, -0.41, 0.675, 0.31);
  R.rslHalo = halo(0xff8a1a, 0.35, 0.8);
  R.rslHalo.position.set(-0.41, 0.68, 0.31);
  robot.add(R.rslHalo);

  // 後方開放式桁架籃子(青綠色),裡面的球量跟 held 成正比
  const BK = { x0: -0.40, x1: 0.04, z: 0.33, y0: 0.15, y1: 0.62 };
  const hop = new THREE.Group();
  robot.add(hop);
  const bx = (BK.x0 + BK.x1) / 2, bw = BK.x1 - BK.x0, bh = BK.y1 - BK.y0, by = (BK.y0 + BK.y1) / 2;
  box(bw, 0.012, BK.z * 2, std(0x3a4049, 0.5, 0.5), hop, bx, BK.y0, 0);
  const meshTex = canvasTex(128, 128, (g, w, h) => {
    // 青綠色三角桁架
    g.clearRect(0, 0, w, h);
    g.strokeStyle = '#1fb5a8'; g.lineWidth = 9;
    g.beginPath(); g.moveTo(0, 4); g.lineTo(w, 4); g.moveTo(0, h - 4); g.lineTo(w, h - 4);
    g.moveTo(0, h); g.lineTo(w / 2, 0); g.lineTo(w, h); g.stroke();
  });
  meshTex.wrapS = meshTex.wrapT = THREE.RepeatWrapping;
  const wire = (w, h) => { const t = meshTex.clone(); t.repeat.set(Math.round(w / 0.16), 2); t.needsUpdate = true; return new THREE.MeshStandardMaterial({ map: t, alphaTest: 0.4, transparent: false, side: THREE.DoubleSide, roughness: 0.4, metalness: 0.7 }); };
  const wSide = wire(bw, bh), wEnd = wire(BK.z * 2, bh);
  for (const s of [-1, 1]) {
    const p = mesh(new THREE.PlaneGeometry(bw, bh), wSide, hop, bx, by, s * BK.z, false);
    p.castShadow = true;
    const e = mesh(new THREE.PlaneGeometry(BK.z * 2, bh), wEnd, hop, s < 0 ? BK.x0 : BK.x1, by, 0, false);
    e.rotation.y = Math.PI / 2; e.castShadow = true;
  }
  const teal = std(0x1fb5a8, 0.4, 0.5);
  for (const [x, z] of [[BK.x0, -BK.z], [BK.x0, BK.z], [BK.x1, -BK.z], [BK.x1, BK.z]]) box(0.025, bh, 0.025, teal, hop, x, by, z);
  for (const s of [-1, 1]) {
    box(bw, 0.025, 0.025, teal, hop, bx, BK.y1, s * BK.z);
    box(0.025, 0.025, BK.z * 2, teal, hop, s < 0 ? BK.x0 : BK.x1, BK.y1, 0);
  }
  R.orbit = new THREE.Group();
  R.orbit.position.set(bx, 0, 0);
  hop.add(R.orbit);
  mesh(new THREE.BoxGeometry(0.4, 0.02, 0.02), std(0xe8702a, 0.5), R.orbit, 0, BK.y0 + 0.02, 0);  // 撥桿(看得出轉動)
  // 40 顆球的位置:3 層 3x4,最上面再堆 4 顆
  R.heldSlots = [];
  for (let ly = 0; ly < 3; ly++) for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++)
    R.heldSlots.push([bx + (i - 1) * 0.142 + (ly % 2) * 0.02, BK.y0 + 0.08 + ly * 0.132, (j - 1.5) * 0.155 + (ly % 2) * 0.02]);
  for (const [i, j] of [[0, 0], [-1, 0.5], [0, -1], [-1, -0.5]]) R.heldSlots.push([bx - 0.07 + i * 0.13, BK.y0 + 0.08 + 3 * 0.128, j * 0.15]);
  R.held = new THREE.InstancedMesh(ballGeo, ballMat, 40);
  R.held.count = 0;
  R.held.castShadow = true;
  R.held.frustumCulled = false;
  robot.add(R.held);

  // 砲塔支架
  for (const z of [-0.24, 0.24]) box(0.04, 0.37, 0.04, alu, robot, 0.17, 0.285, z);
  box(0.06, 0.02, 0.52, alu, robot, 0.17, 0.46, 0);

  // 砲塔
  const tur = new THREE.Group();
  tur.position.set(0.17, 0.47, 0);
  robot.add(tur);
  R.turret = tur;
  mesh(new THREE.CylinderGeometry(0.125, 0.125, 0.035, 32), black, tur, 0, 0.0175, 0);
  mesh(new THREE.TorusGeometry(0.125, 0.008, 6, 40).rotateX(Math.PI / 2), alu, tur, 0, 0.02, 0);
  for (const z of [-0.075, 0.075]) {
    const plate = new THREE.Shape();
    plate.moveTo(-0.1, 0); plate.lineTo(0.12, 0); plate.lineTo(0.2, 0.17); plate.lineTo(0.02, 0.24); plate.lineTo(-0.1, 0.15); plate.lineTo(-0.1, 0);
    const pg = new THREE.ExtrudeGeometry(plate, { depth: 0.01, bevelEnabled: false });
    pg.translate(0, 0, -0.005);
    mesh(pg, std(0x2d6fd6, 0.4, 0.6), tur, 0, 0.03, z);      // 藍色陽極側板
  }
  // 飛輪
  const flyTex = canvasTex(256, 16, (g, w, h) => {
    g.fillStyle = '#2b2e33'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#e6e9ee';
    for (let i = 0; i < 4; i++) g.fillRect(i * w / 4, 0, w / 16, h);
  });
  R.flyMat = std(0xffffff, 0.5, 0.2, { map: flyTex, emissive: 0xff6a00, emissiveIntensity: 0 });
  R.fly = mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.13, 28).rotateX(Math.PI / 2), R.flyMat, tur, 0.0, 0.15, 0);
  mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.17, 8).rotateX(Math.PI / 2), alu, tur, 0.0, 0.15, 0);
  // 罩子(弧形)
  const hood = mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.14, 24, 1, true, -0.2, 2.2).rotateX(Math.PI / 2),
    std(0x1b1e22, 0.35, 0.3, { side: THREE.DoubleSide }), tur, 0.0, 0.15, 0);
  hood.rotation.z = 0;
  // 出球口(朝 +X 上仰)
  const chute = new THREE.Group();
  chute.position.set(0.06, 0.2, 0);
  chute.rotation.z = THREE.MathUtils.degToRad(35);
  tur.add(chute);
  box(0.16, 0.012, 0.14, std(0x1b1e22, 0.35, 0.3), chute, 0.08, 0.07, 0);
  box(0.16, 0.06, 0.01, std(0x1b1e22, 0.35, 0.3), chute, 0.08, 0.04, 0.07);
  box(0.16, 0.06, 0.01, std(0x1b1e22, 0.35, 0.3), chute, 0.08, 0.04, -0.07);
  // 馬達
  mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.07, 16).rotateX(Math.PI / 2), std(0x6e757d, 0.4, 0.8), tur, 0.0, 0.15, 0.115);
  // 視覺鏡頭
  box(0.05, 0.035, 0.08, black, tur, -0.07, 0.25, 0);
  box(0.002, 0.012, 0.05, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 2, 0.5) }), tur, -0.044, 0.25, 0);
  // 發光
  R.flyHalo = halo(0xff7a1a, 0.6, 0);
  R.flyHalo.position.set(0.03, 0.17, 0);
  tur.add(R.flyHalo);
  R.flyLight = new THREE.PointLight(0xff7a1a, 0, 1.6, 2);
  R.flyLight.position.set(0.05, 0.2, 0);
  tur.add(R.flyLight);

  // 進球機構(前方樞紐)
  for (const z of [-0.31, 0.31]) box(0.04, 0.2, 0.03, alu, robot, 0.36, 0.2, z);
  const piv = new THREE.Group();
  piv.position.set(0.38, 0.30, 0);
  robot.add(piv);
  R.intake = piv;
  for (const z of [-0.31, 0.31]) {
    box(ARM_LEN + 0.03, 0.035, 0.02, std(0x2d6fd6, 0.4, 0.6), piv, ARM_LEN / 2, 0, z);
    mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.03, 16).rotateX(Math.PI / 2), black, piv, 0, 0, z);
  }
  box(0.02, 0.02, 0.6, alu, piv, ARM_LEN * 0.45, 0.02, 0);   // 橫桿
  const rollTex = canvasTex(256, 16, (g, w, h) => {
    g.fillStyle = '#9aa0a6'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffffff';
    for (let i = 0; i < 8; i++) g.fillRect(i * w / 8, 0, w / 20, h);
  });
  R.rollMat = std(0x9a9ea4, 0.7, 0, { map: rollTex });
  R.roller = mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.6, 20).rotateX(Math.PI / 2), R.rollMat, piv, ARM_LEN, 0, 0);
  R.rollSpin = 0;
}

// ---- 球 ----
function makeBalls() {
  ballGeo = lumpySphere(24, 16);
  // 霧面泡棉黃
  ballMat = new THREE.MeshStandardMaterial({ color: 0xf3c615, emissive: 0x2e2200, roughness: 0.9, metalness: 0 });
}
// 表面有一點凹凸的球(泡棉球不是完美圓)
function lumpySphere(ws, hs) {
  const g = new THREE.SphereGeometry(1, ws, hs);
  const p = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const k = 1 + 0.022 * Math.sin(v.x * 5.1 + v.y * 2.3) * Math.sin(v.z * 4.7 - v.y * 3.1) + 0.012 * Math.sin(v.x * 11 + v.z * 9);
    p.setXYZ(i, v.x * k, v.y * k, v.z * k);
  }
  g.computeVertexNormals();
  return g;
}

// 把不會動的零件依材質合併成一個 mesh(大幅減少 draw call,內顯才跑得動)
function mergeStatic(root, skip = new Set()) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert(), m4 = new THREE.Matrix4();
  const buckets = new Map();
  (function walk(o) {
    for (const c of o.children) {
      if (skip.has(c)) continue;
      const g = c.geometry;
      if (c.isMesh && !c.isInstancedMesh && !Array.isArray(c.material) && c.children.length === 0 &&
          g.attributes.position && g.attributes.normal && g.attributes.uv) {
        const key = c.material.uuid + '|' + c.castShadow + '|' + c.receiveShadow + '|' + c.renderOrder;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(c);
      }
      walk(c);
    }
  })(root);
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    const parts = list.map(m => {
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      g.applyMatrix4(m4.multiplyMatrices(inv, m.matrixWorld));
      return g;
    });
    const n = parts.reduce((a, g) => a + g.attributes.position.count, 0);
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
    let o = 0;
    for (const g of parts) {
      pos.set(g.attributes.position.array, o * 3);
      nor.set(g.attributes.normal.array, o * 3);
      uv.set(g.attributes.uv.array, o * 2);
      o += g.attributes.position.count;
      g.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.computeBoundingSphere();
    const f = list[0];
    const mm = new THREE.Mesh(geo, f.material);
    mm.castShadow = f.castShadow; mm.receiveShadow = f.receiveShadow; mm.renderOrder = f.renderOrder;
    for (const m of list) m.parent.remove(m);
    root.add(mm);
  }
}

// ---- 建場景 ----
function build() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1b1f25);
  scene.fog = new THREE.Fog(0x1b1f25, 26, 60);
  scene.environment = makeEnvironment();
  scene.environmentIntensity = 0.55;

  glowTex = canvasTex(128, 128, (g) => {
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.25, 'rgba(255,255,255,0.45)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  });
  blobTex = canvasTex(128, 128, (g) => {
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,0.9)');
    gr.addColorStop(0.5, 'rgba(255,255,255,0.35)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  });
  // blob 用 alphaMap 效果:把白色當不透明度
  blobTex.colorSpace = THREE.NoColorSpace;

  // 燈光
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a3833, 0.65));
  const key = new THREE.DirectionalLight(0xf2f6ff, 3.3);
  key.position.set(FW / 2 - 3, 16, FH / 2 + 4);
  key.target.position.set(FW / 2, 0, FH / 2);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  keyLight = key;
  Object.assign(key.shadow.camera, { left: -11, right: 11, top: 8, bottom: -8, near: 2, far: 40 });
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 3;
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight(0x9fb8ff, 0.5);
  fill.position.set(FW / 2 + 6, 6, -6);
  scene.add(fill);

  makeBalls();
  makeBoard();
  // 程序產生的場地放 procG(官方模型載好就藏起來);會場放 arenaG
  const root = scene;
  procG = new THREE.Group(); arenaG = new THREE.Group();
  root.add(procG, arenaG);
  scene = procG; buildField();
  scene = arenaG; buildStands(); buildArena();
  scene = root;
  arenaG.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  buildRobot();
  fixBlobs(scene);
  hubs.push(makeHub('#2f81f7'), makeHub('#f85149'));
  hubs[0].g.position.set(4.63, 0, FH / 2);
  hubs[1].g.position.set(FW - 4.63, 0, FH / 2);
  // 場上的球:InstancedMesh(數百顆也順),陰影改用地上的柔和圓斑
  fieldInst = new THREE.InstancedMesh(lumpySphere(14, 10), ballMat, FIELD_CAP);
  fieldInst.receiveShadow = true;
  fieldInst.count = 0;
  fieldInst.frustumCulled = false;
  blobInst = new THREE.InstancedMesh(new THREE.PlaneGeometry(BALL_R * 3, BALL_R * 3).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: blobTex, transparent: true, opacity: 0.5, depthWrite: false }), FIELD_CAP);
  blobInst.count = 0;
  blobInst.frustumCulled = false;
  blobInst.renderOrder = 1;
  scene.add(blobInst, fieldInst);
  // 飛行中的球(會投射陰影)
  shotInst = new THREE.InstancedMesh(ballGeo, ballMat, SHOT_CAP);
  shotInst.castShadow = true;
  shotInst.count = 0;
  shotInst.frustumCulled = false;
  scene.add(shotInst);

  // 合併靜態零件(場地、機器人車身)
  mergeStatic(procG);
  mergeStatic(arenaG);
  mergeStatic(R.robot, new Set([...R.wheels.map(w => w.g), R.turret, R.intake, R.orbit]));

  camera = new THREE.PerspectiveCamera(CAM_FOV.chase, 16 / 9, 0.04, 140);
}
// 把用 blobTex 當 map 的材質改成 alphaMap(黑色+漸層透明)
function fixBlobs(root) {
  root.traverse(o => {
    const m = o.material;
    if (m && m.map === blobTex) { m.alphaMap = blobTex; m.map = null; m.needsUpdate = true; }
  });
}

// ---- 每幀更新 ----
function updateRobot(s, t, dt) {
  const p = s.pose || { x: 2, y: FH / 2, th: 0 };
  // 開上 BUMP 時抬高+傾斜(前後左右取樣地面高度)
  const th = p.th || 0, fx = Math.cos(th), fz = -Math.sin(th);
  const hF = groundH(p.x + fx * 0.33, p.y + fz * 0.33), hB = groundH(p.x - fx * 0.33, p.y - fz * 0.33);
  const hL = groundH(p.x + fz * 0.3, p.y - fx * 0.3), hR = groundH(p.x - fz * 0.3, p.y + fx * 0.3);
  const lift = Math.max((hF + hB) / 2, (hL + hR) / 2, groundH(p.x, p.y) * 0.9);
  R.robot.position.set(p.x, lift, p.y);
  R.robot.rotation.set(Math.atan2(hR - hL, 0.6) * -1, th, Math.atan2(hF - hB, 0.66), 'YZX');
  const wl = (s.wheelL || 0) / WHEEL_R, wr = (s.wheelR || 0) / WHEEL_R;
  for (const w of R.wheels) w.g.rotation.z = -(w.right ? wr : wl);
  R.intake.rotation.z = lerp(ARM_STOW, ARM_DEPLOY, clamp(s.arm || 0, 0, 1));
  R.turret.rotation.y = s.turret || 0;
  R.fly.rotation.z = -(s.flySpin || 0);
  const fly = s.fly || 0;
  const glow = fly > 5 ? 0.35 + 0.65 * clamp((fly - 5) / 60, 0, 1) : 0;
  R.flyMat.emissiveIntensity = glow * 1.6;
  R.flyHalo.material.opacity = glow * 0.9;
  R.flyHalo.scale.setScalar(0.45 + glow * 0.35);
  R.flyLight.intensity = glow * 2.5;
  R.orbit.rotation.y = s.orbitSpin || 0;
  // 籃子裡的球:held 0..40,跟著撥桿微微晃動
  const held = clamp(Math.round(s.held || 0), 0, 40), os = s.orbitSpin || 0;
  for (let i = 0; i < held; i++) {
    const sl = R.heldSlots[i];
    dummy.position.set(sl[0] + Math.sin(os + i * 1.7) * 0.012, sl[1] + Math.abs(Math.sin(os * 0.5 + i)) * 0.006, sl[2] + Math.cos(os + i * 2.3) * 0.012);
    dummy.rotation.set(i * 0.7 + os * 0.3, i, 0);
    dummy.scale.setScalar(HELD_R);
    dummy.updateMatrix();
    R.held.setMatrixAt(i, dummy.matrix);
  }
  R.held.count = held;
  R.held.instanceMatrix.needsUpdate = true;
  const rd = Math.sign(s.rollerDir || 0);
  R.rollSpin -= rd * dt * 28;
  R.roller.rotation.z = R.rollSpin;
  R.rollMat.color.set(rd > 0 ? 0x5fd37a : rd < 0 ? 0xff8a3a : 0x9a9ea4);
  R.rollMat.emissive.set(rd > 0 ? 0x0c3a18 : rd < 0 ? 0x4a1c00 : 0x000000);
  // RSL:停用恆亮,啟用 2Hz 閃
  const on = !s.enabled || Math.floor(t / 250) % 2 === 0;
  R.rslMat.emissiveIntensity = on ? 3.5 : 0.05;
  R.rslHalo.material.opacity = on ? 0.85 : 0;
}

// 某點的地面高度(只有 BUMP 會 > 0)
function groundH(x, y) {
  const d = BUMP.depth / 2, f = BUMP.flat / 2;
  for (const h of hubs) {
    if (!h.g.visible) continue;
    const dx = Math.abs(x - h.g.position.x), dz = Math.abs(y - h.g.position.z);
    if (dx >= d || dz < HUB.hw || dz > HUB.hw + BUMP.len) continue;
    return dx <= f ? BUMP.h : BUMP.h * (d - dx) / (d - f);
  }
  return 0;
}

const GREEN = new THREE.Color('#3fb950');
const tmpC = new THREE.Color();
function updateHubs(s, t) {
  const list = s.hubs || [];
  while (hubs.length < list.length) hubs.push(makeHub(list[hubs.length].c || '#888'));
  hubs.forEach((h, i) => {
    const d = list[i];
    h.g.visible = !!d || list.length === 0;
    if (!d) return;
    h.g.position.set(d.x, 0, d.y);
    const base = col(d.c || h.c);
    const f = clamp((d.flash || 0) / 0.6, 0, 1);
    tmpC.copy(base).lerp(GREEN, f);
    const pulse = 0.85 + 0.15 * Math.sin(t / 400 + i);
    h.rimMat.emissive.copy(tmpC);
    h.rimMat.emissiveIntensity = (1.6 + 4 * f) * pulse;
    h.coreMat.color.copy(tmpC).multiplyScalar(1 + 2 * f);
    h.edgeMat.color.copy(tmpC).multiplyScalar(1.2 + 2 * f);
    h.halo.material.color.copy(tmpC);
    h.halo.material.opacity = h.official ? 0.75 * f : 0.22 + 0.6 * f;
    h.halo.scale.setScalar(h.official ? 2 + 2.5 * f : 3 + 2 * f);
  });
}

// 落點預測圈:平躺在地上的環,落點在 HUB 裡就變綠、抬到 HUB 入口的高度
let aimRing = null;
function updateAim(s, t) {
  if (!aimRing) {
    aimRing = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0xd29922, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.3, 48), mat);
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.06, 24), mat);
    for (const m of [ring, dot]) { m.rotation.x = -Math.PI / 2; m.renderOrder = 5; aimRing.add(m); }
    aimRing.userData.mat = mat;
    scene.add(aimRing);
  }
  const a = s.aimPt;
  aimRing.visible = !!a;
  if (!a) return;
  aimRing.position.set(a.x, a.good ? (s.hubTop || 1.8) + 0.05 : 0.03, a.y);
  aimRing.userData.mat.color.set(a.good ? 0x3fb950 : 0xd29922);
  aimRing.scale.setScalar(1 + 0.08 * Math.sin(t / 150));
}

// ---- 特效:飛行球的光軌 + 進球時 HUB 噴出的光點 ----
// 都是 InstancedMesh(一次畫完),內顯也跑得動
const TRAIL_N = 7, SPARK_CAP = 240;
let trailInst = null, sparkInst = null;
const sparks = [];            // { x, y, z, vx, vy, vz, life, max }
const prevFlash = [];
function makeGlow(cap, color) {
  const m = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }), cap);
  m.frustumCulled = false; m.count = 0; m.renderOrder = 4;
  scene.add(m);
  return m;
}
function updateFx(s, dt) {
  if (!trailInst) { trailInst = makeGlow(SHOT_CAP * TRAIL_N, 0xffc933); sparkInst = makeGlow(SPARK_CAP, 0x7dffa0); }
  // 光軌:沿著拋物線往回取幾個點,越後面越小
  const sh = s.shots || [];
  let n = 0;
  for (let i = 0; i < Math.min(sh.length, SHOT_CAP); i++) {
    const b = sh[i];
    const hist = b.hist || [];
    if (hist.length < 2 || Math.hypot(b.vx, b.vy, b.vz || 0) < 3) continue;   // 慢慢滾出 HUB 的球不要拖尾巴
    for (let j = 1; j <= TRAIL_N && j < hist.length; j++) {
      const p = hist[j];                             // physics.js 每幀記下來的舊位置
      dummy.position.set(p.x, p.z, p.y);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(BALL_R * (0.9 - j * 0.1));
      dummy.updateMatrix();
      trailInst.setMatrixAt(n++, dummy.matrix);
    }
  }
  trailInst.count = n;
  trailInst.instanceMatrix.needsUpdate = true;
  // 進球光點:HUB 的 flash 突然變大 = 剛進一顆
  (s.hubs || []).forEach((h, i) => {
    const f = h.flash || 0;
    if (f > (prevFlash[i] || 0) + 0.2) {
      for (let k = 0; k < 18 && sparks.length < SPARK_CAP; k++) {
        const a = Math.random() * Math.PI * 2, sp = 1 + Math.random() * 2.5;
        sparks.push({ x: h.x, y: h.y, z: (s.hubTop || 1.8) + 0.2, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                      vz: 2 + Math.random() * 2.5, life: 0.9, max: 0.9 });
      }
    }
    prevFlash[i] = f;
  });
  let m = 0;
  for (let i = sparks.length - 1; i >= 0; i--) {
    const p = sparks[i];
    p.life -= dt;
    if (p.life <= 0 || p.z < 0) { sparks.splice(i, 1); continue; }
    p.vz -= 9.8 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    dummy.position.set(p.x, p.z, p.y);
    dummy.scale.setScalar(0.035 * (0.4 + p.life / p.max));
    dummy.updateMatrix();
    sparkInst.setMatrixAt(m++, dummy.matrix);
  }
  sparkInst.count = m;
  sparkInst.instanceMatrix.needsUpdate = true;
}

const dummy = new THREE.Object3D();
function updateBalls(s) {
  const fb = s.fieldBalls || [];
  const n = Math.min(fb.length, FIELD_CAP);
  for (let i = 0; i < n; i++) {
    const b = fb[i];
    dummy.position.set(b.x, BALL_R, b.y);
    dummy.rotation.set(b.x * 3.1, 0, b.y * 2.7);    // 依位置轉一點,看起來像滾過
    dummy.scale.setScalar(BALL_R);
    dummy.updateMatrix();
    fieldInst.setMatrixAt(i, dummy.matrix);
    dummy.position.y = 0.003;
    dummy.rotation.set(0, 0, 0);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    blobInst.setMatrixAt(i, dummy.matrix);
  }
  fieldInst.count = blobInst.count = n;
  fieldInst.instanceMatrix.needsUpdate = true;
  blobInst.instanceMatrix.needsUpdate = true;
  const sh = s.shots || [];
  const ns = Math.min(sh.length, SHOT_CAP);
  for (let i = 0; i < ns; i++) {
    const b = sh[i];
    // 高度直接用物理算出來的 z(physics.js)
    dummy.position.set(b.x, b.z != null ? b.z : BALL_R, b.y);
    dummy.rotation.set(i, 0, -(b.t || 0) * 20);
    dummy.scale.setScalar(BALL_R);
    dummy.updateMatrix();
    shotInst.setMatrixAt(i, dummy.matrix);
  }
  shotInst.count = ns;
  shotInst.instanceMatrix.needsUpdate = true;
}

function updateCamera(s, dt) {
  const p = s.pose || { x: 2, y: FH / 2, th: 0 };
  const th = p.th || 0;
  if (chaseYaw === null) chaseYaw = th;
  chaseYaw += wrapPi(th - chaseYaw) * (1 - Math.exp(-dt * 4.5));   // 轉彎時稍微甩尾
  const dPos = tmpV, dTgt = tmpV2;
  let k = 4;
  if (camMode === 'chase') {
    const fx = Math.cos(chaseYaw), fz = -Math.sin(chaseYaw);
    // 車子背靠牆(最佳射擊位置就在聯盟牆前面)時,鏡頭以前會跑到牆外面,整個畫面只看到牆。
    // 改成:鏡頭最多退到牆內 0.2 公尺,退不夠的距離改成往上升,變成從上往下看
    let back = 2.1;
    const m = 0.2;
    if (fx > 1e-3) back = Math.min(back, (p.x - m) / fx);
    if (fx < -1e-3) back = Math.min(back, (FW - m - p.x) / -fx);
    if (fz > 1e-3) back = Math.min(back, (p.y - m) / fz);
    if (fz < -1e-3) back = Math.min(back, (FH - m - p.y) / -fz);
    back = Math.max(0.3, back);
    dPos.set(p.x - fx * back, 1.35 + (2.1 - back) * 0.9, p.y - fz * back);
    const ahead = lerp(0.8, 2.8, (back - 0.3) / 1.8);   // 鏡頭升高時看近一點,車子才不會掉出畫面
    dTgt.set(p.x + fx * ahead, 0.05, p.y + fz * ahead);
    k = 9;
  } else if (camMode === 'fpv') {
    const fx = Math.cos(th), fz = -Math.sin(th);
    dPos.set(p.x + fx * 0.45, 0.88, p.y + fz * 0.45);
    dTgt.set(p.x + fx * 4.2, 0.25, p.y + fz * 4.2);
    k = 40;
  } else if (camMode === 'top') {
    // 依畫面比例算距離,整個場地都塞得下
    const tv = Math.tan(THREE.MathUtils.degToRad(CAM_FOV.top / 2));
    const th2 = tv * camera.aspect;
    const dist = Math.max(9.6 / th2, 6.2 / tv);
    dTgt.set(FW / 2, 0, FH / 2 + 0.4);
    dPos.set(FW / 2, dTgt.y + dist * 0.82, dTgt.z + dist * 0.57);
    k = 3;
  } else {
    const bx = clamp(p.x, 2.5, FW - 2.5);
    dPos.set(bx, 3.9, FH + 5.2);
    dTgt.set(lerp(bx, p.x, 0.8), 0.3, lerp(FH / 2, p.y, 0.5));
    k = 3.5;
  }
  // 切換視角時先慢慢過渡,之後才用各模式的跟隨速度
  camBlend = Math.min(1, camBlend + dt / 0.9);
  const kk = lerp(2.5, k, camBlend * camBlend);
  const a = 1 - Math.exp(-dt * kk);
  if (!camInit) { camPos.copy(dPos); camTgt.copy(dTgt); camInit = true; }
  else { camPos.lerp(dPos, a); camTgt.lerp(dTgt, a); }
  camera.position.copy(debugCam ? debugCam.p : camPos);
  camera.lookAt(debugCam ? debugCam.t : camTgt);
  const fov = CAM_FOV[camMode];
  if (Math.abs(camera.fov - fov) > 0.01) {
    camera.fov = lerp(camera.fov, fov, 1 - Math.exp(-dt * 4));
    camera.updateProjectionMatrix();
  }
}

// 自動降畫質:連續掉幀就降低解析度(內顯也能順)
let basePR = 1, curPR = 1, slowT = 0;
function adaptQuality(dt) {
  if (dt <= 0 || dt > 0.08) return;          // 切分頁/卡頓不算
  slowT = dt > 0.021 ? slowT + dt : Math.max(0, slowT - dt * 0.5);
  let pr = curPR;
  // 最低降到 1.0(跟螢幕像素一樣),再低畫面會糊掉(使用者嫌「糊糊的」)
  if (slowT > 1.5 && curPR > 1) { pr = Math.max(1, curPR - 0.25); slowT = 0; }
  // 解析度已經降到底還是卡 → 先關環境遮蔽(最吃效能的那個),只留光暈
  else if (slowT > 3 && curPR <= 1 && quality === 'high' && !qualityPinned) { quality = 'mid'; setupComposer(); slowT = 0; }
  if (pr !== curPR) { curPR = pr; renderer.setPixelRatio(pr); resize(W, H); }
}

function resize(w, h) {
  W = Math.max(1, Math.round(w)); H = Math.max(1, Math.round(h));
  renderer.setSize(W, H, false);
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  if (composer) { composer.setPixelRatio(curPR); composer.setSize(W, H); }
}

// ---- 畫質:高 = 環境遮蔽 + 光暈、中 = 只有光暈、低 = 都不開(最省) ----
let composer = null, gtaoPass = null, bloomPass = null, qualityPinned = false, fxTest = null;
let quality = (() => { try { return localStorage.getItem('sim-quality') || 'high'; } catch { return 'high'; } })();
function setupComposer() {
  if (composer) { composer.dispose(); composer = null; }
  const o = fxTest || { gtao: true };        // fxTest 只有除錯時用(View3D._fx)
  if (quality === 'low') return;
  // 多重取樣的 render target:用後製時內建反鋸齒會失效,要自己開 MSAA
  const rt = new THREE.WebGLRenderTarget(W, H, { type: o.type === 'float' ? THREE.FloatType : THREE.HalfFloatType, samples: o.samples ?? 4 });
  composer = new EffectComposer(renderer, rt);
  // ⚠️ 黑屏真正的原因(2026-09-23 用顯示卡實測):MSAA 畫布「只能畫一次」。
  //    three.js 每次把 MSAA 畫布整理(resolve)成一般貼圖之後,就把 MSAA 那份內容丟掉了。
  //    光暈最後一步是「疊加」回同一張畫布 → 疊在一張已經被丟掉的空白上 → 整片黑,只剩光暈的亮點。
  //    解法:第二張畫布不要 MSAA,場景畫完先複製過去,光暈 / 環境遮蔽都在那張上面疊。
  if (o.copy !== false) composer.renderTarget2.samples = 0;
  composer.setPixelRatio(curPR);
  composer.setSize(W, H);
  composer.addPass(new RenderPass(scene, camera));
  if (o.copy !== false) composer.addPass(new ShaderPass(CopyShader));
  if (quality === 'high' && o.gtao) {
    // 環境遮蔽:角落、縫隙、車底、HUB 腳下自然變暗(立體感主要來源)
    gtaoPass = new GTAOPass(scene, camera, W, H);
    gtaoPass.updateGtaoMaterial({ radius: 0.35, distanceExponent: 1.5, thickness: 1, scale: 1.1, samples: 12 });
    gtaoPass.updatePdMaterial({ radius: 6, lumaPhi: 10, depthPhi: 2, normalPhi: 3 });
    gtaoPass.blendIntensity = 0.9;
    composer.addPass(gtaoPass);
  } else gtaoPass = null;
  // 光暈:只有很亮的東西(場館燈、HUB 燈、RSL、飛輪)會溢光
  if (o.bloom !== false) {
    // 門檻 1.0:只有真的比白色還亮的(會發光的東西)才溢光,白色 HUB 頂不會被糊掉
    bloomPass = new UnrealBloomPass(new THREE.Vector2(W, H), 0.35, 0.55, 1.0);
    composer.addPass(bloomPass);
  } else bloomPass = null;
  composer.addPass(new OutputPass());       // 色調映射(ACES)+ sRGB
}

// ================= 官方 AdvantageScope 模型(場地、Fuel、KitBot) =================
const ASSET = 'assets/';
let loadUI = null, fieldModel = null, kitWrap = null;
const loadPct = { field: 0, robot: 0, fuel: 0 };

// 畫面左下角的載入進度
function showLoading() {
  loadUI = document.createElement('div');
  loadUI.style.cssText = 'position:absolute;left:12px;bottom:12px;padding:6px 10px;border-radius:6px;background:rgba(0,0,0,.55);' +
    'color:#e6edf3;font:13px sans-serif;pointer-events:none;z-index:5;min-width:220px';
  loadUI.innerHTML = '<div class="t">載入官方場地模型…</div><div style="height:4px;background:#30363d;border-radius:2px;margin-top:5px">' +
    '<div class="b" style="height:4px;width:0;background:#f3c615;border-radius:2px"></div></div>';
  container.appendChild(loadUI);
}
function updateLoading() {
  if (!loadUI) return;
  const p = Math.round((loadPct.field * 0.47 + loadPct.robot * 0.52 + loadPct.fuel * 0.01) * 100);
  loadUI.querySelector('.t').textContent = `載入官方場地模型… ${p}%`;
  loadUI.querySelector('.b').style.width = p + '%';
}
function doneLoading() {
  if (loadPct.field >= 1 && loadPct.robot >= 1 && loadUI) { loadUI.remove(); loadUI = null; }
}

// CAD 匯出的材質全是金屬(metallic=1),改成比較像真實的塑膠/鋁/地毯
function fixMaterial(m) {
  if (!m || m.userData.fixed) return m;
  m.userData.fixed = true;
  const c = m.color, mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b);
  const grey = mx - mn < 0.06;
  if (m.transparent || m.opacity < 1) {
    m.metalness = 0; m.roughness = 0.08; m.depthWrite = false; m.side = THREE.DoubleSide;
  } else if (grey && mx > 0.3) {            // 亮灰 = 鋁
    m.metalness = 0.75; m.roughness = 0.38;
  } else if (grey) {                        // 深灰/黑 = 塑膠、塗裝
    m.metalness = 0.15; m.roughness = 0.6;
  } else {                                  // 有顏色 = 塗裝/塑膠
    m.metalness = 0.05; m.roughness = 0.5;
  }
  m.envMapIntensity = 1;
  return m;
}

// 把一堆 mesh 依材質合併(官方場地有 2900 多個 mesh,不合併會很卡)
function mergeByMaterial(root, meshes, relTo) {
  const inv = new THREE.Matrix4().copy(relTo.matrixWorld).invert(), m4 = new THREE.Matrix4();
  const buckets = new Map();
  for (const o of meshes) {
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.length !== 1) { continue; }
    let g = o.geometry.clone();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    g.morphAttributes = {};
    g.clearGroups();
    g.applyMatrix4(m4.multiplyMatrices(inv, o.matrixWorld));
    if (m4.determinant() < 0 && g.index) {            // 鏡像的零件要把三角形方向翻回來
      const a = g.index.array;
      for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; }
    }
    const key = mats[0].uuid + (g.index ? 'i' : 'n');
    if (!buckets.has(key)) buckets.set(key, { mat: mats[0], list: [] });
    buckets.get(key).list.push(g);
  }
  const out = [];
  for (const { mat, list } of buckets.values()) {
    const geo = list.length === 1 ? list[0] : mergeGeometries(list, false);
    if (!geo) continue;
    geo.computeBoundingSphere(); geo.computeBoundingBox();
    const mm = new THREE.Mesh(geo, fixMaterial(mat));
    mm.castShadow = !mat.transparent;
    mm.receiveShadow = true;
    root.add(mm);
    out.push(mm);
  }
  return out;
}

function loadAssets() {
  showLoading();
  const loader = new GLTFLoader();
  const t0 = performance.now();
  // Fuel 球模型:只拿形狀,縮成半徑 1 讓原本的縮放照用
  loader.load(ASSET + 'Field3d_2026FRCFieldV2/model_0.glb', (g) => {
    let geo = null;
    g.scene.traverse(o => { if (o.isMesh && !geo) { o.updateWorldMatrix(true, false); geo = o.geometry.clone().applyMatrix4(o.matrixWorld); } });
    if (geo) {
      for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal') geo.deleteAttribute(k);
      geo.computeBoundingBox();
      const b = geo.boundingBox, c = b.getCenter(new THREE.Vector3()), sz = b.getSize(new THREE.Vector3());
      geo.translate(-c.x, -c.y, -c.z);
      const r = Math.max(sz.x, sz.y, sz.z) / 2;
      geo.scale(1 / r, 1 / r, 1 / r);
      if (!geo.attributes.normal) geo.computeVertexNormals();
      geo.computeBoundingSphere();
      ballGeo = geo;
      fieldInst.geometry = geo; shotInst.geometry = geo; R.held.geometry = geo;
    }
    loadPct.fuel = 1; updateLoading();
  }, (e) => { if (e.total) { loadPct.fuel = e.loaded / e.total; updateLoading(); } }, (err) => console.warn('fuel 模型載入失敗', err));

  // 官方場地
  loader.load(ASSET + 'Field3d_2026FRCFieldV2/model.glb', (g) => {
    const tl = performance.now();
    const model = g.scene;
    model.position.set(FW / 2, 0, FH / 2);    // glTF 本身 Y 朝上、場地中心在原點
    model.rotation.y = Math.PI;               // 模型的 -x 是紅方,我們的 x≈0 是藍方 → 轉 180°
    scene.add(model);
    model.updateMatrixWorld(true);
    // 找出 456 顆預放的 Fuel:記下位置後拿掉(球由我們自己畫)
    const fuelNodes = [], skip = new Set(), box3 = new THREE.Box3(), cc = new THREE.Vector3();
    model.traverse(o => {
      if (/^GE-26900_Fuel/.test(o.name) && !(o.parent && /^GE-26900_Fuel/.test(o.parent.name))) fuelNodes.push(o);
    });
    const staged = [];
    for (const n of fuelNodes) {
      box3.setFromObject(n).getCenter(cc);
      staged.push({ x: +cc.x.toFixed(3), y: +cc.z.toFixed(3), h: +cc.y.toFixed(3) });
      n.traverse(o => skip.add(o));
    }
    // 小於 3 公分的零件(螺絲、螺帽…)看不到又很耗效能,直接略過
    const meshes = [], bs = new THREE.Vector3();
    let dropped = 0;
    model.traverse(o => { if (o.isMesh && !skip.has(o)) { const dim = Math.max(...box3.setFromObject(o).getSize(bs).toArray()), tris = (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; if (dim < 0.03 || (tris > 4000 && dim < 0.15)) dropped++; else meshes.push(o); } });
    // 依材質合併成新的群組
    const merged = new THREE.Group();
    merged.position.copy(model.position);
    merged.quaternion.copy(model.quaternion);
    scene.add(merged);
    merged.updateMatrixWorld(true);
    const parts = mergeByMaterial(merged, meshes, merged);
    scene.remove(model);
    // 地毯:面積最大、又扁的那塊 → 霧面
    let carpet = null, best = 0;
    for (const m of parts) {
      const s = m.geometry.boundingBox.getSize(new THREE.Vector3());
      if (s.y < 0.2 && s.x * s.z > best) { best = s.x * s.z; carpet = m; }
    }
    if (carpet) {
      // 地毯:中灰+細細的絨毛雜訊(用位置當 UV)
      const g2 = carpet.geometry, pa = g2.attributes.position, uv = new Float32Array(pa.count * 2);
      for (let i = 0; i < pa.count; i++) { uv[i * 2] = pa.getX(i) / 0.5; uv[i * 2 + 1] = pa.getZ(i) / 0.5; }
      g2.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      const nt = new THREE.CanvasTexture(noiseCanvas(256, 205, 16));
      nt.wrapS = nt.wrapT = THREE.RepeatWrapping; nt.colorSpace = THREE.SRGBColorSpace; nt.anisotropy = maxAniso;
      carpet.material = new THREE.MeshStandardMaterial({ color: 0x7a7f86, map: nt, roughness: 0.9, metalness: 0 });
      carpet.castShadow = false;
    }
    fieldModel = merged;
    // 程序產生的場地藏起來;hub 只留發光效果
    procG.visible = false;
    for (const h of hubs) {
      h.g.children.forEach(c => { c.visible = c === h.halo; });
      h.halo.position.y = 1.9;
      h.official = true;
    }
    View3D.stagedFuel = staged;
    View3D.fieldLoaded = true;
    loadPct.field = 1; updateLoading(); doneLoading();
    console.log(`官方場地載入:${((tl - t0) / 1000).toFixed(1)} s 下載+解析,合併 ${meshes.length} → ${parts.length} 個 mesh(略過小零件 ${dropped}),${((performance.now() - tl)).toFixed(0)} ms;預放 fuel ${staged.length} 顆`);
    window.dispatchEvent(new Event('view3d-field-loaded'));
  }, (e) => { if (e.total) { loadPct.field = e.loaded / e.total * 0.98; updateLoading(); } }, (err) => { console.warn('場地模型載入失敗', err); loadPct.field = 1; doneLoading(); });

  // 2026 KitBot
  loader.load(ASSET + 'Robot_2026FRCKitBotV2/model.glb', (g) => {
    const model = g.scene;
    // AdvantageScope 機器人座標(x 前、y 左、z 上)→ 我們的(+X 前、+Y 上、+Z 右):繞 X 轉 -90°
    kitWrap = new THREE.Group();
    kitWrap.rotation.x = -Math.PI / 2;
    const cfg = new THREE.Group();            // 套用 AdvantageScope 設定:先繞 x 90°,再繞 z 90°,再平移
    cfg.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));
    cfg.position.set(-0.3, 0, 0.05);
    kitWrap.add(cfg);
    cfg.add(model);
    R.robot.add(kitWrap);
    R.robot.updateMatrixWorld(true);
    // 螺絲螺帽太多又看不到,直接略過;其它依材質合併
    const meshes = [], box3k = new THREE.Box3();
    model.traverse(o => {
      if (o.isMesh) {
        let p = o, tiny = false;
        while (p && p !== model) { if (/screw|nut|washer|rivet|clip/i.test(p.name)) { tiny = true; break; } p = p.parent; }
        let q = o, hidden = false;
        while (q && q !== model) { if (/HiGrip|wheel_tread|6_wheel|ToughBox/i.test(q.name)) { hidden = true; break; } q = q.parent; }   // 輪子/齒輪箱藏在保險桿裡,改用我們自己的輪子
        const dim = Math.max(...box3k.setFromObject(o).getSize(new THREE.Vector3()).toArray());
        const tris = (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
        if (!tiny && !hidden && dim >= 0.04 && !(tris > 15000 && dim < 0.1)) meshes.push(o);
      }
    });
    const body = new THREE.Group();
    R.robot.add(body);
    body.updateMatrixWorld(true);
    // 合併時要以機器人本身為基準,所以先把機器人放回原點
    const saveP = R.robot.position.clone(), saveR = R.robot.rotation.clone();
    R.robot.position.set(0, 0, 0); R.robot.rotation.set(0, 0, 0);
    R.robot.updateMatrixWorld(true);
    const kp = mergeByMaterial(body, meshes, R.robot);
    // 車身不直接投影(三角形太多),改用一個看不見的方塊代替投影
    for (const m of kp) m.castShadow = false;
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.48, 0.8), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    proxy.position.y = 0.26; proxy.castShadow = true;
    body.add(proxy);
    R.robot.position.copy(saveP); R.robot.rotation.copy(saveR);
    R.robot.remove(kitWrap);
    kitWrap = body;
    R.kitBody = body;
    applyKitLayout();
    loadPct.robot = 1; updateLoading(); doneLoading();
  }, (e) => { if (e.total) { loadPct.robot = e.loaded / e.total * 0.98; updateLoading(); } }, (err) => { console.warn('KitBot 模型載入失敗', err); loadPct.robot = 1; doneLoading(); });
}

// KitBot 載入後:藏掉程序產生的車身,只保留會動的零件(進球臂、砲塔、球堆、RSL、隊號)
function applyKitLayout() {
  const keep = new Set([R.kitBody, R.turret, R.intake, R.held, R.rslHalo, R.blob, ...R.wheels.map(w => w.g)]);   // 輪子用我們自己的(會轉)
  for (const c of R.robot.children) {
    if (keep.has(c)) continue;
    if (c.isMesh && (c.material === R.numMat || c.material === R.rslMat)) continue;
    c.visible = false;
  }
  // KitBot 保險桿上印著 KITBOT 字樣 → 隊號牌底色改成保險桿的藍,把字蓋掉
  let bumper = null, bestSat = 0;
  for (const m of R.kitBody.children) {
    const c = m.material.color; if (!c) continue;
    const sat = c.b - Math.max(c.r, c.g);
    if (sat > bestSat) { bestSat = sat; bumper = m.material; }
  }
  if (bumper && R.numMat.map) {
    const cv = R.numMat.map.image, g = cv.getContext('2d');
    g.clearRect(0, 0, cv.width, cv.height);
    g.fillStyle = '#' + bumper.color.getHexString(); g.fillRect(0, 0, cv.width, cv.height);
    g.font = '900 160px "Arial Black", Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#ffffff'; g.fillText('9427', cv.width / 2, cv.height / 2 + 8, cv.width - 10);
    R.numMat.map.needsUpdate = true;
    R.numMat.roughness = bumper.roughness; R.numMat.metalness = bumper.metalness;
  }
  // 砲塔裝在 KitBot 發射器上方
  R.turret.position.set(0.26, 0.505, 0);
  // 球堆放進 KitBot 的透明料斗(x -0.31~0.12、z ±0.22、高 0.14~0.49),滿了往上堆
  R.heldSlots = [];
  const lay = [[9, 0], [9, 1], [9, 2], [9, 3], [4, 4]];
  for (const [cnt, ly] of lay) {
    for (let k = 0; k < cnt; k++) {
      const i = cnt === 9 ? k % 3 : k % 2, j = cnt === 9 ? Math.floor(k / 3) : Math.floor(k / 2);
      const off = ly % 2 ? 0.03 : 0;
      R.heldSlots.push(cnt === 9
        ? [-0.225 + i * 0.135 + off, 0.215 + ly * 0.128, (j - 1) * 0.145 + off]
        : [-0.16 + i * 0.13, 0.215 + ly * 0.125, (j - 0.5) * 0.14]);
    }
  }
  // RSL 移到料斗後上角
  const rsl = mesh(new THREE.BoxGeometry(0.06, 0.05, 0.05), R.rslMat, R.robot, -0.29, 0.52, 0.2, false);
  box(0.02, 0.04, 0.02, std(0x2b2f35, 0.45, 0.7), R.robot, -0.29, 0.485, 0.2);
  for (const c of R.robot.children) if (c.isMesh && c.material === R.rslMat && c !== rsl) c.visible = false;
  R.rslHalo.position.set(-0.29, 0.525, 0.2);
}

// ---- 對外介面 ----
window.View3D = {
  stagedFuel: null,        // 官方場地的 456 顆預放球 {x, y, h}(載入後才有)
  fieldLoaded: false,
  mount(el) {
    if (renderer) return;
    container = el;
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    // 在 RTX 上實測 pr=2 也是滿幀(144fps),所以預設畫質開高一點;跑不動時 adaptQuality 會自己降回 1.0
    basePR = curPR = Math.min((window.devicePixelRatio || 1) * 1.6, 2);
    renderer.setPixelRatio(basePR);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false;     // 陰影每兩幀更新一次(場地三角形很多)
    maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const cv = renderer.domElement;
    cv.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block;';
    el.appendChild(cv);
    build();
    resize(el.clientWidth, el.clientHeight);
    setupComposer();
    new ResizeObserver(() => resize(el.clientWidth, el.clientHeight)).observe(el);
    loadAssets();
  },
  render(s) {
    if (!renderer || !s) return;
    const t = s.time != null ? s.time : performance.now();
    let dt = lastT === null ? 1 / 60 : (t - lastT) / 1000;
    lastT = t;
    dt = clamp(dt, 0, 0.1);
    adaptQuality(dt);
    updateRobot(s, t, dt);
    updateHubs(s, t);
    updateBoard(s, t);
    updateBalls(s);
    updateAim(s, t);
    updateFx(s, dt);
    updateCamera(s, dt);
    if ((frameNo++ & 1) === 0) renderer.shadowMap.needsUpdate = true;
    if (composer && !debugCam) composer.render(); else renderer.render(scene, camera);
  },
  // 畫質選單:'high' | 'mid' | 'low'(使用者手動選的就不會被自動降)
  setQuality(q) {
    if (!['high', 'mid', 'low'].includes(q)) return;
    quality = q; qualityPinned = true;
    try { localStorage.setItem('sim-quality', q); } catch {}
    if (renderer) { if (q === 'high' && curPR < basePR) { curPR = basePR; renderer.setPixelRatio(curPR); resize(W, H); } setupComposer(); }
  },
  get quality() { return quality; },
  setCamera(mode) {
    if (!CAM_MODES.includes(mode) || mode === camMode) return;
    camMode = mode;
    camBlend = 0;
  },
  _info() { return renderer && { calls: renderer.info.render.calls, tris: renderer.info.render.triangles, pr: curPR, progs: renderer.info.programs.length }; },   // 除錯用
  // 除錯用:把場景畫進 32 位元浮點畫布,數有幾個像素是 NaN / 無限大 / 超過半精度上限(後製黑屏的嫌疑犯)
  _fx(o) { fxTest = o; setupComposer(); },   // 除錯用:測試後製 {type:'half'|'float', samples, gtao, bloom},null = 關
  _probe() {
    const w = 400, h = Math.round(400 * H / W);
    const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType });
    renderer.setRenderTarget(rt); renderer.render(scene, camera); renderer.setRenderTarget(null);
    const px = new Float32Array(w * h * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
    rt.dispose();
    const st = { w, h, nan: 0, inf: 0, over: 0, max: 0, nanTop: 0, samples: [] };
    for (let i = 0; i < w * h; i++) {
      const row = Math.floor(i / w);          // 0 = 最下面
      for (let c = 0; c < 4; c++) {
        const v = px[i * 4 + c];
        if (Number.isNaN(v)) { st.nan++; if (row > h / 2) st.nanTop++; if (st.samples.length < 8) st.samples.push([i % w, row, c]); }
        else if (!Number.isFinite(v)) st.inf++;
        else { if (Math.abs(v) > 65504) st.over++; if (c < 3) st.max = Math.max(st.max, v); }
      }
    }
    return st;
  },
  _cam(p, t) { debugCam =p ? { p: new THREE.Vector3(...p), t: new THREE.Vector3(...t) } : null; },   // 除錯用:固定鏡頭
  _sim(v) { for (const o of [R.turret, R.intake, R.held]) o.visible = v; },   // 除錯用:藏自己加的零件
  _pr(v) { curPR = v; renderer.setPixelRatio(v); resize(W, H); },     // 除錯用:手動設解析度
  project(x, y, h) {
    if (!camera) return { x: 0, y: 0, visible: false };
    camera.updateMatrixWorld();
    const v = tmpProj.set(x, h || 0, y).project(camera);
    const visible = v.z > -1 && v.z < 1 && Math.abs(v.x) <= 1.1 && Math.abs(v.y) <= 1.1;
    return { x: (v.x + 1) / 2 * W, y: (1 - v.y) / 2 * H, visible };
  },
};
const tmpProj = new THREE.Vector3();
window.dispatchEvent(new Event('view3d-ready'));
