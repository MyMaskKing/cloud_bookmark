/**
 * 书签管理页面脚本
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
let viewOptions = {
  showDescription: true,
  showNotes: true,
  showTags: true,
  showUrl: true,
  showIcon: true,
  showFolder: false
};
let currentView = 'list';
const defaultSettings = {
  viewOptions: { ...viewOptions },
  viewMode: 'list'
};
const defaultViewOptions = { ...defaultSettings.viewOptions };

function normalizeFolderPath(path) {
  if (!path) return '';
  return path
    .trim()
    .replace(/\/+/g, '/')
    .replace(/^\/|\/$/g, '');
}

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

function isValidUrl(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function getFaviconUrl(url) {
  try {
    const urlObj = new URL(url);
    return `${urlObj.protocol}//${urlObj.host}/favicon.ico`;
  } catch {
    return '';
  }
}

function getDomain(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return '';
  }
}
let currentBookmarks = [];
let currentFolders = [];
let currentFilter = 'all';
let currentSort = 'created-desc';
let editingBookmarkId = null;
let currentSceneId = null;
// 文件夹展开状态（Set，存储展开的文件夹路径）
let expandedFolders = new Set(['']); // 默认展开根节点
let foldersInitialized = false; // 标记文件夹是否已初始化展开状态
let batchMode = false;
let selectedBookmarkIds = new Set();
let pageSource = null; // 记录页面来源（popup/floating-ball等）
let autoCloseTimer = null; // 自动关闭定时器

// DOM元素
const addBookmarkBtn = document.getElementById('addBookmarkBtn');
const searchInput = document.getElementById('searchInput');
const sortSelect = document.getElementById('sortSelect');
const viewToggle = document.getElementById('viewToggle');
const viewOptionsBtn = document.getElementById('viewOptionsBtn');
const exportBtn = document.getElementById('exportBtn');
const syncBtn = document.getElementById('syncBtn');
const syncErrorBanner = document.getElementById('syncErrorBanner');
const bookmarksGrid = document.getElementById('bookmarksGrid');
const emptyState = document.getElementById('emptyState');
const bookmarkModal = document.getElementById('bookmarkModal');
const bookmarkForm = document.getElementById('bookmarkForm');
const closeModal = document.getElementById('closeModal');
const cancelBtn = document.getElementById('cancelBtn');
const foldersList = document.getElementById('foldersList');
const tagsList = document.getElementById('tagsList');
const addFolderBtn = document.getElementById('addFolderBtn');
const sidebar = document.querySelector('.sidebar');
const sidebarResizer = document.getElementById('sidebarResizer');
const sidebarOverlay = document.getElementById('sidebarOverlay');
const sidebarToggle = document.getElementById('sidebarToggle');
const batchModeBtn = document.getElementById('batchModeBtn');
const batchActionsBar = document.getElementById('batchActionsBar');
const normalActions = document.getElementById('normalActions');
const selectedCount = document.getElementById('selectedCount');
const batchMoveBtn = document.getElementById('batchMoveBtn');
const batchDeleteBtn = document.getElementById('batchDeleteBtn');
const batchCancelBtn = document.getElementById('batchCancelBtn');
const selectAllBtn = document.getElementById('selectAllBtn');

// 非阻断 Toast（用于同步失败提示）
let toastEl = null;
let toastTimer = null;
function showToast(message, { title = '提示', type = 'error', duration = 2000 } = {}) {
  try {
    const toastId = 'cloud-bookmark-page-toast';
    if (!toastEl) toastEl = document.getElementById(toastId);

    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = toastId;
      const bg = type === 'error' ? 'rgba(220, 53, 69, 0.96)' : 'rgba(25, 135, 84, 0.92)';
      toastEl.style.cssText = `
        position: fixed;
        top: 16px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483647;
        max-width: calc(100vw - 32px);
        width: 520px;
        padding: 10px 14px;
        border-radius: 10px;
        background: ${bg};
        color: #fff;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
        pointer-events: none;
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
        </div>
      `;
      if (document.body) document.body.appendChild(toastEl);
    }

    const titleEl = toastEl.querySelector(`#${toastId}-title`);
    const msgEl = toastEl.querySelector(`#${toastId}-msg`);
    if (titleEl) titleEl.textContent = title || '提示';
    if (msgEl) msgEl.textContent = message || '';

    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }

    requestAnimationFrame(() => {
      if (toastEl) toastEl.style.opacity = '1';
    });

    toastTimer = setTimeout(() => {
      if (!toastEl) return;
      toastEl.style.opacity = '0';
      setTimeout(() => {
        try { toastEl?.remove(); } catch (_) {}
        toastEl = null;
      }, 160);
    }, Math.max(500, duration));
  } catch (_) {
    // ignore
  }
}

async function updateSyncErrorBanner() {
  if (!syncErrorBanner) return;
  try {
    const status = await storage.getSyncStatus();
    if (status && status.status === 'error' && status.error) {
      syncErrorBanner.style.display = 'block';
      syncErrorBanner.textContent = `同步失败：${status.error}`;
    } else {
      syncErrorBanner.style.display = 'none';
      syncErrorBanner.textContent = '';
    }
  } catch (_) {
    // ignore
  }
}

function openSidebarMobile() {
  if (sidebar) sidebar.classList.add('open');
  if (sidebarOverlay) sidebarOverlay.style.display = 'block';
}

function closeSidebarMobile() {
  if (sidebar) sidebar.classList.remove('open');
  if (sidebarOverlay) sidebarOverlay.style.display = 'none';
}

function toggleSidebarMobile() {
  if (sidebar && sidebar.classList.contains('open')) {
    closeSidebarMobile();
  } else {
    openSidebarMobile();
  }
}

function closeSidebarIfMobile() {
  if (window.innerWidth <= 768) {
    closeSidebarMobile();
  }
}

// 侧边栏宽度拖拽调整（桌面端）
let isResizingSidebar = false;
let sidebarStartX = 0;
let sidebarStartWidth = 0;

function initSidebarResizer() {
  if (!sidebar || !sidebarResizer) return;

  // 读取本地保存的宽度
  try {
    const saved = localStorage.getItem('cloudBookmark_sidebarWidth');
    if (saved) {
      const w = parseInt(saved, 10);
      if (!Number.isNaN(w)) {
        sidebar.style.width = `${w}px`;
      }
    }
  } catch (e) {
    // 忽略本地存储异常
  }

  sidebarResizer.addEventListener('mousedown', (e) => {
    if (window.innerWidth <= 768) return;
    isResizingSidebar = true;
    sidebarStartX = e.clientX;
    sidebarStartWidth = sidebar.offsetWidth;
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizingSidebar) return;
    const delta = e.clientX - sidebarStartX;
    let newWidth = sidebarStartWidth + delta;
    const minWidth = 180;
    const maxWidth = 480;
    newWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
    sidebar.style.width = `${newWidth}px`;
  });

  document.addEventListener('mouseup', () => {
    if (!isResizingSidebar) return;
    isResizingSidebar = false;
    document.body.style.userSelect = '';
    try {
      const width = sidebar.offsetWidth;
      localStorage.setItem('cloudBookmark_sidebarWidth', String(width));
    } catch (e) {
      // 忽略本地存储异常
    }
  });
}

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings(); // 先加载显示设置
  await loadCurrentScene();
  await loadScenes();
  await loadBookmarks();
  await loadFolderState(); // 先加载文件夹展开状态
  await loadFolders();
  await loadTags();
  await updateSyncErrorBanner();
  initSidebarResizer();
  setupEventListeners();
  checkUrlParams();

  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) {
      closeSidebarMobile();
    }
  });
  
  // 监听消息更新
  runtimeAPI.onMessage.addListener((request, sender, sendResponse) => {
    if (request && (request.action === 'bookmarksUpdated' || request.action === 'sceneChanged')) {
      loadCurrentScene();
      loadBookmarks();
      loadFolders();
      loadTags();
      updateSyncErrorBanner();
      return;
    }

    // 后台广播的同步失败 toast（扩展页面收 runtime 消息）
    if (request && request.action === 'showSyncErrorToast') {
      showToast(request.message || '同步失败', {
        title: request.title || '云端书签同步失败',
        type: 'error',
        duration: request.duration || 2000
      });
      updateSyncErrorBanner();
      if (sendResponse) sendResponse({ success: true });
      return true;
    }
  });

  // 同步状态变化时刷新错误条（本地存储变化，不依赖消息）
  try {
    const storageAPI = typeof browser !== 'undefined' ? browser.storage : chrome.storage;
    if (storageAPI && storageAPI.onChanged) {
      storageAPI.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local' && changes && changes.syncStatus) {
          updateSyncErrorBanner();
        }
      });
    }
  } catch (_) {
    // ignore
  }
});

/**
 * 检查URL参数（用于添加书签）
 */
function checkUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const action = params.get('action');
  pageSource = params.get('source'); // 记录页面来源
  
  // 如果是从快捷键打开的，隐藏主内容，只显示添加表单
  if (pageSource === 'shortcut') {
    const appContainer = document.querySelector('.app-container');
    if (appContainer) {
      // 隐藏侧边栏和主内容区域
      const sidebar = document.querySelector('.sidebar');
      const main = document.querySelector('main');
      if (sidebar) sidebar.style.display = 'none';
      if (main) main.style.display = 'none';
      
      // 设置页面样式，居中显示模态框
      document.body.style.display = 'flex';
      document.body.style.alignItems = 'center';
      document.body.style.justifyContent = 'center';
      document.body.style.minHeight = '100vh';
      document.body.style.margin = '0';
      document.body.style.padding = '0';
      document.body.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
    }
  }
  
  if (action === 'add') {
    const url = params.get('url');
    const title = params.get('title');
    if (url) {
      showAddForm({ url, title });
    }
  }
}

/**
 * 设置事件监听
 */
