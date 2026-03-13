/**
 * 弹出窗口脚本
 */

const storage = new StorageManager();

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
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const sceneSwitchBtn = document.getElementById('sceneSwitchBtn');
const currentSceneNameEl = document.getElementById('currentSceneName');
const sceneMenu = document.getElementById('sceneMenu');
// 已移除 MAX_BOOKMARKS_DISPLAY 限制，弹窗现在显示所有书签以保持与完整画面一致
let currentSceneId = null;
let expandedFolders = new Set(['']); // 根默认展开
let isFloatingBallPopup = false; // 是否为悬浮球打开的弹窗
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

  // 检测是否为悬浮球打开的弹窗，如果是则调整高度
  const urlParams = new URLSearchParams(window.location.search);
  const source = urlParams.get('source');
  isFloatingBallPopup = source === 'floating-ball';

  // 检测是否为移动设备
  const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
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
        const currentId = await storage.getCurrentScene(); // 获取当前场景进行比较
        if (sceneId !== currentId) {
          await storage.saveCurrentScene(sceneId);
          currentSceneId = sceneId; // 立即更新本地状态，避免后续逻辑读取旧值

          // 检查 WebDAV 配置是否有效
          const config = await storage.getConfig();
          const hasValidConfig = config && config.serverUrl;
          // 检查该场景是否已同步过
          const isSceneSynced = await storage.isSceneSynced(sceneId);

          // WebDAV配置有效且该场景从未同步过，需要执行云端同步
          if (hasValidConfig && !isSceneSynced) {
            try {
              console.log('[弹窗] 切换场景：开始同步场景', sceneId);
              const syncResult = await sendMessageCompat({ action: 'sync', sceneId });
              console.log('[弹窗] 切换场景：同步完成', syncResult);
            } catch (e) {
              console.error('[弹窗] 切换场景：同步失败', e);
              // 忽略单次同步失败，继续后续逻辑
            }
            // 场景切换不同步到云端，只保存在本地
          }
          await loadCurrentScene();
          await loadScenes();
          // 确保 DOM 更新完成后再加载书签
          await new Promise(resolve => requestAnimationFrame(resolve));
          await loadBookmarksForPopup();
          // 再次确保 DOM 更新完成，给事件委托足够的时间绑定
          await new Promise(resolve => requestAnimationFrame(resolve));
          console.log('[弹窗] 切换场景：书签加载完成，当前书签项数量:', document.querySelectorAll('.bookmark-item').length);
        }
        sceneMenu.style.display = 'none';
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

/**
 * 加载弹窗展示的书签（显示所有书签，与完整画面保持一致）
 */
