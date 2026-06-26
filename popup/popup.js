/**
 * 弹出窗口脚本
 */

const storage = new StorageManager();

// 开发者日志开关：默认关闭，仅在设置中开启后才输出 console.log。
const originalConsoleLog = console.log.bind(console);
let enableDeveloperConsoleLogging = false;
console.log = (...args) => {
  if (enableDeveloperConsoleLogging) {
    originalConsoleLog(...args);
  }
};

// 初始化弹窗页的开发者日志开关，并保持和本地 settings 一致。
async function initDeveloperConsoleLogging() {
  try {
    const settings = await storage.getSettings();
    enableDeveloperConsoleLogging = !!settings?.developerSettings?.enableConsoleLogging;
  } catch (_) {
    enableDeveloperConsoleLogging = false;
  }
}

initDeveloperConsoleLogging().catch(() => { });

// 全局加载遮罩控制函数
function showGlobalLoading(message = '正在执行…') {
  const overlay = document.getElementById('globalLoadingOverlay');
  const textEl = overlay?.querySelector('.global-loading-text');
  if (textEl) {
    textEl.textContent = message;
  }
  if (overlay) {
    overlay.style.display = 'flex';
  }
}

function hideGlobalLoading() {
  const overlay = document.getElementById('globalLoadingOverlay');
  if (overlay) {
    overlay.style.display = 'none';
  }
}

// 兼容的消息发送函数（如果 utils.js 中的 sendMessage 不可用，则使用此实现）
const sendMessageCompat = typeof sendMessage !== 'undefined' ? sendMessage : function (message, callback) {
  const runtime = typeof browser !== 'undefined' ? browser.runtime : chrome.runtime;

  if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.sendMessage) {
    // Firefox: 使用 Promise
    return runtime.sendMessage(message).then(response => {
      if (callback) callback(response);
      return response;
    }).catch(error => {
      // Firefox 中，如果接收端不存在（background script 未准备好），静默处理
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
      runtime.sendMessage(message, (response) => {
        const lastError = runtime.lastError;
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
};

// 兼容的 API 对象
const runtimeAPI = typeof browser !== 'undefined' ? browser.runtime : chrome.runtime;
const tabsAPI = typeof browser !== 'undefined' ? browser.tabs : chrome.tabs;

// 监听 settings 变化，确保弹窗里的日志开关即时生效。
try {
  const storageAPI = typeof browser !== 'undefined' ? browser.storage : chrome.storage;
  if (storageAPI && storageAPI.onChanged) {
    storageAPI.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes.settings) {
        const nextSettings = changes.settings.newValue || {};
        enableDeveloperConsoleLogging = !!nextSettings?.developerSettings?.enableConsoleLogging;
      }
    });
  }
} catch (_) { }

// 工具函数（从utils.js导入的函数需要在这里定义或确保全局可用）
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

function searchBookmarks(bookmarks, query) {
  if (!query || !query.trim()) {
    return bookmarks;
  }
  const lowerQuery = query.toLowerCase();
  return bookmarks.filter(bookmark => {
    return (
      bookmark.title?.toLowerCase().includes(lowerQuery) ||
      bookmark.url?.toLowerCase().includes(lowerQuery) ||
      bookmark.description?.toLowerCase().includes(lowerQuery) ||
      bookmark.notes?.toLowerCase().includes(lowerQuery) ||
      bookmark.tags?.some(tag => tag.toLowerCase().includes(lowerQuery))
    );
  });
}

// DOM元素
const searchInput = document.getElementById('searchInput');
const searchClearBtn = document.getElementById('searchClearBtn');
const addCurrentBtn = document.getElementById('addCurrentBtn');
const openFullBtn = document.getElementById('openFullBtn');
const settingsBtn = document.getElementById('settingsBtn');
const exportLogBtn = document.getElementById('exportLogBtn');
const bookmarkList = document.getElementById('bookmarkList');
/** 场景切换动画作用在整块「书签列表」区域（含标题与列表），比只改 #bookmarkList 更明显 */
const recentBookmarksEl = document.getElementById('recentBookmarks');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const sceneSwitchBtn = document.getElementById('sceneSwitchBtn');
const currentSceneNameEl = document.getElementById('currentSceneName');
const sceneMenu = document.getElementById('sceneMenu');
const sceneSwitchingBar = document.getElementById('sceneSwitchingBar');
const sceneSwitchingBarText = document.getElementById('sceneSwitchingBarText');
const popupLoadingOverlay = document.getElementById('popupLoadingOverlay');
const headerRight = document.querySelector('.header-right');
/** 场景切换进行中：防连点、与轻提示条联动 */
let sceneSwitchBusy = false;
// 已移除 MAX_BOOKMARKS_DISPLAY 限制，弹窗现在显示所有书签以保持与完整画面一致
let currentSceneId = null;
let expandedFolders = new Set(['']); // 根默认展开
let isFloatingBallPopup = false; // 是否为悬浮球打开的弹窗
let isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
  (window.matchMedia && window.matchMedia('(max-width: 768px)').matches && 'ontouchstart' in window);
let lastRenderedBookmarks = [];
let popupSettings = {
  expandFirstLevel: false,
  rememberScrollPosition: true, // 默认启用滚动位置记忆
  showUpdateButton: false, // 默认不显示更新按钮，只显示删除按钮
  favoriteAsDelete: false // 默认仍使用删除按钮
};
let shouldApplyDefaultExpand = true;
const runtimeErrors = [];
const consoleLogs = [];
const opLogs = [];

// 使用全局事件委托（捕获阶段），确保首次同步后渲染的书签也能响应点击
document.addEventListener('click', (e) => {
  try {
    // 先检查是否点击了清除搜索按钮
    if (e.target.id === 'searchClearBtn' || e.target.closest('#searchClearBtn')) {
      // 清除按钮有自己的事件处理器，这里不处理，直接返回
      return;
    }

    // 收藏抽屉中“所属：xxx”点击 -> 目录跳转
    const favFolderLink = e.target.closest('[data-favorite-folder-link="1"]');
    if (favFolderLink) {
      e.preventDefault();
      e.stopPropagation();
      const folderPath = favFolderLink.dataset.folder || '';
      if (folderPath && typeof window.scrollToFolderInPopup === 'function') {
        window.scrollToFolderInPopup(folderPath);
      }
      const favDrawer = document.getElementById('favoriteDrawer');
      if (favDrawer) {
        favDrawer.style.display = 'none';
      }
      return;
    }

    // 先检查是否点击了定位按钮
    const locateBtn = e.target.closest('.bookmark-locate-btn');
    if (locateBtn) {
      e.preventDefault();
      e.stopPropagation();
      const bookmarkId = locateBtn.dataset.id;
      const folderPath = locateBtn.dataset.folder;
      if (bookmarkId) {
        locateBookmarkInFullPage(bookmarkId, folderPath);
      }
      return;
    }

    // 先检查是否点击了更新按钮
    const updateBtn = e.target.closest('.bookmark-update-btn');
    if (updateBtn) {
      e.preventDefault();
      e.stopPropagation();
      const bookmarkId = updateBtn.dataset.id;
      if (bookmarkId) {
        handleUpdateBookmark(bookmarkId);
      }
      return;
    }

    // 收藏模式下：检查是否点击了收藏按钮
    const favBtn = e.target.closest('.bookmark-fav-btn');
    if (favBtn) {
      e.preventDefault();
      e.stopPropagation();
      const bookmarkId = favBtn.dataset.id;
      if (bookmarkId) {
        handleToggleFavorite(bookmarkId);
      }
      return;
    }

    // 先检查是否点击了删除按钮
    const deleteBtn = e.target.closest('.bookmark-delete-btn');
    if (deleteBtn) {
      e.preventDefault();
      e.stopPropagation();
      const bookmarkId = deleteBtn.dataset.id;
      if (bookmarkId) {
        handleDeleteBookmark(bookmarkId);
      }
      return;
    }

    // 先检查是否点击了文件夹或其他元素，避免误触发
    if (e.target.closest('.folder-row')) {
      return; // 文件夹点击由专门的处理器处理
    }
    if (e.target.closest('.scene-menu-item')) {
      return; // 场景菜单项点击由专门的处理器处理
    }

// 检查是否点击了按钮容器，如果是则忽略（按钮点击已在上面的处理中处理）
    if (e.target.closest('.bookmark-item-actions')) {
      return;
    }
    // 检查是否点击了详情按钮，如果是则忽略
    if (e.target.closest('.bookmark-detail-btn')) {
      return;
    }

    const item = e.target.closest('.bookmark-item');
    if (!item) {
      // 调试日志：记录点击了什么
      console.log('[弹窗] 全局委托点击：未找到书签项，点击目标:', e.target, 'closest结果:', e.target.closest('.bookmark-item'));
      return;
    }
    // 确保事件来自当前弹窗文档
    if (item.ownerDocument !== document) {
      console.log('[弹窗] 全局委托点击：事件来自其他文档');
      return;
    }

    const url = item.dataset.url;
    console.log('[弹窗] 全局委托点击：书签项被点击', url, '元素:', item);
    if (!url) {
      console.error('[弹窗] URL为空，无法打开，元素:', item);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    tabsAPI.create({ url });
    window.close();
  } catch (err) {
    console.error('[弹窗] 全局委托点击处理失败:', err);
  }
}, true);

function refreshBackToTopVisibility() {
  try {
    const backToTopBtn = document.getElementById('backToTopBtn');
    if (!backToTopBtn) return;
    const popupContentEl = document.querySelector('.popup-content');
    const scrollContainer = popupContentEl || bookmarkList;
    if (!scrollContainer) return;
    const currentScrollTop = scrollContainer.scrollTop || 0;
    if (window.__folderDrawerOpen || window.__favoriteDrawerOpen) {
      backToTopBtn.style.display = 'none';
      return;
    }
    const canScroll = (scrollContainer.scrollHeight - scrollContainer.clientHeight) > 40;
    // 只要内容可滚动且离顶部有一定距离，就显示（避免阈值过大导致“有滚动条但不显示”）
    const shouldShow = canScroll && currentScrollTop > 60;
    backToTopBtn.style.display = shouldShow ? 'flex' : 'none';
  } catch (_) {
    // ignore
  }
}

function pushOpLog(message) {
  opLogs.push({ t: new Date().toISOString(), m: message });
  if (opLogs.length > 200) opLogs.shift();
}

function pushRuntimeError(payload) {
  if (runtimeErrors.length > 50) runtimeErrors.shift();
  runtimeErrors.push({ ...payload, timestamp: new Date().toISOString() });
}

window.addEventListener('error', (event) => {
  pushRuntimeError({
    type: 'error',
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    stack: event.error?.stack
  });
});

window.addEventListener('unhandledrejection', (event) => {
  pushRuntimeError({
    type: 'unhandledrejection',
    message: event.reason?.message || String(event.reason),
    stack: event.reason?.stack
  });
});

// 捕获控制台日志
['log', 'info', 'warn', 'error'].forEach(level => {
  const original = console[level];
  console[level] = (...args) => {
    try {
      consoleLogs.push({
        t: new Date().toISOString(),
        level,
        msg: args.map(a => {
          try { return typeof a === 'string' ? a : JSON.stringify(a); }
          catch { return String(a); }
        }).join(' ')
      });
      if (consoleLogs.length > 300) consoleLogs.shift();
    } catch (e) {
      // ignore capture failure
    }
    original.apply(console, args);
  };
});

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
  console.log('[弹窗] DOMContentLoaded 触发');

  // 本地密码锁：未解锁前阻塞主体渲染，避免书签内容闪现
  if (typeof LockScreen !== 'undefined') {
    try { await LockScreen.guard({ title: '云端书签', subtitle: '已启用本地密码锁，请输入密码后查看书签' }); }
    catch (_) { /* 不阻塞 */ }
  }

  // 书签列表：文件夹行点击委托（单次绑定，与 innerHTML 刷新无关）
  if (bookmarkList) {
    bookmarkList.addEventListener('click', handlePopupFolderListClick);
  }

  // 检测是否为悬浮球打开的弹窗，如果是则调整高度
  const urlParams = new URLSearchParams(window.location.search);
  const source = urlParams.get('source');
  isFloatingBallPopup = source === 'floating-ball';

  // 检测是否为移动设备
  isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
    (window.matchMedia && window.matchMedia('(max-width: 768px)').matches && 'ontouchstart' in window);

  // PC端和移动端都需要根据自定义高度调整容器高度
  const popupContainer = document.querySelector('.popup-container');
  if (popupContainer) {
    // 读取自定义高度设置
    const settings = await storage.getSettings();
    const floatingBallPopup = settings?.floatingBallPopup || {};
    const iconPopup = settings?.iconPopup || {};

    if (!isMobileDevice) {
      // PC端：根据弹窗类型设置容器高度
      if (isFloatingBallPopup) {
        // PC端悬浮球弹窗：窗口总高度由background.js控制（默认640px），容器高度应该是窗口高度减去标题栏（约40px）
        const windowHeight = floatingBallPopup.heightPc || 640;
        const containerHeight = windowHeight - 40; // 减去标题栏高度
        popupContainer.style.height = `${containerHeight}px`;
        console.log(`[弹窗] 悬浮球打开的弹窗（PC端），窗口总高度${windowHeight}px，内容区域${containerHeight}px`);
      } else {
        // PC端插件图标打开的弹窗：使用自定义高度（默认600px），直接使用，不限制最小值
        const customHeight = iconPopup.heightPc || 600;
        popupContainer.style.height = `${customHeight}px`;
        console.log(`[弹窗] 插件图标打开的弹窗（PC端），高度${customHeight}px`);
      }
    } else {
      // 移动端：根据弹窗类型设置容器高度
      if (isFloatingBallPopup) {
        // 移动端悬浮球打开的弹窗：使用自定义高度（默认85vh）
        const customHeightVh = floatingBallPopup.heightMobile || 85;
        popupContainer.style.height = `${customHeightVh}vh`;
        // 移除minHeight和maxHeight限制，让自定义高度完全生效
        popupContainer.style.maxHeight = '';
        popupContainer.style.minHeight = '';
        console.log(`[弹窗] 移动端悬浮球打开的弹窗，使用${customHeightVh}vh高度`);
      } else {
        // 移动端插件图标打开的弹窗：使用自定义高度（默认90vh）
        const customHeightVh = iconPopup.heightMobile || 90;
        popupContainer.style.height = `${customHeightVh}vh`;
        // 移除minHeight和maxHeight限制，让自定义高度完全生效
        popupContainer.style.maxHeight = '';
        popupContainer.style.minHeight = '';
        console.log(`[弹窗] 移动端插件图标打开的弹窗，使用${customHeightVh}vh高度`);
      }
    }
  }

  await loadPopupSettings();
  await loadFolderState();
  await loadCurrentScene();
  await loadScenes();

  // 确保 DOM 完全准备好后再加载书签
  requestAnimationFrame(async () => {
    console.log('[弹窗] requestAnimationFrame 回调执行，开始加载书签');
    await loadBookmarksForPopup();
    await updateSyncStatus();
    // 恢复搜索内容（内部会在搜索结果渲染后再尝试恢复滚动位置）
    await restoreSearchContent();
    console.log('[弹窗] 书签加载完成');
  });

  // 监听消息更新
  runtimeAPI.onMessage.addListener(async (request) => {
    if (request.action === 'bookmarksUpdated' || request.action === 'sceneChanged') {
      console.log('[弹窗] 收到更新消息，重新加载书签');
      loadCurrentScene();
      // 使用 requestAnimationFrame 确保 DOM 更新完成
      requestAnimationFrame(async () => {
        await loadBookmarksForPopup();
        await updateSyncStatus();
      });
    } else if (request.action === 'settingsUpdated') {
      console.log('[弹窗] 收到设置更新消息，重新加载设置');
      await loadPopupSettings();
      // 重新渲染书签以应用设置
      requestAnimationFrame(async () => {
        await loadBookmarksForPopup();
      });
    }
  });


  // 监听滚动事件，保存滚动位置和处理"回到顶部"按钮
  const backToTopBtn = document.getElementById('backToTopBtn');
  setTimeout(() => {
    const popupContentEl = document.querySelector('.popup-content');
    const scrollContainer = popupContentEl || bookmarkList;
    if (scrollContainer) {
      console.log('[滚动位置] 绑定滚动事件监听器，容器:', scrollContainer.className);

      scrollContainer.addEventListener('scroll', () => {
        const currentScrollTop = scrollContainer.scrollTop;

        // 处理"回到顶部"按钮显示/隐藏（目录抽屉打开时始终隐藏）
        if (backToTopBtn) {
          if (window.__folderDrawerOpen || window.__favoriteDrawerOpen) {
            backToTopBtn.style.display = 'none';
          } else {
            const canScroll = (scrollContainer.scrollHeight - scrollContainer.clientHeight) > 40;
            backToTopBtn.style.display = (canScroll && currentScrollTop > 60) ? 'flex' : 'none';
          }
        }

        // 延迟保存滚动位置
        clearTimeout(scrollContainer._scrollSaveTimer);
        scrollContainer._scrollSaveTimer = setTimeout(() => {
          saveScrollPosition();
        }, 300);
      });

      // 初次绑定后立即刷新一次，避免“未触发 scroll 事件导致按钮状态不对”
      refreshBackToTopVisibility();
    }
  }, 100);

  // "回到顶部"按钮点击事件
  if (backToTopBtn) {
    backToTopBtn.addEventListener('click', () => {
      const popupContentEl = document.querySelector('.popup-content');
      const scrollContainer = popupContentEl || bookmarkList;
      if (scrollContainer) {
        scrollContainer.scrollTo({
          top: 0,
          behavior: 'smooth'
        });
      }
    });
  }

  // 在页面卸载前保存滚动位置和搜索内容（确保不会丢失）
  window.addEventListener('beforeunload', () => {
    saveScrollPosition();
    saveSearchContent();
  });

  // 在页面隐藏时也保存（移动端可能不会触发 beforeunload）
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      saveScrollPosition();
      saveSearchContent();
    }
  });

  // 点击外部关闭场景菜单
  document.addEventListener('click', (e) => {
    if (!sceneSwitchBtn.contains(e.target) && !sceneMenu.contains(e.target)) {
      sceneMenu.style.display = 'none';
    }
  });

  // ESC键关闭弹窗（仅在PC上启用，手机没有物理键盘）
  // 使用上面已声明的 isMobileDevice 变量
  if (!isMobileDevice) {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || e.key === 'Esc') {
        // 如果搜索框有焦点，先清空搜索
        if (document.activeElement === searchInput && searchInput.value.trim()) {
          searchInput.value = '';
          searchInput.dispatchEvent(new Event('input'));
          return;
        }
        // 否则关闭弹窗
        window.close();
      }
    });
  }
});

