/**
 * 弹出窗口脚本
 */

const storage = new StorageManager();

// 兼容的消息发送函数（如果 utils.js 中的 sendMessage 不可用，则使用此实现）
const sendMessageCompat = typeof sendMessage !== 'undefined' ? sendMessage : function(message, callback) {
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
let lastRenderedBookmarks = [];
let popupSettings = {
  expandFirstLevel: false
};
let shouldApplyDefaultExpand = true;
const runtimeErrors = [];
const consoleLogs = [];
const opLogs = [];

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
  
  await loadPopupSettings();
  await loadFolderState();
  await loadCurrentScene();
  await loadScenes();
  
  // 确保 DOM 完全准备好后再加载书签
  requestAnimationFrame(async () => {
    console.log('[弹窗] requestAnimationFrame 回调执行，开始加载书签');
    await loadBookmarksForPopup();
    await updateSyncStatus();
    console.log('[弹窗] 书签加载完成');
  });
  
  // 监听消息更新
  runtimeAPI.onMessage.addListener((request) => {
    if (request.action === 'bookmarksUpdated' || request.action === 'sceneChanged') {
      console.log('[弹窗] 收到更新消息，重新加载书签');
      loadCurrentScene();
      // 使用 requestAnimationFrame 确保 DOM 更新完成
      requestAnimationFrame(async () => {
        await loadBookmarksForPopup();
        await updateSyncStatus();
      });
    }
  });
  
  // 点击外部关闭场景菜单
  document.addEventListener('click', (e) => {
    if (!sceneSwitchBtn.contains(e.target) && !sceneMenu.contains(e.target)) {
      sceneMenu.style.display = 'none';
    }
  });
  
  // ESC键关闭弹窗（仅在PC上启用，手机没有物理键盘）
  // 检测是否为移动设备
  const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || 
                         (window.matchMedia && window.matchMedia('(max-width: 768px)').matches && 'ontouchstart' in window);
  
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
              await sendMessageCompat({ action: 'sync', sceneId });
            } catch (e) {
              // 忽略单次同步失败，继续后续逻辑
            }
            const afterSync = await storage.getBookmarks(sceneId);
            const hasAfter = (afterSync.bookmarks && afterSync.bookmarks.length) || (afterSync.folders && afterSync.folders.length);
            if (!hasAfter) {
              // 云端也没有，创建一个空文件以便后续同步
              try {
                await sendMessageCompat({ action: 'syncToCloud', bookmarks: [], folders: [], sceneId });
              } catch (e) {
                // 忽略，等待用户后续添加书签再同步
              }
            }
            // 场景切换不同步到云端，只保存在本地
          }
          await loadCurrentScene();
          await loadScenes();
          await loadBookmarksForPopup();
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
    // 按当前场景过滤书签
    const data = await storage.getBookmarks(currentSceneId);
    const bookmarks = data.bookmarks || [];
    pushOpLog(`loadBookmarks success, scene=${currentSceneId}, total=${bookmarks.length}`);
    
    // 显示所有书签，与完整画面保持一致（不再限制数量）
    const sorted = bookmarks
      .map(b => ({ ...b }))
      .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
    
    // 默认展开第一层（仅在没有本地折叠状态时）
    if (shouldApplyDefaultExpand && popupSettings.expandFirstLevel) {
      const first = getFirstLevelFolders(sorted);
      first.forEach(p => expandedFolders.add(p));
    }

    lastRenderedBookmarks = sorted;
    renderBookmarks(sorted, { searchMode: false });
  } catch (error) {
    console.error('加载书签失败:', error);
    pushOpLog(`loadBookmarks failed: ${error.message}`);
  }
}

/**
 * 渲染书签列表
 */