function setupEventListeners() {
  addBookmarkBtn.addEventListener('click', () => showAddForm());
  searchInput.addEventListener('input', debounce(handleSearch, 300));
  sortSelect.addEventListener('change', (e) => {
    currentSort = e.target.value;
    renderBookmarks();
  });
  // 视图切换按钮：同时支持点击和触摸事件（解决安卓上点击没效果的问题）
  if (viewToggle) {
    console.log('[视图切换] viewToggle 元素找到:', viewToggle);
    
    viewToggle.addEventListener('click', (e) => {
      console.log('[视图切换] click 事件触发', e);
      e.preventDefault();
      e.stopPropagation();
      toggleView();
    });
    
    viewToggle.addEventListener('touchend', (e) => {
      console.log('[视图切换] touchend 事件触发', e);
      e.preventDefault();
      e.stopPropagation();
      toggleView();
    });
    
    viewToggle.addEventListener('touchstart', (e) => {
      console.log('[视图切换] touchstart 事件触发', e);
    });
  } else {
    console.error('[视图切换] viewToggle 元素未找到！');
  }
  viewOptionsBtn.addEventListener('click', handleViewOptions);
  exportBtn.addEventListener('click', handleExport);
  syncBtn.addEventListener('click', handleSync);
  closeModal.addEventListener('click', hideModal);
  cancelBtn.addEventListener('click', hideModal);
  
  bookmarkForm.addEventListener('submit', handleSubmit);
  addFolderBtn.addEventListener('click', handleAddFolder);
  
  // 绑定创建文件夹按钮（在添加书签表单中）
  const createFolderBtn = document.getElementById('createFolderBtn');
  if (createFolderBtn) {
    createFolderBtn.addEventListener('click', handleCreateFolderInForm);
  }

  // 空状态按钮绑定（Firefox CSP 要求，不能使用内联 onclick）
  const addFirstBookmarkBtn = document.getElementById('addFirstBookmarkBtn');
  if (addFirstBookmarkBtn) {
    addFirstBookmarkBtn.addEventListener('click', (e) => {
      e.preventDefault();
      showAddForm();
    });
  }
  
  // 场景切换按钮
  const sceneSwitchBtn = document.getElementById('sceneSwitchBtn');
  const sceneMenu = document.getElementById('sceneMenu');
  if (sceneSwitchBtn && sceneMenu) {
    sceneSwitchBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      sceneMenu.style.display = sceneMenu.style.display === 'none' ? 'block' : 'none';
    });
    
    // 点击外部关闭场景菜单
    document.addEventListener('click', (e) => {
      if (sceneSwitchBtn && sceneMenu && !sceneSwitchBtn.contains(e.target) && !sceneMenu.contains(e.target)) {
        sceneMenu.style.display = 'none';
      }
    });
  }
  
  // 导航项点击
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      currentFilter = item.dataset.filter;
      renderBookmarks();
      closeSidebarIfMobile();
    });
  });

  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSidebarMobile();
    });
  }

  if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', () => closeSidebarMobile());
  }
}

/**
 * 加载当前场景
 */
async function loadCurrentScene() {
  try {
    currentSceneId = await storage.getCurrentScene();
  } catch (error) {
    console.error('加载当前场景失败:', error);
    currentSceneId = 'home';
  }
}

/**
 * 加载场景列表（用于场景切换菜单）
 */
async function loadScenes() {
  try {
    const scenes = await storage.getScenes();
    // 更新场景切换按钮显示
    const sceneBtn = document.getElementById('sceneSwitchBtn');
    const sceneMenuEl = document.getElementById('sceneMenu');
    if (sceneBtn) {
      const currentScene = scenes.find(s => s.id === currentSceneId);
      const sceneNameEl = sceneBtn.querySelector('.scene-name');
      if (sceneNameEl) {
        sceneNameEl.textContent = currentScene ? currentScene.name : '未知';
      }
    }
    
    // 更新场景菜单
    if (sceneMenuEl) {
      sceneMenuEl.innerHTML = scenes.map(scene => {
        const isCurrent = scene.id === currentSceneId;
        return `
          <div class="scene-menu-item ${isCurrent ? 'current' : ''}" data-id="${scene.id}">
            ${scene.name || scene.id}
          </div>
        `;
      }).join('');
      
      // 绑定点击事件
      sceneMenuEl.querySelectorAll('.scene-menu-item').forEach(item => {
        item.addEventListener('click', async () => {
          const sceneId = item.dataset.id;
          if (sceneId !== currentSceneId) {
            await storage.saveCurrentScene(sceneId);
            currentSceneId = sceneId; // 立即更新，避免后续读取旧值
            
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
            await loadBookmarks();
            await loadFolders();
            await loadTags();
            await sendMessageCompat({ action: 'sceneChanged' });
          }
          sceneMenuEl.style.display = 'none';
        });
      });
    }
  } catch (error) {
    console.error('加载场景列表失败:', error);
  }
}

/**
 * 加载书签
 */
async function loadBookmarks() {
  try {
    // 按当前场景过滤书签
    const data = await storage.getBookmarks(currentSceneId);
    const rawBookmarks = data.bookmarks || [];
    // 规范化书签文件夹路径
    currentBookmarks = rawBookmarks.map(b => {
      if (!b.folder) return b;
      return { ...b, folder: normalizeFolderPath(b.folder) };
    });

    // 规范化存储的文件夹列表（保留用户创建的空文件夹）
    const storedFolders = (data.folders || []).map(p => normalizeFolderPath(p || '')).filter(Boolean);
    const bookmarkFolders = currentBookmarks.map(b => b.folder).filter(Boolean);
    // 合并：保留所有存储的文件夹（包括空文件夹）+ 从书签中提取的文件夹
    const missing = [...new Set(bookmarkFolders)].filter(f => f && !storedFolders.includes(f)).sort();
    const merged = [...storedFolders, ...missing]; // 先保留存储的文件夹，再添加缺失的
    const dedup = [...new Set(merged)];
    currentFolders = dedup;

    // 若与存储数据不一致，回写清理结果（但保留空文件夹）
    const storedKey = storedFolders.join('|');
    const dedupKey = dedup.join('|');
    if (storedKey !== dedupKey) {
      // 保存时确保保留所有文件夹（包括空文件夹）
      await storage.saveBookmarks(currentBookmarks, currentFolders, currentSceneId);
    }

    renderBookmarks();
  } catch (error) {
    console.error('加载书签失败:', error);
  }
}

/**
 * 计算文件夹下的直接子文件夹数量（不递归，只统计直接子文件夹）
 */
function countSubfoldersInTree(node) {
  const children = node.children || {};
  return Object.keys(children).length; // 只统计直接子文件夹数量，不递归
}

/**
 * 检查文件夹是否有内容（子文件夹或书签）
 * 只要有内容就可以展开，不限于子文件夹
 */
function checkFolderHasChildren(folderPath) {
  // 规范化文件夹路径
  const normalizedPath = normalizeFolderPath(folderPath || '');
  
  // 检查是否有书签（只要有书签就算有内容）
  const hasBookmarks = currentBookmarks.some(b => {
    const bFolder = normalizeFolderPath(b.folder || '');
    const matches = bFolder === normalizedPath;
    if (matches) {
      console.log('[文件夹检查] 找到书签:', { folderPath: normalizedPath, bookmarkTitle: b.title });
    }
    return matches;
  });
  
  console.log('[文件夹检查] 检查文件夹:', { folderPath: normalizedPath, hasBookmarks, totalBookmarks: currentBookmarks.length });
  
  // 合并所有文件夹（包括从书签中提取的）
  const bookmarkFolders = [...new Set(currentBookmarks.map(b => b.folder).filter(f => f))];
  const allFolders = [...new Set([...currentFolders, ...bookmarkFolders])];
  
  // 构建临时树结构来检查是否有子文件夹
  const tree = buildFolderTree(allFolders);
  
  // 如果 folderPath 为空，检查根节点
  if (!normalizedPath) {
    const hasSubfolders = Object.keys(tree.children || {}).length > 0;
    const result = hasSubfolders || hasBookmarks;
    console.log('[文件夹检查] 根节点检查:', { hasSubfolders, hasBookmarks, result });
    return result;
  }
  
  // 查找对应的节点
  const parts = normalizedPath.split('/');
  let node = tree;
  for (const part of parts) {
    if (!node.children || !node.children[part]) {
      // 如果找不到节点，只检查是否有书签
      console.log('[文件夹检查] 找不到节点，只检查书签:', { folderPath: normalizedPath, hasBookmarks });
      return hasBookmarks;
    }
    node = node.children[part];
  }
  
  // 检查该节点是否有子文件夹
  const hasSubfolders = Object.keys(node.children || {}).length > 0;
  const result = hasSubfolders || hasBookmarks;
  
  console.log('[文件夹检查] 最终结果:', { folderPath: normalizedPath, hasSubfolders, hasBookmarks, result });
  
  // 只要有子文件夹或书签，就算有内容
  return result;
}

/**
 * 加载文件夹展开状态（从本地存储）
 */
async function loadFolderState() {
  try {
    const storageAPI = typeof browser !== 'undefined' ? browser.storage : chrome.storage;
    const result = typeof browser !== 'undefined' && browser.storage
      ? await browser.storage.local.get(['bookmarksPageFolderState'])
      : await new Promise(resolve => {
          chrome.storage.local.get(['bookmarksPageFolderState'], resolve);
        });
    const state = result && result.bookmarksPageFolderState;

    if (state && Array.isArray(state.expanded) && state.expanded.length) {
      expandedFolders = new Set(state.expanded);
      if (!expandedFolders.has('')) expandedFolders.add(''); // 保证根存在
      // 如果只有根节点，允许按默认规则展开第一层
      if (expandedFolders.size === 1) {
        foldersInitialized = false; // 允许初始化时展开第一层
      } else {
        foldersInitialized = true; // 已有展开状态，不再自动展开
      }
    } else {
      expandedFolders = new Set(['']);
      foldersInitialized = false; // 首次加载，允许初始化时展开第一层
    }
  } catch (e) {
    expandedFolders = new Set(['']);
    foldersInitialized = false;
  }
}

/**
 * 保存文件夹展开状态（到本地存储）
 */
function saveFolderState() {
  try {
    const expanded = Array.from(expandedFolders);
    const storageAPI = typeof browser !== 'undefined' ? browser.storage : chrome.storage;
    const state = {
      bookmarksPageFolderState: {
        expanded
      }
    };
    if (typeof browser !== 'undefined' && browser.storage) {
      // Firefox: 使用 Promise
      browser.storage.local.set(state);
    } else {
      // Chrome/Edge: 使用回调
      chrome.storage.local.set(state, () => {});
    }
  } catch (e) {
    console.warn('保存文件夹展开状态失败', e);
  }
}

/**
 * 加载文件夹列表
 */