/**
 * 加载当前场景
 */
async function loadCurrentScene() {
  try {
    currentSceneId = await storage.getCurrentScene();
    const scenes = await storage.getScenes();
    const currentScene = scenes.find(s => s.id === currentSceneId);
    currentSceneNameEl.textContent = currentScene ? currentScene.name : '未知';
  } catch (error) {
    console.error('加载当前场景失败:', error);
    currentSceneId = 'home';
    currentSceneNameEl.textContent = '家庭';
  }
}

/**
 * 加载场景列表
 */
async function loadScenes() {
  try {
    const scenes = await storage.getScenes();
    // 使用全局变量currentSceneId，不要重新获取

    sceneMenu.innerHTML = scenes.map(scene => {
      const isCurrent = scene.id === currentSceneId;
      return `
        <div class="scene-menu-item ${isCurrent ? 'current' : ''}" data-id="${scene.id}">
          ${scene.name || scene.id}
        </div>
      `;
    }).join('');

    // 绑定点击事件
    sceneMenu.querySelectorAll('.scene-menu-item').forEach(item => {
      item.addEventListener('click', async () => {
        const sceneId = item.dataset.id;
        const sceneName = (item.textContent || '').trim();
        const currentId = await storage.getCurrentScene(); // 获取当前场景进行比较
        sceneMenu.style.display = 'none';

        if (sceneId === currentId) {
          return;
        }
        if (sceneSwitchBusy) {
          return;
        }

        sceneSwitchBusy = true;
        setPopupSceneSwitchUi(true, sceneName);

        try {
          await runPopupSceneSwitchTransition(async () => {
            // 切换场景：清空搜索框（PC/移动端一致），并清除搜索记忆，避免跨场景残留
            try {
              if (searchInput) searchInput.value = '';
              if (searchClearBtn) searchClearBtn.style.display = 'none';
              saveSearchContent();
            } catch (_) {
              // ignore
            }

            await storage.saveCurrentScene(sceneId);
            currentSceneId = sceneId; // 立即更新本地状态，避免后续逻辑读取旧值

            // 检查 WebDAV 配置是否有效
            const config = await storage.getConfig();
            const hasValidConfig = config && config.serverUrl;
            // WebDAV配置有效：每次切换场景都从云端拉取最新，避免本地缓存覆盖浏览器定时同步写云结果
            if (hasValidConfig) {
              try {
                console.log('[弹窗] 切换场景：开始同步场景', sceneId);
                const syncResult = await sendMessageCompat({ action: 'sync', sceneId });
                console.log('[弹窗] 切换场景：同步完成', syncResult);
              } catch (e) {
                console.error('[弹窗] 切换场景：同步失败', e);
                // 忽略单次同步失败，继续后续逻辑
              }
            }
            await loadCurrentScene();
            await loadScenes();
            // 确保 DOM 更新完成后再加载书签
            await new Promise(resolve => requestAnimationFrame(resolve));
            await loadBookmarksForPopup({ lightLoading: true });
            // 再次确保 DOM 更新完成，给事件委托足够的时间绑定
            await new Promise(resolve => requestAnimationFrame(resolve));
            console.log('[弹窗] 切换场景：书签加载完成，当前书签项数量:', document.querySelectorAll('.bookmark-item').length);
          });
        } finally {
          setPopupSceneSwitchUi(false);
          sceneSwitchBusy = false;
        }
      });
    });
  } catch (error) {
    console.error('加载场景列表失败:', error);
  }
}

// 场景切换按钮点击事件
sceneSwitchBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  sceneMenu.style.display = sceneMenu.style.display === 'none' ? 'block' : 'none';
});