async function loadBookmarksForPopup() {
  try {
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
        }
      });
    };

    // 初始延迟，等待 DOM 解析和初步渲染
    setTimeout(attemptRestore, 100);
  } catch (error) {
    console.error('加载书签失败:', error);
    pushOpLog(`loadBookmarks failed: ${error.message}`);
  }
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
    bookmarkList.innerHTML = bookmarks.map(bookmark => {
      const id = escapeHtml(bookmark.id);
      const folderHtml = bookmark.folder
        ? `<div class="bookmark-item-folder">所在：${escapeHtml(bookmark.folder)}</div>`
        : '';
      const updateBtnHtml = `<button class="bookmark-update-btn" data-id="${id}" title="更新" style="display: ${(popupSettings && popupSettings.showUpdateButton) ? 'flex' : 'none'};">✏️</button>`;
      const actionBtnHtml = useFavorite
        ? `<button class="bookmark-fav-btn" data-id="${id}" data-starred="${bookmark.starred ? 'true' : 'false'}" title="${bookmark.starred ? '取消收藏' : '添加到收藏'}">${bookmark.starred ? '★' : '☆'}</button>`
        : `<button class="bookmark-delete-btn" data-id="${id}" title="删除">🗑️</button>`;
      return `
      <div class="bookmark-item" data-url="${escapeHtml(bookmark.url)}" data-id="${id}">
        <div class="bookmark-item-content">
          <div class="bookmark-item-title">${escapeHtml(bookmark.title || '无标题')}</div>
          <div class="bookmark-item-url">${escapeHtml(bookmark.url)}</div>
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

  // 使用 requestAnimationFrame 确保 DOM 更新完成后再绑定事件
  requestAnimationFrame(() => {
    // 绑定文件夹展开/折叠
    bookmarkList.querySelectorAll('.folder-row').forEach(row => {
      row.addEventListener('click', () => {
        const path = row.dataset.folder || '';
        if (expandedFolders.has(path)) {
          expandedFolders.delete(path);
        } else {
          expandedFolders.add(path);
        }
        saveFolderState();
        bookmarkList.innerHTML = renderFolderTreeHtml(tree, '');
        // 重新绑定事件时，也要使用 requestAnimationFrame 确保 DOM 更新完成
        requestAnimationFrame(() => {
          bindFolderEvents();
          bindBookmarkClick();
        });
      });
    });

    bindBookmarkClick();
    // 应用设置到UI（更新按钮的显示/隐藏）
    applyPopupSettings();
  });

  function bindFolderEvents() {
    // 使用 requestAnimationFrame 确保 DOM 更新完成后再绑定事件
    requestAnimationFrame(() => {
      bookmarkList.querySelectorAll('.folder-row').forEach(row => {
        row.addEventListener('click', () => {
          const path = row.dataset.folder || '';
          if (expandedFolders.has(path)) {
            expandedFolders.delete(path);
          } else {
            expandedFolders.add(path);
          }
          saveFolderState();
          bookmarkList.innerHTML = renderFolderTreeHtml(tree, '');
          // 重新绑定事件时，也要使用 requestAnimationFrame 确保 DOM 更新完成
          requestAnimationFrame(() => {
            bindFolderEvents();
            bindBookmarkClick();
          });
        });
      });
    });
  }

  // 保留空函数占位，实际点击逻辑通过事件委托统一处理
  function bindBookmarkClick(retry = 0) {
    console.log('[弹窗] bindBookmarkClick 调用（事件委托模式），retry =', retry);
  }
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
      favoriteAsDelete: !!(settings && settings.popup && settings.popup.favoriteAsDelete) // 默认false
    };
    // 应用设置到UI
    applyPopupSettings();
  } catch (e) {
    console.warn('加载弹窗设置失败，使用默认值', e?.message || e);
    popupSettings = {
      expandFirstLevel: false,
      rememberScrollPosition: true,
      showUpdateButton: false,
      favoriteAsDelete: false
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
}

/**
 * 切换当前场景下某个书签的收藏状态（弹窗内使用）
 */
async function handleToggleFavorite(bookmarkId) {
  try {
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

    // 异步触发云端同步，确保收藏状态写入 WebDAV
    sendMessageCompat({
      action: 'syncToCloud',
      bookmarks: allBookmarks,
      folders: allFolders,
      sceneId: currentSceneId
    }).catch(err => console.error('[弹窗] 收藏状态后台同步失败:', err));
  } catch (e) {
    console.error('[弹窗] 切换收藏状态失败:', e);
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
  const itemHtml = items.map(b => {
    const id = escapeHtml(b.id);
    const folderHtml = b.folder
      ? `<div class="bookmark-item-folder">所在：${escapeHtml(b.folder)}</div>`
      : '';
    const updateBtnHtml = `<button class="bookmark-update-btn" data-id="${id}" title="更新" style="display: ${(popupSettings && popupSettings.showUpdateButton) ? 'flex' : 'none'};">✏️</button>`;
    const actionBtnHtml = useFavorite
      ? `<button class="bookmark-fav-btn" data-id="${id}" data-starred="${b.starred ? 'true' : 'false'}" title="${b.starred ? '取消收藏' : '添加到收藏'}">${b.starred ? '★' : '☆'}</button>`
      : `<button class="bookmark-delete-btn" data-id="${id}" title="删除">🗑️</button>`;
    return `
    <div class="bookmark-item" data-url="${escapeHtml(b.url)}" data-id="${id}">
      <div class="bookmark-item-content">
        <div class="bookmark-item-title">${escapeHtml(b.title || '无标题')}</div>
        <div class="bookmark-item-url">${escapeHtml(b.url)}</div>
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

  let targetUrl, targetTitle;

  if (urlFromParams && titleFromParams) {
    targetUrl = urlFromParams;
    targetTitle = titleFromParams;
    pushOpLog(`addCurrent: using params from floating ball url=${targetUrl}`);
  } else {
    // 回退到查询标签页（PC 端或非悬浮球触发的情况）
    const tab = await getActiveTabSafe();
    if (tab && tab.url) {
      targetUrl = tab.url;
      targetTitle = tab.title || '';
      pushOpLog(`addCurrent: got tab url=${targetUrl}`);
    } else {
      pushOpLog('addCurrent: failed to get active tab');
      alert('无法获取当前页面，请在支持的浏览器/标签页中重试');
      return;
    }
  }

  // 打开添加书签页面
  const source = isFloatingBallPopup ? 'floating-ball' : 'popup';
  tabsAPI.create({
    url: runtimeAPI.getURL(`pages/bookmarks.html?action=add&url=${encodeURIComponent(targetUrl)}&title=${encodeURIComponent(targetTitle || '')}&source=${source}`)
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
    const tab = Array.isArray(tabs) ? tabs[0] : null;
    if (tab && tab.url && !isExtensionUrl(tab.url)) return tab;
  } catch (e) {
    console.warn('tabs.query(currentWindow) 失败:', e?.message || e);
  }

  // 3. lastFocusedWindow
  try {
    const tabs = await queryTabsCompat({ active: true, lastFocusedWindow: true });
    const tab = Array.isArray(tabs) ? tabs[0] : null;
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

  try {
    // 获取当前场景的所有书签
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

    // 2. 异步触发云端同步，不 await
    sendMessageCompat({
      action: 'syncToCloud',
      bookmarks: remainingBookmarks,
      folders: remainingFolders,
      sceneId: currentSceneId
    }).catch(err => console.error('删除后的后台同步失败:', err));

  } catch (error) {
    console.error('删除书签失败:', error);
    alert('删除失败: ' + error.message);
    // 错误时重新加载以恢复 UI 状态
    await loadBookmarksForPopup();
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
