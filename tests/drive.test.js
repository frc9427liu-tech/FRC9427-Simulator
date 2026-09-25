// 底盤物理(physics.js)的自動測試:node tests/drive.test.js
// physics.js 是給瀏覽器用的(讀 screen.js 的全域),這裡用 vm 模擬那些全域
const assert = require('assert');
const fs = require('fs'), vm = require('vm'), path = require('path');
const ctx = { console, Math };
vm.createContext(ctx);
const src = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
vm.runInContext(src('mechlab-core.js').replace('const MechLab =', 'var MechLab ='), ctx);
vm.runInContext(`var FIELD_W = 16.54, FIELD_H = 8.07, HUBS = [{ x: 4.625, y: 4.035 }, { x: 11.915, y: 4.035 }], HUB_TOP = 1.83,
  BALL_R = 0.075, MAX_HELD = 40, pose = { x: 2, y: 0.6, th: 0 }, fieldBalls = [], shots = [], held = 0,
  ROBOT = { shootK: 0.3, launchRad: 1 };`, ctx);
vm.runInContext(src('physics.js').replace('const PHYS =', 'var PHYS ='), ctx);
const P = ctx.PHYS;

function drive(body, L, R, secs) {
  P.configure(body);
  Object.assign(ctx.pose, { x: 2, y: 0.6, th: 0 });
  Object.assign(P.state, { vL: 0, vR: 0, v: 0, w: 0, minV: undefined });
  P.battery.reset();
  let t3 = null;
  for (let i = 0; i < secs * 60; i++) { P.drive(L, R, 1 / 60); if (t3 === null && P.state.v >= 3) t3 = (i + 1) / 60; }
  return { v: P.state.v, w: P.state.w, t3, minV: P.state.minV };
}

// 預設(Kraken ×4、7.31:1、4 吋輪):極速接近理論值、0.5 秒內到 3 m/s
const spec = P.driveSpecs(null);
const d = drive(null, 1, 1, 2);
assert.ok(Math.abs(d.v - spec.vFree) < 0.3, `極速 ${d.v} 應接近理論 ${spec.vFree}`);
assert.ok(d.t3 < 0.5, `到 3 m/s 要 ${d.t3} 秒`);
// 加速度受輪胎限制:摩擦係數越低越慢
const slip = drive({ drive: { mu: 0.5 } }, 1, 1, 2);
assert.ok(slip.t3 > d.t3 * 1.5, `μ = 0.5 應該明顯比較慢(${slip.t3} vs ${d.t3})`);
// 減速比越大極速越低
assert.ok(drive({ drive: { ratio: 10 } }, 1, 1, 3).v < d.v * 0.8, '大減速比應該比較慢');
// 不限電流 + 爛電池 → 電壓掉到 Brownout
assert.ok(drive({ drive: { statorLimit: 0, supplyLimit: 0 }, battery: { openV: 12, resistance: 0.04 } }, 1, 1, 1).minV < 6.75, '應該 Brownout');
// 放開搖桿會停下來
P.configure(null); Object.assign(P.state, { vL: 3, vR: 3 });
for (let i = 0; i < 60; i++) P.drive(0, 0, 1 / 60);
assert.ok(Math.abs(P.state.v) < 0.01, '放開應該停下');
// 原地轉
assert.ok(drive(null, -1, 1, 1).w > 3, '應該能原地轉');
// 車身尺寸:長 1 m 的車貼牆時,中心離牆 0.5 m
P.configure({ length: 1.0, width: 0.8 });
Object.assign(ctx.pose, { x: 0.1, y: 0.6, th: 0 }); Object.assign(P.state, { vL: 0, vR: 0 });
P.drive(0, 0, 1 / 60);
assert.ok(Math.abs(ctx.pose.x - 0.5) < 1e-9, `車中心應該被推到 0.5,實際 ${ctx.pose.x}`);

// 🧩 機構組裝:Intake 寬度、Shooter 種類 / 位置會影響物理
P.configure({ parts: { intake: { type: 'pivot', width: 0.5, reach: 0.4 }, shooter: { type: 'fixed', x: -0.2, h: 0.8 } } });
assert.ok(Math.abs(P.dims.intake - 0.25) < 1e-9 && Math.abs(P.dims.reach - 0.4) < 1e-9, 'Intake 寬度 / 伸出長度');
assert.ok(P.turretFixed && P.canShoot && Math.abs(P.dims.pivot + 0.2) < 1e-9 && Math.abs(P.dims.muzzleZ - 0.88) < 1e-9, 'Shooter 固定式、位置、高度');
Object.assign(ctx.pose, { x: 5, y: 2, th: 0 });
const shot = P.launch(0, 50, false);
assert.ok(Math.abs(shot.z - 0.88) < 1e-9 && shot.x < 5 + 0.2, `出球點應該在車後方偏高:x = ${shot.x}, z = ${shot.z}`);
P.configure({ parts: { intake: { type: 'none' }, shooter: { type: 'none' } } });
assert.ok(!P.hasIntake && !P.canShoot, '沒有 Intake / Shooter');
P.configure(null);

// 底盤前後反過來:往前推會往後開,而且左輪出力比較大時一樣往同一邊轉
P.configure({ drive: { reverse: true } });
Object.assign(ctx.pose, { x: 8, y: 2, th: 0 }); Object.assign(P.state, { vL: 0, vR: 0, v: 0, w: 0 });
for (let i = 0; i < 30; i++) P.drive(1, 1, 1 / 60);
assert.ok(ctx.pose.x < 8 - 0.1, `反向後往前推應該往後開:x = ${ctx.pose.x}`);
P.configure(null);

console.log('✅ 底盤物理測試全部通過');