function showPopupLoading() {
  if (popupLoadingOverlay) {
    popupLoadingOverlay.style.display = 'flex';
  }
  if (headerRight) {
    headerRight.classList.add('disabled-during-loading');
  }
}

function hidePopupLoading() {
  if (popupLoadingOverlay) {
    popupLoadingOverlay.style.display = 'none';
  }
  if (headerRight) {
    headerRight.classList.remove('disabled-during-loading');
  }
}

/**
 * 场景切换轻反馈：顶部条 + 场景按钮 loading（方案 B）
 */
function setPopupSceneSwitchUi(loading, sceneName) {
  if (sceneSwitchBtn) {
    if (loading) {
      sceneSwitchBtn.classList.add('is-scene-loading');
      sceneSwitchBtn.setAttribute('aria-busy', 'true');
      sceneSwitchBtn.disabled = true;
    } else {
      sceneSwitchBtn.classList.remove('is-scene-loading');
      sceneSwitchBtn.removeAttribute('aria-busy');
      sceneSwitchBtn.disabled = false;
    }
  }
  if (sceneSwitchingBar && sceneSwitchingBarText) {
    if (loading) {
      sceneSwitchingBar.classList.remove('scene-switching-bar--collapsed');
      sceneSwitchingBar.classList.add('scene-switching-bar--open');
      sceneSwitchingBarText.textContent = sceneName
        ? `正在切换到「${sceneName}」，正在同步数据…`
        : '正在切换场景…';
    } else {
      sceneSwitchingBar.classList.remove('scene-switching-bar--open');
      sceneSwitchingBar.classList.add('scene-switching-bar--collapsed');
      sceneSwitchingBarText.textContent = '';
    }
  }
}

function prefersReducedMotion() {
  try {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) {
    return false;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 等待指定动画结束（比固定 sleep 更不易与动画尾帧错位闪屏） */
function waitForAnimationEndOnce(el, animationName, fallbackMs) {
  if (!el) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => resolve();
    const t = setTimeout(done, fallbackMs);
    const handler = (e) => {
      if (e.target !== el) return;
      const raw = (e.animationName || '').split(',')[0].trim();
      const token = animationName || '';
      if (token && raw && !raw.includes(token)) return;
      clearTimeout(t);
      el.removeEventListener('animationend', handler);
      done();
    };
    el.addEventListener('animationend', handler);
  });
}

/** 连续两帧，确保浏览器已应用「淡出」类再开始拉数据 */
async function nextPaint() {
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
}

/**
 * 场景列表过渡：仅 DOM/CSS animation（无 MV2/MV3 专有 API）。classList.replace 无则回退 remove+add。
 * 时长需与 popup.css 中淡出(0.52s/480px 以下 0.48s)、淡入(0.62s/0.58s)大致一致。
 */
const SCENE_POPUP_FADE_OUT_MS = 520;
/** animationend 兜底应略大于最长一段淡入（窄屏 0.58s） */
const SCENE_POPUP_FADE_IN_FALLBACK_MS = 720;

/**
 * 场景切换：先完整淡出旧内容 → 再拉数据/渲染 → 再淡入新内容。
 * 注意：不能用「淡出计时与 workFn 并行」：若云端同步很慢，列表会长时间停在全透明空白，体感很生硬。
 */
async function runPopupSceneSwitchTransition(workFn) {
  const listEl = recentBookmarksEl || bookmarkList;
  if (!listEl || prefersReducedMotion()) {
    await workFn();
    return;
  }
  listEl.classList.remove('scene-switch-fade-in');
  listEl.classList.add('scene-switch-fade-out');
  await nextPaint();
  try {
    await sleep(SCENE_POPUP_FADE_OUT_MS);
    await workFn();
  } catch (e) {
    listEl.classList.remove('scene-switch-fade-out', 'scene-switch-fade-in');
    throw e;
  }
  // 原子替换类 + 动画 fill-mode:both，避免「去掉淡出 → 一帧全不透明 → 再淡入」的闪屏
  if (typeof listEl.classList.replace === 'function') {
    listEl.classList.replace('scene-switch-fade-out', 'scene-switch-fade-in');
  } else {
    listEl.classList.remove('scene-switch-fade-out');
    listEl.classList.add('scene-switch-fade-in');
  }
  await waitForAnimationEndOnce(listEl, 'popupSceneListIn', SCENE_POPUP_FADE_IN_FALLBACK_MS);
  listEl.classList.remove('scene-switch-fade-in');
}

/**
 * 加载弹窗展示的书签（显示所有书签，与完整画面保持一致）
 * @param {{ lightLoading?: boolean, skipRestoreScroll?: boolean }} [options]
 * lightLoading 为 true 时不使用全列表遮罩（用于场景切换时的轻反馈）
 * skipRestoreScroll 为 true 时跳过自动恢复滚动位置（用于目录跳转等主动定位场景）
 */
async function loadBookmarksForPopup(options = {}) {
  const lightLoading = !!(options && options.lightLoading);
  const skipRestoreScroll = !!(options && options.skipRestoreScroll);
  try {
    if (!lightLoading) {
      // 列表区域 loading 遮罩 + 右上角目录/收藏按钮置灰
      showPopupLoading();
    }

    // 检查搜索框是否有内容，如果有则执行搜索
    const savedQuery = searchInput ? searchInput.value.trim() : '';
    if (savedQuery) {
      // 搜索模式：从存储中获取书签并过滤
      const data = await storage.getBookmarks(currentSceneId);
      const bookmarks = data.bookmarks || [];
      const filtered = searchBookmarks(bookmarks, savedQuery);
      renderBookmarks(filtered.slice(0, 50), { searchMode: true });
      if (!lightLoading) hidePopupLoading();
      return;
    }

    // 按当前场景过滤书签（与主页面使用相同的逻辑）
    const data = await storage.getBookmarks(currentSceneId);
    const rawBookmarks = data.bookmarks || [];
    // 规范化书签文件夹路径
    const bookmarks = rawBookmarks.map(b => {
      if (!b.folder) return b;
      return { ...b, folder: normalizeFolderPath(b.folder) };
    });

    // 规范化存储的文件夹列表（保留用户创建的空文件夹，保持顺序）
    // data.folders 应该只包含当前场景的文件夹（从 getBookmarks 返回的）
    const storedFolders = (data.folders || []).map(p => normalizeFolderPath(p || '')).filter(Boolean);
    const bookmarkFolders = bookmarks.map(b => b.folder).filter(Boolean);
    // 合并：保留所有存储的文件夹（包括空文件夹，保持顺序）+ 从书签中提取的文件夹
    const storedFoldersSet = new Set(storedFolders);
    const missing = [...new Set(bookmarkFolders)].filter(f => f && !storedFoldersSet.has(f));
    // 先保留存储的文件夹（保持顺序，包括空文件夹），再添加缺失的文件夹（不排序，保持顺序）
    const merged = [...storedFolders, ...missing];
    const dedup = [...new Set(merged)];
    // 确保 folders 只包含当前场景的文件夹（防御性编程）
    // 从当前场景的书签中提取文件夹，确保不会包含其他场景的文件夹
    const currentSceneBookmarkFoldersSet = new Set(bookmarkFolders);
    const folders = dedup.filter(f => {
      // 保留：1) 在存储的文件夹列表中（这些应该是当前场景的）
      //       2) 在当前场景的书签中使用的文件夹
      return storedFoldersSet.has(f) || currentSceneBookmarkFoldersSet.has(f);
    });

    pushOpLog(`loadBookmarks success, scene=${currentSceneId}, total=${bookmarks.length}, folders=${folders.length}`);

    // 弹窗列表按“云端文件/本地存储中的数组顺序”展示，避免与完整画面排序不一致
    // 注意：这里不要再按 updatedAt/createdAt 排序，否则会改变用户在完整画面（尤其是自定义排序）下的顺序
    const sorted = (bookmarks || []).map(b => ({ ...b }));

    // 默认展开第一层（仅在没有本地折叠状态时）
    if (shouldApplyDefaultExpand && popupSettings.expandFirstLevel) {
      const first = getFirstLevelFolders(sorted);
      first.forEach(p => expandedFolders.add(p));
    }

    lastRenderedBookmarks = sorted;
    // 提供给目录抽屉使用的完整文件夹列表
    window.__popupFoldersForDrawer = folders;
    renderBookmarks(sorted, { searchMode: false, folders: folders });
    // 渲染后先刷新一次回到顶部按钮（此时 scrollTop 可能还没恢复，但至少不滞后）
    refreshBackToTopVisibility();

    if (!skipRestoreScroll) {
      // 恢复滚动位置（延迟执行，确保DOM完全渲染）
      // 使用 requestAnimationFrame 等待渲染完成
      console.log('[弹窗] 书签渲染完成，准备恢复滚动位置');

      // 增加延迟和多次轮询，确保在各种设备上都能成功恢复
      let scrollRetries = 0;
      const MAX_SCROLL_RETRIES = 5;

      const attemptRestore = () => {
        restoreScrollPosition().then(success => {
          if (!success && scrollRetries < MAX_SCROLL_RETRIES) {
            scrollRetries++;
            console.log(`[弹窗] 恢复滚动位置未成功，进行第 ${scrollRetries} 次重试`);
            setTimeout(attemptRestore, 100 * scrollRetries);
          } else {
            // 无论恢复成功与否，都刷新一次“回到顶部”按钮显示状态（restoreScrollPosition 不触发 scroll 事件）
            refreshBackToTopVisibility();
            // 额外最后检查一次：确保布局完全完成后再刷新一次，解决概率性按钮消失问题
            setTimeout(() => {
              refreshBackToTopVisibility();
            }, 200);
          }
        });
      };

      // 初始延迟，等待 DOM 解析和初步渲染
      setTimeout(attemptRestore, 100);
    } else {
      refreshBackToTopVisibility();
    }
  } catch (error) {
    console.error('加载书签失败:', error);
    pushOpLog(`loadBookmarks failed: ${error.message}`);
  } finally {
    if (!lightLoading) {
      hidePopupLoading();
    }
  }
}

/**
 * 文件夹行点击：在 #bookmarkList 上委托绑定，避免「innerHTML 后再 requestAnimationFrame 才绑监听」与首次加载/场景动画竞态导致点不开。
 * 仅使用 Element.closest / contains、DOM0 事件、queueMicrotask 等标准能力；与 manifest_version 2/3 无关：
 * MV2 为 browser_action.default_popup，MV3 为 action.default_popup，二者加载的均为同源扩展页 popup，脚本环境一致。
 */
function handlePopupFolderListClick(e) {
  const row = e.target.closest('.folder-row');
  if (!row || !bookmarkList || !bookmarkList.contains(row)) return;
  e.preventDefault();
  e.stopPropagation();
  const path = row.dataset.folder || '';
  if (expandedFolders.has(path)) {
    expandedFolders.delete(path);
  } else {
    expandedFolders.add(path);
  }
  saveFolderState();
  const folders = Array.isArray(window.__popupFoldersForDrawer) ? window.__popupFoldersForDrawer : [];
  const tree = buildFolderTree(lastRenderedBookmarks || [], folders);
  bookmarkList.innerHTML = renderFolderTreeHtml(tree, '');
  queueMicrotask(() => applyPopupSettings());
}