async function loadFolders() {
  // 统计每个文件夹下的书签数量，并预先按文件夹分组书签（用于性能优化）
  const folderCountMap = new Map();
  const folderBookmarksMap = new Map(); // 按文件夹路径分组书签
  currentBookmarks.forEach(b => {
    const folder = normalizeFolderPath(b.folder || '');
    if (!folder) return;
    folderCountMap.set(folder, (folderCountMap.get(folder) || 0) + 1);
    if (!folderBookmarksMap.has(folder)) {
      folderBookmarksMap.set(folder, []);
    }
    folderBookmarksMap.get(folder).push(b);
  });

  // 合并文件夹列表：保留 currentFolders 中的所有文件夹（包括空文件夹），并添加从书签中提取的文件夹
  // 保持 currentFolders 的顺序，然后添加不在其中的文件夹
  const bookmarkFolders = Array.from(folderCountMap.keys());
  // 规范化 currentFolders 并保持顺序
  const normalizedCurrentFolders = currentFolders.map(normalizeFolderPath).filter(f => f);
  const normalizedCurrentFoldersSet = new Set(normalizedCurrentFolders);
  // 规范化 bookmarkFolders 并过滤掉已在 currentFolders 中的
  const normalizedBookmarkFolders = bookmarkFolders
    .map(normalizeFolderPath)
    .filter(f => f && !normalizedCurrentFoldersSet.has(f));
  // 合并：先保留 currentFolders 的顺序，然后添加新文件夹
  const folders = [...normalizedCurrentFolders, ...normalizedBookmarkFolders];

  const tree = buildFolderTree(folders);

  // 只有当前场景下存在“未分类”书签时，才显示一个虚拟的“未分类”入口
  const uncategorizedCount = currentBookmarks.filter(b => !b.folder).length;
  let html = '';
  if (uncategorizedCount > 0) {
    html += `
      <ul class="folder-tree">
        <li class="folder-node">
          <div class="folder-row" data-folder="">
            <span class="folder-label" data-folder="" title="未分类">
              <span class="folder-label-text">📁 未分类</span>
              <span class="folder-count">${uncategorizedCount}</span>
            </span>
          </div>
        </li>
      </ul>
    `;
  }

  html += renderFolderTree(tree.children, folderCountMap, tree, folderBookmarksMap);
  foldersList.innerHTML = html;
  
  // 初始化时，如果 expandedFolders 只有根节点且未初始化过，默认展开所有第一层文件夹
  if (!foldersInitialized && expandedFolders.size === 1 && expandedFolders.has('')) {
    const firstLevelFolders = Object.keys(tree.children || {});
    firstLevelFolders.forEach(key => {
      const child = tree.children[key];
      if (child && child.path) {
        // 完全按照弹窗逻辑：直接使用 child.path，不做规范化
        expandedFolders.add(child.path);
      }
    });
    // 如果添加了第一层文件夹，重新渲染
    if (firstLevelFolders.length > 0) {
      html = '';
      if (uncategorizedCount > 0) {
        html += `
          <ul class="folder-tree">
            <li class="folder-node">
              <div class="folder-row" data-folder="">
                <span class="folder-label" data-folder="" title="未分类">
                  <span class="folder-label-text">📁 未分类</span>
                  <span class="folder-count">${uncategorizedCount}</span>
                </span>
              </div>
            </li>
          </ul>
        `;
      }
      html += renderFolderTree(tree.children, folderCountMap, tree, folderBookmarksMap);
      foldersList.innerHTML = html;
      // 保存自动展开的第一层文件夹状态
      saveFolderState();
    }
    foldersInitialized = true; // 标记已初始化
  }

  // 绑定点击事件（筛选和展开/折叠）
  // 移动端：点击文件夹只筛选，不展开；桌面端：点击文件夹既展开又筛选
  foldersList.querySelectorAll('.folder-row').forEach(row => {
    row.addEventListener('click', async (e) => {
      // 如果点击的是操作按钮，不处理
      if (e.target.closest('.folder-menu')) {
        return;
      }
      // 如果点击的是展开/折叠按钮，不处理（由单独的事件处理）
      if (e.target.closest('.folder-expand-toggle')) {
        return;
      }
      // 如果点击的是文件夹中的书签链接，不处理（避免事件冒泡）
      if (e.target.closest('.bookmark-in-folder')) {
        return;
      }
      
      // 获取文件夹路径（从 dataset 中读取，确保与渲染时使用的路径一致）
      const folderPath = row.dataset.folder || '';
      const isMobile = window.innerWidth <= 768;
      console.log('[文件夹点击] 点击文件夹:', { folderPath, isMobile, expandedFoldersBefore: Array.from(expandedFolders) });
      
      // 保存文件夹路径用于后续筛选（在重新渲染前保存）
      const normalizedFolderPath = normalizeFolderPath(folderPath);
      
      if (isMobile) {
        // 移动端：只执行筛选操作，不展开/折叠文件夹树
        // 设置筛选
        currentFilter = 'folder:' + normalizedFolderPath;
        console.log('[文件夹点击] 移动端设置筛选:', { folderPath, normalizedFolderPath, currentFilter });
        
        // 更新激活状态
        foldersList.querySelectorAll('.folder-label').forEach(i => i.classList.remove('active'));
        const label = row.querySelector('.folder-label');
        if (label) {
          label.classList.add('active');
        }
        
        // 渲染书签列表
        renderBookmarks();
        
        // 关闭侧边栏
        closeSidebarIfMobile();
      } else {
        // 桌面端：既展开又筛选（保持原有行为）
        // 切换展开/折叠状态
        if (expandedFolders.has(folderPath)) {
          expandedFolders.delete(folderPath);
          console.log('[文件夹点击] 桌面端折叠:', { folderPath, expandedFoldersAfter: Array.from(expandedFolders) });
        } else {
          expandedFolders.add(folderPath);
          console.log('[文件夹点击] 桌面端展开:', { folderPath, expandedFoldersAfter: Array.from(expandedFolders) });
        }
        
        // 保存展开状态到本地存储
        saveFolderState();
        
        // 重新渲染文件夹树
        await loadFolders();
        console.log('[文件夹点击] 桌面端渲染完成，验证展开状态:', { folderPath, isExpanded: expandedFolders.has(folderPath), expandedFolders: Array.from(expandedFolders) });
        
        // 同时执行筛选操作
        const escapedPath = folderPath.replace(/"/g, '\\"');
        const newRow = foldersList.querySelector(`[data-folder="${escapedPath}"]`);
        if (newRow) {
          const label = newRow.querySelector('.folder-label');
          if (label) {
            foldersList.querySelectorAll('.folder-label').forEach(i => i.classList.remove('active'));
            label.classList.add('active');
          }
        }
        currentFilter = 'folder:' + normalizedFolderPath;
        console.log('[文件夹点击] 桌面端设置筛选:', { folderPath, normalizedFolderPath, currentFilter });
        renderBookmarks();
      }
    });
  });
  
  // 绑定展开/折叠按钮点击事件（移动端和桌面端都可用）
  foldersList.querySelectorAll('.folder-expand-toggle').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation(); // 阻止事件冒泡到文件夹行
      const folderPath = btn.dataset.folder || '';
      console.log('[展开/折叠按钮] 点击:', { folderPath, expandedFoldersBefore: Array.from(expandedFolders) });
      
      // 切换展开/折叠状态
      if (expandedFolders.has(folderPath)) {
        expandedFolders.delete(folderPath);
        console.log('[展开/折叠按钮] 折叠:', { folderPath });
      } else {
        expandedFolders.add(folderPath);
        console.log('[展开/折叠按钮] 展开:', { folderPath });
      }
      
      // 保存展开状态到本地存储
      saveFolderState();
      
      // 重新渲染文件夹树
      await loadFolders();
    });
  });

  // 拖拽排序
  foldersList.querySelectorAll('.folder-row').forEach(row => {
    row.setAttribute('draggable', 'true');
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', row.dataset.folder);
    });
    row.addEventListener('dragover', (e) => e.preventDefault());
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      const source = e.dataTransfer.getData('text/plain');
      const target = row.dataset.folder;
      if (!source || !target || source === target) return;
      reorderFolder(source, target);
      await storage.saveBookmarks(currentBookmarks, currentFolders, currentSceneId);
      await syncToCloud();
      await loadFolders();
      await loadTags();
    });
  });

  // 绑定文件夹操作菜单
  foldersList.querySelectorAll('.folder-menu').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const folderPath = btn.dataset.folder;
      openFolderMenu(btn, folderPath);
    });
  });

  // 绑定上下移动按钮（同级排序）
  foldersList.querySelectorAll('.folder-move').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const folder = btn.dataset.folder;
      const dir = btn.dataset.dir === 'up' ? -1 : 1;
      const moved = moveFolderSameLevel(folder, dir);
      if (!moved) return;
      await storage.saveBookmarks(currentBookmarks, currentFolders, currentSceneId);
      await syncToCloud();
      await loadFolders();
      await loadTags();
    });
  });

  // 绑定文件夹中书签的点击事件
  foldersList.querySelectorAll('.bookmark-in-folder a').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation(); // 阻止事件冒泡到文件夹行
      const url = link.closest('.bookmark-in-folder')?.dataset.url;
      if (url) {
        tabsAPI.create({ url });
      }
    });
  });
}

/**
 * 构建树结构（保持文件夹顺序）
 */
function buildFolderTree(folders) {
  const root = { name: '', path: '', children: {}, order: [] };
  folders.forEach(folder => {
    // 确保路径是规范化的（虽然传入的应该已经是规范化的，但为了安全再次规范化）
    const normalizedFolder = normalizeFolderPath(folder);
    if (!normalizedFolder) return;
    
    const parts = normalizedFolder.split('/');
    let node = root;
    let currentPath = '';
    parts.forEach(part => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!node.children[part]) {
        node.children[part] = { name: part, path: currentPath, children: {}, order: [] };
        // 维护子节点的顺序
        node.order.push(part);
      }
      node = node.children[part];
    });
  });
  return root;
}

/**
 * 渲染树结构为HTML（保持文件夹顺序，支持折叠/展开）
 * @param {Object} children - 子节点对象
 * @param {Map} folderCountMap - 文件夹书签数量映射
 * @param {Object} rootNode - 根节点
 * @param {Map} folderBookmarksMap - 按文件夹路径分组的书签映射（用于性能优化）
 */
function renderFolderTree(children, folderCountMap = new Map(), rootNode = null, folderBookmarksMap = new Map()) {
  // 如果没有 order 数组，回退到 Object.values（兼容旧代码）
  const entries = rootNode && rootNode.order 
    ? rootNode.order.map(key => children[key]).filter(Boolean)
    : Object.values(children);
  if (entries.length === 0) return '';

  return `
    <ul class="folder-tree">
      ${entries.map(child => {
        // 统计：书签数量 + 子文件夹数量
        const bookmarkCount = folderCountMap.get(child.path) || 0;
        const subfolderCount = countSubfoldersInTree(child);
        const totalCount = bookmarkCount + subfolderCount;
        // 检查是否有子文件夹（仅用于决定是否显示子文件夹内容）
        const hasSubfolders = Object.keys(child.children).length > 0;
        // 检查展开状态：只要 expandedFolders 中包含该路径，就展开，不管是否有子文件夹或书签
        const expanded = expandedFolders.has(child.path);
        
        // 根据展开状态选择图标（展开用📂，折叠用📁）
        const icon = expanded ? '📂' : '📁';
        
        // 展开时，获取该文件夹下的书签并渲染
        let bookmarksHtml = '';
        if (expanded && bookmarkCount > 0) {
          // 从预构建的 Map 中获取书签（性能优化：避免每次展开都过滤所有书签）
          const normalizedPath = normalizeFolderPath(child.path);
          const folderBookmarks = folderBookmarksMap.get(normalizedPath) || [];
          
          // 渲染书签列表
          bookmarksHtml = folderBookmarks.map(b => `
            <li class="bookmark-in-folder" data-url="${escapeHtml(b.url)}">
              <a href="${escapeHtml(b.url)}" target="_blank" title="${escapeHtml(b.title || b.url)}">
                <span class="bookmark-title">${escapeHtml(b.title || '无标题')}</span>
                <span class="bookmark-url">${escapeHtml(b.url)}</span>
              </a>
            </li>
          `).join('');
        }
        
        // 展开时显示子文件夹内容
        const childContent = expanded ? renderFolderTree(child.children, folderCountMap, child, folderBookmarksMap) : '';
        
        // 只要展开就显示内容区域：先显示书签，再显示子文件夹
        const expandedContent = expanded ? `
          ${bookmarksHtml ? `<ul class="bookmarks-in-folder">${bookmarksHtml}</ul>` : ''}
          ${hasSubfolders ? childContent : (bookmarksHtml ? '' : '<ul class="folder-tree"></ul>')}
        ` : '';
        
        return `
        <li class="folder-node">
          <div class="folder-row" data-folder="${escapeHtml(child.path)}">
            <span class="folder-label" data-folder="${escapeHtml(child.path)}" title="${escapeHtml(child.path)}">
              <span class="folder-label-text">${icon} ${escapeHtml(child.name)}</span>
              <span class="folder-count">${totalCount}</span>
            </span>
            <div class="folder-actions">
              <button class="folder-expand-toggle" data-folder="${escapeHtml(child.path)}" title="${expanded ? '折叠' : '展开'}">
                ${expanded ? '▼' : '▶'}
              </button>
              <button class="folder-menu" data-folder="${escapeHtml(child.path)}" title="操作">⋯</button>
            </div>
          </div>
          ${expandedContent}
        </li>
      `;
      }).join('')}
    </ul>
  `;
}

