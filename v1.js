// ==UserScript==
// @name         ChatGPT Limit Render
// @namespace    https://github.com/hu-qihang/chatgpt-limit-render
// @version      0.5.0
// @description  解决 ChatGPT 网页端卡顿问题
// @match        https://chatgpt.com/*
// @run-at       document-idle
// @grant        none
// @license      MIT
// ==/UserScript==

(function() {
  'use strict';

  // 防重入
  if (window.__LR_V5__) return;
  window.__LR_V5__ = true;

  const CONFIG = {
    enabled: true,
    defaultTurns: 15,
    safeTurns: 6,
    preSendAuto: true,
    freezeGuard: true,
    restoreDelay: 1500,
    freezeThreshold: 3500,
    maxCache: 50
  };

  const STATE = {
    mode: 'default', // default, safe, disabled
    streaming: false,
    applying: false,
    expanded: false
  };

  const CACHE = { d: new Map(), o: [] };

  const log = CONFIG.debug ? console.log : () => {};

  // ==================== 核心逻辑 (保持不变) ====================
  
  function getTurns() {
    try {
      let n = document.querySelectorAll('[data-testid="conversation-turn"]');
      if (n.length) return [...n];
      const m = document.querySelector('main');
      return m ? [...document.querySelectorAll('article', m)] : [];
    } catch { return []; }
  }

  function ensureId(el) {
    if (!el.dataset.lrId) el.dataset.lrId = `lr-${Math.random().toString(36).slice(2)}`;
    return el.dataset.lrId;
  }

  function cacheSet(id, node, parent, next) {
    if (CACHE.d.size >= CONFIG.maxCacheSize && CACHE.o.length) {
      CACHE.d.delete(CACHE.o.shift());
    }
    CACHE.d.set(id, { n: node, p: parent, x: next });
    CACHE.o.push(id);
  }

  function applyLimit(count) {
    if (STATE.applying || !CONFIG.enabled) return;
    STATE.applying = true;
    
    try {
      const turns = getTurns();
      if (!turns.length) return;
      
      turns.forEach(ensureId);
      document.querySelectorAll('.lr-ph').forEach(ph => {
        const id = ph.dataset.lrTarget;
        const t = document.querySelector(`[data-lr-id="${CSS.escape(id)}"]`);
        if (t && !t.dataset.lrPin && t.isConnected) ph.remove();
      });

      const keep = Math.max(1, Math.min(count, 200));
      const hide = turns.length - keep;
      if (hide <= 0) { updateStatus(`全部 ${turns.length} 轮`); return; }

      let h = 0;
      for (let i = 0; i < hide; i++) {
        const t = turns[i];
        if (t.dataset.lrPin === '1') continue;
        const id = t.dataset.lrId;
        if (!id || CACHE.d.has(id) || !t.isConnected) continue;

        cacheSet(id, t, t.parentNode, t.nextSibling);
        t.parentNode.removeChild(t);

        const ph = document.createElement('div');
        ph.className = 'lr-ph';
        ph.dataset.lrTarget = id;
        ph.innerHTML = `<span>对话 ${i + 1}</span><button class="lr-pb">展开</button>`;
        t.parentNode.insertBefore(ph, t.nextSibling);
        h++;
      }
      updateStatus(`渲染 ${keep} 轮 • 隐藏 ${h} 轮`);
    } finally {
      STATE.applying = false;
    }
  }

  function togglePh(ph) {
    const id = ph.dataset.lrTarget;
    const expanded = ph.classList.contains('ex');
    const btn = ph.querySelector('.lr-pb');
    
    if (!expanded) {
      const c = CACHE.d.get(id);
      if (c?.n) {
        c.p.insertBefore(c.n, c.x);
        c.n.dataset.lrPin = '1';
        ph.classList.add('ex');
        btn.textContent = '收起';
        updateStatus('已展开');
      }
    } else {
      const t = document.querySelector(`[data-lr-id="${CSS.escape(id)}"]`);
      if (t) {
        cacheSet(id, t, t.parentNode, t.nextSibling);
        delete t.dataset.lrPin;
        t.parentNode.removeChild(t);
        ph.classList.remove('ex');
        btn.textContent = '展开';
        updateStatus('已收起');
      }
    }
  }

  // 模式切换
  let restoreTimer;
  function toSafe(reason) {
    if (!CONFIG.enabled) return;
    clearTimeout(restoreTimer);
    STATE.mode = 'safe';
    applyLimit(CONFIG.safeTurns);
    updateUI();
    updateStatus(`安全模式: ${reason}`);
  }

  function toDefault(reason) {
    if (!CONFIG.enabled) return;
    clearTimeout(restoreTimer);
    STATE.mode = 'default';
    applyLimit(CONFIG.defaultTurns);
    updateUI();
    updateStatus(`默认模式: ${reason}`);
  }

  function scheduleRestore(reason) {
    clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => {
      STATE.streaming ? scheduleRestore(reason) : toDefault(reason);
    }, CONFIG.restoreDelay);
  }

  // ==================== 事件监听 ====================
  
  function setupEvents() {
    // 发送检测
    const checkSend = (e) => {
      if (!CONFIG.enabled || !CONFIG.preSendAuto) return;
      let isSend = false;
      if (e.type === 'click') {
        const b = e.target.closest('button');
        if (b) {
          const l = (b.getAttribute('aria-label')||'').toLowerCase();
          const t = (b.dataset.testid||'').toLowerCase();
          if (l.includes('send') || t.includes('send')) isSend = true;
        }
      } else if (e.type === 'keydown' && e.key === 'Enter' && !e.shiftKey) {
        const tg = e.target;
        if (tg.tagName === 'TEXTAREA' || tg.isContentEditable) isSend = true;
      }
      if (isSend) { toSafe('发送前收缩'); scheduleRestore('发送完成'); }
    };
    document.addEventListener('click', checkSend, true);
    document.addEventListener('keydown', checkSend, true);

    // 卡死检测
    let last = performance.now();
    function loop(ts) {
      if (!CONFIG.enabled || !CONFIG.freezeGuard) return;
      if (ts - last > CONFIG.freezeThreshold && STATE.mode !== 'safe') {
        toSafe(`卡顿 ${Math.round((ts-last)/1000)}s`);
        scheduleRestore('已恢复');
      }
      last = ts;
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);

    // DOM监听
    let timer;
    const obs = new MutationObserver(() => {
      if (!CONFIG.enabled || STATE.applying) return;
      const n = [...document.querySelectorAll('[data-testid="conversation-turn"]')].length;
      if (n > 0) {
        STATE.streaming = true;
        clearTimeout(timer);
        timer = setTimeout(() => {
          STATE.streaming = false;
          applyLimit(CONFIG.defaultTurns);
        }, 1000);
      }
    });
    obs.observe(document.querySelector('main') || document.body, { childList: true, subtree: true });
  }

  // ==================== UI 构建 (完全重写) ====================
  
  function updateUI() {
    const bar = document.getElementById('lr-bar');
    const ind = document.getElementById('lr-ind');
    if (!bar || !ind) return;
    
    ind.className = 'lr-ind';
    if (!CONFIG.enabled) ind.classList.add('off');
    else if (STATE.mode === 'safe') ind.classList.add('safe');
    else ind.classList.add('on');
  }

  function updateStatus(txt) {
    const el = document.getElementById('lr-st');
    if (el) el.textContent = txt;
  }

  function buildUI() {
    if (document.getElementById('lr-root')) return;

    const css = `
      #lr-root {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 99999;
        font-family: 'Segoe UI', system-ui, sans-serif;
        --c-on: #10b981;
        --c-safe: #f59e0b;
        --c-off: #ef4444;
        --bg: #ffffff;
        --bg-panel: rgba(255,255,255,0.85);
        --txt: #1f2937;
        --txt2: #6b7280;
        --border: rgba(0,0,0,0.08);
      }
      @media (prefers-color-scheme: dark) {
        #lr-root { --bg: #1f1f1f; --bg-panel: rgba(30,30,30,0.85); --txt: #f3f4f6; --txt2: #9ca3af; --border: rgba(255,255,255,0.1); }
      }

      /* 呼吸灯条按钮 */
      .lr-bar {
        height: 44px;
        padding: 0 20px;
        background: var(--bg-panel);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        border-radius: 22px;
        border: 1px solid var(--border);
        box-shadow: 0 8px 32px rgba(0,0,0,0.12);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        cursor: pointer;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        user-select: none;
        min-width: 180px;
      }
      .lr-bar:hover { transform: translateY(-2px); box-shadow: 0 12px 40px rgba(0,0,0,0.18); }
      
      /* 左侧状态灯 */
      .lr-s {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .lr-ind {
        width: 32px;
        height: 8px;
        border-radius: 4px;
        background: var(--c-on);
        box-shadow: 0 0 12px var(--c-on);
        transition: all 0.3s;
      }
      .lr-ind.on { animation: glow-on 2.5s ease-in-out infinite; background: var(--c-on); }
      .lr-ind.safe { animation: glow-safe 1s ease-in-out infinite; background: var(--c-safe); box-shadow: 0 0 12px var(--c-safe); }
      .lr-ind.off { background: var(--c-off); opacity: 0.6; box-shadow: none; animation: none; }

      @keyframes glow-on {
        0%, 100% { opacity: 1; box-shadow: 0 0 8px var(--c-on); }
        50% { opacity: 0.7; box-shadow: 0 0 20px var(--c-on); }
      }
      @keyframes glow-safe {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.3; }
      }

      .lr-txt { font-size: 13px; font-weight: 600; color: var(--txt); letter-spacing: -0.02em; }
      
      /* 展开箭头 */
      .lr-arr { color: var(--txt2); transition: transform 0.3s; }
      .lr-bar.open .lr-arr { transform: rotate(180deg); }

      /* 面板 */
      .lr-p {
        position: absolute;
        bottom: 54px;
        right: 0;
        width: 260px;
        background: var(--bg-panel);
        backdrop-filter: blur(24px);
        -webkit-backdrop-filter: blur(24px);
        border-radius: 20px;
        border: 1px solid var(--border);
        box-shadow: 0 20px 60px rgba(0,0,0,0.2);
        padding: 20px;
        opacity: 0;
        visibility: hidden;
        transform: translateY(10px) scale(0.96);
        transition: all 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
      }
      .lr-p.open { opacity: 1; visibility: visible; transform: translateY(0) scale(1); }

      /* 面板内容 */
      .lr-p-t { font-size: 15px; font-weight: 700; color: var(--txt); margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
      .lr-p-t svg { color: var(--c-on); }

      .lr-r { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
      .lr-l { font-size: 13px; color: var(--txt2); }
      .lr-i { width: 50px; padding: 6px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--txt); text-align: center; font-size: 13px; }

      .lr-g { display: flex; gap: 8px; margin-top: 16px; }
      .lr-b { flex: 1; padding: 10px; border: none; border-radius: 10px; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
      .lr-bs { background: rgba(239,68,68,0.1); color: #ef4444; }
      .lr-bs:hover { background: rgba(239,68,68,0.2); }
      .lr-bd { background: rgba(16,163,127,0.1); color: var(--c-on); }
      .lr-bd:hover { background: rgba(16,163,127,0.2); }

      .lr-op { margin-top: 16px; display: flex; flex-direction: column; gap: 8px; }
      .lr-c { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--txt2); cursor: pointer; }
      
      .lr-st { margin-top: 16px; text-align: center; font-size: 11px; color: var(--txt2); padding: 8px; background: rgba(0,0,0,0.03); border-radius: 8px; }

      /* 占位符 */
      .lr-ph { height: 40px; margin: 6px 0; background: rgba(0,0,0,0.03); border: 1px dashed var(--border); border-radius: 10px; display: flex; align-items: center; justify-content: space-between; padding: 0 14px; font-size: 12px; color: var(--txt2); transition: all 0.2s; }
      .lr-ph:hover { background: rgba(0,0,0,0.06); }
      .lr-ph.ex { border-color: var(--c-on); background: rgba(16,163,127,0.05); }
      .lr-pb { padding: 4px 10px; border: 1px solid var(--border); border-radius: 6px; background: transparent; font-size: 11px; color: var(--txt); cursor: pointer; transition: all 0.2s; }
      .lr-ph:hover .lr-pb { background: var(--c-on); color: white; border-color: var(--c-on); }
    `;

    const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);

    const root = document.createElement('div');
    root.id = 'lr-root';
    root.innerHTML = `
      <div class="lr-p" id="lr-panel">
        <div class="lr-p-t"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg> Limit Render</div>
        <div class="lr-r"><span class="lr-l">默认轮数</span><input type="number" class="lr-i" id="lr-d" value="${CONFIG.defaultTurns}"></div>
        <div class="lr-r"><span class="lr-l">安全轮数</span><input type="number" class="lr-i" id="lr-s" value="${CONFIG.safeTurns}"></div>
        <div class="lr-g">
          <button class="lr-b lr-bs" id="lr-btn-s">收缩</button>
          <button class="lr-b lr-bd" id="lr-btn-r">恢复</button>
        </div>
        <div class="lr-op">
          <label class="lr-c"><input type="checkbox" id="lr-c-p" ${CONFIG.preSendAuto?'checked':''}> 发送前收缩</label>
          <label class="lr-c"><input type="checkbox" id="lr-c-f" ${CONFIG.freezeGuard?'checked':''}> 防卡死</label>
        </div>
        <div class="lr-st" id="lr-st">就绪</div>
      </div>
      <div class="lr-bar" id="lr-bar">
        <div class="lr-s">
          <div class="lr-ind on" id="lr-ind"></div>
          <span class="lr-txt">Limit Render</span>
        </div>
        <svg class="lr-arr" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
      </div>
    `;
    document.body.appendChild(root);

    // 事件绑定
    const bar = document.getElementById('lr-bar');
    const pan = document.getElementById('lr-panel');
    
    bar.onclick = () => {
      STATE.expanded = !STATE.expanded;
      bar.classList.toggle('open', STATE.expanded);
      pan.classList.toggle('open', STATE.expanded);
    };
    
    document.addEventListener('click', e => {
      if (STATE.expanded && !e.target.closest('#lr-root')) {
        STATE.expanded = false;
        bar.classList.remove('open');
        pan.classList.remove('open');
      }
    });

    document.getElementById('lr-d').onchange = e => { CONFIG.defaultTurns = +e.target.value || 15; applyLimit(CONFIG.defaultTurns); };
    document.getElementById('lr-s').onchange = e => { CONFIG.safeTurns = +e.target.value || 6; };
    document.getElementById('lr-btn-s').onclick = () => toSafe('手动');
    document.getElementById('lr-btn-r').onclick = () => toDefault('手动');
    document.getElementById('lr-c-p').onchange = e => CONFIG.preSendAuto = e.target.checked;
    document.getElementById('lr-c-f').onchange = e => CONFIG.freezeGuard = e.target.checked;

    document.addEventListener('click', e => {
      const b = e.target.closest('.lr-pb');
      if (b) togglePh(b.closest('.lr-ph'));
    });
  }

  // ==================== 初始化 ====================
  
  function init() {
    buildUI();
    setupEvents();
    setTimeout(() => {
      if (CONFIG.enabled) applyLimit(CONFIG.defaultTurns);
      updateUI();
    }, 1200);
  }

  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
})()