/**
 * 渲染书签列表
 */
function renderBookmarks(bookmarks, { searchMode = false, folders = null } = {}) {
  if (bookmarks.length === 0) {
    bookmarkList.innerHTML = '<div class="empty-state">暂无书签</div>';
    return;
  }

  if (searchMode) {
    const useFavorite = popupSettings && popupSettings.favoriteAsDelete;
    const showLocateButton = popupSettings && popupSettings.showLocateButton !== false; // 默认显示
    bookmarkList.innerHTML = bookmarks.map(bookmark => {
      const id = escapeHtml(bookmark.id);
      const folderHtml = bookmark.folder
        ? `<div class="bookmark-item-folder">所在：${escapeHtml(bookmark.folder)}</div>`
        : '';
      const locateBtn = showLocateButton
        ? `<button class="bookmark-locate-btn" data-id="${id}" data-folder="${escapeHtml(bookmark.folder || '')}" title="在管理页面中定位" style="background:none;border:none;padding:0;margin:0;cursor:pointer;">
  <span style="
    display:inline-flex;
    width:12px;
    height:12px;
    border:1px solid #3b82f6;
    border-radius:50%;
    position:relative;
    box-sizing:border-box;
    vertical-align:middle;
    flex-shrink:0;
  ">
    <span style="
      position:absolute;
      top:50%;left:50%;
      transform:translate(-50%,-50%);
      width:3px;height:3px;
      border:0.8px solid #3b82f6;
      border-radius:50%;
    "></span>
    <span style="
      position:absolute;
      top:50%;left:50%;
      transform:translate(-50%,-50%);
      width:5px;height:0.8px;
      background:#3b82f6;
    "></span>
    <span style="
      position:absolute;
      top:50%;left:50%;
      transform:translate(-50%,-50%);
      width:0.8px;height:5px;
      background:#3b82f6;
    "></span>
  </span>
</button>`
        : '';
      const updateBtnHtml = `<button class="bookmark-update-btn" data-id="${id}" title="更新" style="display: ${(popupSettings && popupSettings.showUpdateButton) ? 'flex' : 'none'};">✏️</button>`;
      const actionBtnHtml = useFavorite
        ? `<button class="bookmark-fav-btn" data-id="${id}" data-starred="${bookmark.starred ? 'true' : 'false'}" title="${bookmark.starred ? '取消收藏' : '添加到收藏'}">${bookmark.starred ? '★' : '☆'}</button>`
        : `<button class="bookmark-delete-btn" data-id="${id}" title="删除">🗑️</button>`;
    return `
    <div class="bookmark-item" data-url="${escapeHtml(bookmark.url)}" data-id="${id}">
      <div class="bookmark-item-content">
        <div class="bookmark-item-title">
          <span class="bookmark-title-text">${escapeHtml(bookmark.title || '无标题')}</span>
          <button class="bookmark-detail-btn" data-id="${id}" title="查看详情">ℹ️</button>
        </div>
        <div class="bookmark-item-url">
          ${locateBtn}
          ${escapeHtml(bookmark.url)}
        </div>
        ${folderHtml}
      </div>
      <div class="bookmark-item-actions">
        ${updateBtnHtml}
        ${actionBtnHtml}
      </div>
    </div>
  `;
    }).join('');

    // 搜索模式中的点击事件由全局事件委托处理，不需要单独绑定
    // 全局事件委托会先检查按钮点击，然后才处理书签项点击

    // 应用设置到UI（更新按钮的显示/隐藏）
    // 使用setTimeout确保DOM已完全渲染
    setTimeout(() => {
      applyPopupSettings();
    }, 0);

    return;
  }

  // 初次加载时默认展开第一层文件夹
  if (expandedFolders.size === 1 && expandedFolders.has('')) {
    // 已迁移到 loadBookmarksForPopup 中按设置控制
  }

  // 使用传入的 folders 参数（如果提供）来保持文件夹顺序
  const tree = buildFolderTree(bookmarks, folders);
  bookmarkList.innerHTML = renderFolderTreeHtml(tree, '');
  // 文件夹展开/折叠由 handlePopupFolderListClick（bookmarkList 事件委托）处理，勿再按行延迟绑定
  queueMicrotask(() => applyPopupSettings());
}

function normalizeFolderPath(path) {
  if (!path) return '';
  return path.trim().replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}

function getFirstLevelFolders(bookmarks) {
  const set = new Set();
  bookmarks.forEach(b => {
    const folder = normalizeFolderPath(b.folder || '');
    if (!folder) return;
    const top = folder.split('/')[0];
    if (top) set.add(top);
  });
  return Array.from(set.values()).map(name => name);
}

async function loadPopupSettings() {
  try {
    const settings = await storage.getSettings();
    popupSettings = {
      expandFirstLevel: !!(settings && settings.popup && settings.popup.expandFirstLevel),
      rememberScrollPosition: settings && settings.popup && settings.popup.rememberScrollPosition !== false, // 默认true
      showUpdateButton: !!(settings && settings.popup && settings.popup.showUpdateButton), // 默认false
      favoriteAsDelete: !!(settings && settings.popup && settings.popup.favoriteAsDelete), // 默认false
      showLocateButton: settings && settings.popup && settings.popup.showLocateButton !== false // 默认true
    };
    // 应用设置到UI
    applyPopupSettings();
  } catch (e) {
    console.warn('加载弹窗设置失败，使用默认值', e?.message || e);
    popupSettings = {
      expandFirstLevel: false,
      rememberScrollPosition: true,
      showUpdateButton: false,
      favoriteAsDelete: false,
      showLocateButton: true
    };
    applyPopupSettings();
  }
}

/**
 * 应用弹窗设置到UI
 */
function applyPopupSettings() {
  // 更新按钮的显示/隐藏
  const updateButtons = document.querySelectorAll('.bookmark-update-btn');
  const shouldShow = popupSettings && popupSettings.showUpdateButton;
  updateButtons.forEach(btn => {
    if (shouldShow) {
      btn.style.display = 'flex';
    } else {
      btn.style.display = 'none';
    }
  });
  console.log('[弹窗设置] 应用设置，showUpdateButton:', shouldShow, '找到按钮数量:', updateButtons.length);

  // 定位按钮的显示/隐藏
  const locateButtons = document.querySelectorAll('.bookmark-locate-btn');
  const showLocateButton = popupSettings && popupSettings.showLocateButton !== false;
  locateButtons.forEach(btn => {
    if (showLocateButton) {
      btn.style.display = 'inline-flex';
    } else {
      btn.style.display = 'none';
    }
  });
  console.log('[弹窗设置] 应用设置，showLocateButton:', showLocateButton, '找到按钮数量:', locateButtons.length);
}

/**
 * 弹窗内写操作前拉取云端最新再刷新列表数据（与管理页书签增删改/收藏一致）
 */
async function ensureSceneFreshFromCloudBeforeWritePopup() {
  try {
    const res = await sendMessageCompat({ action: 'sync', sceneId: currentSceneId });
    if (res && res.success === false) {
      console.warn('[弹窗][写前同步] 拉取云端失败，继续基于本地数据:', res.error);
    }
  } catch (e) {
    console.warn('[弹窗][写前同步] 拉取云端异常:', e?.message || e);
  }
  await loadBookmarksForPopup();
}

/**
 * 切换当前场景下某个书签的收藏状态（弹窗内使用）
 */
async function handleToggleFavorite(bookmarkId) {
  showGlobalLoading('正在更新收藏状态…');

  try {
    await ensureSceneFreshFromCloudBeforeWritePopup();
    const data = await storage.getBookmarks(currentSceneId);
    const allBookmarks = data.bookmarks || [];
    const allFolders = data.folders || [];
    const target = allBookmarks.find(b => b.id === bookmarkId);
    if (!target) {
      console.warn('[弹窗] 找不到需要收藏/取消收藏的书签:', bookmarkId);
      return;
    }
    target.starred = !target.starred;
    await storage.saveBookmarks(allBookmarks, allFolders, currentSceneId);

    // 重新加载弹窗列表以反映最新收藏状态
    await loadBookmarksForPopup();

    // 如果收藏抽屉是打开的，也刷新收藏抽屉
    if (window.__favoriteDrawerOpen && typeof window.renderFavoriteDrawer === 'function') {
      window.renderFavoriteDrawer();
    }

    // 异步触发云端同步，确保收藏状态写入 WebDAV
    sendMessageCompat({
      action: 'syncToCloud',
      bookmarks: allBookmarks,
      folders: allFolders,
      sceneId: currentSceneId,
      patch: { bookmarkUpserts: [bookmarkId] }
    }).catch(err => console.error('[弹窗] 收藏状态后台同步失败:', err));
  } catch (e) {
    console.error('[弹窗] 切换收藏状态失败:', e);
  } finally {
    hideGlobalLoading();
  }
}

async function loadFolderState() {
  try {
    const storageAPI = typeof browser !== 'undefined' ? browser.storage : chrome.storage;
    const result = typeof browser !== 'undefined' && browser.storage
      ? await browser.storage.local.get(['popupFolderState'])
      : await new Promise(resolve => {
        chrome.storage.local.get(['popupFolderState'], resolve);
      });
    const state = result && result.popupFolderState;

    // 如果上次记录的设置值与当前设置不同，则认为用户刚修改了设置，重置展开状态
    if (state && typeof state.lastExpandFirstLevel === 'boolean' &&
      state.lastExpandFirstLevel !== popupSettings.expandFirstLevel) {
      expandedFolders = new Set(['']);
      shouldApplyDefaultExpand = true; // 按新的设置重新应用默认展开规则
      return;
    }

    if (state && Array.isArray(state.expanded) && state.expanded.length) {
      expandedFolders = new Set(state.expanded);
      if (!expandedFolders.has('')) expandedFolders.add(''); // 保证根存在
      // 如果只有根节点，等同于“没有自定义折叠”，仍允许按设置自动展开第一层
      if (expandedFolders.size === 1) {
        shouldApplyDefaultExpand = true;
      } else {
        shouldApplyDefaultExpand = false;
      }
    } else {
      expandedFolders = new Set(['']);
      shouldApplyDefaultExpand = true;
    }
  } catch (e) {
    expandedFolders = new Set(['']);
    shouldApplyDefaultExpand = true;
  }
}

function saveFolderState() {
  const expanded = Array.from(expandedFolders);
  const storageAPI = typeof browser !== 'undefined' ? browser.storage : chrome.storage;
  const state = {
    popupFolderState: {
      expanded,
      lastExpandFirstLevel: popupSettings.expandFirstLevel
    }
  };
  if (typeof browser !== 'undefined' && browser.storage) {
    // Firefox: 使用 Promise
    browser.storage.local.set(state);
  } else {
    // Chrome/Edge: 使用回调
    chrome.storage.local.set(state, () => { });
  }
}