/**
 * 重命名文件夹（包含子文件夹）
 */
async function renameFolderPath(oldPath, newPath) {
  if (currentBookmarks.some(b => b.folder === newPath)) {
    const proceed = confirm('目标路径已存在同名文件夹，是否继续移动？');
    if (!proceed) return;
  }

  currentBookmarks = currentBookmarks.map(b => {
    if (!b.folder) return b;
    if (b.folder === oldPath) {
      return { ...b, folder: newPath };
    }
    if (b.folder.startsWith(oldPath + '/')) {
      const suffix = b.folder.slice(oldPath.length);
      return { ...b, folder: newPath + suffix };
    }
    return b;
  });
  
  // 更新文件夹列表：保留所有现有文件夹（包括空文件夹），并更新重命名的文件夹路径
  const bookmarkFolders = [...new Set(currentBookmarks.map(b => b.folder).filter(f => f))];
  currentFolders = currentFolders.map(f => {
    if (f === oldPath) {
      return newPath; // 重命名文件夹
    }
    if (f.startsWith(oldPath + '/')) {
      return newPath + f.slice(oldPath.length); // 重命名子文件夹
    }
    return f; // 保留其他文件夹
  });
  // 合并：更新后的文件夹列表 + 从书签中提取的文件夹（确保不丢失）
  currentFolders = [...new Set([...currentFolders, ...bookmarkFolders])];
  
  await storage.saveBookmarks(currentBookmarks, currentFolders, currentSceneId);
  await syncToCloud();
}

/**
 * 新增文件夹
 */
async function handleAddFolder() {
  const path = prompt('请输入文件夹路径（用/分隔，如：项目/前端/UI）') || '';
  const normalized = normalizeFolderPath(path);
  if (!normalized) return;
  if (currentFolders.includes(normalized)) {
    alert('该文件夹已存在');
    return;
  }
  currentFolders.push(normalized);
  currentFolders = [...new Set(currentFolders)];
  await storage.saveBookmarks(currentBookmarks, currentFolders, currentSceneId);
  await syncToCloud();
  await loadFolders();
  await loadTags();
}

/**
 * 删除文件夹（删除其下书签）
 */
async function deleteFolderPath(folderPath) {
  // 删除该文件夹及子文件夹下的书签
  currentBookmarks = currentBookmarks.filter(b => {
    if (!b.folder) return true;
    if (b.folder === folderPath || b.folder.startsWith(folderPath + '/')) {
      return false; // 删除书签
    }
    return true;
  });
  // 删除文件夹记录
  currentFolders = currentFolders.filter(f => f !== folderPath && !f.startsWith(folderPath + '/'));
  await storage.saveBookmarks(currentBookmarks, currentFolders, currentSceneId);
  await syncToCloud();
}

/**
 * 打开文件夹操作菜单
 */
function openFolderMenu(anchorBtn, folderPath) {
  // 关闭已有
  const existing = document.querySelector('.folder-menu-popup');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.className = 'folder-menu-popup';
  menu.innerHTML = `
    <div class="folder-menu-item" data-action="add">
      <span style="font-size: 16px;">📁</span>
      <span>新增子文件夹</span>
    </div>
    <div class="folder-menu-item" data-action="rename">
      <span style="font-size: 16px;">✏️</span>
      <span>重命名/移动</span>
    </div>
    <div class="folder-menu-item" data-action="move-up">
      <span style="font-size: 16px;">⬆️</span>
      <span>上移（同层级）</span>
    </div>
    <div class="folder-menu-item" data-action="move-down">
      <span style="font-size: 16px;">⬇️</span>
      <span>下移（同层级）</span>
    </div>
    <div style="height: 1px; background: #e0e0e0; margin: 6px 0;"></div>
    <div class="folder-menu-item danger" data-action="delete">
      <span style="font-size: 16px;">🗑️</span>
      <span>删除文件夹（含书签）</span>
    </div>
  `;

  document.body.appendChild(menu);
  const rect = anchorBtn.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  
  // 计算菜单位置，确保不会超出视口
  let top = rect.bottom + window.scrollY + 4;
  let left = rect.left + window.scrollX - 40;
  
  // 检查右边界
  if (left + menuRect.width > window.innerWidth) {
    left = window.innerWidth - menuRect.width - 10;
  }
  
  // 检查下边界
  if (top + menuRect.height > window.innerHeight + window.scrollY) {
    top = rect.top + window.scrollY - menuRect.height - 4;
  }
  
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;

  const closeMenu = (e) => {
    if (!menu.contains(e.target) && e.target !== anchorBtn) {
      menu.remove();
      document.removeEventListener('click', closeMenu);
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu), 0);

  menu.querySelectorAll('.folder-menu-item').forEach(item => {
    item.addEventListener('click', async () => {
      const action = item.dataset.action;
      if (action === 'add') {
        const name = prompt('请输入子文件夹名称', '');
        if (!name || !name.trim()) return;
        const newPath = normalizeFolderPath(folderPath ? `${folderPath}/${name}` : name);
        if (!newPath) return;
        if (currentFolders.includes(newPath)) {
          alert('该文件夹已存在');
          return;
        }
        currentFolders.push(newPath);
        currentFolders = [...new Set(currentFolders)]; // 去重但保持顺序（不排序，保持用户设置的顺序）
        await storage.saveBookmarks(currentBookmarks, currentFolders, currentSceneId);
        await syncToCloud();
        await loadFolders();
        await loadTags();
      } else if (action === 'rename') {
        const newPath = prompt('输入新路径（支持修改父级，用/分隔，例如：项目/前端/UI）', folderPath) || '';
        const normalized = normalizeFolderPath(newPath);
        if (!normalized) return;
        if (normalized === folderPath) return;
        await renameFolderPath(folderPath, normalized);
        await loadBookmarks();
        await loadFolders();
        await loadTags();
      } else if (action === 'move-up' || action === 'move-down') {
        const dir = action === 'move-up' ? -1 : 1;
        const moved = moveFolderSameLevel(folderPath, dir);
        if (!moved) return;
        await storage.saveBookmarks(currentBookmarks, currentFolders, currentSceneId);
        await syncToCloud();
        await loadFolders();
        await loadTags();
      } else if (action === 'delete') {
        const ok = confirm(`确定删除文件夹「${folderPath}」？该文件夹及其中书签将被删除。`);
        if (!ok) return;
        await deleteFolderPath(folderPath);
        await loadBookmarks();
        await loadFolders();
        await loadTags();
      }
      menu.remove();
      document.removeEventListener('click', closeMenu);
    });
  });
}

/**
 * 重排文件夹顺序（保持路径不变，仅排序）
 */
function reorderFolder(source, target) {
  const srcIdx = currentFolders.indexOf(source);
  const tgtIdx = currentFolders.indexOf(target);
  if (srcIdx === -1 || tgtIdx === -1) return;
  const newOrder = [...currentFolders];
  newOrder.splice(srcIdx, 1);
  newOrder.splice(tgtIdx, 0, source);
  currentFolders = newOrder;
}

function moveFolderSameLevel(folderPath, direction) {
  const parent = getParentFolder(folderPath);
  const siblingIndices = [];
  currentFolders.forEach((f, idx) => {
    if (getParentFolder(f) === parent) siblingIndices.push(idx);
  });
  const currentIdx = currentFolders.indexOf(folderPath);
  const pos = siblingIndices.indexOf(currentIdx);
  if (pos === -1) return false;
  const targetPos = pos + direction;
  if (targetPos < 0 || targetPos >= siblingIndices.length) return false;
  const swapIdx = siblingIndices[targetPos];
  const newOrder = [...currentFolders];
  [newOrder[currentIdx], newOrder[swapIdx]] = [newOrder[swapIdx], newOrder[currentIdx]];
  currentFolders = newOrder;
  return true;
}

function getParentFolder(path) {
  if (!path || path.indexOf('/') === -1) return '';
  return path.slice(0, path.lastIndexOf('/'));
}

/**
 * 加载标签列表
 */
async function loadTags() {
  const allTags = [];
  currentBookmarks.forEach(bookmark => {
    if (bookmark.tags && Array.isArray(bookmark.tags)) {
      allTags.push(...bookmark.tags);
    }
  });
  
  const uniqueTags = [...new Set(allTags)];
  uniqueTags.sort();
  
  tagsList.innerHTML = uniqueTags.map(tag => `
    <div class="tag-item" data-tag="${escapeHtml(tag)}">
      <span>#</span>
      <span>${escapeHtml(tag)}</span>
    </div>
  `).join('');
  
  tagsList.querySelectorAll('.tag-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.tag-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      currentFilter = 'tag:' + item.dataset.tag;
      renderBookmarks();
      closeSidebarIfMobile();
    });
  });
}

/**
 * 渲染书签列表
 */
