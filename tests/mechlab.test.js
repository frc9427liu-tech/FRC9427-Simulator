// 機構實驗室核心的自動測試:node tests/mechlab.test.js
// 不用瀏覽器,直接跑物理,確認三種機構都能追到目標、限制和電池模型有作用
const assert = require('assert');
const M = require('../mechlab-core.js');

function run(kind, goalDisplay, secs, cfg = {}) {
  const sim = new M.Simulation(Object.assign({ kind }, cfg));
  sim.autoFF();
  sim.setGoal(sim.mech.fromDisplay(goalDisplay));
  for (let i = 0; i < secs / sim.dt; i++) sim.step();
  return sim;
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}:${a} 應該接近 ${b}(±${tol})`);

// 馬達常數:從規格反推回去要對得起來
const k = M.MOTORS.krakenX60;
near(k.R, 12 / 366, 1e-9, 'Kraken R');
near(k.kT * k.stallCurrent, 7.09, 1e-9, 'Kraken 堵轉轉矩');
near(k.freeSpeed / k.kV + k.R * k.freeCurrent, 12, 1e-9, 'Kraken 空轉電壓');

// 三種機構都能穩定追到目標
near(run('arm', 90, 3).out.actual, 90, 0.5, '手臂 90°');
near(run('elevator', 1.2, 3).out.actual, 1.2, 0.01, '升降台 1.2 m');
near(run('flywheel', 4000, 3).out.actual, 4000, 40, '飛輪 4000 RPM');

// 定子電流限制:電流不能超過上限
const lim = run('flywheel', 6000, 1, { statorLimit: 40 });
assert.ok(lim.peakI <= 40 + 1e-6, `定子限制 40 A,實際峰值 ${lim.peakI}`);

// 沒有限制時全速起步會把電池拉到 Brownout,之後自己恢復
const open = new M.Simulation({ kind: 'flywheel', mode: 'open', openV: 12, statorLimit: 0, supplyLimit: 0 });
for (let i = 0; i < 250; i++) open.step();
assert.ok(open.minV < M.Battery.BROWNOUT, `應該 Brownout,最低電壓 ${open.minV}`);
near(open.out.actual, 6000, 150, '開迴圈 12 V 接近自由轉速');

// 手臂沒出力會掉到下限擋塊
const fall = new M.Simulation({ kind: 'arm', mode: 'open', openV: 0 });
fall.mech.reset(0);
for (let i = 0; i < 100; i++) fall.step();
near(fall.out.actual, -30, 1e-6, '手臂掉到下限');

// 射球會讓飛輪掉速
const fly = run('flywheel', 4000, 2);
const before = fly.mech.velocity;
assert.ok(fly.mech.shoot() > 5 && fly.mech.velocity < before, '射球後應該掉速');

// 子步數 1 的升降台在 20 ms 步長下不穩定(教學用的反例)
assert.ok(!new M.Simulation({ kind: 'elevator', substeps: 1 }).stability().stable, '1 個子步應該判定為不穩定');
assert.ok(new M.Simulation({ kind: 'elevator' }).stability().stable, '預設子步數應該穩定');

// 梯形曲線:1 m、最高 2 m/s、4 m/s² → 剛好 1 秒(三角形)
const tp = new M.TrapezoidProfile(2, 4);
let st = { pos: 0, vel: 0 }, t = 0;
while (Math.abs(st.pos - 1) > 1e-9 && t < 5) { st = tp.calculate(0.02, st, { pos: 1, vel: 0 }); t += 0.02; }
near(t, 1, 0.021, '梯形曲線時間');

console.log('✅ 機構實驗室測試全部通過');