function buildFolderTree(bookmarks, folders = null) {
  const root = { name: 'root', path: '', folders: {}, order: [], items: [] };

  // 从书签中提取文件夹集合，用于验证文件夹是否属于当前场景
  const bookmarkFoldersSet = new Set(
    bookmarks.map(b => normalizeFolderPath(b.folder || '')).filter(Boolean)
  );

  // 如果提供了 folders 列表，先按照这个顺序创建文件夹结构（保持创建顺序）
  if (folders && folders.length > 0) {
    folders.forEach(folderPath => {
      const normalized = normalizeFolderPath(folderPath);
      if (!normalized) return;
      // 确保文件夹在当前场景的书签中使用，或者是空文件夹（在 folders 列表中）
      // 注意：folders 参数应该已经过滤了，这里再次验证以确保安全
      const parts = normalized.split('/');
      let node = root;
      let currentPath = '';
      parts.forEach(part => {
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        if (!node.folders[part]) {
          node.folders[part] = { name: part, path: currentPath, folders: {}, order: [], items: [] };
          // 维护子节点的顺序
          node.order.push(part);
        }
        node = node.folders[part];
      });
    });
  }

  // 然后添加书签到对应的文件夹
  bookmarks.forEach(b => {
    const folderPath = normalizeFolderPath(b.folder || '');
    if (!folderPath) {
      root.items.push(b);
      return;
    }
    // 确保文件夹在 folders 列表中（防御性编程）
    // 如果不在 folders 列表中，说明可能是其他场景的文件夹，不应该显示
    const parts = folderPath.split('/');
    let node = root;
    let currentPath = '';
    parts.forEach(part => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!node.folders[part]) {
        // 如果文件夹不存在，创建它（但只创建在当前场景书签中使用的文件夹）
        if (bookmarkFoldersSet.has(currentPath)) {
          node.folders[part] = { name: part, path: currentPath, folders: {}, order: [], items: [] };
          // 维护子节点的顺序
          node.order.push(part);
        } else {
          // 如果文件夹不在当前场景的书签中，跳过（不应该发生，但防御性编程）
          return;
        }
      }
      node = node.folders[part];
    });
    if (node) {
      node.items.push(b);
    }
  });

  // 递归对书签项进行排序（按 order 字段），确保与管理页自定义排序逻辑一致
  const sortNode = (node) => {
    if (node.items && node.items.length > 0) {
      node.items.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
    }
    Object.values(node.folders).forEach(sortNode);
  };
  sortNode(root);

  return root;
}

// 计算文件夹下的直接子文件夹数量（不递归，只统计直接子文件夹）
function countSubfolders(node) {
  const folders = node.folders || {};
  return Object.keys(folders).length; // 只统计直接子文件夹数量，不递归
}

function renderFolderTreeHtml(node, indentPath) {
  // 按照 order 数组的顺序获取文件夹，保持创建顺序
  const folderEntries = (node.order || []).map(key => node.folders[key]).filter(Boolean);
  const items = node.items || [];

  const folderHtml = folderEntries.map(child => {
    const expanded = expandedFolders.has(child.path);
    const icon = expanded ? '📂' : '📁';
    const childContent = expanded ? renderFolderTreeHtml(child, child.path) : '';
    // 统计：书签数量 + 子文件夹数量
    const bookmarkCount = (child.items || []).length;
    const subfolderCount = countSubfolders(child);
    const totalCount = bookmarkCount + subfolderCount;
    return `
      <div class="folder-block">
        <div class="folder-row" data-folder="${escapeHtml(child.path)}">
          <span class="folder-icon">${icon}</span>
          <span class="folder-name">${escapeHtml(child.name)}</span>
          <span class="folder-count">${totalCount}</span>
        </div>
        ${expanded ? `<div class="folder-children">${childContent}</div>` : ''}
      </div>
    `;
  }).join('');

  const useFavorite = popupSettings && popupSettings.favoriteAsDelete;
  const showLocateButton = popupSettings && popupSettings.showLocateButton !== false; // 默认显示
  const itemHtml = items.map(b => {
    const id = escapeHtml(b.id);
    const folderHtml = b.folder
      ? `<div class="bookmark-item-folder">所在：${escapeHtml(b.folder)}</div>`
      : '';
    const locateBtn = showLocateButton
      ? `<button class="bookmark-locate-btn" data-id="${id}" data-folder="${escapeHtml(b.folder || '')}" title="在管理页面中定位" style="background:none;border:none;padding:0;margin:0;cursor:pointer;">
  <span style="
    display:inline-flex;
    width:12px;
    height:12px;
    border:1px solid #3b82f6;
    border-radius:50%;
    position:relative;
    box-sizing:border-box;
    vertical-align:middle;
    flex-shrink:0;
  ">
    <span style="
      position:absolute;
      top:50%;left:50%;
      transform:translate(-50%,-50%);
      width:3px;height:3px;
      border:0.8px solid #3b82f6;
      border-radius:50%;
    "></span>
    <span style="
      position:absolute;
      top:50%;left:50%;
      transform:translate(-50%,-50%);
      width:5px;height:0.8px;
      background:#3b82f6;
    "></span>
    <span style="
      position:absolute;
      top:50%;left:50%;
      transform:translate(-50%,-50%);
      width:0.8px;height:5px;
      background:#3b82f6;
    "></span>
  </span>
</button>`
      : '';
    const updateBtnHtml = `<button class="bookmark-update-btn" data-id="${id}" title="更新" style="display: ${(popupSettings && popupSettings.showUpdateButton) ? 'flex' : 'none'};">✏️</button>`;
    const detailBtnHtml = `<button class="bookmark-detail-btn" data-id="${id}" title="查看详情">ℹ️</button>`;
    const actionBtnHtml = useFavorite
      ? `<button class="bookmark-fav-btn" data-id="${id}" data-starred="${b.starred ? 'true' : 'false'}" title="${b.starred ? '取消收藏' : '添加到收藏'}">${b.starred ? '★' : '☆'}</button>`
      : `<button class="bookmark-delete-btn" data-id="${id}" title="删除">🗑️</button>`;
    return `
    <div class="bookmark-item" data-url="${escapeHtml(b.url)}" data-id="${id}">
      <div class="bookmark-item-content">
        <div class="bookmark-item-title">
          <span class="bookmark-title-text">${escapeHtml(b.title || '无标题')}</span>
          ${detailBtnHtml}
        </div>
        <div class="bookmark-item-url">
          ${locateBtn}
          ${escapeHtml(b.url)}
        </div>
        ${folderHtml}
      </div>
      <div class="bookmark-item-actions">
        ${updateBtnHtml}
        ${actionBtnHtml}
      </div>
    </div>
  `;
  }).join('');

  return `
    ${itemHtml}
    ${folderHtml}
  `;
}

/**
 * 更新同步状态
 */
async function updateSyncStatus() {
  try {
    const status = await storage.getSyncStatus();

    const statusMap = {
      'idle': { text: '已同步', class: 'success' },
      'syncing': { text: '同步中', class: 'syncing' },
      'success': { text: '已同步', class: 'success' },
      'error': { text: '同步失败', class: 'error' }
    };

    const statusInfo = statusMap[status.status] || statusMap.idle;
    statusText.textContent = statusInfo.text;
    statusDot.className = 'status-dot ' + statusInfo.class;
  } catch (error) {
    console.error('更新同步状态失败:', error);
  }
}

/**
 * 保存搜索内容
 * 注意：搜索内容记忆功能始终启用，不受滚动条位置记忆设置影响
 */
function saveSearchContent() {
  try {
    const query = searchInput.value.trim();
    const state = {
      popupSearchContent: query
    };
    if (typeof browser !== 'undefined' && browser.storage) {
      browser.storage.local.set(state);
    } else {
      chrome.storage.local.set(state, () => { });
    }
    console.log('[搜索内容] 保存搜索内容:', query);
  } catch (e) {
    console.warn('保存搜索内容失败:', e);
  }
}

/**
 * 恢复搜索内容
 * 注意：搜索内容记忆功能始终启用，不受滚动条位置记忆设置影响
 */
async function restoreSearchContent() {
  try {
    const result = typeof browser !== 'undefined' && browser.storage
      ? await browser.storage.local.get(['popupSearchContent'])
      : await new Promise(resolve => {
        chrome.storage.local.get(['popupSearchContent'], resolve);
      });
    const savedQuery = result && result.popupSearchContent;

    if (savedQuery && savedQuery.trim()) {
      searchInput.value = savedQuery;
      searchClearBtn.style.display = 'flex'; // 显示清除按钮
      console.log('[搜索内容] 恢复搜索内容:', savedQuery);
      // 触发搜索
      searchInput.dispatchEvent(new Event('input'));
      // 等待搜索结果渲染完成后再尝试恢复滚动位置（针对“搜索模式下记住到底部”的场景）
      setTimeout(() => {
        restoreScrollPosition().catch((e) =>
          console.warn('[搜索内容] 恢复搜索后的滚动位置失败:', e)
        );
      }, 400);
    } else {
      searchClearBtn.style.display = 'none'; // 隐藏清除按钮
    }
  } catch (e) {
    console.warn('恢复搜索内容失败:', e);
  }
}

/**
 * 清除搜索
 */
if (searchClearBtn) {
  searchClearBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    searchInput.value = '';
    searchClearBtn.style.display = 'none';
    saveSearchContent();
    loadBookmarksForPopup();
  });
}

/**
 * 搜索书签
 */
searchInput.addEventListener('input', debounce(async (e) => {
  const query = e.target.value.trim();
  // 保存搜索内容
  saveSearchContent();

  // 显示/隐藏清除按钮
  if (query) {
    searchClearBtn.style.display = 'flex';
  } else {
    searchClearBtn.style.display = 'none';
  }

  if (!query) {
    await loadBookmarksForPopup();
    return;
  }

  try {
    // 按当前场景过滤书签
    const data = await storage.getBookmarks(currentSceneId);
    const bookmarks = data.bookmarks || [];
    const filtered = searchBookmarks(bookmarks, query);
    renderBookmarks(filtered.slice(0, 50), { searchMode: true });
  } catch (error) {
    console.error('搜索失败:', error);
  }
}, 300));

/**
 * 添加当前页面
 */
addCurrentBtn.addEventListener('click', async () => {
  pushOpLog('addCurrent: start');

  // 优先使用 URL 参数中的信息（从悬浮球传递过来的，准确）
  const urlParams = new URLSearchParams(window.location.search);
  const urlFromParams = urlParams.get('url');
  const titleFromParams = urlParams.get('title');
  const sourceTabIdParam = urlParams.get('sourceTabId');
  const sourceTabIdFromParams = Number.isFinite(parseInt(sourceTabIdParam, 10))
    ? parseInt(sourceTabIdParam, 10)
    : null;

  let targetUrl, targetTitle;
  let targetTabId = sourceTabIdFromParams;

  if (urlFromParams) {
    targetUrl = urlFromParams;
    targetTitle = titleFromParams || '';
    pushOpLog(`addCurrent: using params from floating ball url=${targetUrl}`);
  } else {
    // 回退到查询标签页（PC 端或非悬浮球触发的情况）
    const tab = await getActiveTabSafe();
    if (tab && tab.url) {
      targetUrl = tab.url;
      targetTitle = tab.title || '';
      targetTabId = typeof tab.id === 'number' ? tab.id : null;
      pushOpLog(`addCurrent: got tab url=${targetUrl}`);
    } else {
      pushOpLog('addCurrent: failed to get active tab');
      alert('无法获取当前页面，请在支持的浏览器/标签页中重试');
      return;
    }
  }

  // 打开添加书签页面
  if (isMobileDevice && targetTabId === null) {
    const urlMatchedTab = await findTabByUrlSafe(targetUrl);
    if (urlMatchedTab && typeof urlMatchedTab.id === 'number') {
      targetTabId = urlMatchedTab.id;
    }
  }

  if (isMobileDevice && targetTabId === null) {
    try {
      const activeTab = await getActiveTabSafe();
      if (activeTab && typeof activeTab.id === 'number') {
        targetTabId = activeTab.id;
      }
    } catch (_) {
      // 忽略，拿不到就回退到原有扩展页模式
    }
  }

  const source = isFloatingBallPopup ? 'floating-ball' : 'popup';
  await sendMessageCompat({
    action: 'openAddBookmarkWindow',
    currentUrl: targetUrl,
    currentTitle: targetTitle || '',
    source,
    tabId: targetTabId,
    preferInlineOverlay: !!isMobileDevice
  });
  // 操作完成后关闭弹窗
  window.close();
});