function renderBookmarks() {
  let filtered = [...currentBookmarks];
  
  // 应用筛选
  if (currentFilter === 'starred') {
    filtered = filtered.filter(b => b.starred);
  } else if (currentFilter === 'recent') {
    filtered = filtered.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 20);
  } else if (currentFilter.startsWith('folder:')) {
    const folder = currentFilter.replace('folder:', '');
    if (folder) {
      // 正常文件夹：匹配指定路径（确保路径规范化）
      const normalizedFolder = normalizeFolderPath(folder);
      filtered = filtered.filter(b => {
        const bFolder = normalizeFolderPath(b.folder || '');
        return bFolder === normalizedFolder;
      });
    } else {
      // 特殊情况：未分类入口，筛选没有folder字段的书签
      filtered = filtered.filter(b => !b.folder);
    }
  } else if (currentFilter.startsWith('tag:')) {
    const tag = currentFilter.replace('tag:', '');
    filtered = filtered.filter(b => b.tags && b.tags.includes(tag));
  }
  
  // 应用搜索
  const query = searchInput.value.trim();
  if (query) {
    filtered = searchBookmarks(filtered, query);
  }
  
  // 应用排序
  filtered.sort((a, b) => {
    switch (currentSort) {
      case 'created-desc':
        return (b.createdAt || 0) - (a.createdAt || 0);
      case 'created-asc':
        return (a.createdAt || 0) - (b.createdAt || 0);
      case 'title-asc':
        return (a.title || '').localeCompare(b.title || '');
      case 'title-desc':
        return (b.title || '').localeCompare(a.title || '');
      case 'starred':
        if (a.starred && !b.starred) return -1;
        if (!a.starred && b.starred) return 1;
        return (b.createdAt || 0) - (a.createdAt || 0);
      default:
        return 0;
    }
  });
  
  // 渲染
  if (filtered.length === 0) {
    bookmarksGrid.innerHTML = '';
    emptyState.style.display = 'block';
  } else {
    emptyState.style.display = 'none';
    bookmarksGrid.innerHTML = filtered.map(bookmark => renderBookmarkCard(bookmark)).join('');
    
    // 添加事件监听
    bookmarksGrid.querySelectorAll('.bookmark-card').forEach(card => {
      const bookmarkId = card.dataset.id;
      const bookmark = currentBookmarks.find(b => b.id === bookmarkId);
      
      // 处理 favicon 图片加载错误（Firefox CSP 要求，不能使用内联 onerror）
      const faviconImg = card.querySelector('.bookmark-favicon[data-fallback-icon]');
      if (faviconImg) {
        faviconImg.addEventListener('error', function() {
          this.src = 'data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27%3E%3Cpath fill=%27%23999%27 d=%27M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z%27/%3E%3C/svg%3E';
        });
      }
      
      // 批量选择模式
      if (batchMode) {
        const checkbox = card.querySelector('.bookmark-select-checkbox');
        if (checkbox) {
          checkbox.addEventListener('change', (e) => {
            e.stopPropagation();
            if (checkbox.checked) {
              selectedBookmarkIds.add(bookmarkId);
            } else {
              selectedBookmarkIds.delete(bookmarkId);
            }
            updateSelectedCount();
          });
        }
        // 批量模式下点击卡片切换选择状态
        card.addEventListener('click', (e) => {
          if (e.target.type !== 'checkbox' && !e.target.closest('.bookmark-checkbox')) {
            const checkbox = card.querySelector('.bookmark-select-checkbox');
            if (checkbox) {
              checkbox.checked = !checkbox.checked;
              checkbox.dispatchEvent(new Event('change'));
            }
          }
        });
      } else {
        // 正常模式
        // 点击卡片打开网站
        card.querySelector('.bookmark-info').addEventListener('click', () => {
          tabsAPI.create({ url: bookmark.url });
        });
        
        // 收藏/取消收藏
        const starBtn = card.querySelector('.bookmark-star');
        if (starBtn) {
          starBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleStar(bookmarkId);
          });
        }
        
        // 编辑
        const editBtn = card.querySelector('.edit-btn');
        if (editBtn) {
          editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            showEditForm(bookmark);
          });
        }
        
        // 删除
        const deleteBtn = card.querySelector('.delete-btn');
        if (deleteBtn) {
          deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteBookmark(bookmarkId);
          });
        }
      }
    });
  }
}

/**
 * 渲染单个书签卡片
 */
function renderBookmarkCard(bookmark) {
  const favicon = bookmark.favicon || bookmark.icon || getFaviconUrl(bookmark.url);
  const domain = getDomain(bookmark.url);
  const isSelected = selectedBookmarkIds.has(bookmark.id);
  
  return `
    <div class="bookmark-card ${bookmark.starred ? 'starred' : ''} ${isSelected ? 'selected' : ''}" data-id="${bookmark.id}">
      ${batchMode ? `
        <div class="bookmark-checkbox">
          <input type="checkbox" class="bookmark-select-checkbox" data-id="${bookmark.id}" ${isSelected ? 'checked' : ''}>
        </div>
      ` : ''}
      <div class="bookmark-actions" style="${batchMode ? 'display: none;' : ''}">
        <button class="action-btn edit-btn" title="编辑">✏️</button>
        <button class="action-btn delete-btn" title="删除">🗑️</button>
      </div>
      <div class="bookmark-header">
        ${viewOptions.showIcon ? `<img src="${favicon}" alt="" class="bookmark-favicon" data-fallback-icon>` : ''}
        <div class="bookmark-info">
          <div class="bookmark-title">${escapeHtml(bookmark.title || '无标题')}</div>
          ${viewOptions.showUrl ? `<div class="bookmark-url">${escapeHtml(domain || bookmark.url)}</div>` : ''}
        </div>
        <div class="bookmark-star">${bookmark.starred ? '⭐' : '☆'}</div>
      </div>
      ${viewOptions.showDescription && bookmark.description ? `<div class="bookmark-description">${escapeHtml(bookmark.description)}</div>` : ''}
      ${viewOptions.showNotes && bookmark.notes ? `<div class="bookmark-notes">📝 ${escapeHtml(bookmark.notes)}</div>` : ''}
      ${viewOptions.showFolder ? `<div class="bookmark-folder">📁 ${bookmark.folder ? escapeHtml(bookmark.folder) : '未分类'}</div>` : ''}
      ${viewOptions.showTags && bookmark.tags && bookmark.tags.length > 0 ? `
        <div class="bookmark-tags">
          ${bookmark.tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

/**
 * 显示添加表单
 */
function showAddForm(data = {}) {
  // 清除可能存在的自动关闭定时器
  if (autoCloseTimer) {
    clearTimeout(autoCloseTimer);
    autoCloseTimer = null;
  }
  
  editingBookmarkId = null;
  document.getElementById('modalTitle').textContent = '添加书签';
  bookmarkForm.reset();
  
  if (data.url) {
    document.getElementById('bookmarkUrl').value = data.url;
  }
  if (data.title) {
    document.getElementById('bookmarkTitle').value = data.title;
  }
  
  // 加载文件夹选项
  loadFolderOptions();
  
  bookmarkModal.style.display = 'flex';
}

/**
 * 显示编辑表单
 */
function showEditForm(bookmark) {
  // 清除可能存在的自动关闭定时器
  if (autoCloseTimer) {
    clearTimeout(autoCloseTimer);
    autoCloseTimer = null;
  }
  
  editingBookmarkId = bookmark.id;
  document.getElementById('modalTitle').textContent = '编辑书签';
  
  document.getElementById('bookmarkTitle').value = bookmark.title || '';
  document.getElementById('bookmarkUrl').value = bookmark.url || '';
  document.getElementById('bookmarkDescription').value = bookmark.description || '';
  document.getElementById('bookmarkNotes').value = bookmark.notes || '';
  document.getElementById('bookmarkTags').value = bookmark.tags ? bookmark.tags.join(', ') : '';
  document.getElementById('bookmarkStarred').checked = bookmark.starred || false;
  
  loadFolderOptions(bookmark.folder);
  
  bookmarkModal.style.display = 'flex';
}

/**
 * 构建文件夹树结构
 */
function buildFolderTreeForSelect(folders) {
  const root = { name: '', path: '', children: {} };
  folders.forEach(folder => {
    const parts = folder.split('/');
    let node = root;
    let currentPath = '';
    parts.forEach(part => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!node.children[part]) {
        node.children[part] = { name: part, path: currentPath, children: {} };
      }
      node = node.children[part];
    });
  });
  return root;
}

/**
 * 渲染文件夹树为选项HTML（带缩进）
 */
function renderFolderTreeOptions(node, level = 0, selected = '') {
  let html = '';
  const indent = '&nbsp;&nbsp;&nbsp;&nbsp;'.repeat(level);
  const icon = level === 0 ? '' : '📁';
  
  // 渲染当前节点（如果不是根节点）
  if (level > 0) {
    const isSelected = node.path === selected;
    html += `<option value="${escapeHtml(node.path)}" ${isSelected ? 'selected' : ''}>${indent}${icon} ${escapeHtml(node.name)}</option>`;
  }
  
  // 递归渲染子节点
  const children = Object.values(node.children).sort((a, b) => a.name.localeCompare(b.name));
  children.forEach(child => {
    html += renderFolderTreeOptions(child, level + 1, selected);
  });
  
  return html;
}

/**
 * 加载文件夹选项（优化版：树形结构）
 * 包含从书签中提取的文件夹和 currentFolders 中的文件夹（确保空文件夹也能显示）
 */
function loadFolderOptions(selected = '') {
  const select = document.getElementById('bookmarkFolder');
  // 合并从书签中提取的文件夹和 currentFolders 中的文件夹
  const bookmarkFolders = [...new Set(currentBookmarks.map(b => b.folder).filter(f => f))];
  const allFolders = [...new Set([...bookmarkFolders, ...currentFolders])];
  allFolders.sort();
  
  // 构建树结构
  const tree = buildFolderTreeForSelect(allFolders);
  
  // 渲染选项
  let html = '<option value="">📁 未分类</option>';
  html += renderFolderTreeOptions(tree, 0, selected);
  
  select.innerHTML = html;
  
  // 如果指定了 selected，确保选中
  if (selected) {
    select.value = selected;
  }
  
  // 添加搜索功能（如果选项很多）
  if (allFolders.length > 10) {
    // 为 select 添加搜索提示
    select.title = '提示：可以输入关键词快速搜索文件夹';
    select.setAttribute('data-searchable', 'true');
  }
}

/**
 * 在添加书签表单中创建新文件夹
 * 新建文件夹时不同步云端，只在保存书签时同步
 */
