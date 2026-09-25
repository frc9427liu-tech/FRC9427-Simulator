// 3D 物理引擎(Rapier)的自動測試:node tests/engine.test.js
const assert = require('assert');
const fs = require('fs'), vm = require('vm'), path = require('path');
const ctx = { console, Math, WebAssembly, TextDecoder, TextEncoder, atob, setTimeout, performance, crypto };
ctx.globalThis = ctx;
vm.createContext(ctx);
const src = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
vm.runInContext(src('rapier.js'), ctx);
vm.runInContext(src('mechlab-core.js').replace('const MechLab =', 'var MechLab ='), ctx);
vm.runInContext(`var FIELD_W = 16.54, FIELD_H = 8.07, HUBS = [{ x: 4.625, y: 4.035 }, { x: 11.915, y: 4.035 }], HUB_TOP = 1.83,
  BALL_R = 0.075, MAX_HELD = 40, pose = { x: 2, y: 0.6, th: 0 }, fieldBalls = [], shots = [], held = 0,
  ROBOT = { shootK: 0.3, launchRad: 1 };`, ctx);
vm.runInContext(src('physics.js').replace('const PHYS =', 'var PHYS ='), ctx);
const P = ctx.PHYS;
const place = (x, y, th) => Object.assign(ctx.pose, { x, y, th });
const run = (L, R, secs, balls) => { for (let i = 0; i < secs * 60; i++) { P.drive(L, R, 1 / 60); if (balls) P.balls(1 / 60, i * 16.7, 0, 0, () => {}); } };

P.engineReady.then(ok => {
  assert.ok(ok, 'Rapier 應該載入成功');
  // 直線加速:跟 2D 馬達模型一樣快
  place(2, 0.6, 0);
  let t3 = null;
  for (let i = 0; i < 120; i++) { P.drive(1, 1, 1 / 60); if (t3 === null && P.state.v >= 3) t3 = (i + 1) / 60; }
  assert.ok(t3 < 0.5, `到 3 m/s 花了 ${t3} 秒`);
  assert.ok(Math.abs(P.state.v - P.driveSpecs(null).vFree) < 0.3, `極速 ${P.state.v}`);
  // 撞牆會停在牆邊
  place(3, 0.6, Math.PI); run(1, 1, 3);
  assert.ok(Math.abs(ctx.pose.x - 0.43) < 0.02 && Math.abs(P.state.v) < 0.05, `撞牆後 x = ${ctx.pose.x}`);
  // 原地轉、放開會停
  place(8, 2, 0); run(-1, 1, 1);
  assert.ok(P.state.w > 3, `原地轉 ${P.state.w} rad/s`);
  assert.ok(Math.hypot(ctx.pose.x - 8, ctx.pose.y - 2) < 0.05, '原地轉不應該亂飄');
  run(0, 0, 1);
  assert.ok(Math.abs(P.state.w) < 0.02 && Math.abs(P.state.v) < 0.02, '放開應該停下');
  // 開過 BUMP(藍方 HUB 旁邊的斜坡)會被抬高、而且過得去
  place(3.3, 5.5, 0);
  let maxH = 0;
  for (let i = 0; i < 90; i++) { P.drive(1, 1, 1 / 60); maxH = Math.max(maxH, P.state.h); }
  assert.ok(maxH > 0.12 && ctx.pose.x > 6, `BUMP:最高 ${maxH} m、最後 x = ${ctx.pose.x}`);
  // 撞球:球被推走、還在地上
  place(8, 6, 0);
  vm.runInContext('fieldBalls = [{ x: 9, y: 6, vx: 0, vy: 0 }]', ctx);
  run(1, 1, 1.5, true);
  const b = ctx.fieldBalls[0];
  assert.ok(b.x > 10 && b.h < 0.2, `球應該被推到前面、在地上:x = ${b.x}, h = ${b.h}`);
  // 側面被推:輪胎抓地力撐得住小的力
  place(8, 3, 0); run(0, 0, 0.5);
  P.engine.robot.applyImpulse({ x: 0, y: 0, z: 20 }, true);    // 很小的側向衝量
  run(0, 0, 0.5);
  assert.ok(Math.abs(ctx.pose.y - 3) < 0.05, `小力推側面不應該滑走:y = ${ctx.pose.y}`);
  // 456 顆球的效能
  const arr = [];
  for (let i = 0; i < 456; i++) arr.push({ x: 6 + (i % 20) * 0.16, y: 1 + Math.floor(i / 20) * 0.16, vx: 0, vy: 0 });
  ctx.fieldBalls = arr; vm.runInContext('fieldBalls = this.fieldBalls', ctx);
  const t0 = Date.now(); run(0.5, 0.5, 2, true);
  const ms = (Date.now() - t0) / 120;
  assert.ok(ms < 12, `每幀 ${ms.toFixed(1)} ms 太慢`);
  console.log(`✅ 物理引擎測試全部通過(456 顆球每幀 ${ms.toFixed(1)} ms)`);
}).catch(e => { console.error(e); process.exit(1); });