function isExtensionUrl(url) {
  return typeof url === 'string' && (
    url.startsWith('chrome-extension://') ||
    url.startsWith('moz-extension://') ||
    url.startsWith('edge-extension://')
  );
}

function pickNonExtensionTab(tabs) {
  if (!Array.isArray(tabs) || tabs.length === 0) return null;
  return tabs.find(t => t && t.url && !isExtensionUrl(t.url)) || null;
}

function normalizeUrlForMatch(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch (_) {
    return String(url).trim();
  }
}

async function findTabByUrlSafe(targetUrl) {
  const normalizedTarget = normalizeUrlForMatch(targetUrl);
  if (!normalizedTarget) return null;
  try {
    const tabs = await queryTabsCompat({});
    const allTabs = Array.isArray(tabs) ? tabs : [];
    const exact = allTabs.find(t =>
      t &&
      typeof t.id === 'number' &&
      t.url &&
      !isExtensionUrl(t.url) &&
      normalizeUrlForMatch(t.url) === normalizedTarget
    );
    return exact || null;
  } catch (e) {
    console.warn('findTabByUrlSafe 失败:', e?.message || e);
    return null;
  }
}

async function getActiveTabSafe() {
  // 1. 优先让后台计算当前活动标签页，避免拿到扩展窗口本身
  try {
    const resp = await sendMessageCompat({ action: 'getActiveTab' });
    if (resp && resp.tab && resp.tab.url && !isExtensionUrl(resp.tab.url)) {
      return resp.tab;
    }
  } catch (e) {
    console.warn('后台获取标签页失败:', e?.message || e);
  }

  // 2. 本地回退：currentWindow
  try {
    const tabs = await queryTabsCompat({ active: true, currentWindow: true });
    const tab = pickNonExtensionTab(tabs);
    if (tab && tab.url && !isExtensionUrl(tab.url)) return tab;
  } catch (e) {
    console.warn('tabs.query(currentWindow) 失败:', e?.message || e);
  }

  // 3. lastFocusedWindow
  try {
    const tabs = await queryTabsCompat({ active: true, lastFocusedWindow: true });
    const tab = pickNonExtensionTab(tabs);
    if (tab && tab.url && !isExtensionUrl(tab.url)) return tab;
  } catch (e) {
    console.warn('tabs.query(lastFocusedWindow) 失败:', e?.message || e);
  }

  // 4. 仅 active，不限定窗口
  try {
    const tabs = await queryTabsCompat({ active: true });
    const tab = (Array.isArray(tabs) ? tabs : []).find(t => t.url && !isExtensionUrl(t.url));
    if (tab) return tab;
  } catch (e) {
    console.warn('tabs.query(active:true) 失败:', e?.message || e);
  }

  // 5. 所有标签中第一个非扩展页
  try {
    const tabs = await queryTabsCompat({});
    const tab = (Array.isArray(tabs) ? tabs : []).find(t => t.url && !isExtensionUrl(t.url));
    if (tab) return tab;
  } catch (e) {
    console.warn('tabs.query({}) 失败:', e?.message || e);
  }

  return null;
}

async function queryTabsCompat(query) {
  // Firefox: browser.tabs.query 返回 Promise，适合 await
  if (typeof browser !== 'undefined' && browser.tabs && browser.tabs.query) {
    return await browser.tabs.query(query);
  }
  // Chrome/Edge: 使用 callback 包装成 Promise
  if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
    return await new Promise((resolve, reject) => {
      try {
        chrome.tabs.query(query, (tabs) => {
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) {
            reject(new Error(err.message));
          } else {
            resolve(tabs || []);
          }
        });
      } catch (e) {
        reject(e);
      }
    });
  }
  throw new Error('tabs API 不可用');
}

/**
 * 打开完整界面
 */
openFullBtn.addEventListener('click', () => {
  tabsAPI.create({
    url: runtimeAPI.getURL('pages/bookmarks.html')
  });
  // 操作完成后关闭弹窗
  window.close();
});

/**
 * 打开设置
 */
settingsBtn.addEventListener('click', () => {
  runtimeAPI.openOptionsPage();
  // 操作完成后关闭弹窗
  window.close();
});

/**
 * 导出调试日志（不包含敏感口令）
 */
exportLogBtn.addEventListener('click', async () => {
  try {
    // 显示加载状态
    const originalText = exportLogBtn.textContent;
    exportLogBtn.disabled = true;
    exportLogBtn.textContent = '导出中...';

    console.log('[导出日志] 开始收集日志数据...');

    const [config, syncStatus, pendingChanges, bookmarkData, devices, deviceInfo, settings] = await Promise.all([
      storage.getConfig().catch(e => {
        console.warn('[导出日志] 获取配置失败:', e);
        return null;
      }),
      storage.getSyncStatus().catch(e => {
        console.warn('[导出日志] 获取同步状态失败:', e);
        return null;
      }),
      storage.getPendingChanges().catch(e => {
        console.warn('[导出日志] 获取待同步变更失败:', e);
        return [];
      }),
      storage.getBookmarks().catch(e => {
        console.warn('[导出日志] 获取书签失败:', e);
        return { bookmarks: [], folders: [] };
      }),
      storage.getDevices().catch(e => {
        console.warn('[导出日志] 获取设备列表失败:', e);
        return [];
      }),
      storage.getDeviceInfo().catch(e => {
        console.warn('[导出日志] 获取设备信息失败:', e);
        return null;
      }),
      storage.getSettings().catch(e => {
        console.warn('[导出日志] 获取设置失败:', e);
        return null;
      })
    ]);

    console.log('[导出日志] 数据收集完成，开始处理...');

    const manifest = runtimeAPI.getManifest ? runtimeAPI.getManifest() : {};
    const alarmsAPI = typeof browser !== 'undefined' ? browser.alarms : chrome.alarms;
    let alarms = [];
    if (alarmsAPI && alarmsAPI.getAll) {
      try {
        if (typeof browser !== 'undefined' && browser.alarms) {
          // Firefox: 使用 Promise
          alarms = await alarmsAPI.getAll();
        } else {
          // Chrome/Edge: 使用回调
          alarms = await new Promise(resolve => {
            alarmsAPI.getAll(resolve);
          });
        }
      } catch (e) {
        console.warn('[导出日志] 获取定时任务失败:', e);
      }
    }

    const maskConfig = (cfg) => {
      if (!cfg) return null;
      const masked = { ...cfg };
      ['password', 'token', 'secret', 'auth', 'key'].forEach(k => {
        if (masked[k]) masked[k] = '***';
      });
      return masked;
    };

    const log = {
      generatedAt: new Date().toISOString(),
      extensionVersion: manifest.version || 'unknown',
      manifestVersion: manifest.manifest_version || 'unknown',
      runtime: {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        language: navigator.language,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
      },
      syncStatus,
      pendingChangesCount: pendingChanges.length,
      pendingChanges,
      alarms,
      runtimeErrors,
      consoleLogs,
      opLogs,
      bookmarksSummary: {
        total: (bookmarkData.bookmarks || []).length,
        folders: (bookmarkData.folders || []).length
      },
      recentBookmarks: (bookmarkData.bookmarks || [])
        .slice()
        .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
        .slice(0, 20),
      devices,
      deviceInfo,
      settings,
      config: maskConfig(config)
    };

    console.log('[导出日志] 开始序列化日志...');
    const text = serializeLogToText(log);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cloud-bookmark-log-${Date.now()}.txt`;
    a.style.display = 'none';
    document.body.appendChild(a);

    console.log('[导出日志] 触发下载...');
    a.click();

    // 延迟清理，确保下载开始
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      console.log('[导出日志] 下载完成');
    }, 100);

    // 恢复按钮状态
    exportLogBtn.disabled = false;
    exportLogBtn.textContent = originalText;

    // 显示成功提示（不关闭弹窗，让用户可以继续使用）
    const successMsg = document.createElement('div');
    successMsg.textContent = '日志已导出';
    successMsg.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: #4caf50;
      color: white;
      padding: 12px 24px;
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      z-index: 10001;
      font-size: 14px;
    `;
    document.body.appendChild(successMsg);
    setTimeout(() => {
      if (successMsg.parentNode) {
        successMsg.parentNode.removeChild(successMsg);
      }
    }, 2000);
  } catch (error) {
    console.error('[导出日志] 导出失败:', error);

    // 恢复按钮状态
    exportLogBtn.disabled = false;
    exportLogBtn.textContent = '导出日志';

    // 显示错误提示
    alert('导出日志失败：' + (error.message || String(error)) + '\n\n请查看控制台获取详细信息。');
  }
});

function serializeLogToText(log) {
  const lines = [];
  const push = (s = '') => lines.push(s);
  push('=== Cloud Bookmark Log ===');
  push(`generatedAt: ${log.generatedAt}`);
  push(`version: ${log.extensionVersion} (manifest v${log.manifestVersion})`);
  push(`ua: ${log.runtime.userAgent}`);
  push(`platform: ${log.runtime.platform}, lang: ${log.runtime.language}, tz: ${log.runtime.timeZone}`);
  push('');
  push('[Sync Status]');
  push(JSON.stringify(log.syncStatus, null, 2));
  push('');
  push(`[Pending Changes] count=${log.pendingChangesCount}`);
  push(JSON.stringify(log.pendingChanges, null, 2));
  push('');
  push('[Alarms]');
  push(JSON.stringify(log.alarms, null, 2));
  push('');
  push(`[Bookmarks] total=${log.bookmarksSummary.total}, folders=${log.bookmarksSummary.folders}`);
  push('Recent:');
  push(JSON.stringify(log.recentBookmarks, null, 2));
  push('');
  push('[Devices]');
  push(JSON.stringify({ devices: log.devices, deviceInfo: log.deviceInfo }, null, 2));
  push('');
  push('[Settings]');
  push(JSON.stringify(log.settings, null, 2));
  push('');
  push('[Config masked]');
  push(JSON.stringify(log.config, null, 2));
  push('');
  push('[Operation Logs]');
  log.opLogs.forEach(entry => push(`${entry.t} [op] ${entry.m}`));
  push('');
  push('[Console Logs]');
  log.consoleLogs.forEach(entry => push(`${entry.t} [${entry.level}] ${entry.msg}`));
  push('');
  push('[Runtime Errors]');
  log.runtimeErrors.forEach(err => {
    push(`${err.timestamp} [${err.type}] ${err.message}`);
    if (err.filename) push(`  at ${err.filename}:${err.lineno}:${err.colno}`);
    if (err.stack) push(`  stack: ${err.stack}`);
  });
  push('');
  return lines.join('\n');
}