function renderBookmarks(bookmarks, { searchMode = false } = {}) {
  if (bookmarks.length === 0) {
    bookmarkList.innerHTML = '<div class="empty-state">暂无书签</div>';
    return;
  }

  if (searchMode) {
    bookmarkList.innerHTML = bookmarks.map(bookmark => `
      <div class="bookmark-item" data-url="${escapeHtml(bookmark.url)}">
        <div class="bookmark-item-title">${escapeHtml(bookmark.title || '无标题')}</div>
        <div class="bookmark-item-url">${escapeHtml(bookmark.url)}</div>
        ${bookmark.folder ? `<div class="bookmark-item-folder">📁 ${escapeHtml(bookmark.folder)}</div>` : ''}
      </div>
    `).join('');

    // 点击事件（使用 requestAnimationFrame 确保 DOM 更新完成）
    requestAnimationFrame(() => {
      const items = bookmarkList.querySelectorAll('.bookmark-item');
      console.log('[弹窗] 搜索模式：找到书签项数量:', items.length);
      
      items.forEach((item, index) => {
        console.log(`[弹窗] 搜索模式：绑定书签项 ${index}:`, item.dataset.url);
        item.addEventListener('click', () => {
          console.log('[弹窗] 搜索模式：书签项被点击:', item.dataset.url);
          const url = item.dataset.url;
          if (url) {
            console.log('[弹窗] 搜索模式：打开URL:', url);
            tabsAPI.create({ url });
            window.close();
          } else {
            console.error('[弹窗] 搜索模式：URL为空，无法打开');
          }
        });
      });
    });
    return;
  }

  // 初次加载时默认展开第一层文件夹
  if (expandedFolders.size === 1 && expandedFolders.has('')) {
    // 已迁移到 loadBookmarksForPopup 中按设置控制
  }

  const tree = buildFolderTree(bookmarks);
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

  function bindBookmarkClick() {
    console.log('[弹窗] bindBookmarkClick 被调用');
    const items = bookmarkList.querySelectorAll('.bookmark-item');
    console.log('[弹窗] 找到书签项数量:', items.length);
    
    items.forEach((item, index) => {
      console.log(`[弹窗] 绑定书签项 ${index}:`, item.dataset.url);
      item.addEventListener('click', (e) => {
        console.log('[弹窗] 书签项被点击:', item.dataset.url);
        e.stopPropagation();
        const url = item.dataset.url;
        if (url) {
          console.log('[弹窗] 打开URL:', url);
          tabsAPI.create({ url });
          window.close();
        } else {
          console.error('[弹窗] URL为空，无法打开');
        }
      });
    });
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
      expandFirstLevel: !!(settings && settings.popup && settings.popup.expandFirstLevel)
    };
  } catch (e) {
    console.warn('加载弹窗设置失败，使用默认值', e?.message || e);
    popupSettings = { expandFirstLevel: false };
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
    chrome.storage.local.set(state, () => {});
  }
}

function buildFolderTree(bookmarks) {
  const root = { name: 'root', path: '', folders: {}, items: [] };
  bookmarks.forEach(b => {
    const folderPath = normalizeFolderPath(b.folder || '');
    if (!folderPath) {
      root.items.push(b);
      return;
    }
    const parts = folderPath.split('/');
    let node = root;
    let currentPath = '';
    parts.forEach(part => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!node.folders[part]) {
        node.folders[part] = { name: part, path: currentPath, folders: {}, items: [] };
      }
      node = node.folders[part];
    });
    node.items.push(b);
  });
  return root;
}

// 计算文件夹下的直接子文件夹数量（不递归，只统计直接子文件夹）
function countSubfolders(node) {
  const folders = node.folders || {};
  return Object.keys(folders).length; // 只统计直接子文件夹数量，不递归
}

function renderFolderTreeHtml(node, indentPath) {
  const folderEntries = Object.values(node.folders).sort((a, b) => a.name.localeCompare(b.name));
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

  const itemHtml = items.map(b => `
    <div class="bookmark-item" data-url="${escapeHtml(b.url)}">
      <div class="bookmark-item-title">${escapeHtml(b.title || '无标题')}</div>
      <div class="bookmark-item-url">${escapeHtml(b.url)}</div>
    </div>
  `).join('');

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
 * 搜索书签
 */
searchInput.addEventListener('input', debounce(async (e) => {
  const query = e.target.value.trim();
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
  const tab = await getActiveTabSafe();
  if (tab && tab.url) {
    pushOpLog(`addCurrent: got tab url=${tab.url}`);
    tabsAPI.create({
      url: runtimeAPI.getURL(`pages/bookmarks.html?action=add&url=${encodeURIComponent(tab.url)}&title=${encodeURIComponent(tab.title)}&source=popup`)
    });
    // 操作完成后关闭弹窗
    window.close();
  } else {
    pushOpLog('addCurrent: failed to get active tab');
    alert('无法获取当前页面，请在支持的浏览器/标签页中重试');
  }
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
    const [config, syncStatus, pendingChanges, bookmarkData, devices, deviceInfo, settings] = await Promise.all([
      storage.getConfig(),
      storage.getSyncStatus(),
      storage.getPendingChanges(),
      storage.getBookmarks(),
      storage.getDevices(),
      storage.getDeviceInfo(),
      storage.getSettings()
    ]);

    const manifest = runtimeAPI.getManifest ? runtimeAPI.getManifest() : {};
    const alarmsAPI = typeof browser !== 'undefined' ? browser.alarms : chrome.alarms;
    let alarms = [];
    if (alarmsAPI && alarmsAPI.getAll) {
      if (typeof browser !== 'undefined' && browser.alarms) {
        // Firefox: 使用 Promise
        alarms = await alarmsAPI.getAll();
      } else {
        // Chrome/Edge: 使用回调
        alarms = await new Promise(resolve => {
          alarmsAPI.getAll(resolve);
        });
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

    const text = serializeLogToText(log);
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cloud-bookmark-log-${Date.now()}.log`;
    a.click();
    URL.revokeObjectURL(url);
    // 操作完成后关闭弹窗
    window.close();
  } catch (error) {
    console.error('导出日志失败:', error);
    alert('导出日志失败：' + error.message);
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