async function handleCreateFolderInForm() {
  const select = document.getElementById('bookmarkFolder');
  if (!select) return;
  
  // 获取当前选择的文件夹路径（空字符串表示"未分类"）
  const currentSelectedPath = select.value.trim();
  
  // 显示创建文件夹对话框
  const result = await showCreateFolderDialog(currentSelectedPath);
  if (!result) {
    return; // 用户取消
  }
  
  const folderName = result.trim();
  if (!folderName) {
    return; // 输入为空
  }
  
  // 构建完整路径
  let newPath = '';
  if (currentSelectedPath) {
    // 在当前选择的文件夹下创建子文件夹
    newPath = normalizeFolderPath(`${currentSelectedPath}/${folderName}`);
  } else {
    // 在根目录创建（"未分类"下不能直接创建子文件夹，只能在根目录创建）
    newPath = normalizeFolderPath(folderName);
  }
  
  if (!newPath) {
    alert('文件夹路径不能为空');
    return;
  }
  
  // 检查文件夹是否已存在
  const existingFolders = [...new Set([
    ...currentBookmarks.map(b => b.folder).filter(f => f),
    ...currentFolders
  ])];
  
  if (existingFolders.includes(newPath)) {
    alert('该文件夹已存在');
    // 如果已存在，直接选中它
    loadFolderOptions(newPath);
    return;
  }
  
  // 添加到文件夹列表（不排序，保持添加顺序，但去重）
  if (!currentFolders.includes(newPath)) {
    currentFolders.push(newPath);
    currentFolders = [...new Set(currentFolders)];
    
    // 保存到本地并同步到云端（确保空文件夹不会丢失）
    await storage.saveBookmarks(currentBookmarks, currentFolders, currentSceneId);
    await syncToCloud();
    
    // 重新加载文件夹选项并自动选中新创建的文件夹
    loadFolderOptions(newPath);
    
    // 同时更新侧边栏的文件夹列表
    await loadFolders();
  } else {
    // 如果已存在，直接选中它
    loadFolderOptions(newPath);
  }
}

/**
 * 显示创建文件夹对话框
 */
function showCreateFolderDialog(currentSelectedPath) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2000;
      animation: fadeIn 0.2s ease-out;
    `;
    
    // 添加动画样式
    if (!document.getElementById('dialog-animations')) {
      const style = document.createElement('style');
      style.id = 'dialog-animations';
      style.textContent = `
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `;
      document.head.appendChild(style);
    }
    
    const dialog = document.createElement('div');
    dialog.className = 'dialog-container';
    // 检测是否为移动设备
    const isMobile = window.innerWidth <= 768;
    dialog.style.cssText = `
      background: #ffffff;
      border-radius: 12px;
      padding: ${isMobile ? '20px' : '24px'};
      width: ${isMobile ? '90%' : '480px'};
      max-width: 90%;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(0, 0, 0, 0.05);
      font-size: ${isMobile ? '16px' : '14px'};
      animation: slideUp 0.3s ease-out;
      position: relative;
    `;
    
    // 构建提示信息
    let title = '创建新文件夹';
    let hintText = '';
    let placeholderText = '';
    
    if (currentSelectedPath) {
      // 如果已选择了某个文件夹，在该文件夹下创建子文件夹
      title = '创建子文件夹';
      hintText = `将在「${escapeHtml(currentSelectedPath)}」下创建子文件夹`;
      placeholderText = '请输入子文件夹名称';
    } else {
      // 如果选择了"未分类"，在根目录创建新文件夹
      title = '创建新文件夹';
      hintText = '提示："未分类"不是真正的文件夹，新文件夹将在根目录创建。支持用 / 创建多级文件夹，如：项目/前端/UI';
      placeholderText = '请输入文件夹名称（支持用/创建多级）';
    }
    
    dialog.innerHTML = `
      <div style="margin-bottom: 20px;">
        <h3 style="margin: 0; font-size: ${isMobile ? '20px' : '18px'}; font-weight: 600; color: #1a1a1a; display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 24px;">📁</span>
          <span>${title}</span>
        </h3>
      </div>
      ${hintText ? `<div style="margin-bottom: 16px; padding: 12px; background: linear-gradient(135deg, #e3f2fd 0%, #f0f7ff 100%); border-left: 4px solid #2196f3; border-radius: 6px; font-size: ${isMobile ? '14px' : '13px'}; color: #1976d2; line-height: 1.6;">
        <span style="display: inline-block; margin-right: 6px;">💡</span>${hintText}
      </div>` : ''}
      <div style="margin-bottom: 20px;">
        <label style="display: block; margin-bottom: 8px; font-weight: 500; color: #333; font-size: ${isMobile ? '15px' : '14px'};">文件夹名称</label>
        <input type="text" id="createFolderNameInput" style="width: 100%; padding: ${isMobile ? '12px 14px' : '10px 12px'}; border: 2px solid #e0e0e0; border-radius: 8px; font-size: ${isMobile ? '16px' : '14px'}; box-sizing: border-box; transition: border-color 0.2s; outline: none;" placeholder="${placeholderText}" autocomplete="off">
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 24px;">
        <button id="createFolderCancelBtn" class="btn btn-secondary" style="min-width: ${isMobile ? '90px' : '80px'}; min-height: ${isMobile ? '44px' : '38px'}; font-size: ${isMobile ? '16px' : '14px'}; border-radius: 8px; font-weight: 500;">取消</button>
        <button id="createFolderOkBtn" class="btn btn-primary" style="min-width: ${isMobile ? '90px' : '80px'}; min-height: ${isMobile ? '44px' : '38px'}; font-size: ${isMobile ? '16px' : '14px'}; border-radius: 8px; font-weight: 500;">创建</button>
      </div>
    `;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const nameInput = dialog.querySelector('#createFolderNameInput');
    const cancelBtn = dialog.querySelector('#createFolderCancelBtn');
    const okBtn = dialog.querySelector('#createFolderOkBtn');

    // 输入框焦点样式
    nameInput.addEventListener('focus', () => {
      nameInput.style.borderColor = '#4a90e2';
      nameInput.style.boxShadow = '0 0 0 3px rgba(74, 144, 226, 0.1)';
    });
    nameInput.addEventListener('blur', () => {
      nameInput.style.borderColor = '#e0e0e0';
      nameInput.style.boxShadow = 'none';
    });

    const cleanup = () => {
      overlay.style.animation = 'fadeIn 0.2s ease-out reverse';
      setTimeout(() => overlay.remove(), 200);
      document.removeEventListener('keydown', onKeyDown);
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        cleanup();
        resolve(null);
      } else if (e.key === 'Enter' && e.ctrlKey) {
        // Ctrl+Enter 快速确认
        okBtn.click();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    cancelBtn.onclick = () => {
      cleanup();
      resolve(null);
    };

    okBtn.onclick = () => {
      const folderName = nameInput.value.trim();
      if (!folderName) {
        nameInput.style.borderColor = '#f44336';
        nameInput.focus();
        setTimeout(() => {
          nameInput.style.borderColor = '#e0e0e0';
        }, 2000);
        return;
      }
      cleanup();
      resolve(folderName);
    };

    // 点击背景关闭
    overlay.onclick = (e) => {
      if (e.target === overlay) {
        cleanup();
        resolve(null);
      }
    };

    nameInput.focus();
  });
}

/**
 * 隐藏模态框
 */
function hideModal() {
  // 清除自动关闭定时器
  if (autoCloseTimer) {
    clearTimeout(autoCloseTimer);
    autoCloseTimer = null;
  }
  bookmarkModal.style.display = 'none';
  editingBookmarkId = null;
  
  // 如果是从快捷键打开的，关闭整个页面
  if (pageSource === 'shortcut') {
    sendMessageCompat({ action: 'closeCurrentTab' }).catch(() => {
      try {
        window.close();
      } catch (e) {
        // 静默处理
      }
    });
  }
}

/**
 * 在模态框中显示成功消息
 */
function showSuccessInModal(message = '添加成功') {
  const modalBody = bookmarkForm;
  if (!modalBody) return;
  
  // 显示成功消息（替换表单内容）
  modalBody.innerHTML = `
    <div style="
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px 20px;
      text-align: center;
      min-height: 200px;
    ">
      <div style="
        font-size: 48px;
        margin-bottom: 16px;
        color: #198754;
      ">✓</div>
      <div style="
        font-size: 18px;
        font-weight: 500;
        color: #198754;
        margin-bottom: 20px;
      ">${escapeHtml(message)}</div>
      <button type="button" id="successCloseBtn" class="btn btn-primary" style="min-width: 100px;">
        关闭
      </button>
    </div>
  `;
  
  // 绑定关闭按钮事件
  const closeBtn = document.getElementById('successCloseBtn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      hideModal();
      // 如果是从弹窗/悬浮球/快捷键打开的，关闭页面
      if (pageSource === 'popup' || pageSource === 'floating-ball' || pageSource === 'shortcut') {
        sendMessageCompat({ action: 'closeCurrentTab' }).catch(() => {
          try {
            window.close();
          } catch (e) {
            // 静默处理
          }
        });
      }
    });
  }
}

/**
 * 处理表单提交
 */
async function handleSubmit(e) {
  e.preventDefault();
  
  const bookmark = {
    title: document.getElementById('bookmarkTitle').value.trim(),
    url: document.getElementById('bookmarkUrl').value.trim(),
    description: document.getElementById('bookmarkDescription').value.trim(),
    notes: document.getElementById('bookmarkNotes').value.trim(),
    tags: document.getElementById('bookmarkTags').value.split(',').map(t => t.trim()).filter(t => t),
    folder: document.getElementById('bookmarkFolder').value.trim() || undefined,
    starred: document.getElementById('bookmarkStarred').checked,
    favicon: getFaviconUrl(document.getElementById('bookmarkUrl').value),
    scene: currentSceneId || 'home', // 添加场景字段
    updatedAt: Date.now()
  };
  
  if (!bookmark.title || !bookmark.url) {
    alert('请填写标题和URL');
    return;
  }
  
  if (!isValidUrl(bookmark.url)) {
    alert('请输入有效的URL');
    return;
  }
  
  try {
    const isNewBookmark = !editingBookmarkId;
    
    if (editingBookmarkId) {
      // 更新
      const index = currentBookmarks.findIndex(b => b.id === editingBookmarkId);
      if (index !== -1) {
        bookmark.id = editingBookmarkId;
        bookmark.createdAt = currentBookmarks[index].createdAt;
        bookmark.scene = currentBookmarks[index].scene || currentSceneId || 'home'; // 保留原有场景
        currentBookmarks[index] = bookmark;
      }
    } else {
      // 新增
      bookmark.id = storage.generateId();
      bookmark.createdAt = Date.now();
      currentBookmarks.push(bookmark);
    }
    
    await storage.saveBookmarks(currentBookmarks, currentFolders, currentSceneId);
    
    // 同步到云端（同步当前场景的书签）
    await syncToCloud();
    
    await loadBookmarks();
    await loadFolders();
    await loadTags();
    
    // 不立即关闭模态框，先显示成功消息
    // 在模态框中显示成功提示
    showSuccessInModal('添加成功');
    
    // 如果是新增书签且是从弹窗/悬浮球/快捷键打开的，1.5秒后关闭页面
    if (isNewBookmark && (pageSource === 'popup' || pageSource === 'floating-ball' || pageSource === 'shortcut')) {
      autoCloseTimer = setTimeout(() => {
        // 先关闭模态框
        hideModal();
        // 通过消息让 background 关闭当前标签页
        sendMessageCompat({ action: 'closeCurrentTab' }).catch(() => {
          // 如果消息失败，尝试使用 window.close()（某些情况下可能有效）
          try {
            window.close();
          } catch (e) {
            // 如果都失败，静默处理
          }
        });
      }, 1500);
    } else if (isNewBookmark) {
      // 其他情况显示成功提示，1.5秒后关闭模态框
      autoCloseTimer = setTimeout(() => {
        hideModal();
      }, 1500);
    } else {
      // 编辑情况，直接关闭模态框
      hideModal();
    }
  } catch (error) {
    console.error('保存失败:', error);
    alert('保存失败: ' + error.message);
  }
}

/**
 * 切换收藏状态
 */
async function toggleStar(bookmarkId) {
  const bookmark = currentBookmarks.find(b => b.id === bookmarkId);
  if (bookmark) {
    bookmark.starred = !bookmark.starred;
    bookmark.updatedAt = Date.now();
    
    try {
      await storage.saveBookmarks(currentBookmarks, currentFolders, currentSceneId);
      await syncToCloud();
      renderBookmarks();
    } catch (error) {
      console.error('更新失败:', error);
    }
  }
}

/**
 * 删除书签
 */
async function deleteBookmark(bookmarkId) {
  if (!confirm('确定要删除这个书签吗？')) {
    return;
  }
  
  currentBookmarks = currentBookmarks.filter(b => b.id !== bookmarkId);
  
  try {
    await storage.saveBookmarks(currentBookmarks, currentFolders, currentSceneId);
    await syncToCloud();
    await loadBookmarks();
    await loadFolders();
    await loadTags();
  } catch (error) {
    console.error('删除失败:', error);
    alert('删除失败: ' + error.message);
  }
}

/**
 * 处理搜索
 */
function handleSearch() {
  renderBookmarks();
}

/**
 * 切换视图
 */
function toggleView() {
  console.log('[视图切换] toggleView 被调用，当前视图:', currentView);
  const oldView = currentView;
  currentView = currentView === 'grid' ? 'list' : 'grid';
  console.log('[视图切换] 新视图:', currentView, '旧视图:', oldView);
  
  try {
    applyViewMode();
    console.log('[视图切换] applyViewMode 执行完成');
    persistViewMode(); // 只保存到本地，不触发云端同步
    console.log('[视图切换] persistViewMode 执行完成');
  } catch (error) {
    console.error('[视图切换] 执行出错:', error);
  }
}

/**
 * 处理导出
 */
function handleExport() {
  const menu = document.createElement('div');
  menu.className = 'export-menu';
  menu.style.cssText = 'position: fixed; top: 60px; right: 20px; background: white; border: 1px solid #ddd; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); z-index: 1000; padding: 8px; min-width: 150px;';
  
  const jsonBtn = document.createElement('button');
  jsonBtn.textContent = '导出为JSON';
  jsonBtn.className = 'btn btn-secondary';
  jsonBtn.style.cssText = 'width: 100%; margin-bottom: 4px;';
  jsonBtn.onclick = () => {
    exportAsJson();
    menu.remove();
  };
  
  const htmlBtn = document.createElement('button');
  htmlBtn.textContent = '导出为HTML';
  htmlBtn.className = 'btn btn-secondary';
  htmlBtn.style.cssText = 'width: 100%;';
  htmlBtn.onclick = () => {
    exportAsHtml();
    menu.remove();
  };
  
  menu.appendChild(jsonBtn);
  menu.appendChild(htmlBtn);
  document.body.appendChild(menu);
  
  // 点击外部关闭
  setTimeout(() => {
    const closeMenu = (e) => {
      if (!menu.contains(e.target) && e.target !== exportBtn) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    };
    document.addEventListener('click', closeMenu);
  }, 0);
}

/**
 * 视图显示选项
 */
function handleViewOptions() {
  const menu = document.createElement('div');
  menu.className = 'export-menu';
  menu.style.cssText = 'position: fixed; top: 60px; right: 70px; background: white; border: 1px solid #ddd; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); z-index: 1000; padding: 8px; min-width: 160px;';

  const options = [
    { key: 'showIcon', label: '显示图标' },
    { key: 'showUrl', label: '显示URL' },
    { key: 'showDescription', label: '显示描述' },
    { key: 'showNotes', label: '显示备注' },
    { key: 'showTags', label: '显示标签' },
    { key: 'showFolder', label: '显示文件夹' }
  ];

  options.forEach(opt => {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 4px;cursor:pointer;';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = viewOptions[opt.key];
    checkbox.onchange = () => {
      viewOptions[opt.key] = checkbox.checked;
      renderBookmarks();
      persistSettings();
    };
    const text = document.createElement('span');
    text.textContent = opt.label;
    row.appendChild(checkbox);
    row.appendChild(text);
    menu.appendChild(row);
  });

  document.body.appendChild(menu);

  setTimeout(() => {
    const closeMenu = (e) => {
      if (!menu.contains(e.target) && e.target !== viewOptionsBtn) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    };
    document.addEventListener('click', closeMenu);
  }, 0);
}

function applyViewMode() {
  console.log('[视图切换] applyViewMode 被调用，currentView:', currentView);
  console.log('[视图切换] bookmarksGrid:', bookmarksGrid);
  console.log('[视图切换] viewToggle:', viewToggle);
  console.log('[视图切换] 窗口宽度:', window.innerWidth, '是否为移动端:', window.innerWidth <= 768);
  
  if (bookmarksGrid) {
    const newClassName = `bookmarks-grid view-${currentView}`;
    console.log('[视图切换] 设置 className:', newClassName);
    bookmarksGrid.className = newClassName;
    console.log('[视图切换] 实际 className:', bookmarksGrid.className);
    
    // 检查计算后的样式
    setTimeout(() => {
      const computedStyle = window.getComputedStyle(bookmarksGrid);
      const gridTemplateColumns = computedStyle.gridTemplateColumns;
      console.log('[视图切换] 计算后的 grid-template-columns:', gridTemplateColumns);
    }, 100);
  } else {
    console.error('[视图切换] bookmarksGrid 元素未找到！');
  }
  
  if (viewToggle) {
    const newText = currentView === 'grid' ? '📋' : '⊞';
    console.log('[视图切换] 设置按钮文本:', newText);
    viewToggle.textContent = newText;
    console.log('[视图切换] 实际按钮文本:', viewToggle.textContent);
  } else {
    console.error('[视图切换] viewToggle 元素未找到！');
  }
}

/**
 * 加载非敏感设置（本地或云端同步后的本地）
 * 注意：viewMode 从本地存储读取，不从云端同步的设置中读取
 */
async function loadSettings() {
  try {
    const settings = await storage.getSettings();
    if (settings && settings.viewOptions) {
      viewOptions = { ...defaultViewOptions, ...settings.viewOptions };
    } else {
      viewOptions = { ...defaultViewOptions };
    }
    
    // viewMode 从本地存储读取，不从云端同步的设置中读取
    let localViewMode = null;
    if (typeof browser !== 'undefined' && browser.storage) {
      const result = await browser.storage.local.get(['viewMode']);
      localViewMode = result.viewMode;
    } else {
      localViewMode = await new Promise((resolve) => {
        chrome.storage.local.get(['viewMode'], (result) => {
          resolve(result.viewMode);
        });
      });
    }
    
    if (localViewMode) {
      currentView = localViewMode;
    } else {
      currentView = defaultSettings.viewMode;
    }
  } catch (e) {
    viewOptions = { ...defaultViewOptions };
    currentView = defaultSettings.viewMode;
  }
  applyViewMode();
}

/**
 * 保存视图模式到本地存储（不触发云端同步）
 */
async function persistViewMode() {
  try {
    // viewMode 只保存到本地存储，不同步到云端
    if (typeof browser !== 'undefined' && browser.storage) {
      await browser.storage.local.set({ viewMode: currentView });
    } else {
      await new Promise((resolve) => {
        chrome.storage.local.set({ viewMode: currentView }, resolve);
      });
    }
  } catch (e) {
    console.warn('保存视图模式失败', e);
  }
}

/**
 * 持久化非敏感设置并通知后台同步到云端
 * 注意：viewMode 不同步到云端，只保存在本地
 */
async function persistSettings() {
  try {
    // 保存到云端的设置（不包含 viewMode）
    const settings = { viewOptions };
    await storage.saveSettings(settings);
    await sendMessageCompat({ action: 'syncSettings' });
  } catch (e) {
    console.warn('保存设置失败', e);
  }
}

/**
 * 导出为JSON
 */
async function exportAsJson() {
  try {
    // 只导出当前场景的书签
    const data = await storage.getBookmarks(currentSceneId);
    const jsonData = JSON.stringify(data, null, 2);
    
    const blob = new Blob([jsonData], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bookmarks_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    
    alert('导出成功');
  } catch (error) {
    alert('导出失败: ' + error.message);
  }
}

/**
 * 导出为HTML
 */
async function exportAsHtml() {
  try {
    // 只导出当前场景的书签
    const data = await storage.getBookmarks(currentSceneId);
    const bookmarks = data.bookmarks || [];
    
    if (typeof exportToHtml === 'function') {
      const htmlData = exportToHtml(bookmarks, data.folders || []);
      
      const blob = new Blob([htmlData], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bookmarks_${Date.now()}.html`;
      a.click();
      URL.revokeObjectURL(url);
      
      alert('导出成功');
    } else {
      alert('HTML导出功能未加载');
    }
  } catch (error) {
    alert('导出失败: ' + error.message);
  }
}