/**
 * 在完整管理页面中定位书签
 */
function locateBookmarkInFullPage(bookmarkId, folderPath) {
  try {
    const params = new URLSearchParams({
      action: 'locate',
      id: bookmarkId,
      folder: folderPath || ''
    });
    tabsAPI.create({
      url: runtimeAPI.getURL(`pages/bookmarks.html?${params.toString()}`)
    });
    window.close();
  } catch (error) {
    console.error('打开管理页面失败:', error);
    alert('打开管理页面失败: ' + error.message);
  }
}

/**
 * 更新书签
 */
async function handleUpdateBookmark(bookmarkId) {
  try {
    // 获取当前场景的所有书签
    const data = await storage.getBookmarks(currentSceneId);
    const bookmarks = data.bookmarks || [];
    const bookmark = bookmarks.find(b => b.id === bookmarkId);

    if (!bookmark) {
      alert('未找到要更新的书签');
      return;
    }

    // 打开编辑页面
    const source = isFloatingBallPopup ? 'floating-ball' : 'popup';
    tabsAPI.create({
      url: runtimeAPI.getURL(`pages/bookmarks.html?action=edit&id=${encodeURIComponent(bookmarkId)}&source=${source}`)
    });
    // 操作完成后关闭弹窗
    window.close();
  } catch (error) {
    console.error('更新书签失败:', error);
    alert('更新书签失败: ' + error.message);
  }
}

/**
 * 显示确认对话框
 */
function showConfirmDialog(message) {
  return new Promise((resolve) => {
    const dialog = document.getElementById('confirmDialog');
    const messageEl = document.getElementById('confirmDialogMessage');
    const confirmBtn = document.getElementById('confirmDialogConfirm');
    const cancelBtn = document.getElementById('confirmDialogCancel');

    messageEl.textContent = message;
    dialog.style.display = 'flex';

    const cleanup = () => {
      dialog.style.display = 'none';
      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
    };

    confirmBtn.onclick = () => {
      cleanup();
      resolve(true);
    };

    cancelBtn.onclick = () => {
      cleanup();
      resolve(false);
    };

    // 点击遮罩层关闭
    dialog.onclick = (e) => {
      if (e.target === dialog) {
        cleanup();
        resolve(false);
      }
    };
  });
}

/**
 * 删除书签
 */
async function handleDeleteBookmark(bookmarkId) {
  const confirmed = await showConfirmDialog('确定要删除这个书签吗？');
  if (!confirmed) {
    return;
  }

  showGlobalLoading('正在删除…');

  try {
    await ensureSceneFreshFromCloudBeforeWritePopup();
    // 获取当前场景的所有书签（已与云端对齐）
    const data = await storage.getBookmarks(currentSceneId);
    const allBookmarks = data.bookmarks || [];
    const allFolders = data.folders || [];

    // 删除指定的书签
    const remainingBookmarks = allBookmarks.filter(b => b.id !== bookmarkId);

    // 更新文件夹列表
    const normalizeFolder = (p) => (p || '').trim().replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
    const expandFolderPathsPreserveOrder = (paths) => {
      const out = [];
      const seen = new Set();
      (paths || []).forEach((p) => {
        const n = normalizeFolder(p || '');
        if (!n) return;
        const parts = n.split('/').filter(Boolean);
        let cur = '';
        for (const part of parts) {
          cur = cur ? `${cur}/${part}` : part;
          if (!seen.has(cur)) {
            seen.add(cur);
            out.push(cur);
          }
        }
      });
      return { out, seen };
    };

    const usedLeafFolders = remainingBookmarks.map(b => normalizeFolder(b.folder)).filter(Boolean);
    const { seen: usedWithParentsSet, out: usedWithParentsOrder } = expandFolderPathsPreserveOrder(usedLeafFolders);
    const remainingFolders = [
      ...(allFolders || []).map(normalizeFolder).filter(f => f && usedWithParentsSet.has(f)),
      ...usedWithParentsOrder.filter(f => f && !(allFolders || []).includes(f))
    ];

    // 1. 先保存到本地并立即更新 UI（乐观更新）
    await storage.saveBookmarks(remainingBookmarks, remainingFolders, currentSceneId);

    // 立即重新加载弹出页书签列表，展示删除后的结果
    await loadBookmarksForPopup();

    // 2. 异步触发云端同步，不 await（deletedIds 用于从云端移除该书签）
    sendMessageCompat({
      action: 'syncToCloud',
      bookmarks: remainingBookmarks,
      folders: remainingFolders,
      sceneId: currentSceneId,
      deletedIds: [bookmarkId],
      patch: { bookmarkDeletes: [bookmarkId] }
    }).catch(err => console.error('删除后的后台同步失败:', err));

  } catch (error) {
    console.error('删除书签失败:', error);
    alert('删除失败: ' + error.message);
    // 错误时重新加载以恢复 UI 状态
    await loadBookmarksForPopup();
  } finally {
    hideGlobalLoading();
  }
}

/**
 * 保存滚动位置
 */
function saveScrollPosition() {
  try {
    // 检查设置，如果未启用滚动位置记忆，则跳过
    if (!popupSettings || popupSettings.rememberScrollPosition === false) {
      console.log('[滚动位置] 滚动位置记忆已禁用，跳过保存');
      return;
    }

    // 优先使用 popup-content 的滚动位置（因为它是实际的滚动容器）
    const popupContentEl = document.querySelector('.popup-content');
    const scrollContainer = popupContentEl || bookmarkList;
    if (!scrollContainer) {
      console.warn('[滚动位置] 未找到滚动容器');
      return;
    }

    const scrollTop = scrollContainer.scrollTop;
    const maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;

    if (scrollTop === undefined || scrollTop === null || scrollTop < 0) {
      console.log('[滚动位置] 跳过保存，scrollTop 无效:', scrollTop);
      return;
    }

    console.log('[滚动位置] 保存滚动位置:', scrollTop, '容器:', scrollContainer.className, 'maxScroll:', maxScroll, 'scrollHeight:', scrollContainer.scrollHeight, 'clientHeight:', scrollContainer.clientHeight);

    const state = {
      popupScrollPosition: scrollTop
    };
    if (typeof browser !== 'undefined' && browser.storage) {
      browser.storage.local.set(state);
    } else {
      chrome.storage.local.set(state, () => { });
    }
  } catch (e) {
    console.warn('保存滚动位置失败:', e);
  }
}

/**
 * 恢复滚动位置
 * @returns {Promise<boolean>} 是否成功恢复了非0的位置
 */
async function restoreScrollPosition() {
  try {
    if (!popupSettings || popupSettings.rememberScrollPosition === false) {
      refreshBackToTopVisibility();
      return true; // 视为完成
    }

    const popupContentEl = document.querySelector('.popup-content');
    const scrollContainer = popupContentEl || bookmarkList;
    if (!scrollContainer) return false;

    const result = typeof browser !== 'undefined' && browser.storage
      ? await browser.storage.local.get(['popupScrollPosition'])
      : await new Promise(resolve => {
        chrome.storage.local.get(['popupScrollPosition'], resolve);
      });
    const savedTop = result && result.popupScrollPosition;

    if (savedTop === undefined || savedTop === null || savedTop <= 0) {
      refreshBackToTopVisibility();
      return true; // 没有位置要恢复
    }

    // 检查当前容器是否有足够的内容进行滚动
    const maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;
    if (maxScroll <= 0) {
      console.log('[滚动位置] 内容高度不足，暂时无法恢复:', { scrollHeight: scrollContainer.scrollHeight, clientHeight: scrollContainer.clientHeight });
      refreshBackToTopVisibility();
      return false;
    }

    const finalScroll = Math.min(savedTop, maxScroll);
    scrollContainer.scrollTop = finalScroll;

    // 验证是否真的设置成功了（允许 2px 误差）
    if (Math.abs(scrollContainer.scrollTop - finalScroll) < 2) {
      console.log('[滚动位置] 恢复成功:', scrollContainer.scrollTop);
      refreshBackToTopVisibility();
      return true;
    } else {
      console.log('[滚动位置] 恢复尝试失败，可能内容仍在变动');
      refreshBackToTopVisibility();
      return false;
    }
  } catch (e) {
    console.warn('恢复滚动位置失败:', e);
    refreshBackToTopVisibility();
    return true;
  }
}

// ========== 书签详情功能 ==========

let currentDetailBookmarkId = null;
let currentDetailBookmark = null;

/**
 * 显示书签详情画面
 */
async function showBookmarkDetail(bookmarkId) {
  try {
    const bookmarks = await storage.getBookmarks();
    const bookmark = bookmarks.bookmarks.find(b => b.id === bookmarkId);

    if (!bookmark) {
      showErrorToast('书签未找到');
      return;
    }

    currentDetailBookmarkId = bookmarkId;
    currentDetailBookmark = bookmark;
    renderDetailPanel(bookmark);

    const modal = document.getElementById('bookmarkDetailModal');
    modal.style.display = 'flex';
  } catch (error) {
    console.error('显示书签详情失败:', error);
    showErrorToast('加载书签详情失败');
  }
}

/**
 * 渲染详情面板内容
 */
function renderDetailPanel(bookmark) {
  // 设置书签名（可点击跳转）
  const titleElement = document.getElementById('detailTitle');
  titleElement.textContent = bookmark.title || '无标题';
  titleElement.href = bookmark.url || '#';

  // 设置描述（为空时不展示）
  const descriptionField = document.getElementById('detailDescriptionField');
  const descriptionElement = document.getElementById('detailDescription');
  if (bookmark.description && bookmark.description.trim()) {
    descriptionField.style.display = 'block';
    descriptionElement.value = bookmark.description;
  } else {
    descriptionField.style.display = 'none';
  }

  // 设置备注
  const notesElement = document.getElementById('detailNotes');
  notesElement.value = bookmark.notes || '';

  // 重置所有字段的编辑状态
  resetAllEditFields();
}

/**
 * 重置所有字段的编辑状态
 */
function resetAllEditFields() {
  document.querySelectorAll('.detail-content').forEach(content => {
    content.classList.remove('editing');
  });

  // 隐藏编辑输入框（而不是删除，因为现在是预置元素）
  document.querySelectorAll('.detail-edit-input, .detail-edit-textarea').forEach(input => {
    input.style.display = 'none';
  });

  // 恢复所有编辑按钮状态
  document.querySelectorAll('.detail-content').forEach(content => {
    updateEditButtonState(content, false);
  });
}

/**
 * 切换字段的编辑状态
 */
