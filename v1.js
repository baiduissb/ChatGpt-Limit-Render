// ==UserScript==
// @name         ChatGPT Limit Render
// @namespace    https://github.com/hu-qihang/chatgpt-limit-render
// @version      0.6.0
// @description  解决 ChatGPT 网页端卡顿问题，提供现代化云母 UI 与更稳定的对话裁剪逻辑
// @match        https://chatgpt.com/*
// @run-at       document-idle
// @grant        none
// @license      MIT
// ==/UserScript==

(function() {
  'use strict';

  if (window.__LR_V6__) return;
  window.__LR_V6__ = true;

  const STORAGE_KEY = 'lr-v6-settings';

  const CONFIG = {
    enabled: true,
    defaultTurns: 15,
    safeTurns: 6,
    preSendAuto: true,
    freezeGuard: true,
    restoreDelay: 1500,
    freezeThreshold: 3500,
    maxCache: 80,
    pulseIntensity: 1
  };

  const STATE = {
    mode: 'default',
    streaming: false,
    applying: false,
    expanded: false,
    mounted: false,
    hiddenCount: 0
  };

  const CACHE = {
    d: new Map(),
    o: []
  };

  let restoreTimer;

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function saveSettings() {
    const payload = {
      enabled: CONFIG.enabled,
      defaultTurns: CONFIG.defaultTurns,
      safeTurns: CONFIG.safeTurns,
      preSendAuto: CONFIG.preSendAuto,
      freezeGuard: CONFIG.freezeGuard,
      restoreDelay: CONFIG.restoreDelay,
      freezeThreshold: CONFIG.freezeThreshold,
      pulseIntensity: CONFIG.pulseIntensity
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const cfg = JSON.parse(raw);
      if (!cfg || typeof cfg !== 'object') return;

      CONFIG.enabled = cfg.enabled !== false;
      CONFIG.defaultTurns = clamp(Number(cfg.defaultTurns) || 15, 1, 200);
      CONFIG.safeTurns = clamp(Number(cfg.safeTurns) || 6, 1, 50);
      CONFIG.preSendAuto = cfg.preSendAuto !== false;
      CONFIG.freezeGuard = cfg.freezeGuard !== false;
      CONFIG.restoreDelay = clamp(Number(cfg.restoreDelay) || 1500, 200, 10000);
      CONFIG.freezeThreshold = clamp(Number(cfg.freezeThreshold) || 3500, 500, 30000);
      CONFIG.pulseIntensity = clamp(Number(cfg.pulseIntensity) || 1, 0.2, 2);
    } catch {
      // 忽略无效配置
    }
  }

  function getTurns() {
    try {
      const direct = document.querySelectorAll('[data-testid="conversation-turn"]');
      if (direct.length) return [...direct];
      const main = document.querySelector('main');
      return main ? [...main.querySelectorAll('article')] : [];
    } catch {
      return [];
    }
  }

  function ensureId(el) {
    if (!el.dataset.lrId) el.dataset.lrId = `lr-${Math.random().toString(36).slice(2)}`;
    return el.dataset.lrId;
  }

  function cacheSet(id, node, parent, next) {
    if (!id || !node || !parent) return;

    if (CACHE.d.has(id)) {
      const idx = CACHE.o.indexOf(id);
      if (idx >= 0) CACHE.o.splice(idx, 1);
    }

    while (CACHE.d.size >= CONFIG.maxCache && CACHE.o.length) {
      CACHE.d.delete(CACHE.o.shift());
    }

    CACHE.d.set(id, { n: node, p: parent, x: next });
    CACHE.o.push(id);
  }

  function createPlaceholder(id, index) {
    const ph = document.createElement('div');
    ph.className = 'lr-ph';
    ph.dataset.lrTarget = id;
    ph.innerHTML = `<span>对话 ${index + 1}</span><button class="lr-pb">展开</button>`;
    return ph;
  }

  function applyLimit(count) {
    if (STATE.applying) return;
    if (!CONFIG.enabled) {
      updateStatus('已关闭');
      return;
    }

    STATE.applying = true;
    try {
      const turns = getTurns();
      if (!turns.length) {
        updateStatus('未检测到对话内容');
        return;
      }

      turns.forEach(ensureId);

      const keep = clamp(Number(count) || CONFIG.defaultTurns, 1, 200);
      const hideCount = turns.length - keep;
      if (hideCount <= 0) {
        STATE.hiddenCount = 0;
        updateStatus(`全部 ${turns.length} 轮`);
        syncStats();
        return;
      }

      let hidden = 0;
      for (let i = 0; i < hideCount; i++) {
        const turn = turns[i];
        if (!turn || turn.dataset.lrPin === '1') continue;
        const id = turn.dataset.lrId;
        if (!id || CACHE.d.has(id) || !turn.isConnected || !turn.parentNode) continue;

        const parent = turn.parentNode;
        const next = turn.nextSibling;
        cacheSet(id, turn, parent, next);

        turn.remove();

        const ph = createPlaceholder(id, i);
        parent.insertBefore(ph, next);
        hidden++;
      }

      STATE.hiddenCount = hidden;
      updateStatus(`渲染 ${keep} 轮 • 隐藏 ${hidden} 轮`);
      syncStats();
    } finally {
      STATE.applying = false;
    }
  }

  function restoreCachedTurn(id, pin = true) {
    const c = CACHE.d.get(id);
    if (!c?.n || !c.p?.isConnected) return false;

    c.p.insertBefore(c.n, c.x);
    if (pin) c.n.dataset.lrPin = '1';
    return true;
  }

  function collapseTurn(id) {
    const turn = document.querySelector(`[data-lr-id="${CSS.escape(id)}"]`);
    if (!turn?.parentNode) return false;

    cacheSet(id, turn, turn.parentNode, turn.nextSibling);
    delete turn.dataset.lrPin;
    turn.remove();
    return true;
  }

  function togglePh(ph) {
    if (!ph) return;

    const id = ph.dataset.lrTarget;
    const expanded = ph.classList.contains('ex');
    const btn = ph.querySelector('.lr-pb');

    if (!expanded) {
      if (restoreCachedTurn(id, true)) {
        ph.classList.add('ex');
        if (btn) btn.textContent = '收起';
        updateStatus('已展开该条对话');
      }
      return;
    }

    if (collapseTurn(id)) {
      ph.classList.remove('ex');
      if (btn) btn.textContent = '展开';
      updateStatus('已收起该条对话');
    }
  }

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
      if (STATE.streaming) {
        scheduleRestore(reason);
      } else {
        toDefault(reason);
      }
    }, CONFIG.restoreDelay);
  }

  function setupEvents() {
    const checkSend = (e) => {
      if (!CONFIG.enabled || !CONFIG.preSendAuto) return;

      let isSend = false;
      if (e.type === 'click') {
        const b = e.target.closest('button');
        if (b) {
          const l = (b.getAttribute('aria-label') || '').toLowerCase();
          const t = (b.dataset.testid || '').toLowerCase();
          const tx = (b.textContent || '').toLowerCase();
          if (l.includes('send') || t.includes('send') || tx.includes('send')) isSend = true;
        }
      } else if (e.type === 'keydown' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        const tg = e.target;
        if (tg?.tagName === 'TEXTAREA' || tg?.isContentEditable) isSend = true;
      }

      if (isSend) {
        toSafe('发送前收缩');
        scheduleRestore('发送完成');
      }
    };

    document.addEventListener('click', checkSend, true);
    document.addEventListener('keydown', checkSend, true);

    let last = performance.now();
    function loop(ts) {
      if (CONFIG.enabled && CONFIG.freezeGuard && ts - last > CONFIG.freezeThreshold && STATE.mode !== 'safe') {
        toSafe(`检测到卡顿 ${Math.round((ts - last) / 1000)}s`);
        scheduleRestore('页面已恢复');
      }
      last = ts;
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);

    let timer;
    const obs = new MutationObserver(() => {
      if (!CONFIG.enabled || STATE.applying) return;

      const turnCount = document.querySelectorAll('[data-testid="conversation-turn"]').length;
      if (turnCount > 0) {
        STATE.streaming = true;
        clearTimeout(timer);
        timer = setTimeout(() => {
          STATE.streaming = false;
          applyLimit(STATE.mode === 'safe' ? CONFIG.safeTurns : CONFIG.defaultTurns);
        }, 900);
      }
    });

    const target = document.querySelector('main') || document.body;
    obs.observe(target, { childList: true, subtree: true });

    window.addEventListener('beforeunload', saveSettings);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveSettings();
    });
  }

  function updateStatus(txt) {
    const el = document.getElementById('lr-st');
    if (el) el.textContent = txt;
  }

  function syncStats() {
    const stat = document.getElementById('lr-stat');
    if (stat) stat.textContent = `隐藏 ${STATE.hiddenCount} / 缓存 ${CACHE.d.size}`;
  }

  function updateUI() {
    const ind = document.getElementById('lr-ind');
    const root = document.getElementById('lr-root');
    if (!ind || !root) return;

    ind.className = 'lr-ind';
    if (!CONFIG.enabled) {
      ind.classList.add('off');
      root.classList.add('lr-disabled');
    } else if (STATE.mode === 'safe') {
      ind.classList.add('safe');
      root.classList.remove('lr-disabled');
    } else {
      ind.classList.add('on');
      root.classList.remove('lr-disabled');
    }

    root.style.setProperty('--lr-pulse', String(CONFIG.pulseIntensity));

    const toggle = document.getElementById('lr-c-en');
    if (toggle) toggle.checked = CONFIG.enabled;
    syncStats();
  }

  function buildUI() {
    if (document.getElementById('lr-root')) return;

    const css = `
      #lr-root {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 99999;
        font-family: Inter, 'Segoe UI', system-ui, sans-serif;
        --c-on: #34d399;
        --c-safe: #f59e0b;
        --c-off: #f87171;
        --txt: #111827;
        --txt2: #4b5563;
        --bd: rgba(255,255,255,0.34);
        --mica: linear-gradient(140deg, rgba(255,255,255,0.5), rgba(255,255,255,0.18));
        --panel-shadow: 0 18px 60px rgba(0,0,0,0.2);
        --lr-pulse: 1;
      }
      @media (prefers-color-scheme: dark) {
        #lr-root {
          --txt: #f3f4f6;
          --txt2: #cbd5e1;
          --bd: rgba(255,255,255,0.15);
          --mica: linear-gradient(145deg, rgba(40,40,42,0.7), rgba(28,28,30,0.42));
          --panel-shadow: 0 20px 70px rgba(0,0,0,0.45);
        }
      }

      .lr-mica {
        background: var(--mica);
        border: 1px solid var(--bd);
        backdrop-filter: blur(18px) saturate(165%);
        -webkit-backdrop-filter: blur(18px) saturate(165%);
      }

      .lr-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        min-width: 205px;
        height: 46px;
        padding: 0 16px;
        border-radius: 16px;
        box-shadow: var(--panel-shadow);
        cursor: pointer;
        user-select: none;
        transition: transform .25s ease, box-shadow .25s ease;
      }
      .lr-bar:hover { transform: translateY(-2px); }

      .lr-s { display: flex; align-items: center; gap: 10px; }
      .lr-ind {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--c-on);
        box-shadow: 0 0 calc(12px * var(--lr-pulse)) var(--c-on);
      }
      .lr-ind.on { animation: lr-breathe 2.6s ease-in-out infinite; }
      .lr-ind.safe { background: var(--c-safe); box-shadow: 0 0 16px var(--c-safe); animation: lr-panic .95s ease-in-out infinite; }
      .lr-ind.off { background: var(--c-off); animation: none; opacity: .65; box-shadow: none; }
      @keyframes lr-breathe {
        0%, 100% { transform: scale(1); opacity: 1; box-shadow: 0 0 calc(8px * var(--lr-pulse)) var(--c-on), 0 0 calc(20px * var(--lr-pulse)) rgba(52,211,153,.38); }
        50% { transform: scale(1.28); opacity: .75; box-shadow: 0 0 calc(16px * var(--lr-pulse)) var(--c-on), 0 0 calc(30px * var(--lr-pulse)) rgba(52,211,153,.65); }
      }
      @keyframes lr-panic {
        0%,100% { opacity: 1; }
        50% { opacity: .25; transform: scale(1.3); }
      }

      .lr-txt { color: var(--txt); font-size: 13px; font-weight: 700; }
      .lr-sub { color: var(--txt2); font-size: 11px; }
      .lr-arr { color: var(--txt2); transition: transform .25s ease; }
      .lr-bar.open .lr-arr { transform: rotate(180deg); }

      .lr-p {
        position: absolute;
        right: 0;
        bottom: 58px;
        width: 300px;
        border-radius: 18px;
        box-shadow: var(--panel-shadow);
        padding: 16px;
        opacity: 0;
        visibility: hidden;
        transform: translateY(12px) scale(.97);
        transition: all .22s ease;
      }
      .lr-p.open { opacity: 1; visibility: visible; transform: translateY(0) scale(1); }

      .lr-title { color: var(--txt); font-size: 15px; font-weight: 800; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; }
      .lr-stat { font-size: 11px; color: var(--txt2); }

      .lr-r { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; gap: 10px; }
      .lr-l { color: var(--txt2); font-size: 12px; }
      .lr-i {
        width: 82px;
        border-radius: 10px;
        border: 1px solid var(--bd);
        background: rgba(255,255,255,0.16);
        color: var(--txt);
        text-align: center;
        padding: 6px 8px;
      }
      .lr-g { display: flex; gap: 8px; margin-top: 10px; }
      .lr-b {
        flex: 1;
        border: 1px solid var(--bd);
        border-radius: 10px;
        background: rgba(255,255,255,0.16);
        color: var(--txt);
        font-size: 12px;
        font-weight: 700;
        padding: 9px;
        cursor: pointer;
      }
      .lr-b:hover { background: rgba(255,255,255,0.24); }
      .lr-op { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
      .lr-c { color: var(--txt2); font-size: 12px; display: flex; align-items: center; gap: 8px; }
      .lr-st { margin-top: 12px; font-size: 11px; color: var(--txt2); text-align: center; padding: 8px; border-radius: 10px; background: rgba(255,255,255,.13); border: 1px solid var(--bd); }

      .lr-disabled .lr-bar,
      .lr-disabled .lr-p { opacity: .78; }

      .lr-ph {
        height: 40px;
        margin: 6px 0;
        padding: 0 12px;
        border-radius: 10px;
        border: 1px dashed rgba(148,163,184,.45);
        background: rgba(148,163,184,.08);
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 12px;
        color: #64748b;
      }
      .lr-ph.ex { border-color: rgba(52,211,153,.65); background: rgba(52,211,153,.13); }
      .lr-pb {
        border-radius: 8px;
        border: 1px solid rgba(148,163,184,.4);
        background: rgba(255,255,255,.3);
        color: #334155;
        font-size: 11px;
        padding: 4px 10px;
        cursor: pointer;
      }
    `;

    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = 'lr-root';
    root.innerHTML = `
      <div class="lr-p lr-mica" id="lr-panel">
        <div class="lr-title">
          <span>Limit Render</span>
          <span class="lr-stat" id="lr-stat">隐藏 0 / 缓存 0</span>
        </div>
        <div class="lr-r"><span class="lr-l">默认轮数</span><input type="number" class="lr-i" id="lr-d" min="1" max="200" value="${CONFIG.defaultTurns}"></div>
        <div class="lr-r"><span class="lr-l">安全轮数</span><input type="number" class="lr-i" id="lr-s" min="1" max="50" value="${CONFIG.safeTurns}"></div>
        <div class="lr-r"><span class="lr-l">恢复延迟(ms)</span><input type="number" class="lr-i" id="lr-rd" min="200" max="10000" value="${CONFIG.restoreDelay}"></div>
        <div class="lr-r"><span class="lr-l">呼吸强度(0.2-2)</span><input type="number" step="0.1" class="lr-i" id="lr-pi" min="0.2" max="2" value="${CONFIG.pulseIntensity}"></div>
        <div class="lr-g">
          <button class="lr-b" id="lr-btn-s">安全收缩</button>
          <button class="lr-b" id="lr-btn-r">恢复默认</button>
        </div>
        <div class="lr-op">
          <label class="lr-c"><input type="checkbox" id="lr-c-en" ${CONFIG.enabled ? 'checked' : ''}> 启用 Limit Render</label>
          <label class="lr-c"><input type="checkbox" id="lr-c-p" ${CONFIG.preSendAuto ? 'checked' : ''}> 发送前自动收缩</label>
          <label class="lr-c"><input type="checkbox" id="lr-c-f" ${CONFIG.freezeGuard ? 'checked' : ''}> 启用防卡死守护</label>
        </div>
        <div class="lr-st" id="lr-st">就绪</div>
      </div>
      <div class="lr-bar lr-mica" id="lr-bar">
        <div class="lr-s">
          <div class="lr-ind on" id="lr-ind"></div>
          <div>
            <div class="lr-txt">Limit Render</div>
            <div class="lr-sub" id="lr-mode">default</div>
          </div>
        </div>
        <svg class="lr-arr" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
      </div>
    `;

    document.body.appendChild(root);
    STATE.mounted = true;

    const bar = document.getElementById('lr-bar');
    const panel = document.getElementById('lr-panel');

    bar?.addEventListener('click', () => {
      STATE.expanded = !STATE.expanded;
      bar.classList.toggle('open', STATE.expanded);
      panel.classList.toggle('open', STATE.expanded);
    });

    document.addEventListener('click', (e) => {
      if (!STATE.expanded) return;
      if (!e.target.closest('#lr-root')) {
        STATE.expanded = false;
        bar.classList.remove('open');
        panel.classList.remove('open');
      }
    });

    document.getElementById('lr-d')?.addEventListener('change', (e) => {
      CONFIG.defaultTurns = clamp(Number(e.target.value) || 15, 1, 200);
      saveSettings();
      applyLimit(CONFIG.defaultTurns);
    });

    document.getElementById('lr-s')?.addEventListener('change', (e) => {
      CONFIG.safeTurns = clamp(Number(e.target.value) || 6, 1, 50);
      saveSettings();
    });

    document.getElementById('lr-rd')?.addEventListener('change', (e) => {
      CONFIG.restoreDelay = clamp(Number(e.target.value) || 1500, 200, 10000);
      saveSettings();
    });

    document.getElementById('lr-pi')?.addEventListener('change', (e) => {
      CONFIG.pulseIntensity = clamp(Number(e.target.value) || 1, 0.2, 2);
      saveSettings();
      updateUI();
    });

    document.getElementById('lr-btn-s')?.addEventListener('click', () => toSafe('手动触发'));
    document.getElementById('lr-btn-r')?.addEventListener('click', () => toDefault('手动触发'));

    document.getElementById('lr-c-en')?.addEventListener('change', (e) => {
      CONFIG.enabled = !!e.target.checked;
      if (!CONFIG.enabled) {
        STATE.mode = 'disabled';
        updateStatus('功能已关闭');
      } else {
        toDefault('已重新启用');
      }
      saveSettings();
      updateUI();
    });

    document.getElementById('lr-c-p')?.addEventListener('change', (e) => {
      CONFIG.preSendAuto = !!e.target.checked;
      saveSettings();
    });

    document.getElementById('lr-c-f')?.addEventListener('change', (e) => {
      CONFIG.freezeGuard = !!e.target.checked;
      saveSettings();
    });

    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.lr-pb');
      if (btn) togglePh(btn.closest('.lr-ph'));
    });
  }

  function refreshModeLabel() {
    const modeEl = document.getElementById('lr-mode');
    if (modeEl) modeEl.textContent = STATE.mode;
  }

  function init() {
    loadSettings();
    buildUI();
    setupEvents();

    setTimeout(() => {
      if (CONFIG.enabled) {
        STATE.mode = 'default';
        applyLimit(CONFIG.defaultTurns);
      } else {
        STATE.mode = 'disabled';
      }
      refreshModeLabel();
      updateUI();
      updateStatus('就绪');
    }, 1200);

    const stateTimer = setInterval(() => {
      if (!STATE.mounted || !document.getElementById('lr-root')) {
        clearInterval(stateTimer);
        return;
      }
      refreshModeLabel();
      syncStats();
    }, 350);
  }

  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', init)
    : init();
})();
