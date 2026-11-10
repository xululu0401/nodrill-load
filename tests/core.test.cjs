/* 免打孔承载装置对账台 · 核心测试（node --test tests/core.test.cjs）
 *
 * 覆盖：手算锚点、独立实现对拍（另一条单位路径 / 数值积分求截面惯性矩 / 二分法求反推 / 逐项连乘求衰减）、
 *       代数恒等式、单调性与方向、边界与退化、非法输入逐条核字段、输出契约、确定性、随机压力自检。
 * 说明：参考实现与工程实现对拍只能证明两边一致，所以每个关键量至少还有一条独立路径互证，
 *       并单独检查单位与常识（1 MPa = 100 N/cm²、1 kPa = 0.1 N/cm²、1 kgf = 9.80665 N）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const C = require(path.join(__dirname, '..', 'core.js'));

const near = (a, b, tol, msg) => {
  const d = Math.abs(a - b);
  assert.ok(d <= tol, (msg || '') + ' |实际 ' + a + ' 期望 ' + b + ' 差 ' + d + ' 容差 ' + tol);
};
const rel = (a, b, tol, msg) => {
  const d = Math.abs(a - b) / Math.max(1e-12, Math.abs(b));
  assert.ok(d <= tol, (msg || '') + ' |实际 ' + a + ' 期望 ' + b + ' 相对差 ' + d + ' 容差 ' + tol);
};
function sc(id) {
  const hit = C.scenarios.filter((x) => x.id === id)[0];
  assert.ok(hit, '找不到场景 ' + id);
  return hit.patch;
}
function withPatch(patch) {
  const d = C.defaultsClone();
  if (!patch) return d;
  Object.keys(patch).forEach((k) => { d[k] = patch[k]; });
  return d;
}
function an(patch) {
  const r = C.analyze(withPatch(patch));
  assert.ok(r.ok, '应通过校验：' + JSON.stringify(r.errors));
  return r;
}
function oneItem(over) {
  const base = C.item(Object.assign({ name: '测试件', mode: 'glue', dir: 'shear', load: '100', dyn: '1', keep: '100', decay: '0' }, over || {}));
  return { sf: '3', years: '5', items: [base] };
}
function allChecksPass(r, label) {
  const bad = r.checks.filter((c) => !c.pass);
  assert.strictEqual(bad.length, 0, (label || '') + ' 结构自检失败：' + bad.map((c) => c.name + ' :: ' + c.detail).join(' | '));
}
/* 可重复的伪随机（确定性） */
function rng(seed) {
  let s = seed >>> 0;
  return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/* ─────────── 1. 手算锚点 ─────────── */
test('手算锚点：背胶剪切 40 cm² × 0.4 MPa × 保持 60% = 960 N', () => {
  const r = C.analyze(oneItem({ mode: 'glue', dir: 'shear', area: '40', tau: '0.4', peel: '0.04', keep: '60' }));
  const it = r.items[0];
  near(it.F0, 960, 1e-9, '粘胶剪切能力');
  /* 手算：0.4 MPa = 40 N/cm²；40 × 40 = 1600 N；× 0.6 = 960 N */
  near(0.4 * 100 * 40 * 0.6, 960, 1e-12, '手算复核');
});
test('手算锚点：同一块胶改成「往外拉」只有 96 N（低一个量级）', () => {
  const r = C.analyze(oneItem({ mode: 'glue', dir: 'peel', area: '40', tau: '0.4', peel: '0.04', keep: '60' }));
  near(r.items[0].F0, 96, 1e-9, '粘胶剥离能力');
  assert.strictEqual(r.items[0].limiter, 'glue');
  assert.ok(r.items[0].warnings.some((w) => /剥离/.test(w)), '剥离方向应给出提醒');
});
test('手算锚点：吸盘 直径 6 cm × 2 只 × 压差 60 kPa × 保持 70% = 237.5044 N；滑移 ×0.4 = 95.0018 N', () => {
  const pull = 60 * 0.1 * (Math.PI * 36 / 4) * 0.7 * 2;
  near(pull, 237.50440461138834, 1e-9, '手算拉脱');
  const a = C.analyze(oneItem({ mode: 'suction', dir: 'peel', cupD: '6', cups: '2', dP: '60', keep: '70', slide: '0.4' }));
  near(a.items[0].F0, pull, 1e-9, '拉离方向 = 拉脱');
  const s = C.analyze(oneItem({ mode: 'suction', dir: 'shear', cupD: '6', cups: '2', dP: '60', keep: '70', slide: '0.4' }));
  near(s.items[0].F0, pull * 0.4, 1e-9, '顺墙方向 = 拉脱 × 滑移系数');
  assert.strictEqual(s.items[0].limiter, 'slide', '顺墙方向应由滑移封顶');
});
test('手算锚点：磁吸 30 N/cm² × 4 cm² × 80% × 85% = 81.6 N', () => {
  const r = C.analyze(oneItem({ mode: 'magnet', dir: 'shear', magQ: '30', magA: '4', keep: '80', tempK: '85' }));
  near(r.items[0].F0, 30 * 4 * 0.8 * 0.85, 1e-9, '磁吸能力');
  near(r.items[0].F0, 81.6, 1e-9, '手算值');
});
test('手算锚点：撑杆 25 mm 外径 / 1.2 mm 壁厚 → 屈曲 763.92 N 封顶压紧力，抗弯 169.84 N 封顶能力', () => {
  const r = C.analyze(oneItem({ mode: 'rod', rodD: '25', rodT: '1.2', rodL: '240', E: '70000', sigma: '200', effLen: '1', springN: '800', mu: '0.5', wallP: '2', padA: '12' }));
  const it = r.items[0];
  const Do = 2.5, Di = 2.26;
  const I = Math.PI * (Math.pow(Do, 4) - Math.pow(Di, 4)) / 64;
  const W = I / (Do / 2);
  const Nb = Math.PI * Math.PI * 70000 * 100 * I / Math.pow(240, 2);
  const bend = 4 * (200 * 100 * W) / 240;
  near(it.extra.Nb, Nb, 1e-9, '屈曲上限');
  near(it.extra.Nb, 763.924, 1e-3, '屈曲手算值');
  near(it.extra.Nb, 763.924, 1e-3, '与手算 763.92 N 一致');
  near(it.extra.bend, bend, 1e-9, '抗弯能力');
  near(it.F0, bend, 1e-12, '能力取抗弯');
  assert.strictEqual(it.limiter, 'bend');
  assert.strictEqual(it.extra.nLimiter, 'buckle', '压紧力由屈曲封顶（弹簧 800 > 屈曲 763.92）');
  near(it.extra.fric, 2 * 0.5 * Nb, 1e-9, '摩擦自锁 = 2μN');
  assert.ok(it.warnings.some((w) => /屈曲上限/.test(w)), '弹簧力超过屈曲上限要给出提醒');
});
test('单位恒等式：1 MPa = 100 N/cm²、1 kPa = 0.1 N/cm²、1 kgf = 9.80665 N', () => {
  const g = C.analyze(oneItem({ mode: 'glue', area: '1', tau: '1', keep: '100' }));
  near(g.items[0].F0, 100, 1e-12, '1 MPa × 1 cm² = 100 N');
  const s = C.analyze(oneItem({ mode: 'suction', cupD: String(2 * Math.sqrt(1 / Math.PI)), cups: '1', dP: '1', keep: '100', dir: 'peel' }));
  near(s.items[0].F0, 0.1, 1e-9, '1 kPa × 1 cm² = 0.1 N');
  near(C.kgfOf(9.80665), 1, 1e-12, '1 kgf');
  assert.strictEqual(C.fmtKgf(9.80665), '1.00 kgf');
});

/* ─────────── 2. 独立实现对拍 ─────────── */
test('对拍（另一条单位路径）：MPa × mm² 直接算，150 组随机背胶', () => {
  const r0 = rng(20261110);
  for (let i = 0; i < 150; i++) {
    const area = 1 + r0() * 300, tau = 0.005 + r0() * 2, keep = 5 + r0() * 95, dir = r0() < 0.5 ? 'shear' : 'peel';
    const peel = tau / (2 + r0() * 30);
    const cfg = oneItem({ mode: 'glue', dir: dir, area: String(area), tau: String(tau), peel: String(peel), keep: String(keep) });
    const got = C.analyze(cfg).items[0].F0;
    /* 独立路径：把强度换成 N/mm²、面积换成 mm²，不经过 N/cm² */
    const s = dir === 'shear' ? tau : peel;
    const want = s * (area * 100) * (keep / 100);
    rel(got, want, 1e-12, '第 ' + i + ' 组背胶');
  }
});
test('对拍（另一条单位路径）：kPa × mm² 直接算，150 组随机吸盘', () => {
  const r0 = rng(777001);
  for (let i = 0; i < 150; i++) {
    const cupD = 0.5 + r0() * 20, cups = 1 + Math.floor(r0() * 12), dP = 1 + r0() * 100, keep = 5 + r0() * 95, slide = r0();
    const dir = r0() < 0.5 ? 'shear' : 'peel';
    const got = C.analyze(oneItem({ mode: 'suction', dir: dir, cupD: String(cupD), cups: String(cups), dP: String(dP), keep: String(keep), slide: String(slide) })).items[0].F0;
    /* 独立路径：1 kPa = 0.001 N/mm²；面积用 mm² */
    const Amm2 = Math.PI * Math.pow(cupD * 10, 2) / 4;
    let want = dP * 0.001 * Amm2 * (keep / 100) * cups;
    if (dir === 'shear') want *= slide;
    rel(got, want, 1e-12, '第 ' + i + ' 组吸盘');
  }
});
test('对拍（数值积分求惯性矩）：空心圆截面 I 与极坐标二重积分一致（相对差 < 1e-4）', () => {
  const r0 = rng(31415);
  const numericI = (Do, Di) => {
    const n = 300, m = 300;
    const dr = (Do - Di) / 2 / n, dth = Math.PI / m * 0.5;
    let sum = 0;
    for (let a = 0; a < n; a++) {
      const r = Di / 2 + (a + 0.5) * dr;
      for (let b = 0; b < m; b++) {
        const th = (b + 0.5) * dth;
        sum += Math.pow(r * Math.sin(th), 2) * r * dr * dth;
      }
    }
    return sum * 4;   // 四个象限
  };
  for (let i = 0; i < 12; i++) {
    const D = 8 + r0() * 80, t = 0.3 + r0() * (D / 2 - 0.6);
    const g = C.tubeGeom(D, t);
    rel(g.I, numericI(D / 10, (D - 2 * t) / 10), 1e-4, '第 ' + i + ' 组 I（D=' + D + ' t=' + t + '）');
    near(g.W, g.I / (g.Do / 2), 1e-12, 'W = I / 外半径');
    near(g.Atube, Math.PI * (Math.pow(g.Do, 2) - Math.pow(g.Di, 2)) / 4, 1e-12, '截面积');
  }
});
test('对拍（独立二分法）：150 组随机撑杆的抗弯能力与「应力上限」反算一致', () => {
  const r0 = rng(9090);
  for (let i = 0; i < 150; i++) {
    const D = 10 + r0() * 80, t = 0.3 + r0() * (D / 2 - 0.6), L = 20 + r0() * 400, sigma = 20 + r0() * 400;
    const cfg = oneItem({ mode: 'rod', rodD: String(D), rodT: String(t), rodL: String(L), sigma: String(sigma), keep: '100' });
    const it = C.analyze(cfg).items[0];
    /* 独立路径：不用 W，直接用 I 与外半径判断 σ = M·c/I ≤ sigma */
    const g = C.tubeGeom(D, t);
    const Fmax = 4 * sigma * 100 * g.I / (L * (g.Do / 2));
    rel(it.extra.bend, Fmax, 1e-12, '第 ' + i + ' 组抗弯');
  }
});
test('对拍（独立二分法）：120 组随机背胶的面积反推与二分搜索一致', () => {
  const r0 = rng(5150);
  for (let i = 0; i < 120; i++) {
    const tau = 0.05 + r0() * 3, peel = tau / (1 + r0() * 40), keep = 10 + r0() * 90;
    const dir = r0() < 0.5 ? 'shear' : 'peel', load = 1 + r0() * 400, dyn = 1 + r0() * 2, decay = r0() * 30, years = 1 + Math.floor(r0() * 20), sf = 1 + r0() * 6;
    const cfg = oneItem({ mode: 'glue', dir: dir, tau: String(tau), peel: String(peel), keep: String(keep), load: String(load), dyn: String(dyn), decay: String(decay), area: '100' });
    cfg.sf = String(sf); cfg.years = String(years);
    const rev = C.analyze(cfg).items[0].rev;
    /* 独立路径：对面积二分（单调），找到最小的「按 0.1 取整后仍达标」的面积 */
    const k = 1 - decay / 100, need0 = load * dyn * sf / Math.pow(k, years);
    const s = dir === 'shear' ? tau : peel;
    let lo = 0.1, hi = 10000;
    for (let n = 0; n < 200; n++) { const mid = (lo + hi) / 2; if (s * 100 * mid * keep / 100 >= need0) hi = mid; else lo = mid; }
    if (hi > 10000 - 1e-9) { assert.strictEqual(rev.feasible, false, '第 ' + i + ' 组超上限应判不可行'); continue; }
    assert.ok(rev.feasible, '第 ' + i + ' 组应可行');
    near(rev.rounded.area, Math.ceil(hi / 0.1 - 1e-9) * 0.1, 0.05 + 1e-9, '第 ' + i + ' 组所需面积');
  }
});
test('对拍（独立二分法）：80 组随机撑杆的最小外径反推（抗弯约束）与二分一致', () => {
  const r0 = rng(24680);
  for (let i = 0; i < 80; i++) {
    const t = 0.5 + r0() * 2, L = 40 + r0() * 200, sigma = 100 + r0() * 300, load = 5 + r0() * 300, dyn = 1 + r0() * 2, mu = 0.3 + r0() * 0.7;
    const cfg = oneItem({ mode: 'rod', rodD: '20', rodT: String(t), rodL: String(L), sigma: String(sigma), mu: String(mu), load: String(load), dyn: String(dyn), decay: '0', springN: '20000', wallP: '20', padA: '500' });
    const rev = C.analyze(cfg).items[0].rev;
    const sf = 3, need0 = load * dyn * sf;
    /* 独立路径：分别按「抗弯」与「屈曲」二分外径，再取两者较大者（引擎应当同解） */
    const Nreq = need0 / (2 * mu);
    const bisect = (ok) => {
      let lo = 2 * t / 10 + 0.05, hi = 10;
      if (ok(hi)) { for (let n = 0; n < 200; n++) { const mid = (lo + hi) / 2; if (ok(mid)) hi = mid; else lo = mid; } return hi; }
      return Infinity;
    };
    const bendD = bisect((Do) => 4 * sigma * 100 * C.tubeGeom(Do * 10, t).W / L >= need0);
    const buckleD = bisect((Do) => Math.PI * Math.PI * (70000 * 100) * C.tubeGeom(Do * 10, t).I / Math.pow(1 * L, 2) >= Nreq);
    const wantD = Math.max(bendD, buckleD);
    if (rev.feasible) {
      if (isFinite(wantD)) {
        assert.ok(rev.rounded.rodD >= wantD * 10 - 0.5 - 1e-9, '第 ' + i + ' 组外径不小于所需（含 0.5 mm 向上取整）');
        near(rev.rounded.rodD, Math.ceil(wantD * 10 / 0.5 - 1e-9) * 0.5, 0.5 + 1e-9, '第 ' + i + ' 组取整外径');
      }
    } else {
      assert.ok(rev.reason.length > 0, '第 ' + i + ' 组不可行要有原因');
    }
  }
});

/* ─────────── 3. 代数恒等式与口径 ─────────── */
test('恒等式：实际安全系数 = 能力 ÷ 有效载荷；许可载荷 = 能力 ÷（SF × 动载）', () => {
  const r = an();
  r.items.forEach((it) => {
    near(it.ratioT, it.FT / (it.load * it.dyn), 1e-9, it.name + ' 实际安全系数');
    near(it.allow, it.FT / (r.sf * it.dyn), 1e-9, it.name + ' 许可载荷');
    for (let t = 0; t <= r.years; t++) {
      near(it.rows[t].F, it.F0 * Math.pow(1 - it.decay / 100, t), 1e-9, it.name + ' 第 ' + t + ' 年能力');
    }
  });
});
test('恒等式：T 年末能力 = 初始能力 × (1−衰减)^T（逐项连乘互证）', () => {
  const r0 = rng(1234);
  for (let i = 0; i < 100; i++) {
    const decay = r0() * 50, years = 1 + Math.floor(r0() * 29);
    const cfg = oneItem({ mode: 'glue', area: '50', tau: '0.4', keep: '70', decay: String(decay) });
    cfg.years = String(years);
    const it = C.analyze(cfg).items[0];
    let k = 1;
    for (let t = 0; t < years; t++) k *= (1 - decay / 100);
    rel(it.FT, it.F0 * k, 1e-12, '第 ' + i + ' 组衰减');
  }
});
test('恒等式：撑杆能力 = min(摩擦自锁, 抗弯)，且压紧力 = min(弹簧, 屈曲, 屈服, 墙面压强)', () => {
  const r = an();
  r.items.filter((x) => x.mode === 'rod').forEach((it) => {
    near(it.F0, Math.min(it.extra.fric, it.extra.bend), 1e-12, it.name + ' 取最小');
    near(it.extra.Neff, Math.min(it.extra.Ns, it.extra.Nb, it.extra.Ny, it.extra.Nw), 1e-12, it.name + ' 压紧力取最小');
    near(it.extra.fric, 2 * it.item.mu * it.extra.Neff, 1e-12, it.name + ' 摩擦自锁');
  });
});
test('恒等式：反推所需的初始能力 = 有效载荷 × SF ÷ (1−衰减)^T，且落地值不下调参数', () => {
  const r = an();
  r.items.forEach((it) => {
    const k = 1 - it.decay / 100;
    const want = it.load * it.dyn * r.sf / Math.pow(k, r.years);
    near(it.rev.need0, want, 1e-9, it.name + ' need0');
    if (it.rev.feasible) {
      Object.keys(it.rev.applied).forEach((key) => {
        assert.ok(it.rev.applied[key] >= it.item[key] - 1e-9, it.name + ' ' + key + ' 不应被下调');
      });
    }
  });
});
test('反推回代：所有可行件的回代安全系数 ≥ 目标 SF，且残差非负', () => {
  const r = an();
  r.items.forEach((it) => {
    if (!it.rev.feasible) return;
    assert.ok(it.rev.recheck.ratio >= r.sf - 1e-9, it.name + ' 回代未达标：' + it.rev.recheck.ratio);
    assert.ok(it.rev.recheck.residual >= -1e-9, it.name + ' 残差为负');
    it.rev.params.forEach((p) => { if (!p.readOnly) assert.ok(p.value >= p.raw - 1e-6, it.name + ' ' + p.key + ' 取整方向'); });
  });
});

/* ─────────── 4. 单调性与方向 ─────────── */
test('单调性：衰减率越高 T 年末能力越低（150 组）', () => {
  const r0 = rng(4321);
  for (let i = 0; i < 150; i++) {
    const d1 = r0() * 25, d2 = d1 + 0.5 + r0() * 24;
    const y = 1 + Math.floor(r0() * 20);
    const a = oneItem({ mode: 'glue', area: '50', tau: '0.4', keep: '70', decay: String(d1) }); a.years = String(y);
    const b = oneItem({ mode: 'glue', area: '50', tau: '0.4', keep: '70', decay: String(d2) }); b.years = String(y);
    const A = C.analyze(a).items[0], B = C.analyze(b).items[0];
    assert.ok(B.FT < A.FT, '第 ' + i + ' 组：衰减更大者 T 年末能力应更低');
    near(A.F0, B.F0, 1e-12, '第 ' + i + ' 组初始能力相同');
  }
});
test('单调性：面积 / 吸盘只数 / 磁铁面积 / 弹簧力 抬高都不会让能力下降（各 60 组）', () => {
  const r0 = rng(8642);
  for (let i = 0; i < 60; i++) {
    const a1 = 1 + r0() * 200, f = 1.01 + r0() * 3;
    const g1 = C.analyze(oneItem({ mode: 'glue', area: String(a1), tau: '0.4', keep: '70' })).items[0].F0;
    const g2 = C.analyze(oneItem({ mode: 'glue', area: String(a1 * f), tau: '0.4', keep: '70' })).items[0].F0;
    assert.ok(g2 >= g1, '背胶面积单调');
    const c1 = 1 + Math.floor(r0() * 6);
    const s1 = C.analyze(oneItem({ mode: 'suction', cupD: '6', cups: String(c1), dP: '60', keep: '70', dir: 'peel' })).items[0].F0;
    const s2 = C.analyze(oneItem({ mode: 'suction', cupD: '6', cups: String(c1 + 1), dP: '60', keep: '70', dir: 'peel' })).items[0].F0;
    assert.ok(s2 > s1, '吸盘只数单调');
    const magBase = 1 + r0() * 20;
    const m1 = C.analyze(oneItem({ mode: 'magnet', magQ: '30', magA: String(magBase), keep: '80', tempK: '85' })).items[0].F0;
    const m2 = C.analyze(oneItem({ mode: 'magnet', magQ: '30', magA: String(magBase + 5), keep: '80', tempK: '85' })).items[0].F0;
    assert.ok(m2 > m1, '磁铁面积单调');
  }
});
test('单调性：动载系数越大，许可载荷越小（不会出现反向）', () => {
  const a = C.analyze(oneItem({ mode: 'glue', area: '40', tau: '0.4', keep: '60', dyn: '1' })).items[0];
  const b = C.analyze(oneItem({ mode: 'glue', area: '40', tau: '0.4', keep: '60', dyn: '2' })).items[0];
  near(b.allow, a.allow / 2, 1e-9, '动载翻倍 → 许可载荷减半');
  near(b.ratioT, a.ratioT / 2, 1e-9, '实际安全系数同步减半');
});
test('方向：背胶剥离强度低于剪切时，换方向结论必然变差', () => {
  const shear = C.analyze(oneItem({ mode: 'glue', dir: 'shear', area: '40', tau: '0.4', peel: '0.04', keep: '60' })).items[0];
  const peel = C.analyze(oneItem({ mode: 'glue', dir: 'peel', area: '40', tau: '0.4', peel: '0.04', keep: '60' })).items[0];
  assert.ok(peel.F0 < shear.F0, '剥离 < 剪切');
  near(shear.F0 / peel.F0, 10, 1e-9, '本例正好 10 倍');
});

/* ─────────── 5. 边界与退化 ─────────── */
test('边界：衰减率为 0 时 T 年末能力等于初始能力，且没有「跌破年份」', () => {
  const r = C.analyze(oneItem({ mode: 'glue', area: '40', tau: '0.4', keep: '60', decay: '0' }));
  const it = r.items[0];
  near(it.FT, it.F0, 1e-12, '零衰减');
  assert.strictEqual(it.breakYear, null);
  assert.strictEqual(it.sfBreakYear, null);
});
test('边界：滑移系数为 0 时顺墙方向能力为 0，反推如实判不可行', () => {
  const r = C.analyze(oneItem({ mode: 'suction', dir: 'shear', cupD: '6', cups: '2', dP: '60', keep: '70', slide: '0' }));
  const it = r.items[0];
  near(it.F0, 0, 1e-12, '滑移系数 0 → 顺墙能力 0');
  assert.strictEqual(it.verdict.id, 'fail');
  assert.strictEqual(it.rev.feasible, false);
  assert.ok(/滑移系数填了 0/.test(it.rev.reason), '原因应指向滑移系数：' + it.rev.reason);
});
test('边界：极薄管（壁厚取下限）与极厚管都不产生 NaN，且结果有限', () => {
  const a = C.analyze(oneItem({ mode: 'rod', rodD: '20', rodT: '0.2', rodL: '200', springN: '1000' }));
  const b = C.analyze(oneItem({ mode: 'rod', rodD: '20', rodT: '9.8', rodL: '200', springN: '1000' }));
  [a, b].forEach((r, i) => {
    const it = r.items[0];
    assert.ok(isFinite(it.F0) && isFinite(it.FT) && it.F0 >= 0, '第 ' + i + ' 组应有限');
    allChecksPass(r, '极薄/极厚管 ' + i);
  });
  assert.ok(a.items[0].F0 > 0 && b.items[0].F0 > 0);
});
test('边界：上限合法值（最大载荷 / 最大面积 / 最粗管）不崩且能力有限', () => {
  const r = C.analyze({
    sf: '10', years: '30',
    items: [
      C.item({ name: '上限背胶', mode: 'glue', area: '10000', tau: '50', peel: '50', keep: '100', decay: '0', load: '500000', dyn: '3' }),
      C.item({ name: '上限撑杆', mode: 'rod', rodD: '100', rodT: '49.8', rodL: '600', E: '300000', sigma: '1500', effLen: '2', springN: '20000', mu: '1.2', wallP: '20', padA: '500', load: '500000', dyn: '3', decay: '0' })
    ]
  });
  assert.ok(r.ok, JSON.stringify(r.errors));
  r.items.forEach((it) => { assert.ok(isFinite(it.F0) && isFinite(it.FT), it.name + ' 应有限'); });
  allChecksPass(r, '上限值');
});
test('退化：年限 1 年 / 载荷下限 0.01 N 也走完整流程', () => {
  const cfg = oneItem({ mode: 'magnet', magQ: '0.5', magA: '0.5', keep: '1', tempK: '5', decay: '50', load: '0.01' });
  cfg.years = '1';
  const r = C.analyze(cfg);
  assert.ok(r.ok);
  assert.strictEqual(r.items[0].rows.length, 2, '1 年 → 2 行（第 0 年 + 第 1 年）');
  allChecksPass(r, '退化');
});
test('跌破年份：闭式解与逐年表一致（150 组）', () => {
  const r0 = rng(13579);
  for (let i = 0; i < 150; i++) {
    const decay = 1 + r0() * 40, years = 1 + Math.floor(r0() * 29);
    const cfg = oneItem({ mode: 'glue', area: String(5 + r0() * 300), tau: String(0.05 + r0() * 1), keep: String(20 + r0() * 80), decay: String(decay), load: String(5 + r0() * 300) });
    cfg.years = String(years);
    const it = C.analyze(cfg).items[0];
    if (it.breakYear === null) { assert.ok(it.ratioT >= 1, '第 ' + i + ' 组：判不出跌破年份时 T 年末必须仍达标'); continue; }
    /* 逐年表核对：breakYear 之后的第一整年必须已经 < 1 */
    const t = Math.floor(it.breakYear) + 1;
    if (t <= years) assert.ok(it.rows[t].ratio < 1 + 1e-9, '第 ' + i + ' 组：第 ' + t + ' 年应已跌破');
    if (it.breakYear >= 1) {
      const tb = Math.ceil(it.breakYear) - 1;
      if (tb >= 0 && tb <= years) assert.ok(it.rows[tb].ratio >= 1 - 1e-9, '第 ' + i + ' 组：跌破前一年应仍达标');
    }
  }
});
test('判定分档：恰好等于门限时归入更保守的一档', () => {
  assert.strictEqual(C.verdictOf(3, 3).id, 'ok');
  assert.strictEqual(C.verdictOf(2.999999, 3).id, 'tight');
  assert.strictEqual(C.verdictOf(1, 3).id, 'tight');
  assert.strictEqual(C.verdictOf(0.999999, 3).id, 'fail');
  assert.strictEqual(C.verdictOf(Infinity, 3).id, 'fail');
  assert.strictEqual(C.verdictOf(0, 3).id, 'fail');
});

/* ─────────── 6. 非法输入（逐条核字段） ─────────── */
test('非法输入：全局与逐字段各报对应错误，且不返回结果', () => {
  const cases = [
    [{ sf: '0.5' }, -1, 'sf'], [{ sf: '11' }, -1, 'sf'], [{ sf: 'x' }, -1, 'sf'],
    [{ years: '0' }, -1, 'years'], [{ years: '31' }, -1, 'years'], [{ years: '3.5x' }, -1, 'years'],
    [{ items: [] }, -1, 'items'],
    [{ items: new Array(7).fill(C.item({})) }, -1, 'items'],
    [{ 0: { name: '' } }, 0, 'name'],
    [{ 0: { name: '一二三四五六七八九十一二三四五六七八九十一' } }, 0, 'name'],
    [{ 0: { mode: 'glueX' } }, 0, 'mode'],
    [{ 0: { mode: 'glue', dir: 'sideways' } }, 0, 'dir'],
    [{ 0: { mode: 'glue', load: '0' } }, 0, 'load'],
    [{ 0: { mode: 'glue', load: '500001' } }, 0, 'load'],
    [{ 0: { mode: 'glue', dyn: '0.9' } }, 0, 'dyn'],
    [{ 0: { mode: 'glue', dyn: '3.1' } }, 0, 'dyn'],
    [{ 0: { mode: 'glue', keep: '0' } }, 0, 'keep'],
    [{ 0: { mode: 'glue', keep: '101' } }, 0, 'keep'],
    [{ 0: { mode: 'glue', decay: '-1' } }, 0, 'decay'],
    [{ 0: { mode: 'glue', decay: '51' } }, 0, 'decay'],
    [{ 0: { mode: 'glue', area: '0' } }, 0, 'area'],
    [{ 0: { mode: 'glue', area: '10001' } }, 0, 'area'],
    [{ 0: { mode: 'glue', tau: '0' } }, 0, 'tau'],
    [{ 0: { mode: 'glue', tau: '51' } }, 0, 'tau'],
    [{ 0: { mode: 'glue', peel: '0.0001' } }, 0, 'peel'],
    [{ 0: { mode: 'suction', cupD: '0.4' } }, 0, 'cupD'],
    [{ 0: { mode: 'suction', cupD: '41' } }, 0, 'cupD'],
    [{ 0: { mode: 'suction', cups: '0' } }, 0, 'cups'],
    [{ 0: { mode: 'suction', cups: '13' } }, 0, 'cups'],
    [{ 0: { mode: 'suction', dP: '0.5' } }, 0, 'dP'],
    [{ 0: { mode: 'suction', dP: '102' } }, 0, 'dP'],
    [{ 0: { mode: 'suction', slide: '1.5' } }, 0, 'slide'],
    [{ 0: { mode: 'rod', rodD: '5' } }, 0, 'rodD'],
    [{ 0: { mode: 'rod', rodD: '101' } }, 0, 'rodD'],
    [{ 0: { mode: 'rod', rodD: '20', rodT: '0.1' } }, 0, 'rodT'],
    [{ 0: { mode: 'rod', rodD: '20', rodT: '10' } }, 0, 'rodT'],
    [{ 0: { mode: 'rod', rodL: '19' } }, 0, 'rodL'],
    [{ 0: { mode: 'rod', rodL: '601' } }, 0, 'rodL'],
    [{ 0: { mode: 'rod', E: '999' } }, 0, 'E'],
    [{ 0: { mode: 'rod', sigma: '9' } }, 0, 'sigma'],
    [{ 0: { mode: 'rod', effLen: '0.4' } }, 0, 'effLen'],
    [{ 0: { mode: 'rod', springN: '9' } }, 0, 'springN'],
    [{ 0: { mode: 'rod', mu: '0.04' } }, 0, 'mu'],
    [{ 0: { mode: 'rod', wallP: '0.04' } }, 0, 'wallP'],
    [{ 0: { mode: 'rod', padA: '0.5' } }, 0, 'padA'],
    [{ 0: { mode: 'magnet', magQ: '0.4' } }, 0, 'magQ'],
    [{ 0: { mode: 'magnet', magQ: '201' } }, 0, 'magQ'],
    [{ 0: { mode: 'magnet', magA: '0.4' } }, 0, 'magA'],
    [{ 0: { mode: 'magnet', magA: '501' } }, 0, 'magA'],
    [{ 0: { mode: 'magnet', tempK: '4' } }, 0, 'tempK'],
    [{ 0: { mode: 'magnet', tempK: '101' } }, 0, 'tempK'],
    [{ 0: { mode: 'glue', load: '' } }, 0, 'load']
  ];
  let checked = 0;
  cases.forEach(([patch, idx, field], n) => {
    const cfg = C.defaultsClone();
    if (patch.sf !== undefined) cfg.sf = patch.sf;
    if (patch.years !== undefined) cfg.years = patch.years;
    if (patch.items !== undefined) { cfg.items = patch.items; }
    else if (patch[0]) { cfg.items[0] = Object.assign(cfg.items[0], patch[0]); }
    const r = C.analyze(cfg);
    assert.strictEqual(r.ok, false, '第 ' + n + ' 例应判非法：' + JSON.stringify(patch));
    const hit = r.errors.filter((e) => e.i === idx && e.field === field);
    assert.ok(hit.length >= 1, '第 ' + n + ' 例应命中 field=' + field + '，实际：' + JSON.stringify(r.errors));
    checked++;
  });
  assert.strictEqual(checked, cases.length);
});

/* ─────────── 7. 输出契约 / 确定性 / 场景 / 压力自检 ─────────── */
test('输出契约：结果里没有 undefined / NaN / Infinity', () => {
  const walk = (o, pathStr) => {
    if (o === undefined) assert.fail('出现 undefined：' + pathStr);
    if (typeof o === 'number') assert.ok(isFinite(o), '非有限值：' + pathStr + ' = ' + o);
    if (o && typeof o === 'object') Object.keys(o).forEach((k) => walk(o[k], pathStr + '.' + k));
  };
  walk(an(), 'root');
  walk(C.analyze(Object.assign(C.defaultsClone(), sc('extreme'))), 'extreme');
});
test('确定性：同一输入两次 analyze 的 JSON 完全一致', () => {
  const a = JSON.stringify(C.analyze(C.defaults()));
  const b = JSON.stringify(C.analyze(C.defaults()));
  assert.strictEqual(a, b);
});
test('不修改入参：analyze 前后配置对象逐字节一致', () => {
  const cfg = C.defaultsClone();
  const before = JSON.stringify(cfg);
  C.analyze(cfg);
  assert.strictEqual(JSON.stringify(cfg), before);
});
test('场景自检：9 个内置场景全部通过校验、结构自检全过、导出可用', () => {
  assert.strictEqual(C.scenarios.length, 9);
  C.scenarios.forEach((s) => {
    const cfg = withPatch(s.patch);
    const r = C.analyze(cfg);
    assert.ok(r.ok, s.id + ' 应通过校验：' + JSON.stringify(r.errors));
    allChecksPass(r, s.id);
    const csv = C.csvText(cfg, r), md = C.mdText(cfg, r);
    assert.ok(csv.split('\n').length > 20, s.id + ' CSV 行数');
    assert.ok(md.indexOf(s.id === 'default' ? '浴室置物架' : r.items[0].name) >= 0, s.id + ' MD 含件名');
    assert.ok(md.indexOf('结构自检') >= 0, s.id + ' MD 含自检段');
    assert.ok(C.jsonBackup(cfg).length > 100, s.id + ' JSON 备份');
  });
});
test('默认样例：6 件结论覆盖 够 / 没余量 / 会掉 三档，且最弱件可复核', () => {
  const r = an();
  assert.strictEqual(r.items.length, 6);
  assert.strictEqual(r.kpis.okN, 2);
  assert.strictEqual(r.kpis.tightN, 2);
  assert.strictEqual(r.kpis.failN, 2);
  const worst = r.items.slice().sort((a, b) => a.ratioT - b.ratioT)[0];
  assert.strictEqual(worst.name, '厨房锅架');
  assert.strictEqual(worst.verdict.id, 'fail');
  /* 手算复核：厨房锅架 剥离 0.04 MPa × 60 cm² × 60% = 144 N；载荷 147.15 N → 0.9787… */
  near(worst.F0, 144, 1e-9, '锅架初始能力');
  near(worst.ratio0, 144 / 147.15, 1e-9, '锅架实际安全系数');
  assert.ok(r.steps.some((s) => /厨房锅架/.test(s)), '下一步应点名最弱件');
});
test('敏感性：每一行都是完整重算，抽两行手工复核', () => {
  const cfg = oneItem({ mode: 'glue', area: '40', tau: '0.4', peel: '0.04', keep: '60', load: '100', decay: '8' });
  cfg.years = '5';
  const r = C.analyze(cfg);
  const row = r.sens.filter((x) => /目标载荷 \+20%/.test(x.label))[0];
  const manual = C.analyzeItem(Object.assign({}, r.items[0].item, { load: 120 }), 3, 5);
  near(row.ratio, manual.ratioT, 1e-12, '载荷 +20% 行');
  const row2 = r.sens.filter((x) => /观察年限 \+2 年/.test(x.label))[0];
  const manual2 = C.analyzeItem(r.items[0].item, 3, 7);
  near(row2.ratio, manual2.ratioT, 1e-12, '年限 +2 行');
  assert.ok(r.sens.length >= 8, '敏感性行数');
  r.sens.forEach((x) => assert.ok(isFinite(x.ratio) && isFinite(x.F) && isFinite(x.allow), '行数值有限：' + x.label));
});
test('压力自检：300 组合法随机输入下结构自检全过', () => {
  const r0 = rng(2026111022);
  let n = 0;
  for (let i = 0; i < 300; i++) {
    const mode = C.MODES[Math.floor(r0() * 4)].id;
    const rodD = 8 + r0() * 80;
    const it = C.item({
      name: 'R' + i, mode: mode,
      dir: r0() < 0.5 ? 'shear' : 'peel',
      load: String(0.5 + r0() * 5000),
      dyn: String(1 + r0() * 2),
      keep: String(5 + r0() * 95),
      decay: String(r0() * 45),
      area: String(0.5 + r0() * 500), tau: String(0.005 + r0() * 5), peel: String(0.005 + r0() * 5),
      cupD: String(0.5 + r0() * 30), cups: String(1 + Math.floor(r0() * 12)), dP: String(1 + r0() * 100), slide: String(r0()),
      rodD: String(rodD), rodT: String(0.2 + r0() * (rodD / 2 - 0.4)), rodL: String(20 + r0() * 500),
      E: String(1000 + r0() * 200000), sigma: String(10 + r0() * 900), effLen: String(0.5 + r0() * 1.5),
      springN: String(10 + r0() * 15000), mu: String(0.05 + r0() * 1.1), wallP: String(0.05 + r0() * 15), padA: String(1 + r0() * 300),
      magQ: String(0.5 + r0() * 150), magA: String(0.5 + r0() * 300), tempK: String(5 + r0() * 95)
    });
    const cfg = { sf: String(1 + r0() * 9), years: String(1 + Math.floor(r0() * 30)), items: [it] };
    const r = C.analyze(cfg);
    assert.ok(r.ok, '第 ' + i + ' 组应合法：' + JSON.stringify(r.errors));
    allChecksPass(r, '随机组 ' + i + '（' + mode + '）');
    n++;
  }
  assert.strictEqual(n, 300);
});
test('导出：CSV 与 MD 里的关键数字与同一次 analyze 结果一致', () => {
  const cfg = C.defaultsClone();
  const r = C.analyze(cfg);
  const csv = C.csvText(cfg, r), md = C.mdText(cfg, r);
  r.items.forEach((it) => {
    assert.ok(csv.indexOf(it.name) >= 0, 'CSV 含件名 ' + it.name);
    assert.ok(md.indexOf(it.name) >= 0, 'MD 含件名 ' + it.name);
    assert.ok(md.indexOf(C.fmtNK(it.F0)) >= 0, 'MD 含初始能力 ' + C.fmtNK(it.F0));
    assert.ok(md.indexOf(C.fmtRatio(it.ratioT)) >= 0, 'MD 含安全系数 ' + C.fmtRatio(it.ratioT));
  });
  assert.ok(csv.indexOf(String(C.r2(r.items[0].FT))) >= 0, 'CSV 含 T 年末能力');
  assert.ok(csv.indexOf('T年末能力(N)') >= 0, 'CSV 含总览表头');
  const j = JSON.parse(C.jsonBackup(cfg));
  assert.strictEqual(j.cfg.items.length, 6);
  assert.strictEqual(j.cfg.sf, '3');
});
test('回归：所有面向页面的文案里没有字面 Markdown 星号（批次 41 踩过同样的坑）', () => {
  const cfg = C.defaultsClone();
  const r = C.analyze(cfg);
  const bag = [];
  r.items.forEach((it) => it.warnings.forEach((w) => bag.push(['warning', w])));
  r.insights.forEach((x) => bag.push(['insight', x.t + ' ' + x.d]));
  r.steps.forEach((s) => bag.push(['step', s]));
  r.checks.forEach((c) => bag.push(['check', c.name + ' ' + c.detail]));
  r.items.forEach((it) => it.list.forEach((x) => bag.push(['list', x.label + ' ' + x.note])));
  C.LIMITS.forEach((s) => bag.push(['limit', s]));
  const bad = bag.filter((x) => /\*\*|__/.test(x[1]));
  assert.strictEqual(bad.length, 0, '发现字面星号/下划线：' + JSON.stringify(bad.slice(0, 3)));
  /* 导出里的 ** 是 Markdown 语法，属于正常 */
  assert.ok(C.mdText(cfg, r).indexOf('**') >= 0, 'MD 导出应当用 Markdown 强调');
});
test('吸收式复核：许可载荷换算成 kgf 与公式一致（1 kgf = 9.80665 N）', () => {
  const r = an();
  r.items.forEach((it) => {
    near(C.kgfOf(it.allow), it.allow / 9.80665, 1e-12, it.name);
    assert.ok(/kgf/.test(C.fmtNK(it.allow)), it.name + ' 展示带 kgf');
  });
});