function toggleEditField(field) {
  const editBtn = document.querySelector(`[data-field="${field}"].detail-edit-btn`);
  if (!editBtn) return;
  const fieldElement = editBtn.closest('.detail-content');
  if (!fieldElement) return;

  // 如果已经处于编辑状态，不做任何操作（保存通过 blur 或 Enter 触发）
  if (fieldElement.classList.contains('editing')) {
    return;
  }

  // 进入编辑状态
  fieldElement.classList.add('editing');

  const bookmark = getBookmarkData();
  if (!bookmark) return;

  // 获取预置的输入框元素
  const wrapper = fieldElement.querySelector('.detail-edit-wrapper');
  if (!wrapper) return;

  let input;
  if (field === 'title') {
    input = document.getElementById('detailTitleInput');
    input.value = bookmark.title || '';
    input.dataset.original = bookmark.title || '';
  } else if (field === 'description') {
    input = document.getElementById('detailDescInput');
    input.value = bookmark.description || '';
    input.dataset.original = bookmark.description || '';
  } else if (field === 'notes') {
    input = document.getElementById('detailNotesInput');
    input.value = bookmark.notes || '';
    input.dataset.original = bookmark.notes || '';
  }

  if (!input) return;

  // 显示输入框
  input.style.display = 'block';
  input.focus();

  // 绑定事件（只绑定一次，使用标志位）
  if (!input.dataset.bound) {
    input.dataset.bound = 'true';
    input.addEventListener('blur', () => {
      // 失去焦点时自动保存
      saveField(field, fieldElement);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && field !== 'notes' && field !== 'description') {
        input.blur();
      } else if (e.key === 'Escape') {
        cancelEdit(field, fieldElement);
      }
    });
  }

  updateEditButtonState(fieldElement, true);
}

/**
 * 执行保存操作（核心保存逻辑）
 */
async function performSave(field, fieldElement) {
  const input = fieldElement.querySelector('.detail-edit-input, .detail-edit-textarea');
  if (!input) return;

  const newValue = input.value.trim();
  const originalValue = input.dataset.original;

  // 如果值没有变化，直接退出编辑模式
  if (newValue === originalValue) {
    cancelEdit(field, fieldElement);
    return;
  }

  // 验证
  if (field === 'title' && !newValue) {
    showErrorToast('书签名不能为空');
    input.focus();
    return;
  }

  if (field === 'title' && newValue.length > 200) {
    showErrorToast('书签名不能超过200字符');
    input.focus();
    return;
  }

  if (field === 'description' && newValue.length > 500) {
    showErrorToast('描述不能超过500字符');
    input.focus();
    return;
  }

  if (field === 'notes' && newValue.length > 2000) {
    showErrorToast('备注不能超过2000字符');
    input.focus();
    return;
  }

// 保存数据
  try {
    await saveDetailField(currentDetailBookmarkId, field, newValue);

    // 更新当前详情书签数据
    if (currentDetailBookmark) {
      currentDetailBookmark[field] = newValue;
      currentDetailBookmark.updatedAt = Date.now();
    }

    showSuccessToast('保存成功');
    cancelEdit(field, fieldElement); // 退出编辑模式
    await updateDetailPanelAfterSave(field, newValue); // 更新详情显示

    // 刷新书签列表（使用轻量级刷新，不显示 loading 遮罩）
    await loadBookmarksForPopup({ lightLoading: true });
  } catch (error) {
    console.error('保存失败:', error);
    showErrorToast('保存失败: ' + (error.message || '未知错误'));
  }
}

/**
 * 保存字段（由 blur 事件触发）
 */
async function saveField(field, fieldElement) {
  if (!fieldElement.classList.contains('editing')) return;
  await performSave(field, fieldElement);
}

/**
 * 更新编辑按钮状态（编辑时隐藏编辑按钮，退出编辑时显示编辑按钮）
 */
function updateEditButtonState(fieldElement, isEditing) {
  const editBtn = fieldElement.querySelector('.detail-edit-btn');
  if (!editBtn) return;

  // 获取复制按钮（只在备注字段的父容器中）
  const copyBtn = document.getElementById('detailCopyBtn');

  if (isEditing) {
    // 编辑模式下隐藏编辑按钮（保存通过 blur 或 Enter 触发）
    editBtn.style.display = 'none';
    // 隐藏复制按钮
    if (copyBtn) {
      copyBtn.style.display = 'none';
    }
  } else {
    // 退出编辑模式，显示编辑按钮
    editBtn.style.display = 'flex';
    editBtn.textContent = '✏️';
    editBtn.title = '编辑';
    // 恢复复制按钮
    if (copyBtn) {
      copyBtn.style.display = '';
    }
  }
}

/**
 * 取消编辑
 */
function cancelEdit(field, fieldElement) {
  fieldElement.classList.remove('editing');

  // 隐藏输入框（而不是删除）
  const wrapper = fieldElement.querySelector('.detail-edit-wrapper');
  if (wrapper) {
    const input = wrapper.querySelector('.detail-edit-input, .detail-edit-textarea');
    if (input) {
      input.style.display = 'none';
    }
  }

  // 恢复按钮状态
  updateEditButtonState(fieldElement, false);
}

/**
 * 保存字段（由 blur 事件触发）
 */
async function saveField(field, fieldElement) {
  if (!fieldElement.classList.contains('editing')) return;
  await performSave(field, fieldElement);
}

/**
 * 更新详情面板显示（保存后调用）
 */
async function updateDetailPanelAfterSave(field, newValue) {
  // 更新显示的文本
  if (field === 'title') {
    const titleElement = document.getElementById('detailTitle');
    if (titleElement) {
      titleElement.textContent = newValue || '无标题';
    }
  } else if (field === 'description') {
    const descElement = document.getElementById('detailDescription');
    const descField = document.getElementById('detailDescriptionField');
    if (descElement && descField) {
      if (newValue && newValue.trim()) {
        descElement.value = newValue;
        descField.style.display = 'block';
      } else {
        descField.style.display = 'none';
      }
    }
  } else if (field === 'notes') {
    const notesElement = document.getElementById('detailNotes');
    if (notesElement) {
      notesElement.value = newValue || '';
    }
  }
}

/**
 * 保存字段到本地和云端
 */
async function saveDetailField(bookmarkId, field, value) {
  const overlay = document.getElementById('globalLoadingOverlay');
  const originalZIndex = overlay?.style.zIndex;
  if (overlay) {
    overlay.style.zIndex = '10001';
  }
  showGlobalLoading('正在保存…');

  try {
    const bookmarks = await storage.getBookmarks(currentSceneId);
    const bookmarkIndex = bookmarks.bookmarks.findIndex(b => b.id === bookmarkId);

    if (bookmarkIndex === -1) {
      throw new Error('书签未找到');
    }

    // 更新本地数据
    bookmarks.bookmarks[bookmarkIndex][field] = value;
    bookmarks.bookmarks[bookmarkIndex].updatedAt = Date.now();

    // 保存到本地存储
    await storage.saveBookmarks(bookmarks.bookmarks, bookmarks.folders, currentSceneId);

    // 同步到云端
    sendMessageCompat({
      action: 'syncToCloud',
      bookmarks: bookmarks.bookmarks,
      folders: bookmarks.folders,
      sceneId: currentSceneId,
      patch: { bookmarkUpserts: [bookmarkId] }
    }).catch(err => console.error('保存后同步云端失败:', err));
  } catch (error) {
    console.error('保存详情字段失败:', error);
    alert('保存失败: ' + error.message);
    throw error;
  } finally {
    if (overlay) {
      overlay.style.zIndex = originalZIndex || '';
    }
    hideGlobalLoading();
  }
}

/**
 * 获取当前书签数据
 */
function getBookmarkData() {
  // 优先使用当前详情书签数据
  if (currentDetailBookmark && currentDetailBookmark.id === currentDetailBookmarkId) {
    return currentDetailBookmark;
  }
  // 备选：从已渲染书签列表中查找
  if (lastRenderedBookmarks && lastRenderedBookmarks.length > 0) {
    return lastRenderedBookmarks.find(b => b.id === currentDetailBookmarkId);
  }
  return null;
}

/**
 * 复制备注
 */
async function copyNotes() {
  const notesElement = document.getElementById('detailNotes');
  const notes = notesElement.value;

  if (!notes) {
    showErrorToast('备注为空');
    return;
  }

  try {
    await navigator.clipboard.writeText(notes);
    showSuccessToast('备注已复制');
  } catch (error) {
    console.error('复制失败:', error);

    // 回退方案
    try {
      notesElement.select();
      document.execCommand('copy');
      showSuccessToast('备注已复制');
    } catch (e) {
      showErrorToast('复制失败');
    }
  }
}

/**
 * 复制描述
 */
async function copyDescription() {
  const descElement = document.getElementById('detailDescription');
  const desc = descElement.value;

  if (!desc) {
    showErrorToast('描述为空');
    return;
  }

  try {
    await navigator.clipboard.writeText(desc);
    showSuccessToast('描述已复制');
  } catch (error) {
    console.error('复制失败:', error);

    // 回退方案
    try {
      descElement.select();
      document.execCommand('copy');
      showSuccessToast('描述已复制');
    } catch (e) {
      showErrorToast('复制失败');
    }
  }
}

/**
 * 关闭详情画面
 */
function closeDetailModal() {
  const modal = document.getElementById('bookmarkDetailModal');
  modal.style.display = 'none';
  resetAllEditFields();
  currentDetailBookmarkId = null;
  currentDetailBookmark = null;
}

/**
 * 显示成功提示
 */
function showSuccessToast(message) {
  showDetailToast(message, 'success');
}

/**
 * 显示错误提示
 */
function showErrorToast(message) {
  showDetailToast(message, 'error');
}

/**
 * 显示提示消息
 */
function showDetailToast(message, type = 'success') {
  // 移除已存在的提示
  const existingToast = document.querySelector('.detail-toast');
  if (existingToast) {
    existingToast.remove();
  }

  const toast = document.createElement('div');
  toast.className = `detail-toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(-20px)';
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

// 详情画面事件监听
document.addEventListener('DOMContentLoaded', () => {
  // 关闭按钮
  const closeBtn = document.getElementById('detailCloseBtn');
  if (closeBtn) {
    closeBtn.addEventListener('click', closeDetailModal);
  }

  // 点击遮罩关闭
  const overlay = document.querySelector('.bookmark-detail-overlay');
  if (overlay) {
    overlay.addEventListener('click', closeDetailModal);
  }

// 复制备注按钮
  const copyBtn = document.getElementById('detailCopyBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', copyNotes);
  }

  // 复制描述按钮
  const descCopyBtn = document.getElementById('detailDescCopyBtn');
  if (descCopyBtn) {
    descCopyBtn.addEventListener('click', copyDescription);
  }

// 编辑按钮事件委托
  document.getElementById('bookmarkDetailModal').addEventListener('click', (e) => {
    if (e.target.classList.contains('detail-edit-btn')) {
      const field = e.target.dataset.field;
      const fieldElement = document.querySelector(`.detail-edit-btn[data-field="${field}"]`).closest('.detail-content');
      // 只在非编辑模式下进入编辑模式（保存通过 blur 或 Enter 触发）
      if (!fieldElement.classList.contains('editing')) {
        toggleEditField(field);
      }
    }
  });

  // 详情按钮事件委托（书签列表）
  document.getElementById('bookmarkList').addEventListener('click', async (e) => {
    if (e.target.classList.contains('bookmark-detail-btn')) {
      e.stopPropagation();
      const bookmarkId = e.target.dataset.id;
      await showBookmarkDetail(bookmarkId);
    }
  });
});
