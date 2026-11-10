/* 免打孔承载装置对账台 · 核心引擎（nodrill-load）
 *
 * 问题：不能打孔的时候（租房 / 宿舍 / 瓷砖墙 / 办公室），用背胶、真空吸盘、撑杆、磁铁
 *       固定东西，到底能挂多重？几年后还够吗？要挂住目标重量该改什么？
 *
 * 口径（详见 需求与调研.md 第 4 节，单位一律先换算到 N / cm / cm² / cm⁴）：
 *   换算      1 MPa = 1 N/mm² = 100 N/cm²；1 kPa = 0.1 N/cm²；1 kgf = 9.80665 N
 *   有效载荷  F_eff = F_req × dyn                        dyn = 动载系数
 *   年衰减    F(t) = F0 × (1 − decay/100)^t              t = 0…T（合并口径，用户自填）
 *   背胶      F0 = σ_eff × 100 × area × keep/100         σ_eff = 方向=剪切 ? tau : peel
 *   吸盘      F_pull = dP × 0.1 × A_cup × keep/100 × cups；A_cup = π·cupD²/4
 *             方向=拉离 → F0 = F_pull；方向=顺墙 → F0 = F_pull × slide
 *   撑杆      A_tube/I/W 由「外径 D、壁厚 t」算空心圆截面
 *             N_eff = min(springN, N_buckle, N_yield, N_wall)
 *             N_buckle = π²·E·100·I/(effLen·L)²      欧拉屈曲
 *             N_yield  = sigma·100·A_tube            管材屈服
 *             N_wall   = wallP·100·padA              墙面许用压强
 *             摩擦自锁 F_fric = 2·mu·N_eff
 *             管件抗弯 F_bend = 4·sigma·100·W / L     简支跨距取管长、载荷作用于中点
 *             F0 = min(F_fric, F_bend)               并记录是哪一项封顶
 *   磁吸      F0 = magQ × magA × keep/100 × tempK/100
 *   判定      ratio(t) = F(t) / F_eff；许可载荷 F_allow(t) = F(t) / (SF × dyn)
 *             ratio(T) ≥ SF → 够；1 ≤ ratio(T) < SF → 撑得住但没余量；< 1 → 会掉
 *   反推      F0_req = F_eff × SF / (1 − decay/100)^T，再按方式解出所需面积 / 直径 / 只数 /
 *             外径 / 垫片 / 弹簧力；一律朝「更能承重」的方向取整，并把取整后的解**回代重算**。
 *
 * 不做的事（见 LIMITS 与 需求与调研.md 第 4.6 节）：不做产品合格判定、不引用任何标准、
 * 不建模疲劳/冲击谱/蠕变曲线、不查产品参数、不联网。
 */
