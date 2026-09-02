// ==UserScript==
// @name         UESTC 选课辅助（多序号清单+自动确认）
// @namespace    http://tampermonkey.net/
// @version      2025-09-05
// @description  多课程序号清单自动抢课；关键词匹配；自动确认原生/自定义弹窗；悬浮面板；广匹配；无innerHTML
// @author       You
// @match        *://eams.uestc.edu.cn/eams/stdElectCourse*
// @match        *://eams.uestc.edu.cn/eams/*ElectCourse*
// @match        *://eams.uestc.edu.cn/*ElectCourse*
// @match        *://*.uestc.edu.cn/eams/*ElectCourse*
// @match        *://*.uestc.edu.cn/*ElectCourse*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'uestc_elect_helper_v5';
  const STATE = { enabled: false, cooldown: false, autoOk: true };
  let inputEl, toggleEl, statusEl, autoOkEl, idListEl;

  // ---------- 小工具 ----------
  const log = (...a) => console.log('[ElectHelper]', ...a);
  const safeText = (n) => (n ? (n.innerText || n.textContent || '').trim() : '');
  const parseIdList = (s) =>
    (s || '')
      .split(/[\s,，;；]+/g)
      .map((x) => x.trim())
      .filter(Boolean);

  const saveState = () => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          query: inputEl?.value?.trim() || '',
          enabled: !!toggleEl?.checked,
          autoOk: !!autoOkEl?.checked,
          idList: idListEl ? idListEl.value : '',
        })
      );
    } catch {}
  };
  const loadState = () => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch {
      return {};
    }
  };

  // ---------- 自动确认弹窗 ----------
  const ConfirmAuto = (() => {
    const original = { confirm: window.confirm ? window.confirm.bind(window) : null };
    let armed = false;
    let timeoutId = null;
    let armedUntil = 0;

    const setConfirm = (fn) => {
      try { window.confirm = fn; } catch {}
      try { if (window.top && window.top !== window && window.top.confirm) window.top.confirm = fn; } catch {}
    };
    const restoreConfirm = () => { if (original.confirm) setConfirm(original.confirm); };

    const disarm = () => {
      armed = false;
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
      restoreConfirm();
    };
    const isArmed = () => armed && Date.now() < armedUntil;

    const arm = (ms = 3000) => {
      armed = true;
      armedUntil = Date.now() + ms;
      if (original.confirm) {
        setConfirm((msg) => { try { log('自动确认：confirm', msg); } catch {} disarm(); return true; });
      }
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(disarm, ms);
    };

    const tryClickDomOk = () => {
      if (!isArmed()) return false;
      const labels = ['确定', '确认', '是', 'OK', 'Yes'];
      const sel = 'button, [role="button"], a, input[type="button"], input[type="submit"]';
      const dialogs = Array.from(document.querySelectorAll(
        '[role="dialog"], .modal, .dialog, .el-message-box, .layui-layer, .ant-modal, .weui-dialog'
      ));
      const pool = dialogs.length ? dialogs.flatMap(d => Array.from(d.querySelectorAll(sel))) : Array.from(document.querySelectorAll(sel));
      const ok = pool.find(el => {
        const t = safeText(el);
        return labels.includes(t) || labels.some(l => t.startsWith(l));
      });
      if (ok && !ok.disabled) { try { ok.click(); log('自动确认：DOM', safeText(ok)); } catch {} disarm(); return true; }
      return false;
    };

    setInterval(tryClickDomOk, 200);
    document.addEventListener('click', () => { if (STATE.autoOk) arm(3000); }, true);
    return { arm, tryClickDomOk };
  })();

  // ---------- 表格解析 ----------
  const parseRemain = (txt) => {
    if (!txt) return null;
    const s = txt.replace(/\s/g, '');
    const m = s.match(/(\d+)[/|｜](\d+)[/|｜](\d+)/);
    if (m) return parseInt(m[3], 10);
    if (/已满|满额/.test(txt)) return 0;
    return null;
  };

  const getTableRoot = () =>
    document.querySelector('#electableLessonList') ||
    document.querySelector('[id*="elect"][id*="Lesson"]') ||
    document.querySelector('table[id],div[id*="Lesson"] table') ||
    document.querySelector('table');

  const getRows = () => {
    const root = getTableRoot();
    if (!root) return [];
    const rows = Array.from(root.querySelectorAll('tbody tr')).filter((tr) => tr.cells && tr.cells.length);
    if (rows.length) return rows;
    return Array.from(root.querySelectorAll('tr')).filter((tr) => tr.querySelectorAll('td').length);
  };

  // 尝试根据表头识别“课程序号”列，找不到就返回 -1 表示全列扫描
  const getCourseIdColIndex = () => {
    const root = getTableRoot();
    if (!root) return -1;
    const headRow = root.querySelector('thead tr') || root.querySelector('tr th')?.parentElement;
    if (!headRow) return -1;
    const keys = ['课程序号', '课程号', '课号', '课程代码', '课程编号', '序号', '代码'];
    const ths = Array.from(headRow.querySelectorAll('th'));
    for (let i = 0; i < ths.length; i++) {
      const t = safeText(ths[i]);
      if (keys.some((k) => t.includes(k))) return i;
    }
    return -1;
  };

  const wordBoundContains = (hay, needle) => {
    // 在非字母数字边界上匹配，避免“2023001x”误命中“2023001”
    const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^0-9A-Za-z])${esc}([^0-9A-Za-z]|$)`);
    return re.test(hay);
  };

  const rowHasId = (tr, idList, idColIdx) => {
    if (!idList.length) return { hit: false, id: null };
    if (idColIdx >= 0 && tr.cells[idColIdx]) {
      const cellTxt = safeText(tr.cells[idColIdx]);
      for (const id of idList) {
        if (cellTxt === id || wordBoundContains(cellTxt, id)) return { hit: true, id };
      }
      return { hit: false, id: null };
    }
    // 退化：扫描整行
    const rowTxt = safeText(tr);
    for (const id of idList) {
      if (rowTxt === id || wordBoundContains(rowTxt, id)) return { hit: true, id };
    }
    return { hit: false, id: null };
  };

  const findRemainOnRow = (tr) => {
    for (const td of Array.from(tr.cells)) {
      const r = parseRemain(safeText(td));
      if (r !== null) return r;
    }
    return null;
  };

  const rowMatchesKeyword = (tr, query) => {
    if (!query) return true;
    const hay = safeText(tr).replace(/\s+/g, ' ').toLowerCase();
    const keys = query.split(/\s+/).filter(Boolean).map((k) => k.toLowerCase());
    return keys.every((k) => hay.includes(k));
  };

  const isVisible = (el) => {
    if (!el) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const clickEnrollBtn = (tr) => {
    const cands = Array.from(tr.querySelectorAll('button, a')).filter((b) => !b.disabled);
    const byText = cands.find((b) => /选课|添加|选择|报名/.test(safeText(b))) || cands.find(isVisible);
    const btn = byText || cands[0];
    if (btn) { btn.click(); return true; }
    return false;
  };

  const beep = () => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 880; o.start();
      setTimeout(() => { o.stop(); ctx.close(); }, 220);
    } catch {}
  };

  const updateStatus = (msg) => { if (statusEl) statusEl.textContent = msg; };

  // ---------- 主循环 ----------
  const checkOnce = () => {
    try {
      const rows = getRows();
      if (!rows.length) { updateStatus('未找到课程表'); return; }

      const q = inputEl ? inputEl.value.trim() : '';
      const idList = parseIdList(idListEl ? idListEl.value : '');
      const idColIdx = getCourseIdColIndex();

      const matchedByKeyword = rows.filter((r) => rowMatchesKeyword(r, q));
      const annotated = matchedByKeyword.map((r) => {
        const remain = findRemainOnRow(r);
        const { hit, id } = rowHasId(r, idList, idColIdx);
        return { row: r, remain, idHit: hit, idHitVal: id };
      }).filter(x => x.remain !== null);

      let available = annotated.filter((x) => x.remain > 0);

      // 如果填写了序号清单，则只抢清单内的
      let picked = available;
      if (idList.length) {
        picked = available.filter((x) => x.idHit);
        // 按清单顺序排序
        picked.sort((a, b) => idList.indexOf(a.idHitVal) - idList.indexOf(b.idHitVal));
      }

      const msgBase = `匹配${matchedByKeyword.length}；识别余量列${annotated.length}；可选${available.length}` +
        (idList.length ? `；清单命中可选${picked.length}` : '');

      if (STATE.enabled && picked.length > 0 && !STATE.cooldown) {
        STATE.cooldown = true;
        if (STATE.autoOk) ConfirmAuto.arm(4000);
        const ok = clickEnrollBtn(picked[0].row);
        updateStatus(`${msgBase} → ${ok ? '已自动点击' : '未找到按钮'}`);
        beep();
        setTimeout(() => (STATE.cooldown = false), 1000);
      } else {
        updateStatus(msgBase);
      }
    } catch (e) {
      console.error('[ElectHelper] checkOnce error:', e);
      updateStatus('运行异常（见控制台）');
    }
  };

  // ---------- 悬浮面板 ----------
  const ensurePanel = () => {
    if (document.getElementById('uestc-elect-helper-root')) return;

    const host = document.createElement('div');
    host.id = 'uestc-elect-helper-root';
    host.style.position = 'fixed';
    host.style.top = '12px';
    host.style.right = '12px';
    host.style.zIndex = '2147483647';
    (document.documentElement || document.body).appendChild(host);

    const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

    const style = document.createElement('style');
    style.appendChild(document.createTextNode(`
      .panel{background:rgba(255,255,255,.98);border:1px solid rgba(0,0,0,.1);
        border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.15);padding:10px 12px;min-width:360px;}
      .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:4px;}
      .label{font-size:12px;opacity:.8;white-space:nowrap;}
      input[type="text"], textarea{
        flex:1;min-width:220px;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font-family:inherit;font-size:12px;
      }
      textarea{resize:vertical;min-height:48px;max-height:160px;line-height:1.4;}
      .status{margin-top:6px;font-size:12px;opacity:.85;}
      .title{font-weight:600;margin-bottom:6px;font-size:13px;}
    `));
    root.appendChild(style);

    const panel = document.createElement('div'); panel.className = 'panel';
    const title = document.createElement('div'); title.className = 'title'; title.textContent = '选课辅助';
    const rowIds = document.createElement('div'); rowIds.className = 'row';
    const rowKey = document.createElement('div'); rowKey.className = 'row';
    const rowTog = document.createElement('div'); rowTog.className = 'row';

    // 序号清单
    const idLabel = document.createElement('span'); idLabel.className = 'label'; idLabel.textContent = '序号清单';
    idListEl = document.createElement('textarea');
    idListEl.placeholder = '在此粘贴多个课程序号：换行/空格/逗号/分号分隔\n出现任意一个有余量即自动抢课（按输入顺序优先）';

    // 关键词
    const kLabel = document.createElement('span'); kLabel.className = 'label'; kLabel.textContent = '关键词';
    inputEl = document.createElement('input'); inputEl.type = 'text'; inputEl.placeholder = '课程/序号/教师（空格=并且）';

    // 开关
    const toggleWrap = document.createElement('label'); toggleWrap.style.display = 'flex'; toggleWrap.style.alignItems = 'center'; toggleWrap.style.gap = '6px'; toggleWrap.style.cursor = 'pointer';
    toggleEl = document.createElement('input'); toggleEl.type = 'checkbox'; const toggleText = document.createElement('span'); toggleText.textContent = '自动抢课';
    toggleWrap.appendChild(toggleEl); toggleWrap.appendChild(toggleText);

    const autoOkWrap = document.createElement('label'); autoOkWrap.style.display = 'flex'; autoOkWrap.style.alignItems = 'center'; autoOkWrap.style.gap = '6px'; autoOkWrap.style.cursor = 'pointer';
    autoOkEl = document.createElement('input'); autoOkEl.type = 'checkbox'; const autoOkText = document.createElement('span'); autoOkText.textContent = '自动确认弹窗';
    autoOkWrap.appendChild(autoOkEl); autoOkWrap.appendChild(autoOkText);

    statusEl = document.createElement('div'); statusEl.className = 'status'; statusEl.textContent = '初始化中…';

    rowIds.appendChild(idLabel); rowIds.appendChild(idListEl);
    rowKey.appendChild(kLabel); rowKey.appendChild(inputEl);
    rowTog.appendChild(toggleWrap); rowTog.appendChild(autoOkWrap);

    panel.appendChild(title); panel.appendChild(rowIds); panel.appendChild(rowKey); panel.appendChild(rowTog); panel.appendChild(statusEl);
    root.appendChild(panel);

    const saved = loadState();
    if (typeof saved.idList === 'string') idListEl.value = saved.idList;
    if (saved.query) inputEl.value = saved.query;
    if (saved.enabled) { toggleEl.checked = true; STATE.enabled = true; }
    if (typeof saved.autoOk === 'boolean') { autoOkEl.checked = saved.autoOk; STATE.autoOk = saved.autoOk; } else { autoOkEl.checked = true; STATE.autoOk = true; }

    idListEl.addEventListener('input', saveState);
    inputEl.addEventListener('input', saveState);
    toggleEl.addEventListener('change', () => { STATE.enabled = toggleEl.checked; saveState(); checkOnce(); });
    autoOkEl.addEventListener('change', () => { STATE.autoOk = autoOkEl.checked; saveState(); });

    updateStatus('面板已加载');
  };

  // ---------- 监听 & 轮询 ----------
  const observe = () => {
    const obs = new MutationObserver(() => {
      ensurePanel();
      if (STATE.enabled) checkOnce();
      ConfirmAuto.tryClickDomOk();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  };

  const ready = (fn) => { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn); else fn(); };

  ready(() => {
    log('脚本启动，URL=', location.href);
    ensurePanel();
    observe();
    setInterval(checkOnce, 1000);
    checkOnce();
  });
})();
