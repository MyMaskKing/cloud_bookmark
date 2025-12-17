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
  
  // 初始化悬浮球
  async function initFloatingBall() {
    console.log('[悬浮球] initFloatingBall 开始');
    
    // 检查是否启用悬浮球
    const settings = await getSettings();
    console.log('[悬浮球] 设置:', settings?.floatingBall);
    
    if (!settings || !settings.floatingBall || !settings.floatingBall.enabled) {
      console.log('[悬浮球] 悬浮球未启用，移除现有实例');
      if (floatingBall) {
        floatingBall.remove();
        floatingBall = null;
      }
      return;
    }
    
    // 如果已存在，不重复创建
    if (floatingBall) {
      console.log('[悬浮球] 已存在，跳过创建');
      return;
    }
    
    console.log('[悬浮球] 开始创建悬浮球元素');
    
    // 创建悬浮球
    floatingBall = document.createElement('div');
    floatingBall.id = 'cloud-bookmark-floating-ball';
    floatingBall.innerHTML = '📚';
    floatingBall.style.cssText = `
      position: fixed;
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      cursor: pointer;
      z-index: 999999;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      user-select: none;
      transition: transform 0.2s, box-shadow 0.2s;
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
    
    // 添加悬停效果
    floatingBall.addEventListener('mouseenter', () => {
      floatingBall.style.transform = floatingBall.style.transform.includes('translateY') 
        ? 'translateY(-50%) scale(1.1)' 
        : 'scale(1.1)';
      floatingBall.style.boxShadow = '0 6px 16px rgba(0,0,0,0.2)';
    });
    
    floatingBall.addEventListener('mouseleave', () => {
      floatingBall.style.transform = floatingBall.style.transform.includes('scale') 
        ? floatingBall.style.transform.replace(' scale(1.1)', '')
        : floatingBall.style.transform;
      floatingBall.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
    });
    
    document.body.appendChild(floatingBall);
  }
  
  // 开始拖动
  function startDrag(e) {
    e.preventDefault();
    e.stopPropagation();
    isDragging = true;
    
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
    isDragging = false;
    hasMoved = false;
    
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('touchmove', onDrag);
    document.removeEventListener('mouseup', stopDrag);
    document.removeEventListener('touchend', stopDrag);
    
    floatingBall.style.transition = 'transform 0.2s, box-shadow 0.2s';
    
    // 保存位置
    const rect = floatingBall.getBoundingClientRect();
    saveFloatingBallPosition({
      x: rect.left,
      y: rect.top
    });
    
    // 重置触摸状态
    touchStartTime = 0;
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
    
    console.log('[悬浮球] 开始发送 openPopup 消息');
    
    // 打开书签弹窗（在新窗口中打开popup页面）
    sendMessageCompat({ action: 'openPopup' }).then(response => {
      console.log('[悬浮球] openPopup 响应:', response);
      if (!response || !response.success) {
        console.log('[悬浮球] openPopup 失败，尝试打开完整页面');
        // 如果无法打开popup，尝试打开完整页面
        return sendMessageCompat({ action: 'openBookmarksPage' });
      }
    }).catch((error) => {
      console.error('[悬浮球] openPopup 异常:', error);
      // 如果打开弹窗失败，尝试打开完整页面
      sendMessageCompat({ action: 'openBookmarksPage' }).then(() => {
        console.log('[悬浮球] openBookmarksPage 成功');
      }).catch((err) => {
        console.error('[悬浮球] openBookmarksPage 也失败:', err);
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
  
  // 处理触摸结束
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
      return;
    }
    
    // 如果没有移动且时间很短，认为是点击
    if (!hasMoved && timeDiff < 300 && distance < 10) {
      console.log('[悬浮球] 识别为点击，调用 handleClick');
      e.preventDefault();
      e.stopPropagation();
      handleClick(e);
    }
    
    // 重置状态
    touchStartTime = 0;
    hasMoved = false;
  }
  
  // 兼容的 storage API
  const storageAPI = typeof browser !== 'undefined' ? browser.storage : chrome.storage;
  
  // 获取设置
  function getSettings() {
    return new Promise((resolve) => {
      if (typeof browser !== 'undefined' && browser.storage) {
        // Firefox: 使用 Promise
        browser.storage.local.get(['settings']).then(result => {
          resolve(result.settings || {});
        });
      } else {
        // Chrome/Edge: 使用回调
        chrome.storage.local.get(['settings'], (result) => {
          resolve(result.settings || {});
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
})();
