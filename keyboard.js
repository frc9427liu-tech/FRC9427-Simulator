// ============================================================
//  鍵盤操作:滑鼠一次只能按一個,鍵盤可以同時按好幾個
//  駕駛手 WASD(W/S 前後、A/D 轉彎,按住 Shift 慢速)
//  操作手 ↑↓ 手臂、←→ 砲台、Q 吸球、E 吐球、R 飛輪開/關、F 發射、G Orbit
//  空白鍵 / Enter 還是緊急停止(index.html 那邊處理)
//  讀 index.html 的全域:state, holds, BTN, AX, enabled, lastInput, warnNotEnabled, syncVisual, gpAssign
// ============================================================
(() => {
  const down = new Set();
  let flyOn = false;
  const DRV = 0, OP = 1;
  const KB = 'kb';                        // 在 holds 裡代表「鍵盤按著」,跟滑鼠按的分開算
  const KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
                'KeyQ', 'KeyE', 'KeyR', 'KeyF', 'KeyG', 'KeyZ', 'KeyC'];

  function btn(pi, name, on) {
    const i = BTN[name] - 1, set = holds[pi][i];
    on ? set.add(KB) : set.delete(KB);
    state[pi].buttons[i] = set.size > 0;
  }
  let usedDrive = false, usedTurret = false, usedFly = false;
  function apply() {
    const k = c => down.has(c);
    // 駕駛手:坦克式,把「前後 + 轉彎」換成左右輪。搖桿往上推是負的
    if (gpAssign[DRV] == null) {
      const f = (k('KeyW') ? 1 : 0) - (k('KeyS') ? 1 : 0);
      const t = (k('KeyD') ? 1 : 0) - (k('KeyA') ? 1 : 0);   // 往右轉 = 左輪快
      const slow = k('ShiftLeft') || k('ShiftRight') ? 0.5 : 1;
      if (!(window.simPrefs && simPrefs.driveMode === 'tank')) {
        // swerve(預設):跟真機一樣 —— 場地座標平移(W/S 前後、A/D 左右)+ Z/C 旋轉;搖桿往上推是負的
        const rot = (k('KeyC') ? 1 : 0) - (k('KeyZ') ? 1 : 0);   // 右搖桿往右 = 順時針
        const a = state[DRV].axes;
        a[AX.LY] = -f * slow; a[AX.LX] = t * slow; a[AX.RX] = rot * slow;
        a[AX.RY] = 0;
        usedDrive = false;
      } else if (f || t || usedDrive) {
        const clamp = v => Math.max(-1, Math.min(1, v));
        const turn = f ? t * 0.6 : t * 0.75;                  // 原地轉不要太猛
        state[DRV].axes[AX.LY] = -clamp((f + turn) * slow);
        state[DRV].axes[AX.RY] = -clamp((f - turn) * slow);
        usedDrive = !!(f || t);
      }
      syncVisual(DRV);
    }
    if (gpAssign[OP] == null) {
      const s = state[OP];
      s.pov.u = k('ArrowUp') ? 1 : 0;
      s.pov.d = k('ArrowDown') ? 1 : 0;
      const tr = (k('ArrowRight') ? 1 : 0) - (k('ArrowLeft') ? 1 : 0);
      if (tr || usedTurret) { s.axes[AX.LX] = tr; usedTurret = !!tr; }
      if (flyOn || usedFly) { s.axes[AX.RT] = flyOn ? 1 : 0; usedFly = flyOn; }
      btn(OP, 'LB', k('KeyQ'));
      btn(OP, 'X', k('KeyE'));
      btn(OP, 'A', k('KeyF'));
      btn(OP, 'RB', k('KeyG'));
      syncVisual(OP);
    }
  }

  const typing = e => e.target.closest && e.target.closest('input, textarea, select, dialog');
  window.addEventListener('keydown', e => {
    if (!KEYS.includes(e.code) || typing(e)) return;
    e.preventDefault();                   // 方向鍵不要捲動網頁
    if (e.repeat) return;
    if (window.demoMode && demoMode.on) demoMode.stop('你用鍵盤接手了,展示模式已停止');
    down.add(e.code);
    if (e.code === 'KeyR') { flyOn = !flyOn; if (window.toast) toast(flyOn ? '🔥 飛輪:開(再按 R 關掉)' : '飛輪:關', 1200); }
    lastInput = performance.now();
    if (!enabled) warnNotEnabled();
    apply();
  });
  window.addEventListener('keyup', e => {
    if (!down.delete(e.code)) return;
    apply();
  });
  // 切視窗時鍵盤的 keyup 會收不到 → 全部放開,免得車子一直衝
  window.addEventListener('blur', () => { down.clear(); flyOn = false; apply(); });
  // 停用的時候飛輪開關也歸零,重新啟用才不會突然轉起來
  setInterval(() => { if (!enabled && flyOn) { flyOn = false; apply(); } }, 200);

  // 按鍵表
  const tip = document.createElement('details');
  tip.className = 'kbhelp';
  tip.innerHTML = `<summary>⌨️ 鍵盤操作(可以同時按好幾個鍵)</summary>
    <div class="kbgrid">
      <div><b>駕駛手</b></div><div></div>
      <div><kbd>W</kbd><kbd>S</kbd></div><div>往場地遠端 / 近端(場地座標,跟真機一樣)</div>
      <div><kbd>A</kbd><kbd>D</kbd></div><div>往上 / 往下平移</div>
      <div><kbd>Z</kbd><kbd>C</kbd></div><div>車頭逆時針 / 順時針轉</div>
      <div><kbd>Shift</kbd></div><div>按住 = 慢速</div>
      <div><b>操作手</b></div><div></div>
      <div><kbd>↑</kbd><kbd>↓</kbd></div><div>手臂收起 / 放下</div>
      <div><kbd>←</kbd><kbd>→</kbd></div><div>砲台左右轉</div>
      <div><kbd>Q</kbd> / <kbd>E</kbd></div><div>吸球 / 吐球</div>
      <div><kbd>R</kbd></div><div>飛輪 開 / 關</div>
      <div><kbd>F</kbd></div><div>發射(飛輪要先開)</div>
      <div><kbd>G</kbd></div><div>只轉 Orbit</div>
      <div><kbd>空白</kbd></div><div>緊急停止</div>
    </div>`;
  document.getElementById('pads').prepend(tip);
})();
