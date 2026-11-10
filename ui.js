/* 免打孔承载装置对账台 · 界面（nodrill-load）
 * 依赖 window.AppCore（core.js）。所有展示数字都来自同一次 analyze() 的结果。
 */
(function () {
  'use strict';
  const C = window.AppCore;
  const $ = (id) => document.getElementById(id);
  const STORE_KEY = 'nodrill-load:v1';

  const state = { res: null, checks: [], errors: [], items: null, sel: 0, exports: 0, renders: 0 };

  /* 每种安装方式的专属输入（顺序即渲染顺序） */
  const FIELDS = {
    glue: [
      { key: 'area', label: '有效粘贴面积', unit: 'cm²' },
      { key: 'tau', label: '剪切强度', unit: 'MPa' },
      { key: 'peel', label: '剥离强度', unit: 'MPa' }
    ],
    suction: [
      { key: 'cupD', label: '单只吸盘有效直径', unit: 'cm' },
      { key: 'cups', label: '吸盘只数', unit: '只' },
      { key: 'dP', label: '内外压差', unit: 'kPa' },
      { key: 'slide', label: '侧向滑移系数', unit: '0–1' }
    ],
    rod: [
      { key: 'rodD', label: '管外径', unit: 'mm' },
      { key: 'rodT', label: '壁厚', unit: 'mm' },
      { key: 'rodL', label: '管长（跨距）', unit: 'cm' },
      { key: 'E', label: '弹性模量', unit: 'MPa' },
      { key: 'sigma', label: '许用应力', unit: 'MPa' },
      { key: 'effLen', label: '有效长度系数', unit: '0.5–2' },
      { key: 'springN', label: '最大压紧力', unit: 'N' },
      { key: 'mu', label: '端部摩擦系数', unit: '—' },
      { key: 'wallP', label: '墙面许用压强', unit: 'MPa' },
      { key: 'padA', label: '单个垫片面积', unit: 'cm²' }
    ],
    magnet: [
      { key: 'magQ', label: '单位面积吸力', unit: 'N/cm²' },
      { key: 'magA', label: '有效接触面积', unit: 'cm²' },
      { key: 'tempK', label: '温度与间隙系数', unit: '%' }
    ]
  };
  const COMMON = [{ key: 'load', label: '目标载荷', unit: 'N' }, { key: 'dyn', label: '动载系数', unit: '1–3' }];
  const MODE_HINT = {
    glue: '背胶的可用强度取决于<b>力的方向</b>：顺墙（剪切）用剪切强度，垂直往外拉（剥离）用剥离强度——两者常常差一个量级。',
    suction: '吸盘能力 = 内外压差 × 有效面积 × 只数 × 保持系数；顺墙方向还要再乘<b>侧向滑移系数</b>（滑移通常才是封顶的那一项）。',
    rod: '撑杆先用四项取最小得到能压多紧（弹簧 / 欧拉屈曲 / 管材屈服 / 墙面压强），再算摩擦自锁 2μN 与<b>管件抗弯</b>，承载力取这两者较小。',
    magnet: '磁吸能力 = 单位面积吸力 × 有效接触面积 × 保持系数 × 温度与间隙系数；「单位面积吸力」由你自己按磁铁规格填。'
  };
  const fmt = (x, u) => C.fmtAdaptive(x, u, 2);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const PILL = { ok: 'ok', tight: 'tight', fail: 'fail' };
  const pill = (v) => '<span class="pill ' + (PILL[v.id] || 'tight') + '">' + esc(v.label) + '</span>';
  function patchLabel(p) {
    if (p && p.dir) {
      const d = C.DIRS.filter((x) => x.id === p.dir)[0];
      return '改成「' + (d ? d.short : p.dir) + '」试试';
    }
    return '换成这个设置试试';
  }

  function toast(msg) {
    let t = $('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.style.opacity = '0'; }, 1900);
  }

  /* ── 清单渲染 ─────────────────────────────────────── */
  function modeOptions(cur) {
    return C.MODES.map((m) => '<option value="' + m.id + '"' + (m.id === cur ? ' selected' : '') + '>' + esc(m.name) + '</option>').join('');
  }
  function dirOptions(cur) {
    return C.DIRS.map((d) => '<option value="' + d.id + '"' + (d.id === cur ? ' selected' : '') + '>' + esc(d.name) + '</option>').join('');
  }
  function itemHTML(it, i) {
    const mode = C.MODES.filter((m) => m.id === it.mode)[0] || C.MODES[0];
    const fields = FIELDS[mode.id] || [];
    let h = '<div class="item" data-item="' + i + '">';
    h += '<div class="itemhead"><span class="idx">第 ' + (i + 1) + ' 件</span>';
    h += '<input class="nm" type="text" id="f-name-' + i + '" value="' + esc(it.name) + '" maxlength="24" placeholder="名称">';
    h += '<select id="f-mode-' + i + '" aria-label="安装方式">' + modeOptions(mode.id) + '</select>';
    if (mode.useDir) h += '<select id="f-dir-' + i + '" aria-label="受力方向">' + dirOptions(it.dir) + '</select>';
    h += '</div><div class="gridf">';
    COMMON.forEach((f) => { h += '<label>' + f.label + '（' + f.unit + '）<input type="text" id="f-' + f.key + '-' + i + '"></label>'; });
    if (mode.useKeep) h += '<label>有效保持系数（%）<input type="text" id="f-keep-' + i + '"></label>';
    h += '<label>年衰减率（%/年）<input type="text" id="f-decay-' + i + '"></label>';
    fields.forEach((f) => { h += '<label>' + f.label + '（' + f.unit + '）<input type="text" id="f-' + f.key + '-' + i + '"></label>'; });
    h += '</div><p class="footnote" id="hint-' + i + '">' + MODE_HINT[mode.id] + '</p></div>';
    return h;
  }
  function renderItems(items) {
    $('items').innerHTML = items.map(itemHTML).join('');
    $('itemCount').textContent = items.length + ' / ' + C.MAX_ITEMS;
    fillValues(items);
  }
  function fillValues(items) {
    items.forEach((it, i) => {
      const set = (id, v) => { const el = $(id); if (el && v !== undefined && v !== null) el.value = String(v); };
      set('f-name-' + i, it.name); set('f-mode-' + i, it.mode); set('f-dir-' + i, it.dir);
      set('f-load-' + i, it.load); set('f-dyn-' + i, it.dyn); set('f-keep-' + i, it.keep); set('f-decay-' + i, it.decay);
      (FIELDS[it.mode] || []).forEach((f) => set('f-' + f.key + '-' + i, it[f.key]));
    });
  }
  /* 只读回「当前 DOM 里存在的输入」，不存在（被折叠）的字段保留原值 */
  function readItems() {
    const items = state.items;
    items.forEach((it, i) => {
      const g = (id) => { const el = $(id); return el ? el.value : undefined; };
      const n = g('f-name-' + i); if (n !== undefined) it.name = n;
      const m = g('f-mode-' + i); if (m !== undefined) it.mode = m;
      const d = g('f-dir-' + i); if (d !== undefined) it.dir = d;
      COMMON.forEach((f) => { const v = g('f-' + f.key + '-' + i); if (v !== undefined) it[f.key] = v; });
      const k = g('f-keep-' + i); if (k !== undefined) it.keep = k;
      const dc = g('f-decay-' + i); if (dc !== undefined) it.decay = dc;
      (FIELDS[it.mode] || []).forEach((f) => { const v = g('f-' + f.key + '-' + i); if (v !== undefined) it[f.key] = v; });
    });
    return { sf: $('sf').value, years: $('years').value, items: items };
  }
  function applyCfg(cfg) {
    const d = C.defaultsClone();
    state.items = (cfg.items || d.items).map((it) => Object.assign(C.item({}), it));
    $('sf').value = cfg.sf !== undefined ? cfg.sf : d.sf;
    $('years').value = cfg.years !== undefined ? cfg.years : d.years;
    renderItems(state.items);
  }

  /* ── 计算与渲染 ───────────────────────────────────── */
  function compute() {
    const cfg = readItems();
    const res = C.analyze(cfg);
    const errBox = $('errors');
    if (!res.ok) {
      state.errors = res.errors;
      errBox.innerHTML = '<div class="errbox"><b>先修好这些再算：</b><ul class="tight">' +
        res.errors.slice(0, 12).map((e) => '<li>' + esc(e.msg) + '</li>').join('') +
        (res.errors.length > 12 ? '<li>……还有 ' + (res.errors.length - 12) + ' 条</li>' : '') + '</ul></div>';
      document.querySelectorAll('input.bad, select.bad').forEach((el) => el.classList.remove('bad'));
      res.errors.forEach((e) => { const el = $('f-' + e.field + '-' + e.i); if (el) el.classList.add('bad'); });
      const g = $('f-' + res.errors[0].field + '-' + res.errors[0].i);
      if (!g) { const el = $(res.errors[0].field); if (el) el.classList.add('bad'); }
      return;
    }
    state.errors = [];
    errBox.innerHTML = '';
    document.querySelectorAll('input.bad, select.bad').forEach((el) => el.classList.remove('bad'));
    state.res = res;
    if (state.sel >= res.items.length) state.sel = 0;
    render(res);
  }

  function render(res) {
    state.renders++;
    const k = res.kpis;
    const sel = res.items[state.sel] || res.items[0];
    $('verdictTag').textContent = k.okN + ' 够 / ' + k.tightN + ' 没余量 / ' + k.failN + ' 会掉';
    $('headline').innerHTML = '按这组假设（安全系数 <b>' + C.fmtFix(res.sf, 1) + '</b>、看 <b>' + res.years +
      '</b> 年）：<b>' + k.okN + '</b> 件够、<b>' + k.tightN + '</b> 件撑得住但没余量、<b>' + k.failN + '</b> 件会掉。' +
      '最弱的是「<b>' + esc(k.worstName) + '</b>」，实际安全系数 <b>' + C.fmtRatio(k.worstRatio) + '</b>（' + k.worstVerdict.label +
      '），瓶颈是<b>' + esc(k.worstLimiter) + '</b>。';
    $('kpis').innerHTML = [
      { k: '达标件数（实际安全系数 ≥ ' + C.fmtFix(res.sf, 1) + '）', v: k.okN + ' / ' + k.total, s: '没余量 ' + k.tightN + ' 件、会掉 ' + k.failN + ' 件' },
      { k: '最弱一件', v: C.fmtRatio(k.worstRatio), s: esc(k.worstName) + ' · 瓶颈 ' + esc(k.worstLimiter) },
      { k: '按当前假设做不到的件', v: k.infeasibleN + ' 件', s: k.infeasibleN ? esc(k.infeasibleNames.join('、')) : '每件都有可落地的改法' },
      { k: '目标载荷合计', v: C.fmtN(k.totalLoad), s: C.fmtKgf(k.totalLoad) + ' · 共 ' + k.total + ' 件' }
    ].map((x) => '<div class="kpi"><div class="k">' + x.k + '</div><div class="v">' + x.v + '</div><div class="s">' + x.s + '</div></div>').join('');

    const warns = [];
    res.items.forEach((it) => it.warnings.forEach((w) => warns.push('<b>' + esc(it.name) + '</b>：' + w)));
    $('warnBox').innerHTML = warns.length ? '<div class="warnbox">' + warns.map((w) => '<div>' + w + '</div>').join('') + '</div>' : '';

    /* 全件总览 */
    $('ovBody').innerHTML = res.items.map((it, i) => {
      const w = Math.max(0, Math.min(100, it.ratioT / res.sf * 100));
      const col = it.verdict.id === 'ok' ? 'var(--good)' : it.verdict.id === 'tight' ? 'var(--warn)' : 'var(--bad)';
      return '<tr class="pick' + (i === state.sel ? ' sel' : '') + '" data-i="' + i + '">' +
        '<td>' + esc(it.name) + ' ' + pill(it.verdict) + '<div class="muted" style="font-size:11px">瓶颈：' + esc(it.limiterLabel) + '</div></td>' +
        '<td>' + esc(it.modeShort) + (it.useDir ? '·' + esc(it.dirShort) : '') + '</td>' +
        '<td>' + C.fmtNTable(it.load) + '</td><td>' + C.fmtNTable(it.effLoad) + '</td><td>' + C.fmtNTable(it.F0) + '</td>' +
        '<td>' + C.fmtNTable(it.FT) + '</td>' +
        '<td><span class="' + (it.verdict.id === 'ok' ? 'vd' : it.verdict.id === 'tight' ? 'vt' : 'vf') + '">' + C.fmtRatio(it.ratioT) + '</span>' +
        '<div class="bar" style="margin-top:3px"><i style="width:' + w.toFixed(1) + '%;background:' + col + '"></i></div></td>' +
        '<td>' + C.fmtNTable(it.allow) + '</td></tr>';
    }).join('');

    /* 选中件 */
    $('selName').textContent = sel.name + ' · ' + sel.modeName;
    const groups = [];
    if (sel.mode === 'rod') {
      groups.push({ title: '压紧力上限（四项取最小 → N = ' + C.fmtN0(sel.extra.Neff) + '）', items: sel.list.filter((x) => x.group === 'N') });
      groups.push({ title: '承载能力（两项取最小 → 能力 = ' + C.fmtN(sel.F0) + '）', items: sel.list.filter((x) => x.group !== 'N') });
    } else {
      groups.push({ title: '约束项（能力取最小）', items: sel.list });
    }
    $('binding').innerHTML = groups.map((grp) => {
      const mm = grp.items.reduce((m, x) => Math.min(m, x.value), Infinity);
      return '<div class="kv">' + grp.items.map((x) => {
        const bind = Math.abs(x.value - mm) < 1e-9;
        return '<div class="row"><div class="k">' + esc(x.label) + (bind ? ' <span class="tag">瓶颈</span>' : '') + '</div>' +
          '<div class="v">' + C.fmtNK(x.value) + '</div><div class="k muted">' + esc(x.note || '') + '</div></div>';
      }).join('') + '</div><p class="footnote">' + esc(grp.title) + '</p>';
    }).join('');

    $('yearBody').innerHTML = sel.rows.map((r) => '<tr' + (r.t === res.years ? ' class="sum"' : '') + '><td>' + (r.t === 0 ? '第 0 年（现在）' : '第 ' + r.t + ' 年') + '</td>' +
      '<td>' + C.fmtN(r.F) + '</td><td>' + C.fmtRatio(r.ratio) + '</td><td>' + C.fmtN(r.allow) + '</td><td>' + pill(r.verdict) + '</td></tr>').join('');
    const by = sel.breakYear, sy = sel.sfBreakYear;
    $('yearNote').innerHTML = '「T 年末能力」= 初始能力 × (1 − ' + C.fmtPct(sel.decay, 1) + ')^T。' +
      (by === null ? '按这组假设，实际安全系数在整个观察期内不会跌破 1.00。'
        : by === 0 ? '按这组假设，<b>现在就已经不够</b>（实际安全系数 ' + C.fmtRatio(sel.ratio0) + '）。'
          : '大约在<b>第 ' + C.fmtFix(Math.floor(by * 10) / 10, 1) + ' 年</b>前后跌破 1.00（撑不住）。') +
      (sy === null ? '' : (sy === 0 ? ' 另外，它<b>从一开始就没有达到</b>目标安全系数 ' + C.fmtFix(res.sf, 1) + '。'
        : ' 而跌破目标安全系数 ' + C.fmtFix(res.sf, 1) + ' 的位置在第 ' + C.fmtFix(Math.floor(sy * 10) / 10, 1) + ' 年。'));

    /* 反推 */
    const rv = sel.rev;
    if (rv.feasible) {
      $('revBody').innerHTML = '<div class="okbox">要在第 ' + res.years + ' 年末仍有 <b>' + C.fmtFix(res.sf, 1) + ' 倍</b>安全系数，' +
        '需要的初始能力是 <b>' + C.fmtN(rv.need0) + '</b>（= 有效载荷 ' + C.fmtN(sel.effLoad) + ' × ' + C.fmtFix(res.sf, 1) + ' ÷ (1−' + C.fmtPct(sel.decay, 1) + ')^' + res.years + '）。</div>' +
        '<div class="kv" style="margin-top:10px">' + rv.params.map((p) => '<div class="row"><div class="k">' + esc(p.label) + (p.alreadyOK ? ' <span class="tag gray">当前已够</span>' : '') + '</div>' +
          '<div class="v">' + fmt(p.value, p.unit) + '</div><div class="k muted">' + (p.readOnly ? '参考值' : '你当前填的是 ' + fmt(p.cur, p.unit)) + '</div></div>').join('') + '</div>' +
        '<p class="footnote">回代核验：把取整后的解带回去重算，第 ' + res.years + ' 年末实际安全系数 = <b>' + C.fmtRatio(rv.recheck.ratio) +
        '</b>（残差 ' + C.fmtN(rv.recheck.residual) + ' = 落地后的初始能力比所需多出的部分，' + C.fmtPct(rv.recheck.residualPct, 1) +
        '；残差很大通常说明<b>你现在的设置本来就超过所需</b>，不是算错）。' + (rv.note ? ' ' + esc(rv.note) : '') + '</p>' +
        '<div class="btns">' +
        (rv.params.some((p) => !p.readOnly && !p.alreadyOK)
          ? '<button type="button" class="primary" data-act="apply">一键采用这些数字</button>' : '') +
        rv.alternatives.filter((a) => a.patch).map((a) => '<button type="button" data-act="patch" data-patch=\'' + esc(JSON.stringify(a.patch)) + '\'>' + esc(patchLabel(a.patch)) + '</button>').join('') +
        '</div>' +
        (rv.alternatives.length ? '<p class="footnote">' + rv.alternatives.map((a) => esc(a.text)).join('<br>') + '</p>' : '');
    } else {
      $('revBody').innerHTML = '<div class="errbox"><b>按当前假设：做不到。</b><br>' + esc(rv.reason) +
        '<br><span class="muted">本页不会为了给出一个能过的数字而放宽口径。</span></div>' +
        (rv.alternatives && rv.alternatives.length ? '<p class="footnote">' + rv.alternatives.map((a) => esc(a.text)).join('<br>') + '</p>' : '');
    }

    /* 值得记住的几条 */
    $('insights').innerHTML = res.insights.map((x) => '<div class="slice"><span class="st">' + esc(x.t) + '</span>' + esc(x.d) + '</div>').join('');

    /* 敏感性（对选中件） */
    const sens = C.sensitivity(sel.item, res.sf, res.years);
    $('sensOf').textContent = '对「' + sel.name + '」';
    $('sensBody').innerHTML = sens.map((r, i) => '<tr' + (i === 0 ? ' class="sum"' : '') + '><td>' + esc(r.label) + (r.note ? ' <span class="muted">（' + esc(r.note) + '）</span>' : '') + '</td><td>' + C.fmtN(r.F) + '</td>' +
      '<td>' + C.fmtRatio(r.ratio) + '</td><td>' + C.fmtN(r.allow) + '</td><td>' + pill(r.verdict) + '</td>' +
      '<td>' + (i === 0 ? '—' : (r.delta >= 0 ? '+' : '−') + C.fmtFix(Math.abs(r.delta), 3)) + '</td></tr>').join('');

    $('steps').innerHTML = res.steps.map((s) => '<li>' + esc(s) + '</li>').join('');
    $('limits').innerHTML = C.LIMITS.map((s) => '<li>' + esc(s) + '</li>').join('');
    const pass = res.checks.filter((c) => c.pass).length;
    $('checkTag').textContent = pass + ' / ' + res.checks.length + ' 通过';
    $('checks').innerHTML = res.checks.map((c) => '<li>' + (c.pass ? '<span class="vd">✔</span> ' : '<span class="vf">✘</span> ') +
      esc(c.name) + ' <span class="muted">— ' + esc(c.detail) + '</span></li>').join('');
  }

  /* ── 导出 ─────────────────────────────────────────── */
  function download(name, text, type) {
    const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
    state.exports++;
  }

  /* 结果卡 PNG（1080×1350）：固定坐标分块排布，避免「流水式 y 累加」漏画或叠字 */
  function pngCard() {
    if (!state.res) { toast('先让输入通过校验'); return; }
    const res = state.res;
    const W = 1080, H = 1350;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const FONT = (w2, sz) => w2 + ' ' + sz + 'px "PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
    const toks = (t) => String(t).match(/[A-Za-z0-9.,%×÷+\-−/（）()]+|\s+|[\u4e00-\u9fa5]|[^\s]/g) || [];
    const wrap = (text, maxW, size, weight) => {
      g.font = FONT(weight || 400, size);
      const out = []; let line = '';
      toks(text).forEach((t) => {
        const t2 = line + t;
        if (g.measureText(t2).width > maxW && line.trim()) { out.push(line.replace(/\s+$/, '')); line = t.replace(/^\s+/, ''); }
        else line = t2;
      });
      if (line.trim()) out.push(line.replace(/\s+$/, ''));
      /* 不让收尾标点落在行首 */
      return out.map((x) => (/^[）)；，。、%》]/.test(x) ? '　' + x : x));
    };
    const put = (text, x, y, size, color, weight, maxW, lh) => {
      g.fillStyle = color; g.font = FONT(weight || 400, size);
      const lines = maxW ? wrap(text, maxW, size, weight) : [String(text)];
      lines.forEach((ln, i) => g.fillText(ln, x, y + i * (lh || size + 8)));
      return y + lines.length * (lh || size + 8);
    };
    /* 按可用宽度截断（末位用 …），避免长名称画到下一列上叠字 */
    const fitText = (text, maxW, size, weight) => {
      g.font = FONT(weight || 400, size);
      let s2 = String(text);
      if (g.measureText(s2).width <= maxW) return s2;
      while (s2.length > 1 && g.measureText(s2 + '…').width > maxW) s2 = s2.slice(0, -1);
      return s2 + '…';
    };
    const putFit = (text, x, y, size, minSize, color, weight, maxW) => {
      let sz = size;
      g.font = FONT(weight || 400, sz);
      while (sz > minSize && g.measureText(String(text)).width > maxW) { sz -= 1; g.font = FONT(weight || 400, sz); }
      g.fillStyle = color; g.font = FONT(weight || 400, sz);
      g.fillText(String(text), x, y);
    };
    const k = res.kpis;
    const worst = res.items.slice().sort((a, b) => a.ratioT - b.ratioT)[0];
    const dec = res.items.slice().sort((a, b) => b.decay - a.decay)[0];

    g.fillStyle = '#f5f6f8'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#0f5fa6'; g.fillRect(0, 0, W, 12);
    put('免打孔承载装置对账台', 72, 106, 50, '#161b22', 700);
    put('安全系数 ' + C.fmtFix(res.sf, 1) + ' · 看 ' + res.years + ' 年 · ' + res.items.length + ' 件（背胶 / 吸盘 / 撑杆 / 磁吸）', 72, 150, 23, '#4a5568', 400, W - 144);

    /* 结论框 176–360 */
    const win = k.failN === 0 && k.tightN === 0;
    g.fillStyle = win ? '#e8f6ef' : (k.failN > 0 ? '#fdeceb' : '#fff5e5');
    g.fillRect(72, 176, W - 144, 184);
    put('按这组假设：' + k.okN + ' 件够 / ' + k.tightN + ' 件没余量 / ' + k.failN + ' 件会掉', 96, 224, 33, win ? '#0f7b52' : (k.failN > 0 ? '#b42318' : '#9a5b00'), 700, W - 240);
    put('最弱「' + worst.name + '」实际安全系数 ' + C.fmtRatio(worst.ratioT) + '（' + worst.verdict.label + '），瓶颈是' + worst.limiterLabel, 96, 276, 24, '#161b22', 500, W - 240);
    put('按当前假设做不到的件：' + (k.infeasibleN ? k.infeasibleNames.join('、') : '无（每件都有可落地的改法）'), 96, 322, 23, '#37424f', 400, W - 240);

    /* KPI 2×2：380–616 */
    const kpi = [
      ['最弱一件的实际安全系数', C.fmtRatio(k.worstRatio)],
      ['最弱件的瓶颈', worst.limiterLabel],
      ['目标载荷合计', C.fmtN(k.totalLoad) + '（' + C.fmtKgf(k.totalLoad) + '）'],
      ['衰减最狠的一件', dec.name + ' ' + C.fmtPct(dec.decay, 0) + '/年']
    ];
    kpi.forEach((x, i) => {
      const px = 72 + (i % 2) * 476, py = 380 + Math.floor(i / 2) * 122;
      g.fillStyle = '#fff'; g.fillRect(px, py, 452, 114);
      g.strokeStyle = '#e3e6eb'; g.strokeRect(px, py, 452, 114);
      g.fillStyle = '#4a5568'; g.font = FONT(400, 21); g.fillText(x[0], px + 22, py + 36);
      putFit(x[1], px + 22, py + 84, 32, 17, '#161b22', 700, 408);
    });

    /* 全件总览：标题 662 / 表头 698 / 行 744 起，每行 31，最多 6 行 */
    put('全件总览', 72, 662, 27, '#161b22', 700, W - 144);
    const cols = [72, 250, 356, 500, 640, 780, 918];
    g.fillStyle = '#7b8794'; g.font = FONT(400, 19);
    ['件 / 方式', '目标载荷', '初始能力', 'T 年末能力', '安全系数', '许可载荷', '判定'].forEach((t, i) => g.fillText(t, cols[i], 698));
    g.strokeStyle = '#e3e6eb'; g.beginPath(); g.moveTo(72, 710); g.lineTo(W - 72, 710); g.stroke();
    let ry = 744;
    res.items.slice(0, 6).forEach((it) => {
      g.font = FONT(400, 21); g.fillStyle = '#37424f';
      g.font = FONT(400, 21); g.fillStyle = '#37424f';
      g.fillText(fitText(it.name + '（' + it.modeShort + '）', cols[1] - cols[0] - 18, 21, 400), cols[0], ry);
      g.fillText(C.fmtN(it.load), cols[1], ry);
      g.fillText(C.fmtN(it.F0), cols[2], ry);
      g.fillText(C.fmtN(it.FT), cols[3], ry);
      g.fillStyle = it.verdict.id === 'ok' ? '#0f7b52' : it.verdict.id === 'tight' ? '#9a5b00' : '#b42318';
      g.fillText(C.fmtRatio(it.ratioT), cols[4], ry);
      g.fillStyle = '#37424f';
      g.fillText(C.fmtN(it.allow), cols[5], ry);
      g.fillText(it.verdict.label, cols[6], ry);
      ry += 31;
    });

    /* 下半部自底向上排布：页脚 → 口径 → 要点框，保证任何内容长度都不会叠字 */
    const FOOT = [
      '安全系数 ' + C.fmtFix(res.sf, 1) + ' / 观察 ' + res.years + ' 年 / 逐件年衰减率见页面；强度、保持系数、衰减率全部由用户自填，是假设不是事实',
      '不做产品合格判定、不引用任何标准、不联网、不查产品参数；默认与场景都是虚构示例、不对任何真实产品与事件作判断'
    ];
    const footLh = 26;
    let fy = H - 34 - (FOOT.length - 1) * footLh;
    const ruleY = fy - 34;
    FOOT.forEach((t) => { put(t, 72, fy, 19, '#7b8794', 400, W - 144); fy += footLh; });
    g.fillStyle = '#e3e6eb'; g.fillRect(72, ruleY, W - 144, 1);

    const CAL = [
      '实际安全系数 = 能力 ÷（目标载荷 × 动载系数）；许可载荷 = 能力 ÷（安全系数 × 动载系数）',
      '年衰减按 (1−d)^T 作用在能力上；能力取该方式全部约束的最小值，反推解一律向上取整并回代重算'
    ];
    const calTop = ruleY - 24 - CAL.length * 28;
    put('口径', 72, calTop, 23, '#161b22', 700, W - 144);
    CAL.forEach((t, i) => put(t, 72, calTop + 34 + i * 28, 20, '#37424f', 400, W - 144));

    const b1 = '最弱的是「' + worst.name + '」：实际安全系数 ' + C.fmtRatio(worst.ratioT) + '（' + worst.verdict.label + '），瓶颈是' + worst.limiterLabel;
    const b2 = '「' + dec.name + '」按 ' + C.fmtPct(dec.decay, 0) + '/年 衰减，第 ' + res.years + ' 年末只剩 ' + C.fmtPct(dec.FT / dec.F0 * 100, 1) + ' 的能力（' + C.fmtN(dec.F0) + ' → ' + C.fmtN(dec.FT) + '）';
    const b3 = k.infeasibleN > 0 ? ('有 ' + k.infeasibleN + ' 件按当前假设做不到：' + k.infeasibleNames.join('、') + '——页面直接说做不到，不凑数字') : '每件「要挂住目标重量需要改什么」都在页面反推区给出，并且把取整后的解回代重算过';
    let bullets = [b1, b2, b3];
    let inner = 0, lines = [];
    while (bullets.length) {
      lines = bullets.map((t) => wrap(t, W - 240, 21, 400).length);
      inner = lines.reduce((s, x) => s + x, 0) * 29 + 22;
      if (946 + inner + 32 + 24 + CAL.length * 28 + 44 + FOOT.length * footLh + 40 <= H) break;
      bullets = bullets.slice(0, bullets.length - 1);
    }
    const boxTop = Math.max(946, calTop - 32 - inner);
    g.fillStyle = '#eaf2fa'; g.fillRect(72, boxTop, W - 144, inner);
    let by = boxTop + 34;
    bullets.forEach((t, i) => { by = put(t, 96, by, 21, i === 0 ? '#0f5fa6' : '#161b22', i === 0 ? 700 : 400, W - 240) + 2; });

    cv.toBlob((b) => {
      const url = URL.createObjectURL(b);
      const a = document.createElement('a');
      a.href = url; a.download = '免打孔承载装置对账台-结果卡.png'; a.style.display = 'none';
      document.body.appendChild(a); a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
      state.exports++;
    }, 'image/png');
  }

  /* ── 本机保存 / 导入 ─────────────────────────────── */
  function saveLocal() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(readItems()));
      $('saveState').textContent = '已保存到本机（' + new Date().toLocaleTimeString('zh-CN') + '）。只存在这个浏览器里。';
      toast('已保存到本机');
    } catch (e) { $('saveState').textContent = '这台浏览器不允许本机保存（可能是隐私模式）。'; }
  }
  function loadLocal(silent) {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) { if (!silent) toast('本机还没有保存过'); return false; }
      const o = JSON.parse(raw);
      if (!o || !Array.isArray(o.items)) throw new Error('结构不对');
      applyCfg(o);
      if (!silent) toast('已读取上次保存的输入');
      return true;
    } catch (e) { if (!silent) toast('本机保存的内容读不出来'); return false; }
  }
  function importBackup(file) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const o = JSON.parse(String(fr.result));
        if (o && o.app && o.app !== 'nodrill-load') throw new Error('不是本页的备份');
        const cfg = o && o.cfg ? o.cfg : o;
        if (!cfg || !Array.isArray(cfg.items)) throw new Error('结构不对');
        applyCfg(cfg);
        $('scenario').value = '';
        compute();
        toast('已导入备份' + (o && o.app ? '（' + o.app + '）' : ''));
      } catch (e) { toast('这个备份文件读不出来'); }
    };
    fr.readAsText(file);
  }

  /* ── 事件 ─────────────────────────────────────────── */
  function bind() {
    ['sf', 'years'].forEach((id) => $(id).addEventListener('input', compute));
    $('items').addEventListener('input', (e) => {
      if (e.target.matches('input[type=text]')) compute();
    });
    $('items').addEventListener('change', (e) => {
      if (!e.target.matches('select')) return;
      readItems();
      if (e.target.id.indexOf('f-mode-') === 0) { renderItems(state.items); compute(); }
      else if (e.target.id.indexOf('f-dir-') === 0) compute();
    });
    $('btnAdd').addEventListener('click', () => {
      readItems();
      if (state.items.length >= C.MAX_ITEMS) { toast('最多 ' + C.MAX_ITEMS + ' 件'); return; }
      state.items.push(C.item({ name: '新装置 ' + (state.items.length + 1) }));
      renderItems(state.items); compute();
    });
    $('btnDel').addEventListener('click', () => {
      readItems();
      if (state.items.length <= 1) { toast('至少要留一件'); return; }
      state.items.pop();
      if (state.sel >= state.items.length) state.sel = 0;
      renderItems(state.items); compute();
    });
    $('ovBody').addEventListener('click', (e) => {
      const tr = e.target.closest ? e.target.closest('tr[data-i]') : null;
      if (!tr) return;
      state.sel = Number(tr.getAttribute('data-i'));
      render(state.res);
    });
    $('revBody').addEventListener('click', (e) => {
      const btn = e.target.closest ? e.target.closest('button[data-act]') : null;
      if (!btn || !state.res) return;
      const sel = state.res.items[state.sel];
      const it = state.items[state.sel];
      const act = btn.getAttribute('data-act');
      if (act === 'apply') {
        Object.keys(sel.rev.applied).forEach((key) => { it[key] = String(sel.rev.applied[key]); });
        fillValues(state.items); compute(); toast('已按反推数字改输入（可再用「恢复默认示例」还原）');
      } else if (act === 'patch') {
        try {
          const p = JSON.parse(btn.getAttribute('data-patch'));
          Object.keys(p).forEach((key) => { it[key] = p[key]; });
          fillValues(state.items); compute(); toast('已改成：' + JSON.stringify(p));
        } catch (err) { toast('这个备选改不动'); }
      }
    });
    $('btnReset').addEventListener('click', () => {
      applyCfg(C.defaultsClone());
      $('scenario').value = '';
      state.sel = 0; compute(); toast('已恢复默认虚构示例');
    });
    $('btnSave').addEventListener('click', saveLocal);
    $('btnLoad').addEventListener('click', () => { if (loadLocal(false)) { $('scenario').value = ''; compute(); } });
    $('scenario').addEventListener('change', (e) => {
      const id = e.target.value;
      if (!id) return;
      const sc = C.scenarios.filter((x) => x.id === id)[0];
      if (!sc) return;
      const d = C.defaultsClone();
      if (sc.patch) Object.assign(d, JSON.parse(JSON.stringify(sc.patch)));
      applyCfg(d);
      state.sel = 0; compute();
      toast('已换上场景：' + String(sc.name).split(/[：/]/)[0].trim());
    });
    $('btnCsv').addEventListener('click', () => { if (!state.res) return toast('先让输入通过校验'); download('免打孔承载装置对账台.csv', C.csvText(readItems(), state.res), 'text/csv;charset=utf-8'); toast('CSV 已导出'); });
    $('btnMd').addEventListener('click', () => { if (!state.res) return toast('先让输入通过校验'); download('免打孔承载装置对账台.md', C.mdText(readItems(), state.res), 'text/markdown;charset=utf-8'); toast('Markdown 已导出'); });
    $('btnJson').addEventListener('click', () => { if (!state.res) return toast('先让输入通过校验'); download('免打孔承载装置对账台-备份.json', C.jsonBackup(readItems()), 'application/json'); toast('JSON 备份已导出'); });
    $('btnPng').addEventListener('click', () => { if (!state.res) return toast('先让输入通过校验'); pngCard(); toast('结果卡 PNG 正在生成'); });
    $('btnPrint').addEventListener('click', () => window.print());
    $('importFile').addEventListener('change', (e) => { if (e.target.files && e.target.files[0]) importBackup(e.target.files[0]); });
  }

  function boot() {
    fillSelects();
    applyCfg(C.defaultsClone());
    bind();
    compute();
    if (loadLocal(true)) { $('scenario').value = ''; compute(); }
  }
  function fillSelects() {
    $('scenario').innerHTML = '<option value="">（选择场景）</option>' + C.scenarios.map((s) => '<option value="' + s.id + '">' + esc(s.name) + '</option>').join('');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* 给验收脚本用的只读钩子（不改变页面行为） */
  window.__ndl = {
    state: state,
    res: () => state.res,
    errors: () => state.errors,
    renders: () => state.renders,
    exports: () => state.exports,
    sensitivity: () => (state.res ? C.sensitivity(state.res.items[state.sel].item, state.res.sf, state.res.years) : null)
  };
})();
