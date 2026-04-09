/**
 * 悬浮球功能
 * 在所有页面显示悬浮球，点击打开书签弹窗
 */

(function() {
  'use strict';
  
  // 兼容的 API 对象
  const runtimeAPI = typeof browser !== 'undefined' ? browser.runtime : chrome.runtime;
  
  // 兼容的消息发送函数（避免与全局 sendMessage 冲突）
  function sendMessageCompat(message, callback) {
    if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.sendMessage) {
      // Firefox: 使用 Promise
      return browser.runtime.sendMessage(message).then(response => {
        if (callback) callback(response);
        return response;
      }).catch(error => {
        const isReceivingEndError = error && (
          error.message?.includes('Receiving end does not exist') ||
          error.message?.includes('Could not establish connection') ||
          String(error).includes('Receiving end does not exist') ||
          String(error).includes('Could not establish connection')
        );
        if (isReceivingEndError) {
          if (callback) callback(null);
          return null;
        }
        if (callback) callback(null);
        throw error;
      });
    } else {
      // Chrome/Edge: 使用回调
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            if (callback) callback(null);
            reject(new Error(lastError.message));
          } else {
            if (callback) callback(response);
            resolve(response);
          }
        });
      });
    }
  }
  
  let floatingBall = null;
  let isDragging = false;
  let dragOffset = { x: 0, y: 0 };
  let touchStartTime = 0;
  let touchStartPos = { x: 0, y: 0 };
  let hasMoved = false; // 标记是否实际移动了
  let autoDockTimer = null; // 悬浮球自动贴边计时器
  let floatingBallSettingsCache = null; // 缓存设置，包含 clickAction 等
  
  const FLOATING_BALL_STYLE_ID = 'cloud-bookmark-floating-ball-style';
  let baseVisualState = 'idle'; // idle | docked（hover/dragging 为临时态）

  // 检测是否为移动设备
  const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || 
                         (window.matchMedia && window.matchMedia('(max-width: 768px)').matches && 'ontouchstart' in window);

  function ensureFloatingBallStyle() {
    try {
      if (document.getElementById(FLOATING_BALL_STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = FLOATING_BALL_STYLE_ID;
      style.textContent = `
#cloud-bookmark-floating-ball {
  box-sizing: border-box;
  -webkit-tap-highlight-color: transparent;
  touch-action: none;
  border-radius: 999px;
  will-change: transform, opacity, box-shadow, background-color, border-color, filter;
}

#cloud-bookmark-floating-ball .cb-fb-icon {
  position: relative;
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  line-height: 1;
  opacity: 0.62; /* idle: 主体更明显，但仍克制 */
  filter: saturate(0.9) brightness(0.98);
  transition: opacity 220ms cubic-bezier(0.2, 0.9, 0.2, 1),
    filter 220ms cubic-bezier(0.2, 0.9, 0.2, 1);
}

/* 云端书签：纯 CSS 矢量（细线云 + 书签标签），更“产品化” */
#cloud-bookmark-floating-ball .cb-fb-icon::before,
#cloud-bookmark-floating-ball .cb-fb-icon::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  pointer-events: none;
}

/* 云朵：描边 + 轻微内发光 */
#cloud-bookmark-floating-ball .cb-fb-icon::before {
  width: 24px;
  height: 15px;
  transform: translate(-50%, -50%) translateY(-1px);
  border-radius: 999px;
  background:
    radial-gradient(circle at 30% 55%, rgba(255, 255, 255, 0.22) 0 55%, rgba(255, 255, 255, 0) 56%),
    radial-gradient(circle at 52% 35%, rgba(255, 255, 255, 0.20) 0 58%, rgba(255, 255, 255, 0) 59%),
    radial-gradient(circle at 72% 58%, rgba(255, 255, 255, 0.18) 0 55%, rgba(255, 255, 255, 0) 56%);
  box-shadow:
    0 0 0 1.8px rgba(167, 139, 250, 0.78),
    0 0 14px rgba(99, 102, 241, 0.22);
  opacity: 1;
  filter: drop-shadow(0 3px 6px rgba(15, 23, 42, 0.16));
}

/* 书签：细线标签 + 缺口 */
#cloud-bookmark-floating-ball .cb-fb-icon::after {
  width: 13px;
  height: 18px;
  transform: translate(-50%, -50%) translateX(7px) translateY(5px) rotate(7deg);
  border-radius: 4px;
  background:
    linear-gradient(180deg, rgba(99, 102, 241, 0.95), rgba(168, 85, 247, 0.92));
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.30) inset,
    0 8px 18px rgba(15, 23, 42, 0.20);
  clip-path: polygon(0 0, 100% 0, 100% 100%, 50% 82%, 0 100%);
  opacity: 0.98;
}

/* 状态下的微调：hover 更亮，docked 更克制 */
#cloud-bookmark-floating-ball[data-state='hover'] .cb-fb-icon::before {
  box-shadow:
    0 0 0 1.5px rgba(129, 140, 248, 0.85),
    0 0 14px rgba(99, 102, 241, 0.26);
}
#cloud-bookmark-floating-ball[data-state='docked'] .cb-fb-icon::after {
  opacity: 0.92;
}

/* idle: 背景几乎完全透明，只保留轮廓和图标，尽量不遮挡页面内容 */
#cloud-bookmark-floating-ball[data-state='idle'] {
  background: transparent;
  border: 1px solid rgba(129, 140, 248, 0.35);
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  transform: translateZ(0);
}

/* hover: 轻微高亮，仍然保持半透明，不大块遮挡内容 */
#cloud-bookmark-floating-ball[data-state='hover'] {
  background: rgba(99, 102, 241, 0.10);
  border: 1px solid rgba(129, 140, 248, 0.55);
  box-shadow: 0 8px 22px rgba(15, 23, 42, 0.18),
    0 0 0 1px rgba(99, 102, 241, 0.18);
}
#cloud-bookmark-floating-ball[data-state='hover'] .cb-fb-icon {
  opacity: 1;
  filter: saturate(1.25) brightness(1.05);
}

/* dragging: 更清晰 + 取消多余动效（略有填充，但用户正在操作时优先可见性） */
#cloud-bookmark-floating-ball[data-state='dragging'] {
  background: rgba(99, 102, 241, 0.20);
  border: 1px solid rgba(129, 140, 248, 0.55);
  box-shadow: 0 10px 26px rgba(15, 23, 42, 0.22);
}
#cloud-bookmark-floating-ball[data-state='dragging'] .cb-fb-icon {
  opacity: 1;
  filter: saturate(1.25) brightness(1.05);
}

/* docked: 贴边后基本只有轮廓+图标，不填充背景，避免挡住内容 */
#cloud-bookmark-floating-ball[data-state='docked'] {
  background: transparent;
  border: 1px solid rgba(99, 102, 241, 0.30);
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}
#cloud-bookmark-floating-ball[data-state='docked'] .cb-fb-icon {
  opacity: 0.48; /* docked: 仍然看得清主体 */
  filter: saturate(0.85) brightness(0.95);
}

@media (prefers-reduced-motion: reduce) {
  #cloud-bookmark-floating-ball,
  #cloud-bookmark-floating-ball .cb-fb-icon {
    transition: none !important;
  }
}
      `.trim();
      (document.head || document.documentElement).appendChild(style);
    } catch (e) {
      console.warn('[悬浮球] 注入样式失败（忽略）:', e?.message || e);
    }
  }

  function setFloatingBallState(state) {
    if (!floatingBall) return;
    floatingBall.dataset.state = state;

    // hover/dragging 在 mouseleave/stopDrag 后回到 baseVisualState
    if (state === 'idle' || state === 'docked') {
      baseVisualState = state;
    }

    // 高级感：hover/dragging 轻微上浮（不破坏 translateY(-50%) 的居中定位）
    try {
      const hasTranslateY = typeof floatingBall.style.transform === 'string' &&
        floatingBall.style.transform.includes('translateY(-50%)');
      if (state === 'hover') {
        floatingBall.style.transform = hasTranslateY
          ? 'translateY(-50%) translateZ(0) scale(1.08)'
          : 'translateZ(0) scale(1.08)';
      } else if (state === 'dragging') {
        floatingBall.style.transform = '';
      } else {
        // idle / docked：恢复到原定位 transform（如果有）
        if (hasTranslateY) {
          floatingBall.style.transform = 'translateY(-50%)';
        }
      }
    } catch (_) {
      // ignore
    }
  }

  function setHovering(isHovering) {
    if (!floatingBall) return;
    if (isDragging) return;
    // docked 状态：悬停时回弹完全可见；离开时恢复“贴边隐藏”
    if (baseVisualState === 'docked') {
      try {
        applyDockOffset({ reveal: !!isHovering });
      } catch (_) {}
    }
    setFloatingBallState(isHovering ? 'hover' : baseVisualState);
  }

  // 同步失败 Toast（不影响页面交互：pointer-events: none）
  let toastEl = null;
  let toastTimer = null;

  function showSyncErrorToast({ title, message, duration = 2000 } = {}) {
    try {
      const toastId = 'cloud-bookmark-sync-error-toast';
      if (!toastEl) {
        toastEl = document.getElementById(toastId);
      }

      if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.id = toastId;
        toastEl.style.cssText = `
          position: fixed;
          top: 16px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 2147483647;
          max-width: calc(100vw - 32px);
          width: 420px;
          padding: 10px 14px;
          border-radius: 10px;
          background: rgba(220, 53, 69, 0.96);
          color: #fff;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          pointer-events: none; /* 关键：不阻断页面点击 */
          opacity: 0;
          transition: opacity 120ms ease;
        `;

        toastEl.innerHTML = `
          <div style="display:flex; gap:10px; align-items:flex-start;">
            <div style="font-size:18px; line-height:1; margin-top:1px;">⚠️</div>
            <div style="flex:1; min-width:0;">
              <div id="${toastId}-title" style="font-weight:700; font-size:13px; margin-bottom:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;"></div>
              <div id="${toastId}-msg" style="font-size:12px; line-height:1.35; opacity:0.95; word-break:break-word;"></div>
            </div>
            <button id="${toastId}-close" style="
              background:none;
              border:none;
              color:#fff;
              font-size:18px;
              line-height:1;
              cursor:pointer;
              padding:0;
              width:20px;
              height:20px;
              display:flex;
              align-items:center;
              justify-content:center;
              opacity:0.8;
              transition:opacity 0.15s;
              flex-shrink:0;
              margin-left:4px;
            " title="关闭" aria-label="关闭">×</button>
          </div>
        `;
        
        // 添加关闭按钮事件（需要允许点击，所以给按钮单独设置 pointer-events）
        const closeBtn = toastEl.querySelector(`#${toastId}-close`);
        if (closeBtn) {
          closeBtn.style.pointerEvents = 'auto'; // 关闭按钮需要可点击
          closeBtn.addEventListener('mouseenter', () => {
            closeBtn.style.opacity = '1';
          });
          closeBtn.addEventListener('mouseleave', () => {
            closeBtn.style.opacity = '0.8';
          });
          closeBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (toastTimer) {
              clearTimeout(toastTimer);
              toastTimer = null;
            }
            if (toastEl) {
              toastEl.style.opacity = '0';
              setTimeout(() => {
                try {
                  toastEl?.remove();
                } catch (_) {}
                toastEl = null;
              }, 160);
            }
          });
        }

        // 只在 body 可用时插入；否则延迟到 DOMReady
        const mount = () => {
          if (document.body && !document.getElementById(toastId)) {
            document.body.appendChild(toastEl);
          }
        };
        if (document.body) mount();
        else document.addEventListener('DOMContentLoaded', mount, { once: true });
      }

      const titleEl = toastEl.querySelector(`#${toastId}-title`);
      const msgEl = toastEl.querySelector(`#${toastId}-msg`);
      if (titleEl) titleEl.textContent = title || '云端书签同步失败';
      if (msgEl) msgEl.textContent = message || '同步失败，请检查网络或 WebDAV 配置';

      if (toastTimer) {
        clearTimeout(toastTimer);
        toastTimer = null;
      }

      // 显示
      requestAnimationFrame(() => {
        if (toastEl) toastEl.style.opacity = '1';
      });

      // 自动隐藏 + 移除（duration <= 0 时不自动消失，用于调试）
      if (duration && duration > 0) {
        toastTimer = setTimeout(() => {
          if (!toastEl) return;
          toastEl.style.opacity = '0';
          setTimeout(() => {
            try {
              toastEl?.remove();
            } catch (_) {}
            toastEl = null;
          }, 160);
        }, Math.max(500, duration));
      } else {
        toastTimer = null;
      }
    } catch (e) {
      // content script 里避免打断页面
      console.warn('[Toast] 显示失败:', e?.message || e);
    }
  }
  
  // 确保悬浮球在可视区域内
  function constrainToViewport() {
    if (!floatingBall) return;
    
    const rect = floatingBall.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const ballWidth = rect.width;
    const ballHeight = rect.height;
    
    // 使用 getBoundingClientRect 获取实际位置（更可靠）
    let currentLeft = rect.left;
    let currentTop = rect.top;
    
    let needsAdjustment = false;
    let newLeft = currentLeft;
    let newTop = currentTop;
    
    // 检查并修正水平位置
    // docked 状态允许“贴边隐藏一部分”（PC 默认隐藏 1/3；移动端默认不隐藏）
    const hiddenPx = baseVisualState === 'docked' ? getDockHiddenPx(ballWidth) : 0;
    const minLeft = baseVisualState === 'docked' ? -hiddenPx : 0;
    const maxLeft = baseVisualState === 'docked'
      ? Math.max(minLeft, viewportWidth - ballWidth + hiddenPx)
      : Math.max(0, viewportWidth - ballWidth);

    if (currentLeft < minLeft) {
      newLeft = minLeft;
      needsAdjustment = true;
    } else if (currentLeft > maxLeft) {
      newLeft = maxLeft;
      needsAdjustment = true;
    }
    
    // 检查并修正垂直位置
    if (currentTop < 0) {
      newTop = 0;
      needsAdjustment = true;
    } else if (currentTop + ballHeight > viewportHeight) {
      newTop = Math.max(0, viewportHeight - ballHeight);
      needsAdjustment = true;
    }
    
    // 如果需要调整，更新位置
    if (needsAdjustment) {
      floatingBall.style.left = newLeft + 'px';
      floatingBall.style.top = newTop + 'px';
      floatingBall.style.right = 'auto';
      floatingBall.style.transform = '';
      
      // 保存新位置
      saveFloatingBallPosition({ x: newLeft, y: newTop });
    }
  }
  
  // 清除自动贴边计时器
  function clearAutoDockTimer() {
    if (autoDockTimer) {
      clearTimeout(autoDockTimer);
      autoDockTimer = null;
    }
  }

  // 启动（或重置）自动贴边计时器
  function scheduleAutoDock() {
    clearAutoDockTimer();
    autoDockTimer = setTimeout(async () => {
      await dockToNearestEdge();
    }, 2000); // 2 秒无操作自动贴边
  }

  function getDockHiddenPx(width) {
    // 手机屏幕小：默认不隐藏（只做低存在感），避免误触/难点到
    if (isMobileDevice) return 0;
    // PC：默认隐藏 1/3
    return Math.max(0, Math.round(width / 3));
  }

  function applyDockOffset({ reveal } = {}) {
    if (!floatingBall) return;
    if (baseVisualState !== 'docked') return;

    const rect = floatingBall.getBoundingClientRect();
    const hiddenPx = getDockHiddenPx(rect.width);
    const side = floatingBall.dataset.dockSide || (rect.left <= window.innerWidth / 2 ? 'left' : 'right');

    // reveal: 悬停时完全可见；否则按隐藏比例贴边
    const offset = reveal ? 0 : -hiddenPx;

    floatingBall.style.transition = 'left 0.2s ease, right 0.2s ease, transform 0.2s, opacity 0.2s';
    if (side === 'left') {
      floatingBall.style.left = `${offset}px`;
      floatingBall.style.right = 'auto';
    } else {
      floatingBall.style.right = `${offset}px`;
      floatingBall.style.left = 'auto';
    }
  }

  // 贴近最近的左右边缘（根据设置决定靠左、靠右或自动）
  async function dockToNearestEdge() {
    if (!floatingBall) return;

    // 获取设置
    const settings = await getSettings();
    const floatingBallSettings = (settings && settings.floatingBall) || {};
    const defaultPosition = floatingBallSettings.defaultPosition || 'auto';

    const rect = floatingBall.getBoundingClientRect();
    const viewportWidth = window.innerWidth;

    // 使用平滑动画
    floatingBall.style.transition = 'left 0.2s ease, right 0.2s ease, transform 0.2s, opacity 0.2s';

    const hiddenPx = getDockHiddenPx(rect.width);

    // 根据设置决定靠左、靠右或自动（贴边时隐藏一部分）
    if (defaultPosition === 'left') {
      // 强制靠左
      floatingBall.dataset.dockSide = 'left';
      floatingBall.style.left = `-${hiddenPx}px`;
      floatingBall.style.right = 'auto';
    } else if (defaultPosition === 'right') {
      // 强制靠右
      floatingBall.dataset.dockSide = 'right';
      floatingBall.style.right = `-${hiddenPx}px`;
      floatingBall.style.left = 'auto';
    } else {
      // 自动：根据距离最近的边缘贴边
      const distanceToLeft = rect.left;
      const distanceToRight = viewportWidth - (rect.left + rect.width);
      
      if (distanceToLeft <= distanceToRight) {
        // 贴左边
        floatingBall.dataset.dockSide = 'left';
        floatingBall.style.left = `-${hiddenPx}px`;
        floatingBall.style.right = 'auto';
      } else {
        // 贴右边
        floatingBall.dataset.dockSide = 'right';
        floatingBall.style.right = `-${hiddenPx}px`;
        floatingBall.style.left = 'auto';
      }
    }

    // 贴边后进入 docked 状态（更低存在感）
    setFloatingBallState('docked');

    // 保存新位置（使用最新的实际位置）
    setTimeout(() => {
      if (!floatingBall) return;
      const finalRect = floatingBall.getBoundingClientRect();
      saveFloatingBallPosition({
        x: finalRect.left,
        y: finalRect.top
      });
    }, 220);
  }

  // 初始化悬浮球
  async function initFloatingBall() {
    console.log('[悬浮球] initFloatingBall 开始');
    
    // 检查是否启用悬浮球
    const settings = await getSettings();
    floatingBallSettingsCache = (settings && settings.floatingBall) || {};
    console.log('[悬浮球] 设置:', settings?.floatingBall);
    
    if (!settings || !settings.floatingBall || !settings.floatingBall.enabled) {
      console.log('[悬浮球] 悬浮球未启用，移除现有实例');
      if (floatingBall) {
        floatingBall.remove();
        floatingBall = null;
      }
      return;
    }
    
    // 如果已存在，只更新位置约束
    if (floatingBall) {
      console.log('[悬浮球] 已存在，检查位置约束');
      constrainToViewport();
      return;
    }
    
    console.log('[悬浮球] 开始创建悬浮球元素');
    
    // 创建悬浮球
    floatingBall = document.createElement('div');
    floatingBall.id = 'cloud-bookmark-floating-ball';
    ensureFloatingBallStyle();
    floatingBall.dataset.state = 'idle';
    floatingBall.innerHTML = '<span class="cb-fb-icon" aria-hidden="true"></span>';
    floatingBall.style.cssText = `
      position: fixed;
      width: 40px;
      height: 40px;
      cursor: pointer;
      z-index: 999999;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      user-select: none;
      opacity: 1;
      transition: left 0.2s ease, right 0.2s ease, transform 220ms cubic-bezier(0.2, 0.9, 0.2, 1), opacity 220ms cubic-bezier(0.2, 0.9, 0.2, 1);
    `;
    
    // 加载保存的位置
    const position = await getFloatingBallPosition();
    if (position) {
      floatingBall.style.left = position.x + 'px';
      floatingBall.style.top = position.y + 'px';
    } else {
      // 默认位置：右侧中间
      floatingBall.style.right = '20px';
      floatingBall.style.top = '50%';
      floatingBall.style.transform = 'translateY(-50%)';
    }
    
    // 添加事件监听
    floatingBall.addEventListener('mousedown', startDrag);
    floatingBall.addEventListener('touchstart', handleTouchStart, { passive: false });
    floatingBall.addEventListener('touchmove', handleTouchMove, { passive: false });
    floatingBall.addEventListener('touchend', handleTouchEnd, { passive: false });
    floatingBall.addEventListener('click', handleClick);
    
    console.log('[悬浮球] 初始化完成，事件监听已绑定');
    
    // 添加悬停效果（仅视觉状态切换）
    floatingBall.addEventListener('mouseenter', () => setHovering(true));
    floatingBall.addEventListener('mouseleave', () => setHovering(false));
    
    document.body.appendChild(floatingBall);
    
    // 确保位置在可视区域内（延迟执行以确保元素已渲染）
    setTimeout(() => {
      constrainToViewport();
      // 初始化后开始自动贴边计时
      setFloatingBallState('idle');
      scheduleAutoDock();
    }, 0);
  }
  
  // 开始拖动
  function startDrag(e) {
    e.preventDefault();
    e.stopPropagation();
    isDragging = true;
    clearAutoDockTimer();
    if (floatingBall) {
      setFloatingBallState('dragging');
      floatingBall.style.opacity = '1';
    }
    
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    
    const rect = floatingBall.getBoundingClientRect();
    dragOffset.x = clientX - rect.left - rect.width / 2;
    dragOffset.y = clientY - rect.top - rect.height / 2;
    
    // 记录初始位置（用于检测是否移动，仅对鼠标事件）
    if (!e.touches) {
      // 鼠标事件：记录初始位置
      touchStartPos.x = clientX;
      touchStartPos.y = clientY;
      hasMoved = false;
    }
    
    // 临时禁用点击事件，防止拖动时误触发
    floatingBall.style.pointerEvents = 'auto';
    
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('touchmove', onDrag, { passive: false });
    document.addEventListener('mouseup', stopDrag);
    document.addEventListener('touchend', stopDrag);
    
    floatingBall.style.transition = 'none';
    floatingBall.style.transform = '';
  }
  
  // 拖动中
  function onDrag(e) {
    if (!isDragging) return;
    e.preventDefault();
    
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    
    // 检测是否移动（仅对鼠标事件）
    if (!e.touches) {
      const distance = Math.sqrt(
        Math.pow(clientX - touchStartPos.x, 2) + 
        Math.pow(clientY - touchStartPos.y, 2)
      );
      if (distance > 5) { // 鼠标移动超过5px认为是在拖动
        hasMoved = true;
      }
    }
    
    let x = clientX - dragOffset.x - floatingBall.offsetWidth / 2;
    let y = clientY - dragOffset.y - floatingBall.offsetHeight / 2;
    
    // 限制在可视区域内
    const maxX = window.innerWidth - floatingBall.offsetWidth;
    const maxY = window.innerHeight - floatingBall.offsetHeight;
    x = Math.max(0, Math.min(x, maxX));
    y = Math.max(0, Math.min(y, maxY));
    
    floatingBall.style.left = x + 'px';
    floatingBall.style.top = y + 'px';
    floatingBall.style.right = 'auto';
    floatingBall.style.transform = '';
  }
  
  // 停止拖动
  function stopDrag(e) {
    if (!isDragging) return;
    
    const wasMoved = hasMoved; // 保存移动状态
    isDragging = false;
    
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('touchmove', onDrag);
    document.removeEventListener('mouseup', stopDrag);
    document.removeEventListener('touchend', stopDrag);
    
    floatingBall.style.transition = 'left 0.2s ease, right 0.2s ease, transform 220ms cubic-bezier(0.2, 0.9, 0.2, 1), opacity 220ms cubic-bezier(0.2, 0.9, 0.2, 1)';
    
    // 确保位置在可视区域内
    constrainToViewport();
    
    // 保存位置（使用当前实际位置）
    const rect = floatingBall.getBoundingClientRect();
    saveFloatingBallPosition({
      x: rect.left,
      y: rect.top
    });
    
    // 如果移动了，延迟重置 hasMoved，确保 click 事件能正确检测到
    // 这样可以防止拖动后误触发点击
    // 注意：移动端使用触摸事件，不会触发 click 事件，所以不需要拦截
    if (wasMoved) {
      // PC端：延迟重置，给 click 事件足够的时间检查 hasMoved
      // 同时临时阻止点击事件（仅PC端，移动端不会触发click）
      if (!isMobileDevice) {
        const clickHandler = (e) => {
          e.preventDefault();
          e.stopPropagation();
          floatingBall.removeEventListener('click', clickHandler);
        };
        floatingBall.addEventListener('click', clickHandler, { once: true, capture: true });
      }
      
      setTimeout(() => {
        hasMoved = false;
      }, 150);
    } else {
      hasMoved = false;
    }
    
    // 重置触摸状态
    touchStartTime = 0;

    // 拖动结束后重新启动自动贴边计时
    setFloatingBallState('idle');
    scheduleAutoDock();
  }
  
  // 处理点击
  function handleClick(e) {
    console.log('[悬浮球] handleClick 被调用, isDragging:', isDragging, 'hasMoved:', hasMoved);
    
    // 如果刚刚拖动过，不触发点击
    if (isDragging || hasMoved) {
      console.log('[悬浮球] 检测到拖动状态，忽略点击');
      return;
    }
    
    e.preventDefault();
    e.stopPropagation();

    // 点击也视为一次操作，恢复不透明并重新计时
    if (floatingBall) {
      floatingBall.style.opacity = '1';
      setFloatingBallState('idle');
    }
    scheduleAutoDock();
    
    // 获取当前页面的URL和标题（直接从content script获取，避免标签页查询问题）
    const currentUrl = window.location.href;
    const currentTitle = document.title;
    const clickAction = (floatingBallSettingsCache && floatingBallSettingsCache.clickAction) || 'popup';

    if (clickAction === 'quickSave') {
      // 一键模式：直接打开「添加当前页面」的完整界面（等价于弹窗里的“添加当前页面”按钮）
      sendMessageCompat({
        action: 'openAddBookmarkWindow',
        currentUrl,
        currentTitle,
        source: 'floating-ball'
      }).catch(err => {
        console.error('[悬浮球] openAddBookmarkWindow(quickSave) 异常:', err);
      });
    } else {
      // 默认：仅打开弹窗
      fallbackOpenPopup(currentUrl, currentTitle);
    }
  }
  
  function fallbackOpenPopup(currentUrl, currentTitle) {
    sendMessageCompat({ 
      action: 'openPopup',
      currentUrl,
      currentTitle
    }).then(response => {
      console.log('[悬浮球] openPopup 响应:', response);
      if (!response || !response.success) {
        console.log('[悬浮球] openPopup 失败，尝试打开完整页面');
        return sendMessageCompat({ 
          action: 'openAddBookmarkWindow',
          currentUrl,
          currentTitle,
          source: 'floating-ball'
        });
      }
    }).catch((error) => {
      console.error('[悬浮球] openPopup 异常:', error);
      sendMessageCompat({ 
        action: 'openAddBookmarkWindow',
        currentUrl,
        currentTitle,
        source: 'floating-ball'
      }).catch((err) => {
        console.error('[悬浮球] openAddBookmarkWindow 也失败:', err);
      });
    });
  }
  
  // 处理触摸开始（移动端专用）
  function handleTouchStart(e) {
    touchStartTime = Date.now();
    hasMoved = false;
    isDragging = false;
    const touch = e.touches[0];
    touchStartPos.x = touch.clientX;
    touchStartPos.y = touch.clientY;
    
    // 记录初始位置用于拖动（但不立即开始拖动）
    const rect = floatingBall.getBoundingClientRect();
    dragOffset.x = touch.clientX - rect.left - rect.width / 2;
    dragOffset.y = touch.clientY - rect.top - rect.height / 2;

    // 触摸开始视为一次操作，清除自动贴边计时器并恢复不透明
    clearAutoDockTimer();
    if (floatingBall) {
      floatingBall.style.opacity = '1';
      setFloatingBallState('idle');
    }
  }
  
  // 处理触摸移动
  function handleTouchMove(e) {
    if (!touchStartTime) return;
    
    const touch = e.touches[0];
    const distance = Math.sqrt(
      Math.pow(touch.clientX - touchStartPos.x, 2) + 
      Math.pow(touch.clientY - touchStartPos.y, 2)
    );
    
    // 如果移动距离超过阈值（10px），认为是拖动
    if (distance > 10 && !isDragging) {
      hasMoved = true;
      isDragging = true;
      e.preventDefault();
      e.stopPropagation();
      
      // 开始拖动
      setFloatingBallState('dragging');
      floatingBall.style.transition = 'none';
      floatingBall.style.transform = '';
      
      document.addEventListener('touchmove', onDrag, { passive: false });
      document.addEventListener('touchend', stopDrag);
    }
    
    // 如果已经在拖动，继续拖动
    if (isDragging) {
      onDrag(e);
    }
  }
  
  // 处理触摸结束（移动端专用）
  function handleTouchEnd(e) {
    const touchEndTime = Date.now();
    const touch = e.changedTouches[0];
    const touchEndPos = { x: touch.clientX, y: touch.clientY };
    
    // 计算时间和距离
    const timeDiff = touchEndTime - touchStartTime;
    const distance = Math.sqrt(
      Math.pow(touchEndPos.x - touchStartPos.x, 2) + 
      Math.pow(touchEndPos.y - touchStartPos.y, 2)
    );
    
    console.log('[悬浮球] touchEnd, timeDiff:', timeDiff, 'distance:', distance, 'isDragging:', isDragging, 'hasMoved:', hasMoved);
    
    // 如果正在拖动，停止拖动
    if (isDragging) {
      stopDrag(e);
      // 重置状态（移动端拖动后不触发点击）
      touchStartTime = 0;
      hasMoved = false;
      return;
    }
    
    // 如果没有移动且时间很短，认为是点击（移动端）
    // 移动端使用触摸事件，不会触发 click 事件，所以直接在这里处理
    if (!hasMoved && timeDiff < 300 && distance < 10) {
      console.log('[悬浮球] 移动端识别为点击');
      e.preventDefault();
      e.stopPropagation();

      // 点击视为一次操作，恢复不透明并重新计时
      if (floatingBall) {
        floatingBall.style.opacity = '1';
        setFloatingBallState('idle');
      }
      scheduleAutoDock();
      
      // 获取当前页面的URL和标题（直接从content script获取，避免标签页查询问题）
      const currentUrl = window.location.href;
      const currentTitle = document.title;
      
      const clickAction = (floatingBallSettingsCache && floatingBallSettingsCache.clickAction) || 'popup';
      if (clickAction === 'quickSave') {
        sendMessageCompat({
          action: 'openAddBookmarkWindow',
          currentUrl,
          currentTitle,
          source: 'floating-ball'
        }).catch(err => {
          console.error('[悬浮球] openAddBookmarkWindow(quickSave touch) 异常:', err);
        });
      } else {
        fallbackOpenPopup(currentUrl, currentTitle);
      }
    }
    
    // 重置状态
    touchStartTime = 0;
    hasMoved = false;

    // 触摸结束后，如果没有触发点击（例如长按但未拖动），也重新开始计时
    if (!isDragging) {
      scheduleAutoDock();
    }
  }
  
  // 兼容的 storage API
  const storageAPI = typeof browser !== 'undefined' ? browser.storage : chrome.storage;
  
  // 获取设置
  function getSettings() {
    return new Promise((resolve) => {
      if (typeof browser !== 'undefined' && browser.storage) {
        // Firefox: 使用 Promise
        browser.storage.local.get(['settings']).then(result => {
          const settings = result.settings || {};
          // 默认设置合并：确保“默认启用悬浮球”在 content script 里也生效
          const floatingBall = (settings && settings.floatingBall) || {};
          resolve({
            ...settings,
            floatingBall: {
              enabled: floatingBall.enabled !== false, // 未设置时默认 true
              defaultPosition: floatingBall.defaultPosition || 'auto',
              clickAction: floatingBall.clickAction || 'popup'
            }
          });
        });
      } else {
        // Chrome/Edge: 使用回调
        chrome.storage.local.get(['settings'], (result) => {
          const settings = result.settings || {};
          const floatingBall = (settings && settings.floatingBall) || {};
          resolve({
            ...settings,
            floatingBall: {
              enabled: floatingBall.enabled !== false,
              defaultPosition: floatingBall.defaultPosition || 'auto',
              clickAction: floatingBall.clickAction || 'popup'
            }
          });
        });
      }
    });
  }
  
  // 获取悬浮球位置
  function getFloatingBallPosition() {
    return new Promise((resolve) => {
      if (typeof browser !== 'undefined' && browser.storage) {
        // Firefox: 使用 Promise
        browser.storage.local.get(['floatingBallPosition']).then(result => {
          resolve(result.floatingBallPosition || null);
        });
      } else {
        // Chrome/Edge: 使用回调
        chrome.storage.local.get(['floatingBallPosition'], (result) => {
          resolve(result.floatingBallPosition || null);
        });
      }
    });
  }
  
  // 保存悬浮球位置
  function saveFloatingBallPosition(position) {
    if (typeof browser !== 'undefined' && browser.storage) {
      // Firefox: 使用 Promise
      browser.storage.local.set({ floatingBallPosition: position });
    } else {
      // Chrome/Edge: 使用回调
      chrome.storage.local.set({ floatingBallPosition: position }, () => {});
    }
  }
  
  // 监听消息
  runtimeAPI.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'updateFloatingBall') {
      initFloatingBall();
      sendResponse({ success: true });
      return true; // Firefox 异步消息需要返回 true
    }
    if (request.action === 'showSyncErrorToast') {
      try {
        console.log('[Toast] content script received showSyncErrorToast', {
          title: request.title,
          hasMessage: !!request.message,
          duration: request.duration
        });
      } catch (_) {}
      showSyncErrorToast({
        title: request.title,
        message: request.message,
        duration: request.duration
      });
      sendResponse({ success: true });
      return true;
    }
  });
  
  // 页面加载完成后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFloatingBall);
  } else {
    initFloatingBall();
  }
  
  // 监听设置变化
  storageAPI.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.settings) {
      initFloatingBall();
    }
  });
  
  // 监听窗口大小变化和页面缩放，自动调整悬浮球位置
  let resizeTimer = null;
  let lastViewportWidth = window.innerWidth;
  let lastViewportHeight = window.innerHeight;
  
  function handleResize() {
    // 防抖处理，避免频繁调用
    if (resizeTimer) {
      clearTimeout(resizeTimer);
    }
    resizeTimer = setTimeout(() => {
      if (floatingBall) {
        // 检查视口大小是否真的改变了（避免不必要的调用）
        const currentWidth = window.innerWidth;
        const currentHeight = window.innerHeight;
        if (currentWidth !== lastViewportWidth || currentHeight !== lastViewportHeight) {
          lastViewportWidth = currentWidth;
          lastViewportHeight = currentHeight;
          constrainToViewport();
        }
      }
    }, 100);
  }
  
  // 基础 resize 事件（所有浏览器都支持）
  if (window.addEventListener) {
    window.addEventListener('resize', handleResize);
  } else if (window.attachEvent) {
    // 兼容 IE8 及以下（虽然现在很少用，但为了完整性）
    window.attachEvent('onresize', handleResize);
  }
  
  // 监听页面缩放（通过 visualViewport API，如果可用）
  // visualViewport API 支持情况：
  // - Chrome 61+, Edge 79+, Firefox 91+, Safari 13+
  if (typeof window !== 'undefined' && window.visualViewport) {
    try {
      if (window.visualViewport.addEventListener) {
        window.visualViewport.addEventListener('resize', handleResize);
        window.visualViewport.addEventListener('scroll', handleResize);
      }
    } catch (e) {
      // 某些浏览器可能不支持，忽略错误
      console.warn('[悬浮球] visualViewport API 不可用:', e);
    }
  }
  
  // 备用方案：通过定时检查视口变化（用于检测缩放）
  // 这可以捕获一些 visualViewport 无法捕获的情况
  let viewportCheckInterval = null;
  function startViewportCheck() {
    if (viewportCheckInterval) return;
    viewportCheckInterval = setInterval(() => {
      if (floatingBall) {
        const currentWidth = window.innerWidth;
        const currentHeight = window.innerHeight;
        if (currentWidth !== lastViewportWidth || currentHeight !== lastViewportHeight) {
          lastViewportWidth = currentWidth;
          lastViewportHeight = currentHeight;
          constrainToViewport();
        }
      }
    }, 500); // 每 500ms 检查一次
  }
  
  // 页面加载完成后开始检查
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startViewportCheck);
  } else {
    startViewportCheck();
  }
})();