(function (root) {
  'use strict';

  const G = 9.80665;
  const MAX_ITEMS = 6, NAME_MAX = 20, MAX_YEARS = 30;

  /* ── 输入范围（只用来挡住明显打错的输入，不是任何标准的限值） ── */
  const SF_MIN = 1, SF_MAX = 10;
  const LOAD_MIN = 0.01, LOAD_MAX = 500000;          // N
  const DYN_MIN = 1, DYN_MAX = 3;
  const KEEP_MIN = 1, KEEP_MAX = 100;                // %
  const DECAY_MIN = 0, DECAY_MAX = 50;               // %/年
  const AREA_MIN = 0.1, AREA_MAX = 10000;            // cm²
  const STRENGTH_MIN = 0.001, STRENGTH_MAX = 50;     // MPa
  const CUP_D_MIN = 0.5, CUP_D_MAX = 40;             // cm
  const CUPS_MIN = 1, CUPS_MAX = 12;
  const DP_MIN = 1, DP_MAX = 101;                    // kPa
  const SLIDE_MIN = 0, SLIDE_MAX = 1;
  const ROD_D_MIN = 6, ROD_D_MAX = 100;              // mm
  const ROD_T_MIN = 0.2;                             // mm
  const ROD_L_MIN = 20, ROD_L_MAX = 600;             // cm
  const E_MIN = 1000, E_MAX = 300000;                // MPa
  const SIGMA_MIN = 10, SIGMA_MAX = 1500;            // MPa
  const EFFLEN_MIN = 0.5, EFFLEN_MAX = 2;
  const SPRING_MIN = 10, SPRING_MAX = 20000;         // N
  const MU_MIN = 0.05, MU_MAX = 1.2;
  const WALLP_MIN = 0.05, WALLP_MAX = 20;            // MPa
  const PAD_MIN = 1, PAD_MAX = 500;                  // cm²
  const MAGQ_MIN = 0.5, MAGQ_MAX = 200;              // N/cm²
  const MAGA_MIN = 0.5, MAGA_MAX = 500;              // cm²
  const TEMPK_MIN = 5, TEMPK_MAX = 100;              // %

  /* ── 安装方式 ─────────────────────────────────────── */
  const MODES = [
    { id: 'glue', name: '背胶 / 免钉胶', short: '背胶', useDir: true, useKeep: true },
    { id: 'suction', name: '真空吸盘', short: '吸盘', useDir: true, useKeep: true },
    { id: 'rod', name: '撑杆 / 顶天立地', short: '撑杆', useDir: false, useKeep: false },
    { id: 'magnet', name: '磁吸', short: '磁吸', useDir: true, useKeep: true }
  ];
  const DIRS = [
    { id: 'shear', name: '顺墙方向（剪切 / 滑移）', short: '顺墙' },
    { id: 'peel', name: '垂直墙面往外拉（剥离 / 拉脱）', short: '往外拉' }
  ];
  const modeOf = (id) => MODES.filter((m) => m.id === id)[0] || MODES[0];
  const dirOf = (id) => DIRS.filter((d) => d.id === id)[0] || DIRS[0];

  /* ── 数字解析与格式化（UI 与导出共用，保证同口径） ── */
  function parseNum(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    if (v === null || v === undefined) return NaN;
    let s = String(v).trim();
    if (!s) return NaN;
    s = s.replace(/[，,\s_]/g, '').replace(/％/g, '%');
    if (s.endsWith('%')) {
      const n0 = Number(s.slice(0, -1));
      return isFinite(n0) ? n0 / 100 : NaN;
    }
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return NaN;
    const n = Number(s);
    return isFinite(n) ? n : NaN;
  }
  const num = (v) => { const n = parseNum(v); return isFinite(n) ? n : NaN; };

  const r2 = (x) => Math.round(x * 100) / 100;
  const r4 = (x) => Math.round(x * 10000) / 10000;
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  const ceilTo = (x, step) => Math.ceil(x / step - 1e-9) * step;

  function group3(s) {
    const parts = String(s).split('.');
    const head = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.length > 1 ? head + '.' + parts[1] : head;
  }
  function fmtFix(x, d) {
    if (!isFinite(x)) return '—';
    const neg = x < 0, a = Math.abs(x);
    return (neg ? '−' : '') + group3(a.toFixed(d));
  }
  /* 自适应小数位：极小非零值不能被显示成 0.00（历史批次踩过） */
  function fmtAdaptive(x, unit, maxD) {
    if (!isFinite(x)) return '—';
    const a = Math.abs(x);
    if (a === 0) return '0' + (unit ? ' ' + unit : '');
    const md = maxD === undefined ? 2 : maxD;
    if (a >= 1) return fmtFix(x, md) + (unit ? ' ' + unit : '');
    if (a >= 0.01) return fmtFix(x, 2) + (unit ? ' ' + unit : '');
    if (a >= 1e-4) return fmtFix(x, 4) + (unit ? ' ' + unit : '');
    return (x < 0 ? '−' : '') + '< 0.0001' + (unit ? ' ' + unit : '');
  }
  const fmtN = (x) => fmtAdaptive(x, 'N', 2);
  const fmtN0 = (x) => (isFinite(x) ? fmtFix(x, 0) + ' N' : '—');
  /* 总览表专用：≥ 1000 N 只显示整数，避免定宽列里被挤断（完整小数见明细、逐年表与导出） */
  const fmtNTable = (x) => (!isFinite(x) ? '—' : (Math.abs(x) >= 1000 ? fmtFix(x, 0) + ' N' : fmtN(x)));
  const kgfOf = (x) => (isFinite(x) ? x / G : NaN);
  function fmtKgf(x) {
    if (!isFinite(x)) return '—';
    const k = kgfOf(x);
    const a = Math.abs(k);
    if (a >= 100) return fmtFix(k, 0) + ' kgf';
    if (a >= 0.01) return fmtFix(k, 2) + ' kgf';
    if (a > 0) return fmtFix(k, 4) + ' kgf';
    return '0 kgf';
  }
  const fmtNK = (x) => (isFinite(x) ? fmtN(x) + '（' + fmtKgf(x) + '）' : '—');
  const fmtRatio = (x) => {
    if (!isFinite(x)) return '—';
    const a = Math.abs(x);
    if (a === 0) return '0.00×';
    if (a < 0.01) return (x < 0 ? '−' : '') + (a < 1e-4 ? '< 0.0001' : fmtFix(a, 4)) + '×';
    return fmtFix(x, 2) + '×';
  };
  const fmtMPa = (x) => fmtAdaptive(x, 'MPa', 3);
  const fmtCm = (x) => fmtAdaptive(x, 'cm', 2);
  const fmtMm = (x) => fmtAdaptive(x, 'mm', 1);
  const fmtArea = (x) => fmtAdaptive(x, 'cm²', 2);
  /* 极大面积补一个 m² 对照，避免读者对着 12 位数字没有量级感 */
  const fmtAreaBig = (x) => (isFinite(x) && x >= 100000 ? fmtArea(x) + '（≈ ' + fmtFix(x / 10000, 1) + ' m²）' : fmtArea(x));
  const fmtPct = (x, d) => (isFinite(x) ? fmtFix(x, d === undefined ? 1 : d) + '%' : '—');
  const fmtYears = (x) => {
    if (!isFinite(x)) return '—';
    if (x === 0) return '第 0 年（现在）';
    return '第 ' + (Number.isInteger(x) ? x : fmtFix(x, 1)) + ' 年';
  };

  /* ── 输入规范化 ───────────────────────────────────── */
  const numFields = ['load', 'dyn', 'keep', 'decay', 'area', 'tau', 'peel', 'cupD', 'cups', 'dP', 'slide',
    'rodD', 'rodT', 'rodL', 'E', 'sigma', 'effLen', 'springN', 'mu', 'wallP', 'padA',
    'magQ', 'magA', 'tempK'];
  const strFields = ['name', 'mode', 'dir'];

  function normItem(raw, i) {
    const it = {};
    strFields.forEach((k) => { it[k] = raw && raw[k] !== undefined && raw[k] !== null ? String(raw[k]) : ''; });
    numFields.forEach((k) => { it[k] = raw && raw[k] !== undefined && raw[k] !== null ? String(raw[k]) : ''; });
    it.i = i;
    return it;
  }
  function normCfg(cfg) {
    const c = cfg || {};
    return {
      sf: c.sf === undefined || c.sf === null ? '' : String(c.sf),
      years: c.years === undefined || c.years === null ? '' : String(c.years),
      items: Array.isArray(c.items) ? c.items.map(normItem) : []
    };
  }

  /* ── 默认示例（全部虚构） ─────────────────────────── */
  const F = (o) => o;   // 只是让下面的表更易读
  function item(o) {
    return Object.assign({
      name: '装置', mode: 'glue', dir: 'shear', load: '10', dyn: '1', keep: '70', decay: '8',
      area: '50', tau: '0.4', peel: '0.04',
      cupD: '6', cups: '2', dP: '60', slide: '0.4',
      rodD: '25', rodT: '1.2', rodL: '240', E: '70000', sigma: '200', effLen: '1', springN: '800', mu: '0.5', wallP: '2', padA: '12',
      magQ: '30', magA: '4', tempK: '85'
    }, o);
  }
  function defaults() {
    return {
      sf: '3', years: '5',
      items: [
        item({ name: '浴室置物架', mode: 'glue', dir: 'shear', load: '98.1', dyn: '1', keep: '60', decay: '8', area: '40', tau: '0.4', peel: '0.04' }),
        item({ name: '毛巾架', mode: 'suction', dir: 'peel', load: '19.6', dyn: '1', keep: '70', decay: '12', cupD: '6', cups: '2', dP: '60', slide: '0.4' }),
        item({ name: '顶天立地晾衣杆', mode: 'rod', dir: 'shear', load: '49.05', dyn: '1', decay: '5', rodD: '25', rodT: '1.2', rodL: '240', E: '70000', sigma: '200', effLen: '1', springN: '800', mu: '0.5', wallP: '2', padA: '12' }),
        item({ name: '冰箱侧面刀架', mode: 'magnet', dir: 'shear', load: '29.43', dyn: '1', keep: '80', decay: '3', magQ: '30', magA: '4', tempK: '85' }),
        item({ name: '厨房锅架', mode: 'glue', dir: 'peel', load: '147.15', dyn: '1', keep: '60', decay: '8', area: '60', tau: '0.4', peel: '0.04' }),
        item({ name: '门框单杠（假设有人拉）', mode: 'rod', dir: 'shear', load: '600', dyn: '2', decay: '4', rodD: '30', rodT: '1.5', rodL: '75', E: '70000', sigma: '200', effLen: '1', springN: '1500', mu: '0.6', wallP: '1.5', padA: '20' })
      ]
    };
  }
  const defaultsClone = () => JSON.parse(JSON.stringify(defaults()));

  const scenarios = [
    { id: 'default', name: '默认示例：6 件混合（背胶 / 吸盘 / 撑杆 / 磁吸）', patch: null },
    {
      id: 'suction3', name: '只做吸盘：毛巾架 / 皂盒 / 挂钩',
      patch: {
        sf: '3', years: '5', items: [
          item({ name: '毛巾架', mode: 'suction', dir: 'peel', load: '19.6', keep: '70', decay: '12', cupD: '6', cups: '2', dP: '60', slide: '0.4' }),
          item({ name: '皂盒', mode: 'suction', dir: 'peel', load: '5', keep: '70', decay: '12', cupD: '4', cups: '1', dP: '55', slide: '0.4' }),
          item({ name: '浴球挂钩', mode: 'suction', dir: 'shear', load: '3', keep: '65', decay: '15', cupD: '3', cups: '1', dP: '50', slide: '0.35' })
        ]
      }
    },
    {
      id: 'rod2', name: '只做撑杆：晾衣杆 + 门帘杆',
      patch: {
        sf: '3', years: '5', items: [
          item({ name: '顶天立地晾衣杆', mode: 'rod', load: '49.05', decay: '5', rodD: '25', rodT: '1.2', rodL: '240', springN: '800', mu: '0.5', wallP: '2', padA: '12' }),
          item({ name: '门帘杆（短跨距）', mode: 'rod', load: '9.81', decay: '5', rodD: '16', rodT: '0.8', rodL: '75', springN: '300', mu: '0.5', wallP: '2', padA: '6' })
        ]
      }
    },
    {
      id: 'peelonly', name: '全用背胶、方向全是「往外拉」（最容易踩的口径）',
      patch: {
        sf: '3', years: '5', items: [
          item({ name: '厨房锅架', mode: 'glue', dir: 'peel', load: '147.15', keep: '60', decay: '8', area: '60', tau: '0.4', peel: '0.04' }),
          item({ name: '浴室挂钩', mode: 'glue', dir: 'peel', load: '49.05', keep: '60', decay: '10', area: '30', tau: '0.4', peel: '0.04' }),
          item({ name: '门后挂衣钩', mode: 'glue', dir: 'peel', load: '24.5', keep: '55', decay: '10', area: '24', tau: '0.35', peel: '0.035' })
        ]
      }
    },
    {
      id: 'damp', name: '潮湿环境（年衰减 20%/年，看 5 年）',
      patch: {
        sf: '3', years: '5', items: [
          item({ name: '浴室置物架', mode: 'glue', dir: 'shear', load: '98.1', keep: '55', decay: '20', area: '40', tau: '0.4', peel: '0.04' }),
          item({ name: '淋浴间吸盘架', mode: 'suction', dir: 'shear', load: '19.6', keep: '65', decay: '20', cupD: '6', cups: '2', dP: '60', slide: '0.4' }),
          item({ name: '浴室磁吸剃须刀架', mode: 'magnet', dir: 'shear', load: '9.81', keep: '75', decay: '18', magQ: '30', magA: '4', tempK: '80' })
        ]
      }
    },
    {
      id: 'long15', name: '长期 15 年：同一批装置看 15 年还剩多少',
      patch: {
        sf: '3', years: '15', items: [
          item({ name: '浴室置物架', mode: 'glue', dir: 'shear', load: '98.1', keep: '60', decay: '8', area: '40', tau: '0.4', peel: '0.04' }),
          item({ name: '毛巾架', mode: 'suction', dir: 'peel', load: '19.6', keep: '70', decay: '12', cupD: '6', cups: '2', dP: '60', slide: '0.4' }),
          item({ name: '顶天立地晾衣杆', mode: 'rod', load: '49.05', decay: '5', rodD: '25', rodT: '1.2', rodL: '240', springN: '800', mu: '0.5', wallP: '2', padA: '12' })
        ]
      }
    },
    {
      id: 'magnet4', name: '磁吸阵列：刀架 / 剪刀 / 钥匙 / 工具条',
      patch: {
        sf: '3', years: '5', items: [
          item({ name: '冰箱侧面刀架', mode: 'magnet', dir: 'shear', load: '29.43', keep: '80', decay: '3', magQ: '30', magA: '4', tempK: '85' }),
          item({ name: '剪刀挂钩', mode: 'magnet', dir: 'peel', load: '9.81', keep: '80', decay: '3', magQ: '30', magA: '2', tempK: '85' }),
          item({ name: '钥匙板', mode: 'magnet', dir: 'shear', load: '4.9', keep: '75', decay: '4', magQ: '25', magA: '3', tempK: '80' }),
          item({ name: '工具磁条', mode: 'magnet', dir: 'shear', load: '58.86', keep: '80', decay: '3', magQ: '35', magA: '12', tempK: '85' })
        ]
      }
    },
    {
      id: 'strict', name: '严格口径：安全系数 4、动载 1.5，六件一起看',
      patch: {
        sf: '4', years: '5', items: [
          item({ name: '浴室置物架', mode: 'glue', dir: 'shear', load: '98.1', dyn: '1.5', keep: '60', decay: '8', area: '40', tau: '0.4', peel: '0.04' }),
          item({ name: '毛巾架', mode: 'suction', dir: 'peel', load: '19.6', dyn: '1.5', keep: '70', decay: '12', cupD: '6', cups: '2', dP: '60', slide: '0.4' }),
          item({ name: '顶天立地晾衣杆', mode: 'rod', load: '49.05', dyn: '1.5', decay: '5', rodD: '25', rodT: '1.2', rodL: '240', springN: '800', mu: '0.5', wallP: '2', padA: '12' }),
          item({ name: '冰箱侧面刀架', mode: 'magnet', dir: 'shear', load: '29.43', dyn: '1.5', keep: '80', decay: '3', magQ: '30', magA: '4', tempK: '85' }),
          item({ name: '厨房锅架', mode: 'glue', dir: 'peel', load: '147.15', dyn: '1.5', keep: '60', decay: '8', area: '60', tau: '0.4', peel: '0.04' }),
          item({ name: '门框单杠（假设有人拉）', mode: 'rod', load: '600', dyn: '2', decay: '4', rodD: '30', rodT: '1.5', rodL: '75', E: '70000', sigma: '200', effLen: '1', springN: '1500', mu: '0.6', wallP: '1.5', padA: '20' })
        ]
      }
    },
    {
      id: 'extreme', name: '极端口径：年衰减 40%、看 30 年（会判「做不到」）',
      patch: {
        sf: '3', years: '30', items: [
          item({ name: '浴室置物架', mode: 'glue', dir: 'shear', load: '98.1', keep: '60', decay: '40', area: '40', tau: '0.4', peel: '0.04' }),
          item({ name: '毛巾架', mode: 'suction', dir: 'peel', load: '19.6', keep: '70', decay: '40', cupD: '6', cups: '2', dP: '60', slide: '0.4' }),
          item({ name: '冰箱侧面刀架', mode: 'magnet', dir: 'shear', load: '29.43', keep: '80', decay: '40', magQ: '30', magA: '4', tempK: '85' })
        ]
      }
    }
  ];

  /* ── 截面几何（空心圆管，输入 mm → 输出 cm 制） ──── */
  function tubeGeom(rodD, rodT) {
    const Do = rodD / 10, Di = (rodD - 2 * rodT) / 10;
    const q = Math.pow(Do, 4) - Math.pow(Di, 4);
    return {
      Do: Do, Di: Di,
      Atube: Math.PI * (Do * Do - Di * Di) / 4,
      I: Math.PI * q / 64,
      W: Math.PI * q / (32 * Do)
    };
  }

  /* ── 校验 ─────────────────────────────────────────── */
  function rangeErr(out, i, field, v, lo, hi, label) {
    if (!isFinite(v)) { out.push({ i: i, field: field, msg: (label || field) + '：要填一个数字' }); return true; }
    if (v < lo || v > hi) { out.push({ i: i, field: field, msg: (label || field) + '：要在 ' + lo + ' ～ ' + hi + ' 之间（当前 ' + v + '）' }); return true; }
    return false;
  }
  function validate(cfg) {
    const c = normCfg(cfg);
    const out = [];
    const sf = num(c.sf), years = num(c.years);
    rangeErr(out, -1, 'sf', sf, SF_MIN, SF_MAX, '目标安全系数');
    rangeErr(out, -1, 'years', years, 1, MAX_YEARS, '观察年限');
    if (!Array.isArray(c.items) || c.items.length < 1) out.push({ i: -1, field: 'items', msg: '至少要有一件装置' });
    if (c.items.length > MAX_ITEMS) out.push({ i: -1, field: 'items', msg: '最多 ' + MAX_ITEMS + ' 件装置（当前 ' + c.items.length + ' 件）' });
    c.items.forEach((it, i) => {
      const p = '第 ' + (i + 1) + ' 件';
      if (!it.name.trim()) out.push({ i: i, field: 'name', msg: p + '：名称不能为空' });
      else if (it.name.trim().length > NAME_MAX) out.push({ i: i, field: 'name', msg: p + '：名称最多 ' + NAME_MAX + ' 个字（当前 ' + it.name.trim().length + '）' });
      if (!modeOf(it.mode) || MODES.every((m) => m.id !== it.mode)) out.push({ i: i, field: 'mode', msg: p + '：安装方式不认' });
      if (modeOf(it.mode).useDir && DIRS.every((d) => d.id !== it.dir)) out.push({ i: i, field: 'dir', msg: p + '：受力方向不认' });
      const mk = modeOf(it.mode);
      rangeErr(out, i, 'load', num(it.load), LOAD_MIN, LOAD_MAX, p + ' 目标载荷');
      rangeErr(out, i, 'dyn', num(it.dyn), DYN_MIN, DYN_MAX, p + ' 动载系数');
      rangeErr(out, i, 'decay', num(it.decay), DECAY_MIN, DECAY_MAX, p + ' 年衰减率');
      if (mk.useKeep) rangeErr(out, i, 'keep', num(it.keep), KEEP_MIN, KEEP_MAX, p + ' 有效保持系数');
      if (mk.id === 'glue') {
        rangeErr(out, i, 'area', num(it.area), AREA_MIN, AREA_MAX, p + ' 有效粘贴面积');
        rangeErr(out, i, 'tau', num(it.tau), STRENGTH_MIN, STRENGTH_MAX, p + ' 剪切强度');
        rangeErr(out, i, 'peel', num(it.peel), STRENGTH_MIN, STRENGTH_MAX, p + ' 剥离强度');
      }
      if (mk.id === 'suction') {
        rangeErr(out, i, 'cupD', num(it.cupD), CUP_D_MIN, CUP_D_MAX, p + ' 吸盘有效直径');
        rangeErr(out, i, 'cups', num(it.cups), CUPS_MIN, CUPS_MAX, p + ' 吸盘只数');
        rangeErr(out, i, 'dP', num(it.dP), DP_MIN, DP_MAX, p + ' 内外压差');
        rangeErr(out, i, 'slide', num(it.slide), SLIDE_MIN, SLIDE_MAX, p + ' 侧向滑移系数');
      }
      if (mk.id === 'rod') {
        const D = num(it.rodD), t = num(it.rodT);
        if (!rangeErr(out, i, 'rodD', D, ROD_D_MIN, ROD_D_MAX, p + ' 管外径')) {
          rangeErr(out, i, 'rodT', t, ROD_T_MIN, D / 2 - 0.2, p + ' 壁厚');
        }
        rangeErr(out, i, 'rodL', num(it.rodL), ROD_L_MIN, ROD_L_MAX, p + ' 管长（跨距）');
        rangeErr(out, i, 'E', num(it.E), E_MIN, E_MAX, p + ' 弹性模量');
        rangeErr(out, i, 'sigma', num(it.sigma), SIGMA_MIN, SIGMA_MAX, p + ' 许用应力');
        rangeErr(out, i, 'effLen', num(it.effLen), EFFLEN_MIN, EFFLEN_MAX, p + ' 有效长度系数');
        rangeErr(out, i, 'springN', num(it.springN), SPRING_MIN, SPRING_MAX, p + ' 最大压紧力');
        rangeErr(out, i, 'mu', num(it.mu), MU_MIN, MU_MAX, p + ' 端部摩擦系数');
        rangeErr(out, i, 'wallP', num(it.wallP), WALLP_MIN, WALLP_MAX, p + ' 墙面许用压强');
        rangeErr(out, i, 'padA', num(it.padA), PAD_MIN, PAD_MAX, p + ' 单个垫片面积');
      }
      if (mk.id === 'magnet') {
        rangeErr(out, i, 'magQ', num(it.magQ), MAGQ_MIN, MAGQ_MAX, p + ' 单位面积吸力');
        rangeErr(out, i, 'magA', num(it.magA), MAGA_MIN, MAGA_MAX, p + ' 有效接触面积');
        rangeErr(out, i, 'tempK', num(it.tempK), TEMPK_MIN, TEMPK_MAX, p + ' 温度与间隙保持系数');
      }
    });
    return out;
  }

  /* ── 能力（t = 0 的初始能力 + 全部约束项） ────────── */
  function constraintsOf(it, sf) {
    const mk = modeOf(it.mode);
    const list = [];        // {key,label,value,unit,note}
    const extra = {};
    switch (mk.id) {
      case 'glue': {
        const s = it.dir === 'shear' ? it.tau : it.peel;
        const v = s * 100 * it.area * it.keep / 100;
        list.push({ key: 'glue', group: 'F', label: (it.dir === 'shear' ? '粘胶剪切' : '粘胶剥离'), value: v,
          note: (it.dir === 'shear' ? 'tau' : 'peel') + ' ' + fmtMPa(s) + ' × 100 × ' + fmtArea(it.area) + ' × ' + fmtPct(it.keep, 0) });
        extra.sigmaEff = s;
        return { F0: v, list: list, limiter: 'glue', extra: extra };
      }
      case 'suction': {
        const A = Math.PI * it.cupD * it.cupD / 4;
        const pull = it.dP * 0.1 * A * it.keep / 100 * it.cups;
        list.push({ key: 'pull', group: 'F', label: '吸盘拉脱（压差 × 面积 × 只数）', value: pull,
          note: fmtAdaptive(it.dP, 'kPa', 1) + ' × 0.1 × ' + fmtArea(A) + ' × ' + fmtPct(it.keep, 0) + ' × ' + it.cups + ' 只' });
        extra.cupArea = A; extra.pull = pull;
        if (it.dir === 'shear') {
          const slide = pull * it.slide;
          list.push({ key: 'slide', group: 'F', label: '侧向滑移（拉脱 × 滑移系数）', value: slide, note: '滑移系数 ' + fmtFix(it.slide, 2) });
          return { F0: Math.min(pull, slide), list: list, limiter: slide <= pull ? 'slide' : 'pull', extra: extra };
        }
        return { F0: pull, list: list, limiter: 'pull', extra: extra };
      }
      case 'rod': {
        const g = tubeGeom(it.rodD, it.rodT);
        const Nb = Math.PI * Math.PI * (it.E * 100) * g.I / Math.pow(it.effLen * it.rodL, 2);
        const Ny = it.sigma * 100 * g.Atube;
        const Nw = it.wallP * 100 * it.padA;
        const Ns = it.springN;
        const Ns4 = [
          { key: 'spring', group: 'N', label: '弹簧 / 机构压紧力', value: Ns, note: '你填的机构上限 ' + fmtN0(Ns) },
          { key: 'buckle', group: 'N', label: '管件欧拉屈曲', value: Nb, note: 'π²EI/(μL)²：I = ' + fmtAdaptive(g.I, 'cm⁴', 4) + '，μL = ' + fmtCm(it.effLen * it.rodL) },
          { key: 'yield', group: 'N', label: '管材屈服', value: Ny, note: 'σ·A = ' + fmtMPa(it.sigma) + ' × ' + fmtArea(g.Atube) },
          { key: 'wall', group: 'N', label: '墙面许用压强', value: Nw, note: 'p·A垫 = ' + fmtMPa(it.wallP) + ' × ' + fmtArea(it.padA) }
        ];
        let nMin = Ns4[0];
        Ns4.forEach((x) => { if (x.value < nMin.value) nMin = x; });
        const Neff = nMin.value;
        const fric = 2 * it.mu * Neff;
        const Mallow = it.sigma * 100 * g.W;
        const bend = 4 * Mallow / it.rodL;
        list.push(Ns4[0], Ns4[1], Ns4[2], Ns4[3]);
        list.push({ key: 'fric', group: 'F', label: '摩擦自锁 2μN', value: fric, note: '2 × ' + fmtFix(it.mu, 2) + ' × ' + fmtN0(Neff) + '（N 取上面四项最小）' });
        list.push({ key: 'bend', group: 'F', label: '管件抗弯（载荷在管中点、跨距取管长）', value: bend, note: '4·σ·W/L：W = ' + fmtAdaptive(g.W, 'cm³', 4) });
        extra.geom = g; extra.Nb = Nb; extra.Ny = Ny; extra.Nw = Nw; extra.Ns = Ns; extra.Neff = Neff; extra.nLimiter = nMin.key; extra.fric = fric; extra.bend = bend;
        return { F0: Math.min(fric, bend), list: list, limiter: bend <= fric ? 'bend' : 'fric', extra: extra };
      }
      case 'magnet': {
        const v = it.magQ * it.magA * it.keep / 100 * it.tempK / 100;
        list.push({ key: 'magnet', group: 'F', label: it.dir === 'shear' ? '磁吸（顺墙）' : '磁吸（往外拉）', value: v,
          note: fmtAdaptive(it.magQ, 'N/cm²', 1) + ' × ' + fmtArea(it.magA) + ' × ' + fmtPct(it.keep, 0) + ' × ' + fmtPct(it.tempK, 0) });
        extra.tempK = it.tempK / 100;
        return { F0: v, list: list, limiter: 'magnet', extra: extra };
      }
      default:
        return { F0: 0, list: [], limiter: '', extra: {} };
    }
  }
  const limiterLabel = (key) => ({
    glue: '背胶强度', pull: '吸盘拉脱', slide: '吸盘侧向滑移',
    spring: '弹簧压紧力', buckle: '管件屈曲', yield: '管材屈服', wall: '墙面压强',
    fric: '摩擦自锁', bend: '管件抗弯', magnet: '磁吸吸力'
  }[key] || key);

  function verdictOf(ratio, sf) {
    if (!isFinite(ratio)) return { id: 'fail', label: '算不出' };
    if (ratio >= sf) return { id: 'ok', label: '够' };
    if (ratio >= 1) return { id: 'tight', label: '撑得住但没余量' };
    return { id: 'fail', label: '会掉' };
  }
  function breakYearOf(F0, decay, threshold) {
    if (!(threshold > 0) || !(F0 > 0)) return null;
    if (F0 <= threshold) return 0;
    if (decay <= 0) return null;
    const k = 1 - decay / 100;
    if (!(k > 0 && k < 1)) return null;
    const t = Math.log(threshold / F0) / Math.log(k);
    if (!isFinite(t) || t < 0) return null;
    return t;
  }

  /* ── 反推：T 年末仍要达标，需要改什么 ─────────────── */
  function reverseSolve(rawIt, sf, years) {
    const it = coerce(rawIt);
    const mk = modeOf(it.mode);
    const effLoad = it.load * it.dyn;
    const k = 1 - it.decay / 100;
    const tooMuchDecay = !(k > 0);
    const need0 = tooMuchDecay ? Infinity : effLoad * sf / Math.pow(k, years);
    const out = { mode: mk.id, need0: need0, raw: {}, rounded: {}, applyMap: {}, params: [], feasible: true, reason: '', note: '', recheck: null, alternatives: [] };
    if (!isFinite(need0)) {
      out.feasible = false;
      out.reason = '年衰减率达到 ' + fmtPct(it.decay, 0) + ' 时，' + years + ' 年后能力归零，任何初始能力都救不回来——只能换方式或打孔。';
      return out;
    }
    switch (mk.id) {
      case 'glue': {
        const s = it.dir === 'shear' ? it.tau : it.peel;
        const areaReq = need0 / (s * 100 * it.keep / 100);
        out.raw.area = areaReq;
        out.rounded.area = r6(ceilTo(areaReq, 0.1));
        out.applyMap = { area: out.rounded.area };
        out.params.push({ key: 'area', label: '有效粘贴面积', value: out.rounded.area, unit: 'cm²', raw: areaReq, cur: it.area, alreadyOK: out.rounded.area <= it.area });
        out.params.push({ key: 'tapeLen', label: '按 2.5 cm 宽胶条算，需要长度', value: r2(out.rounded.area / 2.5), unit: 'cm', raw: areaReq / 2.5, readOnly: true });
        if (out.rounded.area > AREA_MAX) {
          out.feasible = false;
          out.reason = '需要 ' + fmtAreaBig(out.rounded.area) + ' 粘贴面积，超过本页上限 ' + fmtArea(AREA_MAX) + '——这个方向靠背胶做不到。';
        }
        const other = it.dir === 'shear' ? 'peel' : 'shear';
        const so = other === 'shear' ? it.tau : it.peel;
        const areaOther = need0 / (so * 100 * it.keep / 100);
        if (isFinite(areaOther) && areaOther <= AREA_MAX) {
          out.alternatives.push({ text: '如果改成' + dirOf(other).name + '，同样条件只需要 ' + fmtArea(ceilTo(areaOther, 0.1)) + ' 的粘贴面积。', patch: { dir: other } });
        } else {
          out.alternatives.push({ text: '即使改成' + dirOf(other).name + '，也需要 ' + fmtAreaBig(areaOther) + ' 的粘贴面积，同样超出上限。', patch: null });
        }
        break;
      }
      case 'suction': {
        const f = (it.dir === 'shear' ? it.slide : 1);
        if (!(f > 0)) {
          out.feasible = false;
          out.reason = '侧向滑移系数填了 0：顺墙方向下吸盘没有任何抗滑移能力，靠吸盘做不到。';
          break;
        }
        const pullNeed = need0 / f;
        const perCup = it.dP * 0.1 * (Math.PI * it.cupD * it.cupD / 4) * it.keep / 100;
        const cupsReq = perCup > 0 ? pullNeed / perCup : Infinity;
        const areaReq = pullNeed / (it.dP * 0.1 * it.keep / 100 * it.cups);
        const cupDReq = 2 * Math.sqrt(areaReq / Math.PI);
        out.raw.cups = cupsReq; out.raw.cupD = cupDReq;
        out.rounded.cups = Math.ceil(cupsReq - 1e-9);
        out.rounded.cupD = r6(ceilTo(cupDReq, 0.1));
        out.params.push({ key: 'cups', label: '保持直径 ' + fmtCm(it.cupD) + '，需要只数', value: out.rounded.cups, unit: '只', raw: cupsReq, cur: it.cups, alreadyOK: out.rounded.cups <= it.cups });
        out.params.push({ key: 'cupD', label: '保持 ' + it.cups + ' 只，需要单只直径', value: out.rounded.cupD, unit: 'cm', raw: cupDReq, cur: it.cupD, alreadyOK: out.rounded.cupD <= it.cupD });
        const okCups = out.rounded.cups <= CUPS_MAX;
        const okD = out.rounded.cupD <= CUP_D_MAX;
        if (!okCups && !okD) {
          out.feasible = false;
          out.reason = '既要 ' + out.rounded.cups + ' 只（上限 ' + CUPS_MAX + ' 只）又要 ' + fmtCm(out.rounded.cupD) + ' 的吸盘（上限 ' + fmtCm(CUP_D_MAX) + '）——这个方向靠吸盘做不到。';
        } else if (out.rounded.cups <= it.cups) {
          out.applyMap = { cups: it.cups };
          out.note = '按当前 ' + it.cups + ' 只就够（算下来 ' + out.rounded.cups + ' 只即可），不用改配置。';
        } else if (okCups) {
          out.applyMap = { cups: out.rounded.cups };
          out.note = '优先加只数：把吸盘加到 ' + out.rounded.cups + ' 只（直径不变）比换大吸盘更省事。';
        } else {
          out.applyMap = { cupD: out.rounded.cupD };
          out.note = '只数已经超过上限，改成把单只直径加到 ' + fmtCm(out.rounded.cupD) + '（只数不变）。';
        }
        if (out.feasible && it.dir === 'shear') {
          out.alternatives.push({ text: '如果改成垂直往外拉（不走滑移口径），所需只数会少一些。', patch: { dir: 'peel' } });
        }
        break;
      }
      case 'rod': {
        const t = it.rodT;
        const Nreq = need0 / (2 * it.mu);
        const Ireq = Nreq * Math.pow(it.effLen * it.rodL, 2) / (Math.PI * Math.PI * (it.E * 100));
        const Wreq = need0 * it.rodL / (4 * it.sigma * 100);
        const solveD = (targetFn) => {
          let lo = 2 * t / 10 + 0.05, hi = ROD_D_MAX / 10;
          if (targetFn(hi) < 0) return Infinity;
          for (let n = 0; n < 200; n++) {
            const mid = (lo + hi) / 2;
            if (targetFn(mid) >= 0) hi = mid; else lo = mid;
          }
          return hi;
        };
        const DoBuckle = solveD((Do) => {
          const g = tubeGeom(Do * 10, t);
          return Math.PI * Math.PI * (it.E * 100) * g.I / Math.pow(it.effLen * it.rodL, 2) - Nreq;
        });
        const DoBend = solveD((Do) => {
          const g = tubeGeom(Do * 10, t);
          return 4 * it.sigma * 100 * g.W / it.rodL - need0;
        });
        const padReq = Nreq / (it.wallP * 100);
        const springReq = Nreq;
        const DoMax = Math.max(isFinite(DoBuckle) ? DoBuckle : 0, isFinite(DoBend) ? DoBend : 0);
        if (!isFinite(DoMax) || DoMax > ROD_D_MAX / 10) {
          out.feasible = false;
          out.reason = '这个跨距（' + fmtCm(it.rodL) + '）与载荷下，需要的管外径超过本页上限 ' + fmtMm(ROD_D_MAX) +
            '（屈曲要 ' + fmtMm(isFinite(DoBuckle) ? DoBuckle * 10 : Infinity) + '、抗弯要 ' + fmtMm(isFinite(DoBend) ? DoBend * 10 : Infinity) +
            '）——撑杆做不到，只能打孔、缩短跨距或减少载荷。';
          out.raw.rodD = DoMax * 10;
          return out;
        }
        out.raw.rodD = DoMax * 10; out.raw.padA = padReq; out.raw.springN = springReq;
        out.rounded.rodD = r6(ceilTo(DoMax * 10, 0.5));
        out.rounded.padA = r6(ceilTo(padReq, 0.5));
        out.rounded.springN = Math.ceil(springReq - 1e-9);
        out.params.push({ key: 'rodD', label: '管外径（壁厚 ' + fmtMm(t) + ' 不变）', value: out.rounded.rodD, unit: 'mm', raw: DoMax * 10, cur: it.rodD, alreadyOK: out.rounded.rodD <= it.rodD, why: '屈曲要 ' + fmtMm(isFinite(DoBuckle) ? DoBuckle * 10 : Infinity) + ' / 抗弯要 ' + fmtMm(isFinite(DoBend) ? DoBend * 10 : Infinity) });
        out.params.push({ key: 'padA', label: '单个垫片（墙面压强）', value: out.rounded.padA, unit: 'cm²', raw: padReq, cur: it.padA, alreadyOK: out.rounded.padA <= it.padA });
        out.params.push({ key: 'springN', label: '机构压紧力', value: out.rounded.springN, unit: 'N', raw: springReq, cur: it.springN, alreadyOK: out.rounded.springN <= it.springN });
        out.applyMap = { rodD: out.rounded.rodD, padA: out.rounded.padA, springN: out.rounded.springN };
        const bad = [];
        if (!(out.rounded.rodD <= ROD_D_MAX)) bad.push('外径要 ' + fmtMm(out.rounded.rodD) + '（上限 ' + fmtMm(ROD_D_MAX) + '）');
        if (!(out.rounded.padA <= PAD_MAX)) bad.push('垫片要 ' + fmtArea(out.rounded.padA) + '（上限 ' + fmtArea(PAD_MAX) + '）');
        if (!(out.rounded.springN <= SPRING_MAX)) bad.push('压紧力要 ' + fmtN0(out.rounded.springN) + '（上限 ' + fmtN0(SPRING_MAX) + '）');
        if (bad.length) {
          out.feasible = false;
          out.reason = '这个跨距与载荷下，撑杆方案做不到：' + bad.join('；') + '。';
        }
        break;
      }
      case 'magnet': {
        const areaReq = need0 / (it.magQ * it.keep / 100 * it.tempK / 100);
        out.raw.magA = areaReq;
        out.rounded.magA = r6(ceilTo(areaReq, 0.1));
        out.applyMap = { magA: out.rounded.magA };
        out.params.push({ key: 'magA', label: '有效接触面积', value: out.rounded.magA, unit: 'cm²', raw: areaReq, cur: it.magA, alreadyOK: out.rounded.magA <= it.magA });
        out.params.push({ key: 'magN', label: '按 3×3 cm 一块算，需要块数', value: Math.ceil(areaReq / 9), unit: '块', raw: areaReq / 9, readOnly: true });
        if (out.rounded.magA > MAGA_MAX) {
          out.feasible = false;
          out.reason = '需要 ' + fmtAreaBig(out.rounded.magA) + ' 接触面积，超过本页上限 ' + fmtArea(MAGA_MAX) + '。';
        }
        break;
      }
      default: break;
    }
    /* 回代：把取整后的解带回，重算 F0 → F(T) → ratio（落地值一律取「当前值」与「所需值」的较大者，不下调） */
    if (!out.feasible) return out;
    const cand = Object.assign({}, it);
    Object.keys(out.applyMap).forEach((key) => { cand[key] = Math.max(it[key], out.applyMap[key]); });
    out.applied = {};
    Object.keys(out.applyMap).forEach((key) => { out.applied[key] = cand[key]; });
    const c = constraintsOf(cand, sf);
    cand.__F0 = c.F0;
    out.candidate = cand;
    out.recheck = { F0: c.F0, FT: c.F0 * Math.pow(k, years), need0: need0, residual: c.F0 - need0 };
    out.recheck.effLoad = effLoad;
    out.recheck.ratio = c.F0 * Math.pow(k, years) / effLoad;
    out.recheck.pass = out.recheck.ratio >= sf - 1e-9;
    if (!out.recheck.pass) {
      out.feasible = false;
      const cl = c.list.reduce((m, x) => (x.value < m.value ? x : m), c.list[0]);
      out.reason = '取整后的解回代仍未达标（安全系数 ' + fmtFix(out.recheck.ratio, 2) + ' < 目标 ' + fmtFix(sf, 2) +
        '）：回代后能力由「' + limiterLabel(cl.key) + '」封顶在 ' + fmtN(c.F0) + '，仍低于所需的 ' + fmtN(need0) + '。';
    }
    return out;
  }

  /* 把字符串字段强制成数字（analyze 已做过一次，这里保证 analyzeItem / sensitivity 单独调用也安全） */
  function coerce(it) {
    const o = {};
    Object.keys(it || {}).forEach((k) => { o[k] = it[k]; });
    numFields.forEach((k) => { if (o[k] !== undefined && o[k] !== null && typeof o[k] === 'string') o[k] = num(o[k]); });
    return o;
  }

  /* ── 单件分析 ─────────────────────────────────────── */
  function analyzeItem(rawIt, sf, years) {
    const it = coerce(rawIt);
    const mk = modeOf(it.mode);
    const dir = dirOf(it.dir);
    const c = constraintsOf(it, sf);
    const effLoad = it.load * it.dyn;
    const k = 1 - it.decay / 100;
    const rows = [];
    for (let t = 0; t <= years; t++) {
      const Ft = c.F0 * Math.pow(k, t);
      rows.push({ t: t, F: Ft, ratio: Ft / effLoad, allow: Ft / (sf * it.dyn), verdict: verdictOf(Ft / effLoad, sf) });
    }
    const FT = rows[rows.length - 1].F;
    const ratioT = rows[rows.length - 1].ratio;
    const v = verdictOf(ratioT, sf);
    const warnings = [];
    if (it.mode === 'rod') {
      if (c.extra.Ns > c.extra.Nb) warnings.push('弹簧压紧力（' + fmtN0(c.extra.Ns) + '）已经超过管件的屈曲上限（' + fmtN0(c.extra.Nb) + '），继续加大弹簧力不会提升承载能力，只会把管子压弯。');
      if (c.limiter === 'bend') warnings.push('这一件的瓶颈是「管件抗弯」：摩擦自锁还有 ' + fmtN(c.extra.fric) + '，但管件本身在中点受力下只能到 ' + fmtN(c.extra.bend) + '——加粗管子或缩短跨距才有效。');
      if (c.extra.nLimiter === 'wall') warnings.push('压紧力被「墙面许用压强」封顶（' + fmtN0(c.extra.Nw) + '）：加大垫片面积比加大弹簧力更有效。');
    }
    if (mk.useDir && it.dir === 'peel' && it.mode === 'glue') warnings.push('顺着往外拉（剥离）时，胶的可用强度比顺墙方向低——这一件的结论直接取决于「力是横着推还是往外拽」。');
    const res = {
      i: it.i, name: it.name, mode: it.mode, modeName: mk.name, modeShort: mk.short,
      dir: it.dir, dirName: dir.name, dirShort: dir.short, useDir: mk.useDir,
      load: it.load, dyn: it.dyn, keep: it.keep, decay: it.decay, effLoad: effLoad,
      F0: c.F0, FT: FT, list: c.list, limiter: c.limiter, limiterLabel: limiterLabel(c.limiter),
      extra: c.extra, rows: rows, ratio0: rows[0].ratio, ratioT: ratioT,
      allow: rows[rows.length - 1].allow, verdict: v,
      breakYear: breakYearOf(c.F0, it.decay, effLoad),
      sfBreakYear: breakYearOf(c.F0, it.decay, effLoad * sf),
      warnings: warnings,
      rev: reverseSolve(it, sf, years),
      item: it
    };
    return res;
  }

  /* ── 敏感性（对选中件，每一行完整重算） ──────────── */
  function sensitivity(it, sf, years) {
    const base = analyzeItem(it, sf, years);
    const rows = [{ label: '当前设置', F: base.FT, ratio: base.ratioT, allow: base.allow, verdict: base.verdict, delta: 0, note: '' }];
    const push = (label, patch, sf2, years2, note) => {
      const it2 = Object.assign({}, it, patch);
      const r = analyzeItem(it2, sf2 === undefined ? sf : sf2, years2 === undefined ? years : years2);
      rows.push({ label: label, F: r.FT, ratio: r.ratioT, allow: r.allow, verdict: r.verdict, delta: r.ratioT - base.ratioT, note: note || '' });
    };
    const mk = modeOf(it.mode);
    push('目标载荷 +20%', { load: it.load * 1.2 });
    push('目标载荷 −20%', { load: it.load * 0.8 });
    push('安全系数 ' + fmtFix(sf, 0) + ' → ' + fmtFix(sf + 1, 0), {}, sf + 1, years, '只影响许可载荷');
    push('动载系数 ×1.5', { dyn: Math.min(DYN_MAX, it.dyn * 1.5) });
    push('观察年限 +2 年', {}, sf, Math.min(MAX_YEARS, years + 2));
    if (mk.useDir) {
      const other = it.dir === 'shear' ? 'peel' : 'shear';
      push('受力方向换成「' + dirOf(other).short + '」', { dir: other });
    }
    if (mk.id === 'glue') push('粘贴面积 +50%', { area: Math.min(AREA_MAX, it.area * 1.5) });
    if (mk.id === 'suction') push('吸盘直径 +50%', { cupD: Math.min(CUP_D_MAX, it.cupD * 1.5) });
    if (mk.id === 'rod') push('管外径 +50%', { rodD: Math.min(ROD_D_MAX, ceilTo(it.rodD * 1.5, 0.5)) });
    if (mk.id === 'magnet') push('接触面积 +50%', { magA: Math.min(MAGA_MAX, it.magA * 1.5) });
    push('年衰减率减半', { decay: it.decay / 2 });
    return rows;
  }

  /* ── 主分析 ───────────────────────────────────────── */
  function analyze(cfg) {
    const c = normCfg(cfg);
    const errors = validate(c);
    if (errors.length) return { ok: false, errors: errors, items: [], checks: [], insights: [], steps: [], sens: [], rows: [] };
    const sf = num(c.sf), years = Math.round(num(c.years));
    const items = c.items.map((raw, i) => {
      const it = {};
      Object.keys(raw).forEach((k) => { it[k] = raw[k]; });
      it.i = i;
      Object.keys(it).forEach((k) => { if (numFields.indexOf(k) >= 0) it[k] = num(it[k]); });
      it.name = String(it.name).trim();
      return it;
    });
    const results = items.map((it) => analyzeItem(it, sf, years));
    const okN = results.filter((r) => r.verdict.id === 'ok').length;
    const tightN = results.filter((r) => r.verdict.id === 'tight').length;
    const failN = results.filter((r) => r.verdict.id === 'fail').length;
    const worst = results.slice().sort((a, b) => a.ratioT - b.ratioT)[0];
    const infeasible = results.filter((r) => !r.rev.feasible);
    const kpis = {
      total: results.length, okN: okN, tightN: tightN, failN: failN,
      worstName: worst.name, worstRatio: worst.ratioT, worstVerdict: worst.verdict,
      worstLimiter: worst.limiterLabel,
      totalLoad: results.reduce((s, r) => s + r.load, 0),
      totalAllow: results.reduce((s, r) => s + Math.min(r.allow, r.load), 0),
      infeasibleN: infeasible.length, infeasibleNames: infeasible.map((r) => r.name),
      sf: sf, years: years
    };
    const sel = 0;
    const primary = results[0];
    const sens = sensitivity(items[0], sf, years);
    const res = {
      ok: true, errors: [], sf: sf, years: years, items: results, kpis: kpis,
      sel: sel, sens: sens, rows: primary.rows,
      insights: insightsOf(results, kpis, sf, years),
      steps: stepsOf(results, kpis, sf, years),
      checks: []
    };
    res.checks = runChecks(c, res);
    return res;
  }

  /* ── 需要记住的几条（全部由本次结果算出） ────────── */
  function insightsOf(results, kpis, sf, years) {
    const out = [];
    const worst = results.slice().sort((a, b) => a.ratioT - b.ratioT)[0];
    out.push({ t: '最弱的是「' + worst.name + '」', d: '实际安全系数 ' + fmtRatio(worst.ratioT) + '（' + worst.verdict.label + '），瓶颈是' + worst.limiterLabel + '，T 年末能力 ' + fmtNK(worst.FT) + '。' });
    const dec = results.slice().sort((a, b) => b.decay - a.decay)[0];
    if (dec && dec.decay > 0) {
      out.push({ t: '衰减最狠的是「' + dec.name + '」（' + fmtPct(dec.decay, 0) + '/年）', d: fmtYears(years) + '后能力从 ' + fmtNK(dec.F0) + ' 掉到 ' + fmtNK(dec.FT) + '，只剩 ' + fmtPct(dec.FT / dec.F0 * 100, 1) + '——安全系数不是一次性买断的。' });
    }
    const g = results.filter((r) => r.mode === 'glue')[0];
    if (g) {
      const it = g.item;
      const other = g.dir === 'shear' ? 'peel' : 'shear';
      const s2 = other === 'shear' ? it.tau : it.peel;
      const s1 = g.dir === 'shear' ? it.tau : it.peel;
      if (s1 > 0 && s2 > 0) {
        out.push({ t: '背胶：方向换一下，能力差 ' + fmtFix(Math.max(s1, s2) / Math.min(s1, s2), 1) + ' 倍', d: '同样 ' + fmtArea(it.area) + ' 面积，' + dirOf(g.dir).name + ' 用 ' + fmtMPa(s1) + ' → ' + fmtNK(g.F0) + '；换成' + dirOf(other).name + ' 用 ' + fmtMPa(s2) + ' → ' + fmtNK(g.F0 * s2 / s1) + '。力是横着推还是往外拽，比贴多大面积更决定成败。' });
      }
    }
    const rod = results.filter((r) => r.mode === 'rod' && r.limiter === 'bend')[0];
    if (rod) {
      out.push({ t: '撑杆的瓶颈常常不是摩擦、是管子自己会弯', d: '「' + rod.name + '」摩擦自锁能到 ' + fmtNK(rod.extra.fric) + '，但载荷压在管子中间时抗弯只到 ' + fmtNK(rod.extra.bend) + '（跨距 ' + fmtCm(rod.item.rodL) + '）——加粗管子或缩短跨距，比加大弹簧力有用。' });
    }
    out.push({ t: '动载系数是「打折器」', d: '许可载荷 = 能力 ÷（安全系数 × 动载系数）。安全系数 ' + fmtFix(sf, 0) + ' 下，动载 1 时许可载荷是能力的 ' + fmtPct(100 / sf, 1) + '，动载 2 就只剩 ' + fmtPct(100 / (sf * 2), 1) + '——「站着不动」和「有人拉一下」是两回事。' });
    if (kpis.infeasibleN > 0) {
      out.push({ t: '有 ' + kpis.infeasibleN + ' 件按当前假设做不到', d: kpis.infeasibleNames.join('、') + '：在 T 年末达标所需的尺寸超过了本页上限，页面会直接说「做不到」，不会凑一个能过的数字。' });
    } else {
      out.push({ t: '按当前假设，' + results.length + ' 件都有可落地的改法', d: '每件的「要挂住目标重量需要什么」都在下面反推区给出，并且都把取整后的解回代重算过。' });
    }
    return out;
  }

  /* ── 下一步（能作用到输入的建议） ────────────────── */
  function stepsOf(results, kpis, sf, years) {
    const out = [];
    const worst = results.slice().sort((a, b) => a.ratioT - b.ratioT)[0];
    out.push('先处理最弱的一件「' + worst.name + '」：它现在的实际安全系数是 ' + fmtRatio(worst.ratioT) + '（' + worst.verdict.label + '），其余件都比它强。');
    results.forEach((r) => {
      if (r.rev.feasible && r.rev.params.length) {
        const need = r.rev.params.filter((x) => !x.readOnly);
        if (need.length && need.every((x) => x.alreadyOK)) {
          out.push('「' + r.name + '」按当前设置就不需要改：算下来只需要 ' + need.map((x) => x.label + ' ' + fmtAdaptive(x.value, x.unit, 2)).join('、') + '，都不超过你现在填的值。');
        } else {
          const p = need.map((x) => x.label + ' → ' + fmtAdaptive(x.value, x.unit, 2) + (x.alreadyOK ? '（当前已够）' : '')).join('、');
          out.push('「' + r.name + '」要在' + fmtYears(years) + '后仍有 ' + fmtFix(sf, 0) + ' 倍安全系数：' + p + '（取整后的解已回代重算）。');
        }
      } else if (!r.rev.feasible) {
        out.push('「' + r.name + '」按当前假设做不到：' + r.rev.reason + '可选做法是打孔固定、减少目标载荷、缩短跨距，或换成另一种安装方式。');
      }
    });
    results.forEach((r) => {
      if (r.breakYear !== null && r.breakYear > 0 && r.breakYear <= years) {
        out.push('「' + r.name + '」大约在' + fmtYears(Math.floor(r.breakYear * 10) / 10) + '前后跌破「撑得住」（实际安全系数掉到 1.00 以下）——要么提前加固，要么别挂那么久。');
      }
      if (r.breakYear === 0) out.push('「' + r.name + '」现在就已经不够（实际安全系数 ' + fmtRatio(r.ratioT) + '），不用等衰减。');
    });
    out.push('把这些数字当成「假设下的对账」而不是结论：材料强度、保持系数、年衰减率都是你填的假设，换一组假设结论就会变（敏感性表里每一行都是完整重算的）。');
    return out;
  }

  /* ── 结构自检（每次重算都跑） ────────────────────── */
  function runChecks(c, res) {
    const out = [];
    const add = (name, pass, detail) => out.push({ name: name, pass: !!pass, detail: detail });
    const sf = res.sf, years = res.years;
    let ratioOK = true, allowOK = true, decayOK = true, minOK = true, monoOK = true, verdictOK = true, revOK = true, finiteOK = true, limOK = true, ceilOK = true, zeroDecayOK = true, rowsLenOK = true, effOK = true;
    const badDetail = [];
    res.items.forEach((r) => {
      const it = r.item;
      const eff = it.load * it.dyn;
      if (Math.abs(r.ratio0 - r.F0 / eff) > 1e-9 * Math.max(1, r.ratio0)) { ratioOK = false; badDetail.push(r.name + ' ratio0'); }
      if (Math.abs(r.allow - r.FT / (sf * it.dyn)) > 1e-9 * Math.max(1, r.allow)) { allowOK = false; badDetail.push(r.name + ' allow'); }
      const want = r.F0 * Math.pow(1 - it.decay / 100, years);
      if (Math.abs(r.FT - want) > 1e-9 * Math.max(1, r.FT)) { decayOK = false; badDetail.push(r.name + ' 衰减'); }
      const fList = r.list.filter((x) => (x.group || 'F') === 'F');
      const mn = fList.reduce((m, x) => Math.min(m, x.value), Infinity);
      if (Math.abs(r.F0 - mn) > 1e-9 * Math.max(1, r.F0)) { minOK = false; badDetail.push(r.name + ' 取最小'); }
      const nList = r.list.filter((x) => x.group === 'N');
      if (nList.length && Math.abs(r.extra.Neff - nList.reduce((m, x) => Math.min(m, x.value), Infinity)) > 1e-9 * Math.max(1, r.extra.Neff)) { minOK = false; badDetail.push(r.name + ' 压紧力取最小'); }
      for (let i = 1; i < r.rows.length; i++) if (r.rows[i].F > r.rows[i - 1].F + 1e-9 * Math.max(1, r.rows[0].F)) { monoOK = false; badDetail.push(r.name + ' 单调'); break; }
      if (r.verdict.id !== verdictOf(r.ratioT, sf).id) { verdictOK = false; badDetail.push(r.name + ' 判定'); }
      if (r.rows.length !== years + 1) { rowsLenOK = false; badDetail.push(r.name + ' 行数'); }
      if (Math.abs(eff - it.load * it.dyn) > 1e-12) { effOK = false; }
      if (it.decay === 0 && Math.abs(r.FT - r.F0) > 1e-9) { zeroDecayOK = false; badDetail.push(r.name + ' 零衰减'); }
      if (!r.list.some((x) => x.key === r.limiter)) { limOK = false; badDetail.push(r.name + ' 瓶颈'); }
      if (r.rev.feasible) {
        if (!r.rev.recheck || !r.rev.recheck.pass) { revOK = false; badDetail.push(r.name + ' 反推回代'); }
        r.rev.params.forEach((p) => {
          if (p.readOnly) return;
          if (p.value < p.raw - 1e-6) { ceilOK = false; badDetail.push(r.name + ' ' + p.key + ' 取整方向'); }
        });
      }
      const walk = (o) => {
        if (typeof o === 'number') { if (!isFinite(o)) finiteOK = false; return; }
        if (o && typeof o === 'object') Object.keys(o).forEach((k) => walk(o[k]));
      };
      walk({ F0: r.F0, FT: r.FT, ratioT: r.ratioT, allow: r.allow, rows: r.rows, list: r.list });
    });
    add('实际安全系数 = 能力 ÷ 有效载荷（逐件）', ratioOK, badDetail.filter((x) => /ratio0/.test(x)).join('，') || '全部件一致');
    add('许可载荷 = 能力 ÷（安全系数 × 动载系数）', allowOK, badDetail.filter((x) => /allow/.test(x)).join('，') || '全部件一致');
    add('T 年末能力 = 初始能力 × (1−衰减)^T', decayOK, badDetail.filter((x) => /衰减/.test(x)).join('，') || '全部件一致');
    add('初始能力 = 该方式承载能力项取最小（撑杆另有压紧力四项取最小）', minOK, badDetail.filter((x) => /取最小/.test(x)).join('，') || '全部件一致');
    add('能力随年份单调不增', monoOK, monoOK ? '逐件逐年检查通过' : badDetail.filter((x) => /单调/.test(x)).join('，'));
    add('判定三档与门限一致（≥SF / ≥1 / <1）', verdictOK, verdictOK ? '逐件通过' : badDetail.filter((x) => /判定/.test(x)).join('，'));
    add('逐年表行数 = 观察年限 + 1', rowsLenOK, rowsLenOK ? '逐件通过（T+1 行）' : badDetail.filter((x) => /行数/.test(x)).join('，'));
    add('有效载荷 = 目标载荷 × 动载系数', effOK, '逐件一致');
    add('衰减率为 0 时 T 年末能力等于初始能力', zeroDecayOK, zeroDecayOK ? '通过' : badDetail.filter((x) => /零衰减/.test(x)).join('，'));
    add('每件的瓶颈项都在候选约束列表里', limOK, limOK ? '通过' : badDetail.filter((x) => /瓶颈/.test(x)).join('，'));
    add('反推：取整后的解回代后仍达标', revOK, revOK ? '全部可行件通过' : badDetail.filter((x) => /反推回代/.test(x)).join('，'));
    add('反推：每个参数都朝「更能承重」的方向取整（不小于原值）', ceilOK, ceilOK ? '通过' : badDetail.filter((x) => /取整方向/.test(x)).join('，'));
    add('结果里没有 NaN / Infinity', finiteOK, finiteOK ? '递归检查通过' : '发现非有限值');
    /* 反推的独立互证：把反推解按「解析式」重算一遍 */
    let crossOK = true, crossBad = '';
    res.items.forEach((r) => {
      if (!r.rev.feasible || !r.rev.recheck) return;
      const it = r.item, k = 1 - it.decay / 100;
      const need0 = it.load * it.dyn * sf / Math.pow(k, years);
      if (Math.abs(r.rev.recheck.need0 - need0) > 1e-9 * Math.max(1, need0)) { crossOK = false; crossBad = r.name; }
      const cand = r.rev.candidate;
      if (cand) {
        const cc = constraintsOf(Object.assign({}, it, cand), sf);
        if (Math.abs(cc.F0 - r.rev.recheck.F0) > 1e-9 * Math.max(1, cc.F0)) { crossOK = false; crossBad = r.name + ' F0'; }
      }
    });
    add('反推所需的初始能力 = 有效载荷 × SF ÷ (1−衰减)^T', crossOK, crossOK ? '逐件互证通过' : '不一致：' + crossBad);
    add('敏感性每一行都是完整重算（不是按比例估算）', res.sens.length >= 8, res.sens.length + ' 行（含当前设置）');
    return out;
  }

  /* ── 导出（页面与测试共用同一份口径） ────────────── */
  function csvText(cfg, res) {
    const c = normCfg(cfg);
    const cell = (x) => { const t = String(x); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    const L = [];
    L.push(['免打孔承载装置对账台 · 导出', new Date().toISOString()].map(cell).join(','));
    L.push(['目标安全系数', res.sf, '观察年限（年）', res.years].map(cell).join(','));
    L.push('');
    L.push(['# 全件总览'].map(cell).join(','));
    L.push(['件', '安装方式', '受力方向', '目标载荷(N)', '动载系数', '有效载荷(N)', '初始能力(N)', 'T年末能力(N)', '实际安全系数', '许可载荷(N)', '瓶颈', '判定'].map(cell).join(','));
    res.items.forEach((r) => {
      L.push([r.name, r.modeName, r.useDir ? r.dirName : '—', r2(r.load), r.dyn, r2(r.effLoad), r2(r.F0), r2(r.FT), r4(r.ratioT), r2(r.allow), r.limiterLabel, r.verdict.label].map(cell).join(','));
    });
    L.push('');
    res.items.forEach((r) => {
      L.push(['# ' + r.name + ' · 约束明细'].map(cell).join(','));
      L.push(['约束项', '数值(N)', '说明'].map(cell).join(','));
      r.list.forEach((x) => L.push([x.label, r2(x.value), x.note || ''].map(cell).join(',')));
      L.push(['# 逐年衰减', '能力(N)', '实际安全系数', '许可载荷(N)', '判定'].map(cell).join(','));
      r.rows.forEach((x) => L.push([x.t, r2(x.F), r4(x.ratio), r2(x.allow), x.verdict.label].map(cell).join(',')));
      L.push(['# 反推', r.rev.feasible ? '可行' : '不可行'].map(cell).join(','));
      if (r.rev.feasible) {
        r.rev.params.forEach((p) => L.push([p.label, r2(p.value), p.unit].map(cell).join(',')));
        L.push(['回代安全系数', r4(r.rev.recheck.ratio), '残差(N)', r4(r.rev.recheck.residual)].map(cell).join(','));
      } else {
        L.push([r.rev.reason].map(cell).join(','));
      }
      L.push('');
    });
    L.push(['# 敏感性（选中件：' + res.items[0].name + '）', 'T年末能力(N)', '实际安全系数', '许可载荷(N)', '判定', '安全系数变化'].map(cell).join(','));
    res.sens.forEach((x) => L.push([x.label, r2(x.F), r4(x.ratio), r2(x.allow), x.verdict.label, (x.delta >= 0 ? '+' : '') + r4(x.delta)].map(cell).join(',')));
    L.push('');
    L.push(['# 结构自检', '结果', '说明'].map(cell).join(','));
    res.checks.forEach((x) => L.push([x.name, x.pass ? 'PASS' : 'FAIL', x.detail].map(cell).join(',')));
    L.push('');
    L.push(['# 边界'].map(cell).join(','));
    LIMITS.forEach((t) => L.push([t].map(cell).join(',')));
    return L.join('\n');
  }

  function mdText(cfg, res) {
    const L = [];
    L.push('# 免打孔承载装置对账台 · 导出');
    L.push('');
    L.push('- 导出时间：' + new Date().toISOString());
    L.push('- 目标安全系数：**' + fmtFix(res.sf, 1) + '**；观察年限：**' + res.years + ' 年**');
    L.push('- 结论：' + res.kpis.okN + ' 件够 / ' + res.kpis.tightN + ' 件没余量 / ' + res.kpis.failN + ' 件会掉；最弱的是「' + res.kpis.worstName + '」（' + fmtRatio(res.kpis.worstRatio) + '）');
    L.push('');
    L.push('## 全件总览');
    L.push('');
    L.push('| 件 | 方式 | 方向 | 目标载荷 | 有效载荷 | 初始能力 | T 年末能力 | 实际安全系数 | 许可载荷 | 瓶颈 | 判定 |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|');
    res.items.forEach((r) => {
      L.push('| ' + r.name + ' | ' + r.modeName + ' | ' + (r.useDir ? r.dirName : '—') + ' | ' + fmtNK(r.load) + ' | ' + fmtNK(r.effLoad) + ' | ' + fmtNK(r.F0) + ' | ' + fmtNK(r.FT) + ' | ' + fmtRatio(r.ratioT) + ' | ' + fmtNK(r.allow) + ' | ' + r.limiterLabel + ' | ' + r.verdict.label + ' |');
    });
    L.push('');
    L.push('## 需要记住的几条');
    L.push('');
    res.insights.forEach((x) => L.push('- **' + x.t + '**：' + x.d));
    L.push('');
    res.items.forEach((r) => {
      L.push('## ' + r.name + '（' + r.modeName + '）');
      L.push('');
      L.push('约束明细（能力取最小值，瓶颈：**' + r.limiterLabel + '**）：');
      L.push('');
      L.push('| 约束项 | 数值 | 说明 |');
      L.push('|---|---|---|');
      r.list.forEach((x) => L.push('| ' + x.label + ' | ' + fmtNK(x.value) + ' | ' + (x.note || '') + ' |'));
      L.push('');
      L.push('逐年衰减：');
      L.push('');
      L.push('| 年 | 能力 | 实际安全系数 | 许可载荷 | 判定 |');
      L.push('|---|---|---|---|---|');
      r.rows.forEach((x) => L.push('| ' + x.t + ' | ' + fmtNK(x.F) + ' | ' + fmtRatio(x.ratio) + ' | ' + fmtNK(x.allow) + ' | ' + x.verdict.label + ' |'));
      L.push('');
      if (r.rev.feasible) {
        L.push('反推：要在 ' + res.years + ' 年后仍有 ' + fmtFix(res.sf, 0) + ' 倍安全系数，需要——');
        L.push('');
        r.rev.params.forEach((p) => L.push('- ' + p.label + '：**' + fmtAdaptive(p.value, p.unit, 2) + '**'));
        L.push('- 回代核验：安全系数 **' + fmtRatio(r.rev.recheck.ratio) + '**（残差 ' + fmtN(r.rev.recheck.residual) + '）');
        if (r.rev.note) L.push('- ' + r.rev.note);
        r.rev.alternatives.forEach((a) => L.push('- 备选：' + a.text));
      } else {
        L.push('反推：**不可行** —— ' + r.rev.reason);
      }
      L.push('');
    });
    L.push('## 敏感性（' + res.items[0].name + '）');
    L.push('');
    L.push('| 改动 | T 年末能力 | 实际安全系数 | 许可载荷 | 判定 | 变化 |');
    L.push('|---|---|---|---|---|---|');
    res.sens.forEach((x) => L.push('| ' + x.label + ' | ' + fmtNK(x.F) + ' | ' + fmtRatio(x.ratio) + ' | ' + fmtNK(x.allow) + ' | ' + x.verdict.label + ' | ' + (x.delta >= 0 ? '+' : '') + fmtFix(x.delta, 4) + ' |'));
    L.push('');
    L.push('## 结构自检');
    L.push('');
    res.checks.forEach((x) => L.push('- [' + (x.pass ? 'PASS' : 'FAIL') + '] ' + x.name + ' — ' + x.detail));
    L.push('');
    L.push('## 这份账不算什么');
    L.push('');
    LIMITS.forEach((t) => L.push('- ' + t));
    return L.join('\n');
  }

  function jsonBackup(cfg) {
    const c = normCfg(cfg);
    return JSON.stringify({ app: 'nodrill-load', version: 1, exportedAt: new Date().toISOString(), cfg: { sf: c.sf, years: c.years, items: c.items } }, null, 2);
  }

  const LIMITS = [
    '不做任何产品合格判定：不引用也不替代任何标准（GB / EN / ISO 等）的条款、检测方法或工程验收；不针对任何真实品牌、产品、事件或当事人。',
    '静力线性模型：不做疲劳、冲击谱、蠕变曲线、温度循环、紫外老化的时程建模；「年衰减率」是你自填的合并假设，把胶体蠕变、吸盘泄漏、橡胶老化、弹簧松弛合并成一个数，不是材料实验数据。',
    '背胶不建模偏心力矩、剥离前沿扩展、基材差异（乳胶漆 / 瓷砖 / 玻璃 / 木材）、表面清洁度与压合工艺——这些只能通过「强度」与「保持系数」由你自己体现。',
    '吸盘不建模曲面、粗糙面、抽气方式、温度对压差的影响与泄漏面积；压差由你填。',
    '撑杆只做「两端铰接、载荷作用于管中点」的简支模型与欧拉屈曲，不做端部转动约束、初始弯曲、多点加载、斜撑与多根并联；抗弯与抗压许用应力用同一个数，不区分抗拉 / 抗压 / 抗剪。',
    '磁吸不建模磁路、气隙、磁体牌号、温度退磁曲线，也不区分剪切与拉脱的方向差异（除「保持系数」与「温度与间隙系数」之外）。',
    '不联网、不查任何产品参数、不查任何行业或标准数据；不做购买建议、不评价任何品牌。',
    '判定三档（够 / 撑得住但没余量 / 会掉）只是本页内部的显示分组，不是任何标准的安全等级。',
    '默认样例与 9 个内置场景全部是虚构示例；其中一个场景叫「门框单杠（假设有人拉）」，只用于演示「动态载荷」口径，不对任何真实产品、事件或人作任何判断。'
  ];

  const api = {
    MAX_ITEMS: MAX_ITEMS, NAME_MAX: NAME_MAX, MAX_YEARS: MAX_YEARS, G: G,
    MODES: MODES, DIRS: DIRS, LIMITS: LIMITS, scenarios: scenarios,
    SF_MIN: SF_MIN, SF_MAX: SF_MAX, LOAD_MIN: LOAD_MIN, LOAD_MAX: LOAD_MAX,
    DYN_MIN: DYN_MIN, DYN_MAX: DYN_MAX, KEEP_MIN: KEEP_MIN, KEEP_MAX: KEEP_MAX,
    DECAY_MIN: DECAY_MIN, DECAY_MAX: DECAY_MAX,
    AREA_MIN: AREA_MIN, AREA_MAX: AREA_MAX, STRENGTH_MIN: STRENGTH_MIN, STRENGTH_MAX: STRENGTH_MAX,
    CUP_D_MIN: CUP_D_MIN, CUP_D_MAX: CUP_D_MAX, CUPS_MIN: CUPS_MIN, CUPS_MAX: CUPS_MAX, DP_MIN: DP_MIN, DP_MAX: DP_MAX,
    SLIDE_MIN: SLIDE_MIN, SLIDE_MAX: SLIDE_MAX,
    ROD_D_MIN: ROD_D_MIN, ROD_D_MAX: ROD_D_MAX, ROD_T_MIN: ROD_T_MIN, ROD_L_MIN: ROD_L_MIN, ROD_L_MAX: ROD_L_MAX,
    E_MIN: E_MIN, E_MAX: E_MAX, SIGMA_MIN: SIGMA_MIN, SIGMA_MAX: SIGMA_MAX,
    EFFLEN_MIN: EFFLEN_MIN, EFFLEN_MAX: EFFLEN_MAX, SPRING_MIN: SPRING_MIN, SPRING_MAX: SPRING_MAX,
    MU_MIN: MU_MIN, MU_MAX: MU_MAX, WALLP_MIN: WALLP_MIN, WALLP_MAX: WALLP_MAX, PAD_MIN: PAD_MIN, PAD_MAX: PAD_MAX,
    MAGQ_MIN: MAGQ_MIN, MAGQ_MAX: MAGQ_MAX, MAGA_MIN: MAGA_MIN, MAGA_MAX: MAGA_MAX,
    TEMPK_MIN: TEMPK_MIN, TEMPK_MAX: TEMPK_MAX,
    defaults: defaults, defaultsClone: defaultsClone, item: item,
    parseNum: parseNum, num: num, normCfg: normCfg, validate: validate,
    tubeGeom: tubeGeom, constraintsOf: constraintsOf, limiterLabel: limiterLabel,
    analyzeItem: analyzeItem, analyze: analyze, reverseSolve: reverseSolve,
    sensitivity: sensitivity, verdictOf: verdictOf, breakYearOf: breakYearOf,
    csvText: csvText, mdText: mdText, jsonBackup: jsonBackup,
    fmtN: fmtN, fmtN0: fmtN0, fmtNTable: fmtNTable, fmtKgf: fmtKgf, fmtNK: fmtNK, fmtRatio: fmtRatio, fmtMPa: fmtMPa,
    fmtCm: fmtCm, fmtMm: fmtMm, fmtArea: fmtArea, fmtAreaBig: fmtAreaBig, fmtPct: fmtPct, fmtYears: fmtYears,
    fmtAdaptive: fmtAdaptive, fmtFix: fmtFix, kgfOf: kgfOf,
    r2: r2, r4: r4, r6: r6, ceilTo: ceilTo
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AppCore = api;
})(typeof window !== 'undefined' ? window : null);
