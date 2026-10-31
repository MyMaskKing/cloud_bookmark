/**
 * 设置页分类 tab 切换
 * 纯显隐控制：面板始终保留在 DOM 中，不影响 options.js 的加载、事件绑定与定时刷新。
 * 激活的 tab 仅记于本机 localStorage，不上传云端。
 * 外部可派发事件切换：document.dispatchEvent(new CustomEvent('cloudBookmark:activateOptionsTab', { detail: { tab: 'security', scroll: true } }))
 */
(function () {
  const STORAGE_KEY = 'cloudBookmark_optionsActiveTab';
  const ACTIVATE_EVENT = 'cloudBookmark:activateOptionsTab';
  const DEFAULT_TAB = 'sync';

  const nav = document.querySelector('.settings-tabs');
  if (!nav) return;
  const tabs = Array.from(nav.querySelectorAll('.settings-tab[data-tab]'));
  if (!tabs.length) return;
  const panels = Array.from(document.querySelectorAll('[data-tabpanel]'));

  function isValidTab(tabId) {
    return tabs.some(tab => tab.dataset.tab === tabId);
  }

  function readStoredTab() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved && isValidTab(saved) ? saved : DEFAULT_TAB;
    } catch (_) {
      return DEFAULT_TAB;
    }
  }

  function rememberTab(tabId) {
    try {
      localStorage.setItem(STORAGE_KEY, tabId);
    } catch (_) { /* 隐私模式等场景下忽略 */ }
  }

  function activate(tabId, shouldRemember) {
    const target = tabs.find(tab => tab.dataset.tab === tabId);
    if (!target) return;
    tabs.forEach(tab => {
      const active = tab === target;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.tabIndex = active ? 0 : -1;
    });
    panels.forEach(panel => {
      panel.classList.toggle('is-active', panel.dataset.tabpanel === tabId);
    });
    if (shouldRemember !== false) rememberTab(tabId);
    return target;
  }

  // 点击切换（事件委托）
  nav.addEventListener('click', event => {
    const tab = event.target.closest('.settings-tab');
    if (!tab || !nav.contains(tab)) return;
    activate(tab.dataset.tab);
  });

  // 左右方向键在 tab 间循环（roving tabindex）
  nav.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const currentIndex = tabs.findIndex(tab => tab.classList.contains('is-active'));
    if (currentIndex < 0) return;
    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = tabs[(currentIndex + step + tabs.length) % tabs.length];
    activate(next.dataset.tab);
    next.focus();
  });

  // 外部请求切换 tab（如锁屏「忘记密码」后跳到安全设置）
  document.addEventListener(ACTIVATE_EVENT, event => {
    const tabId = event.detail && event.detail.tab;
    if (!isValidTab(tabId)) return;
    activate(tabId);
    if (event.detail.scroll) {
      // 面板从 display:none 恢复后等一帧再滚动，确保浏览器已完成布局
      requestAnimationFrame(() => {
        const firstPanel = panels.find(panel => panel.dataset.tabpanel === tabId);
        if (firstPanel && firstPanel.scrollIntoView) {
          firstPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    }
  });

  // 初始激活：读取本机记忆，非法或异常回落默认 tab（回落不写存储）
  activate(readStoredTab(), false);
})();