/**
 * 处理同步
 */
async function handleSync() {
  syncBtn.disabled = true;
  syncBtn.textContent = '同步中...';
  
  try {
    const response = await sendMessageCompat({ action: 'sync' });
    if (response && response.success) {
      await loadBookmarks();
      await loadFolders();
      await loadTags();
      await updateSyncErrorBanner();
    } else {
      await updateSyncErrorBanner();
    }
  } catch (error) {
    await updateSyncErrorBanner();
  } finally {
    syncBtn.disabled = false;
    syncBtn.textContent = '🔄';
  }
}

/**
 * 同步到云端
 */
async function syncToCloud() {
  try {
    // currentBookmarks已经是当前场景的书签，直接同步
    // 确保传递当前场景ID，让后台同步到正确的场景文件
    await sendMessageCompat({
      action: 'syncToCloud',
      bookmarks: currentBookmarks,
      folders: currentFolders,
      sceneId: currentSceneId // 明确指定当前场景ID
    });
  } catch (error) {
    console.error('同步到云端失败:', error);
  }
}

/**
 * 切换批量模式
 */
function toggleBatchMode() {
  batchMode = !batchMode;
  if (!batchMode) {
    selectedBookmarkIds.clear();
  }
  updateBatchModeUI();
  renderBookmarks();
}

/**
 * 更新批量模式UI
 */
function updateBatchModeUI() {
  if (batchMode) {
    batchActionsBar.style.display = 'flex';
    normalActions.style.display = 'none';
  } else {
    batchActionsBar.style.display = 'none';
    normalActions.style.display = 'flex';
    selectedBookmarkIds.clear();
  }
  updateSelectedCount();
}

/**
 * 更新选中数量
 */
