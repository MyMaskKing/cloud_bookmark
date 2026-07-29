/**
 * 锁屏遮罩
 *
 * 在任意页面之上覆盖一层全屏遮罩，要求输入本地密码。
 * 解锁后遮罩会被销毁，调用方可以继续渲染主体内容。
 *
 * 用法：
 *   await LockScreen.guard();
 *   // 解锁后才会执行后续代码
 *
 * 选项：
 *   - title:    锁屏标题（默认「云端书签」）
 *   - subtitle: 锁屏副标题
 *   - onForgotPassword: 点击「忘记密码」时的回调（不传则跳到设置页）
 *   - allowReset: 是否在锁屏上显示「忘记密码」按钮（默认 true）
 */
(function (root) {
  'use strict';

  const STYLE_ID = 'cb-lock-screen-style';
  const ROOT_ID = 'cb-lock-screen-root';
  const COOLDOWN_AFTER = 5;       // 连续错误次数
  const COOLDOWN_MS = 30 * 1000;  // 冷却 30 秒

  function getRuntime() {
    return typeof chrome !== 'undefined' && chrome.runtime ? chrome : (typeof browser !== 'undefined' ? browser : null);
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
      #${ROOT_ID} {
        position: fixed; inset: 0; z-index: 2147483600;
        background: #ffffff;
        display: flex; align-items: center; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        color: #1f2937;
      }
      #${ROOT_ID} .cb-lock-card {
        width: min(360px, 88vw);
        padding: 28px 24px 22px;
        box-sizing: border-box;
        text-align: center;
      }
      #${ROOT_ID} .cb-lock-icon {
        font-size: 40px; line-height: 1; margin-bottom: 8px;
      }
      #${ROOT_ID} .cb-lock-title {
        font-size: 18px; font-weight: 600; margin: 4px 0 4px;
      }
      #${ROOT_ID} .cb-lock-subtitle {
        font-size: 13px; color: #6b7280; margin-bottom: 20px;
      }
      #${ROOT_ID} .cb-lock-input {
        width: 100%; box-sizing: border-box;
        padding: 10px 12px; font-size: 14px;
        border: 1px solid #d1d5db; border-radius: 8px;
        outline: none; background: #fff;
      }
      #${ROOT_ID} .cb-lock-input:focus { border-color: #4a90e2; box-shadow: 0 0 0 3px rgba(74,144,226,.15); }
      #${ROOT_ID} .cb-lock-actions { margin-top: 12px; display: flex; gap: 8px; }
      #${ROOT_ID} .cb-lock-btn {
        flex: 1; padding: 10px 12px; font-size: 14px; font-weight: 600;
        border: none; border-radius: 8px; cursor: pointer;
        background: #4a90e2; color: #fff;
        transition: background .15s ease, opacity .15s ease;
      }
      #${ROOT_ID} .cb-lock-btn:hover { background: #3b7dd8; }
      #${ROOT_ID} .cb-lock-btn:disabled { opacity: .55; cursor: not-allowed; }
      #${ROOT_ID} .cb-lock-error {
        margin-top: 10px; min-height: 18px; font-size: 12px; color: #dc2626;
      }
      #${ROOT_ID} .cb-lock-foot {
        margin-top: 18px; font-size: 12px; color: #6b7280;
        display: flex; justify-content: center; gap: 14px; flex-wrap: wrap;
      }
      #${ROOT_ID} .cb-lock-link {
        background: none; border: none; padding: 0;
        color: #4a90e2; cursor: pointer; font-size: 12px;
        text-decoration: underline; text-underline-offset: 2px;
      }
      #${ROOT_ID}.cb-lock-shake .cb-lock-input { animation: cb-lock-shake .35s ease; }
      @keyframes cb-lock-shake {
        0%,100%{ transform: translateX(0); }
        20% { transform: translateX(-6px); }
        40% { transform: translateX(6px); }
        60% { transform: translateX(-4px); }
        80% { transform: translateX(4px); }
      }
    `;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  function createDom(opts) {
    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');

    const card = document.createElement('div');
    card.className = 'cb-lock-card';

    card.innerHTML = `
      <div class="cb-lock-icon">🔒</div>
      <div class="cb-lock-title"></div>
      <div class="cb-lock-subtitle"></div>
      <input type="password" class="cb-lock-input" autocomplete="current-password" placeholder="请输入本地密码" />
      <div class="cb-lock-actions">
        <button type="button" class="cb-lock-btn">解锁</button>
      </div>
      <div class="cb-lock-error" aria-live="polite"></div>
      <div class="cb-lock-foot"></div>
    `;
    root.appendChild(card);

    card.querySelector('.cb-lock-title').textContent = opts.title || '云端书签';
    card.querySelector('.cb-lock-subtitle').textContent = opts.subtitle
      || '已启用本地密码锁，请输入密码查看书签';

    const foot = card.querySelector('.cb-lock-foot');
    if (opts.allowReset !== false) {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'cb-lock-link';
      link.textContent = '忘记密码？前往设置重置';
      link.addEventListener('click', () => {
        if (typeof opts.onForgotPassword === 'function') {
          opts.onForgotPassword();
          return;
        }
        const r = getRuntime();
        try {
          if (r && r.runtime && typeof r.runtime.openOptionsPage === 'function') {
            r.runtime.openOptionsPage();
          } else if (r && r.runtime && r.runtime.getURL) {
            window.open(r.runtime.getURL('options/options.html'), '_blank');
          }
        } catch (_) { /* ignore */ }
      });
      foot.appendChild(link);
    }

    return root;
  }

  function destroyDom() {
    const el = document.getElementById(ROOT_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  /**
   * 检查并强制要求解锁。
   * 未启用密码锁时立刻 resolve(true)；
   * 已解锁时立刻 resolve(true)；
   * 否则注入遮罩，等待用户输入正确密码后再 resolve(true)。
   */
  function guard(opts) {
    opts = opts || {};
    return new Promise(async (resolve) => {
      if (!root.LockManager) {
        // 没有 LockManager，跳过
        return resolve(true);
      }
      try {
        if (!(await root.LockManager.isEnabled())) return resolve(true);
        if (await root.LockManager.isUnlocked()) return resolve(true);
      } catch (_) {
        // 读不到设置时不阻塞主流程
        return resolve(true);
      }

      injectStyle();
      const dom = createDom(opts);
      // 立刻挂载，不等 DOMContentLoaded：调用方就是要在渲染主体之前阻塞
      const append = () => {
        (document.body || document.documentElement).appendChild(dom);
        const input = dom.querySelector('.cb-lock-input');
        const btn = dom.querySelector('.cb-lock-btn');
        const errEl = dom.querySelector('.cb-lock-error');
        let failCount = 0;
        let cooldownUntil = 0;

        const setError = (msg) => { errEl.textContent = msg || ''; };
        const shake = () => {
          dom.classList.add('cb-lock-shake');
          setTimeout(() => dom.classList.remove('cb-lock-shake'), 360);
        };
        const refreshCooldown = () => {
          const remain = cooldownUntil - Date.now();
          if (remain > 0) {
            btn.disabled = true;
            input.disabled = true;
            const sec = Math.ceil(remain / 1000);
            setError(`错误次数过多，请 ${sec} 秒后重试`);
            setTimeout(refreshCooldown, 1000);
          } else if (cooldownUntil) {
            cooldownUntil = 0;
            failCount = 0;
            btn.disabled = false;
            input.disabled = false;
            setError('');
            input.focus();
          }
        };

        const tryUnlock = async () => {
          if (Date.now() < cooldownUntil) return;
          const pwd = input.value;
          if (!pwd) {
            setError('请输入密码');
            shake();
            return;
          }
          btn.disabled = true;
          try {
            const ok = await root.LockManager.unlock(pwd);
            if (ok) {
              destroyDom();
              resolve(true);
              return;
            }
            failCount += 1;
            input.value = '';
            shake();
            if (failCount >= COOLDOWN_AFTER) {
              cooldownUntil = Date.now() + COOLDOWN_MS;
              refreshCooldown();
            } else {
              setError(`密码不正确（${failCount}/${COOLDOWN_AFTER}）`);
            }
          } catch (e) {
            setError(e && e.message ? e.message : '解锁失败');
          } finally {
            if (Date.now() >= cooldownUntil) {
              btn.disabled = false;
              input.focus();
            }
          }
        };

        btn.addEventListener('click', tryUnlock);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            tryUnlock();
          }
        });
        // 自动聚焦
        setTimeout(() => { try { input.focus(); } catch (_) {} }, 0);
      };

      if (document.body) {
        append();
      } else {
        document.addEventListener('DOMContentLoaded', append, { once: true });
      }
    });
  }

  const LockScreen = {
    guard,
    destroy: destroyDom
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = LockScreen;
  }
  root.LockScreen = LockScreen;
})(typeof self !== 'undefined' ? self : this);