function updateSelectedCount() {
  selectedCount.textContent = `已选择 ${selectedBookmarkIds.size} 项`;
  if (!selectAllBtn) return;

  const displayedCards = Array.from(document.querySelectorAll('.bookmark-card'));
  const displayedIds = displayedCards.map(card => card.dataset.id);
  const totalDisplayed = displayedIds.length;
  const selectedOnScreen = displayedIds.filter(id => selectedBookmarkIds.has(id)).length;
  const allSelected = totalDisplayed > 0 && selectedOnScreen === totalDisplayed;

  selectAllBtn.textContent = allSelected ? '取消全选' : '全选';
}

/**
 * 全选/取消全选
 */
function toggleSelectAll() {
  const cards = Array.from(document.querySelectorAll('.bookmark-card'));
  const displayedIds = cards.map(card => card.dataset.id);
  const selectedOnScreen = displayedIds.filter(id => selectedBookmarkIds.has(id));
  const allSelected = displayedIds.length > 0 && selectedOnScreen.length === displayedIds.length;

  if (allSelected) {
    // 只取消当前界面显示的书签
    displayedIds.forEach(id => selectedBookmarkIds.delete(id));
  } else {
    // 只选择当前界面显示的书签
    displayedIds.forEach(id => selectedBookmarkIds.add(id));
  }

  // 更新UI
  updateSelectedCount();
  // 更新所有复选框状态
  document.querySelectorAll('.bookmark-card .bookmark-select-checkbox').forEach(checkbox => {
    checkbox.checked = selectedBookmarkIds.has(checkbox.dataset.id);
  });
}

/**
 * 批量移动书签
 */
async function batchMoveBookmarks() {
  if (selectedBookmarkIds.size === 0) {
    alert('请先选择要移动的书签');
    return;
  }
  
  // 显示文件夹选择对话框
  const targetFolder = await showFolderSelectDialog();
  if (targetFolder === null) return; // 用户取消（null 表示取消，空字符串表示"未分类"）
  
  try {
    const bookmarksToMove = currentBookmarks.filter(b => selectedBookmarkIds.has(b.id));
    
    // 更新书签的文件夹（与单个编辑逻辑一致：空字符串转为 undefined）
    const normalizedTargetFolder = targetFolder.trim() ? normalizeFolderPath(targetFolder) : undefined;
    bookmarksToMove.forEach(bookmark => {
      bookmark.folder = normalizedTargetFolder;
      bookmark.updatedAt = Date.now();
    });
    
    // 更新 currentFolders：保留现有顺序，添加新文件夹
    const bookmarkFolders = currentBookmarks.map(b => b.folder).filter(Boolean);
    const bookmarkFoldersSet = new Set(bookmarkFolders);
    // 保留 currentFolders 中存在的文件夹（保持顺序），然后添加新文件夹
    const existingFolders = currentFolders.filter(f => bookmarkFoldersSet.has(f));
    const newFolders = bookmarkFolders.filter(f => !currentFolders.includes(f));
    currentFolders = [...existingFolders, ...newFolders];
    
    // 保存到本地
    await storage.saveBookmarks(currentBookmarks, currentFolders, currentSceneId);
    
    // 同步到云端（与单个编辑逻辑一致：使用 syncToCloud）
    await syncToCloud();
    
    // 退出批量模式并刷新
    toggleBatchMode();
    await loadBookmarks();
    await loadFolders();
    await loadTags();
    renderBookmarks();
    
    alert(`已成功移动 ${bookmarksToMove.length} 个书签`);
  } catch (error) {
    console.error('批量移动失败:', error);
    alert('批量移动失败: ' + error.message);
  }
}

/**
 * 批量删除书签
 */
async function batchDeleteBookmarks() {
  if (selectedBookmarkIds.size === 0) {
    alert('请先选择要删除的书签');
    return;
  }
  
  const count = selectedBookmarkIds.size;
  const confirmMessage = `确定要删除选中的 ${count} 个书签吗？此操作不可恢复。`;
  
  if (!confirm(confirmMessage)) {
    return;
  }
  
  try {
    // 删除选中的书签
    currentBookmarks = currentBookmarks.filter(b => !selectedBookmarkIds.has(b.id));
    
    // 更新文件夹列表：保留现有顺序，移除不再使用的文件夹
    const bookmarkFolders = currentBookmarks.map(b => b.folder).filter(Boolean);
    const bookmarkFoldersSet = new Set(bookmarkFolders);
    // 保留 currentFolders 中仍然有书签使用的文件夹（保持顺序）
    currentFolders = currentFolders.filter(f => bookmarkFoldersSet.has(f));
    
    // 保存到本地
    await storage.saveBookmarks(currentBookmarks, currentFolders, currentSceneId);
    
    // 同步到云端
    await syncToCloud();
    
    // 退出批量模式并刷新
    toggleBatchMode();
    await loadBookmarks();
    await loadFolders();
    await loadTags();
    renderBookmarks();
    
    alert(`已成功删除 ${count} 个书签`);
  } catch (error) {
    console.error('批量删除失败:', error);
    alert('批量删除失败: ' + error.message);
  }
}

/**
 * 显示文件夹选择对话框
 */
function showFolderSelectDialog() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2000;
      animation: fadeIn 0.2s ease-out;
    `;
    
    const dialog = document.createElement('div');
    dialog.className = 'dialog-container';
    // 检测是否为移动设备
    const isMobile = window.innerWidth <= 768;
    dialog.style.cssText = `
      background: #ffffff;
      border-radius: 12px;
      padding: ${isMobile ? '20px' : '24px'};
      width: ${isMobile ? '90%' : '480px'};
      max-width: 90%;
      max-height: ${isMobile ? '85vh' : '80vh'};
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(0, 0, 0, 0.05);
      font-size: ${isMobile ? '16px' : '14px'};
      display: flex;
      flex-direction: column;
      animation: slideUp 0.3s ease-out;
      position: relative;
    `;
    
    // 与单个编辑时的 loadFolderOptions 逻辑一致：合并从书签中提取的文件夹和 currentFolders 中的文件夹
    const bookmarkFolders = [...new Set(currentBookmarks.map(b => b.folder).filter(f => f))];
    const folders = [...new Set([...bookmarkFolders, ...currentFolders])];
    folders.sort();
    
    // 构建树结构
    const tree = buildFolderTreeForSelect(folders);
    
    // 渲染选项
    let folderOptions = '<option value="">📁 未分类</option>';
    folderOptions += renderFolderTreeOptions(tree, 0, '');
    
    const selectSize = isMobile ? 8 : 12;
    const inputPadding = isMobile ? '12px' : '8px 12px';
    const inputFontSize = isMobile ? '16px' : '14px';
    const selectFontSize = isMobile ? '16px' : '14px';
    const minHeight = isMobile ? '250px' : '200px';
    const maxHeight = isMobile ? '50vh' : '400px';
    
    dialog.innerHTML = `
      <div style="margin-bottom: 20px;">
        <h3 style="margin: 0; font-size: ${isMobile ? '20px' : '18px'}; font-weight: 600; color: #1a1a1a; display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 24px;">📂</span>
          <span>选择目标文件夹</span>
        </h3>
      </div>
      <div style="margin-bottom: 16px;">
        <input type="text" id="folderSearchInput" placeholder="🔍 搜索文件夹..." style="width: 100%; padding: ${inputPadding}; border: 2px solid #e0e0e0; border-radius: 8px; font-size: ${inputFontSize}; box-sizing: border-box; -webkit-appearance: none; transition: border-color 0.2s; outline: none;" autocomplete="off">
      </div>
      <div style="margin-bottom: 20px; flex: 1; min-height: ${minHeight}; max-height: ${maxHeight}; overflow-y: auto; border: 2px solid #e0e0e0; border-radius: 8px; padding: 8px; background: #fafafa;">
        <select id="targetFolderSelect" size="${selectSize}" style="width: 100%; border: none; font-size: ${selectFontSize}; outline: none; background: transparent; color: #333;">
          ${folderOptions}
        </select>
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: auto;">
        <button id="folderSelectCancelBtn" class="btn btn-secondary" style="min-width: ${isMobile ? '90px' : '80px'}; min-height: ${isMobile ? '44px' : '38px'}; font-size: ${isMobile ? '16px' : '14px'}; border-radius: 8px; font-weight: 500;">取消</button>
        <button id="folderSelectOkBtn" class="btn btn-primary" style="min-width: ${isMobile ? '90px' : '80px'}; min-height: ${isMobile ? '44px' : '38px'}; font-size: ${isMobile ? '16px' : '14px'}; border-radius: 8px; font-weight: 500;">确定</button>
      </div>
    `;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const folderSelect = dialog.querySelector('#targetFolderSelect');
    const searchInput = dialog.querySelector('#folderSearchInput');
    const cancelBtn = dialog.querySelector('#folderSelectCancelBtn');
    const okBtn = dialog.querySelector('#folderSelectOkBtn');
    
    // 添加搜索功能
    if (searchInput) {
      // 搜索框焦点样式
      searchInput.addEventListener('focus', () => {
        searchInput.style.borderColor = '#4a90e2';
        searchInput.style.boxShadow = '0 0 0 3px rgba(74, 144, 226, 0.1)';
      });
      searchInput.addEventListener('blur', () => {
        searchInput.style.borderColor = '#e0e0e0';
        searchInput.style.boxShadow = 'none';
      });
      
      const allOptions = Array.from(folderSelect.options);
      searchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();
        if (!query) {
          // 显示所有选项
          allOptions.forEach(opt => {
            opt.style.display = '';
          });
          return;
        }
        
        // 过滤选项
        allOptions.forEach(opt => {
          const text = opt.textContent.toLowerCase();
          if (text.includes(query) || opt.value === '') {
            opt.style.display = '';
          } else {
            opt.style.display = 'none';
          }
        });
      });
    }

    const cleanup = () => {
      overlay.style.animation = 'fadeIn 0.2s ease-out reverse';
      setTimeout(() => overlay.remove(), 200);
      document.removeEventListener('keydown', onKeyDown);
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        cleanup();
        resolve(null);
      }
    };
    document.addEventListener('keydown', onKeyDown);

    cancelBtn.onclick = () => {
      cleanup();
      resolve(null);
    };

    okBtn.onclick = () => {
      // 与单个编辑逻辑一致：空字符串表示"未分类"，返回空字符串而不是 null
      const folder = folderSelect.value.trim();
      cleanup();
      resolve(folder); // 空字符串表示"未分类"，null 表示取消
    };

    folderSelect.focus();
  });
}

// 绑定批量操作事件
batchModeBtn.addEventListener('click', toggleBatchMode);
batchCancelBtn.addEventListener('click', toggleBatchMode);
batchMoveBtn.addEventListener('click', batchMoveBookmarks);
batchDeleteBtn.addEventListener('click', batchDeleteBookmarks);
selectAllBtn.addEventListener('click', toggleSelectAll);

// 全局函数供HTML调用
window.showAddForm = showAddForm;


