/**
 * 书签管理页面脚本
 */

const storage = new StorageManager();

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

// 开发者日志开关：默认关闭，仅在设置中开启后才输出 console.log。
const originalConsoleLog = console.log.bind(console);
let enableDeveloperConsoleLogging = false;
console.log = (...args) => {
  if (enableDeveloperConsoleLogging) {
    originalConsoleLog(...args);
  }
};

// 初始化书签管理页的开发者日志开关，并保持和本地 settings 一致。
async function initDeveloperConsoleLogging() {
  try {
    const settings = await storage.getSettings();
    enableDeveloperConsoleLogging = !!settings?.developerSettings?.enableConsoleLogging;
  } catch (_) {
    enableDeveloperConsoleLogging = false;
  }
}

initDeveloperConsoleLogging().catch(() => { });

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

/** 场景切换中：防连点 */
let sceneSwitchBusyPage = false;

function normalizeFolderPath(path) {
  if (!path) return '';
  // 去除零宽字符，做 Unicode 归一化（避免“看起来一样但字符串不同”导致去重/排序异常）
  let s = String(path).replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  try {
    if (typeof s.normalize === 'function') s = s.normalize('NFKC');
  } catch (_) { }
  // 统一分隔符：防止界面输入/系统来源出现反斜杠导致云端删除/匹配失败
  s = s.replace(/\\+/g, '/');
  return s.replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}

// 将形如 a/b/c 的路径补齐中间父级：a、a/b、a/b/c，并保持“首次出现顺序”
function expandFolderPathsPreserveOrder(paths) {
  const out = [];
  const seen = new Set();
  (paths || []).forEach((p) => {
    const n = normalizeFolderPath(p || '');
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
  return out;
}

// 将新文件夹插入到"同父级分组"的末尾，避免新增子文件夹总是跑到 folders 最后
function insertFolderPathSmart(folders, newPath) {
  const n = normalizeFolderPath(newPath || '');
  if (!n) return folders || [];
  const list = Array.isArray(folders) ? [...folders] : [];
  if (list.includes(n)) return list;

  const parent = getParentFolder(n); // '' 表示根
  // 找到父级在数组中的位置（可能不存在）
  const parentIdx = parent ? list.indexOf(parent) : -1;

  // 规则：插入到"父级的最后一个后代"之后（含父级本身）
  // 即：找到最后一个满足 f === parent 或 f 以 `${parent}/` 开头的元素位置
  let insertAt = -1;
  if (parent) {
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (f === parent || (typeof f === 'string' && f.startsWith(parent + '/'))) {
        insertAt = i;
      }
    }
    if (insertAt === -1 && parentIdx !== -1) insertAt = parentIdx;
  } else {
    // 根目录：插入到最后一个根级（不含"a/b"）之后
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (typeof f === 'string' && f.indexOf('/') === -1) {
        insertAt = i;
      }
    }
  }

  if (insertAt === -1) {
    list.push(n);
  } else {
    list.splice(insertAt + 1, 0, n);
  }
  return list;
}

// 将新书签插入到"同文件夹分组"的末尾，避免新增书签总是跑到所有书签最后
function insertBookmarkSmart(bookmarks, newBookmark) {
  const list = Array.isArray(bookmarks) ? [...bookmarks] : [];
  const bookmarkFolder = normalizeFolderPath(newBookmark.folder || '');

  // 规则：插入到"该文件夹的最后一个书签"之后
  // 即：找到最后一个满足 b.folder === bookmarkFolder 的书签位置
  let insertAt = -1;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    const bFolder = normalizeFolderPath(b.folder || '');
    if (bFolder === bookmarkFolder) {
      insertAt = i;
    }
  }

  if (insertAt === -1) {
    // 如果该文件夹没有书签，需要找到该文件夹在文件夹列表中的位置
    // 然后找到下一个文件夹的第一个书签之前插入
    const folderIndex = currentFolders.indexOf(bookmarkFolder);
    if (folderIndex !== -1) {
      // 找到该文件夹之后的所有文件夹（按顺序）
      const afterFolders = [];
      for (let i = folderIndex + 1; i < currentFolders.length; i++) {
        afterFolders.push(normalizeFolderPath(currentFolders[i]));
      }
      // 找到第一个属于这些文件夹的书签位置，插入到该位置之前
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        const bFolder = normalizeFolderPath(b.folder || '');
        if (afterFolders.includes(bFolder)) {
          insertAt = i - 1;
          break;
        }
      }
    }
  }

  if (insertAt === -1) {
    list.push(newBookmark);
  } else {
    list.splice(insertAt + 1, 0, newBookmark);
  }
  return list;
}

function showModalActionBarImmediately() {
  if (!formActionsBar) return;
  formActionsBar.classList.remove('is-scrolling');
}

function scheduleModalActionBarReveal(delay = 420) {
  if (!formActionsBar) return;
  if (modalActionBarTimer) {
    clearTimeout(modalActionBarTimer);
  }
  modalActionBarTimer = setTimeout(() => {
    formActionsBar.classList.remove('is-scrolling');
    modalActionBarTimer = null;
  }, delay);
}

function bindModalActionBarAutoHide() {
  if (!modalFormScroll || !formActionsBar) return;

  modalFormScroll.addEventListener('scroll', () => {
    const nearBottom = modalFormScroll.scrollTop + modalFormScroll.clientHeight >= modalFormScroll.scrollHeight - 24;
    if (!nearBottom) {
      formActionsBar.classList.add('is-scrolling');
    }
    scheduleModalActionBarReveal(nearBottom ? 180 : 420);
  }, { passive: true });
}

function getHostnameForDisplay(url) {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

function updateModalHeader(mode, data = {}) {
  const eyebrowEl = document.getElementById('modalEyebrow');
  const titleEl = document.getElementById('modalTitle');
  const subtitleEl = document.getElementById('modalSubtitle');
  if (!eyebrowEl || !titleEl || !subtitleEl) return;

  const sceneNameEl = document.querySelector('#sceneSwitchBtn .scene-name');
  const sceneName = sceneNameEl ? sceneNameEl.textContent.trim() : (currentSceneId || 'home');
  const host = getHostnameForDisplay(data.url);
  const contextText = host ? `站点：${host}` : '整理到你的当前场景';

  if (mode === 'edit') {
    eyebrowEl.textContent = '编辑内容';
    titleEl.textContent = '编辑书签';
    subtitleEl.textContent = `当前场景：${sceneName} · ${contextText}`;
    return;
  }

  eyebrowEl.textContent = '快速收藏';
  titleEl.textContent = '添加书签';
  subtitleEl.textContent = `当前场景：${sceneName} · ${contextText}`;
}

/**
 * 按文件夹分组排序书签，保持文件夹顺序，同一文件夹内的书签保持原有顺序
 * @param {Array} bookmarks - 书签数组
 * @returns {Array} 排序后的书签数组
 */
function sortBookmarksByFolder(bookmarks) {
  const list = Array.isArray(bookmarks) ? [...bookmarks] : [];

  // 按文件夹分组，保持每个文件夹内书签的原有顺序
  const folderGroups = {};
  const folderOrder = [];

  list.forEach(bookmark => {
    const folder = normalizeFolderPath(bookmark.folder || '');
    if (!folderGroups[folder]) {
      folderGroups[folder] = [];
      folderOrder.push(folder);
    }
    folderGroups[folder].push(bookmark);
  });

  // 按照文件夹列表的顺序重新排列
  const sortedBookmarks = [];

  // 先按文件夹列表的顺序添加
  currentFolders.forEach(folder => {
    const normalizedFolder = normalizeFolderPath(folder);
    if (folderGroups[normalizedFolder]) {
      sortedBookmarks.push(...folderGroups[normalizedFolder]);
      delete folderGroups[normalizedFolder];
    }
  });

  // 添加不在文件夹列表中的书签（按原有顺序）
  folderOrder.forEach(folder => {
    if (folderGroups[folder]) {
      sortedBookmarks.push(...folderGroups[folder]);
    }
  });

  return sortedBookmarks;
}

/**
 * 自定义排序（最新策略）：按文件夹顺序 + 文件夹内 order 字段排序，保证画面显示一致
 * 注意：不会修改 currentFolders，仅排序传入书签数组
 */
function sortBookmarksForCustomDisplay(bookmarks) {
  const list = Array.isArray(bookmarks) ? [...bookmarks] : [];
  const folderRank = new Map();
  (currentFolders || []).forEach((p, idx) => folderRank.set(normalizeFolderPath(p), idx));
  const originalIdx = new Map();
  list.forEach((b, i) => {
    if (b && b.id) originalIdx.set(b.id, i);
  });
  return list.sort((a, b) => {
    const af = getBookmarkFolderKey(a);
    const bf = getBookmarkFolderKey(b);
    if (af !== bf) {
      const ai = folderRank.has(af) ? folderRank.get(af) : Number.MAX_SAFE_INTEGER;
      const bi = folderRank.has(bf) ? folderRank.get(bf) : Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return af.localeCompare(bf);
    }
    const ao = typeof a.order === 'number' ? a.order : Number.MAX_SAFE_INTEGER;
    const bo = typeof b.order === 'number' ? b.order : Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return (originalIdx.get(a.id) || 0) - (originalIdx.get(b.id) || 0);
  });
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
// 文件夹主键元数据：folderId 作为主键（需求.md: 文件夹操作按 Id）
let currentFolderMeta = { order: [], byId: {} };
let currentFolderIdByPath = new Map(); // normalizedPath -> folderId
// 书签排序元数据：bookmarkId 作为主键（需求.md: 排序按 Id）
let currentBookmarkMeta = { order: [] };

function getBookmarkFolderKey(b) {
  return normalizeFolderPath((b && b.folder) || '');
}

/**
 * 按“当前列表顺序”重排每个文件夹内书签的 order 字段（从 0 开始递增）
 * 满足 需求.md：每个文件夹里面的每个书签有一个排序字段
 */
function reindexBookmarkOrderByFolder() {
  const counters = new Map(); // folderKey -> nextOrder
  currentBookmarks = (currentBookmarks || []).map((b) => {
    if (!b || !b.id) return b;
    const fk = getBookmarkFolderKey(b);
    const next = counters.get(fk) || 0;
    counters.set(fk, next + 1);
    // 仅当 order 变化时才创建新对象，减少无谓 diff
    if (b.order === next) return b;
    return { ...b, order: next };
  });
}

function ensureBookmarkFolderIdAndOrder() {
  const counters = new Map();
  let metaChanged = false;

  currentBookmarks = (currentBookmarks || []).map((b) => {
    if (!b || !b.id) return b;
    const fp = normalizeFolderPath(b.folder || '');
    let folderId = b.folderId;

    if (fp) {
      // 检查内存映射中是否已有该路径对应的 ID，或该书签自带的 ID 是否合法
      let targetId = currentFolderIdByPath.get(fp);

      // 如果内存中没有，尝试从现有的 Meta 中反查（兼容性检查）
      if (!targetId && currentFolderMeta && currentFolderMeta.byId) {
        for (const [id, row] of Object.entries(currentFolderMeta.byId)) {
          if (normalizeFolderPath(row.path) === fp) {
            targetId = id;
            break;
          }
        }
      }

      // 如果还是没有，或者现有书签的 ID 格式不对（比如以前的 home_xxx 拼接格式），则纠正它
      const isLegacyId = folderId && !folderId.startsWith('f_');
      if (!targetId || isLegacyId) {
        // 如果 targetId 存在但格式不对，我们维持一个正确的 targetId
        if (!targetId || !targetId.startsWith('f_')) {
          targetId = storage.generateStableFolderId(fp, currentSceneId);
        }
        currentFolderIdByPath.set(fp, targetId);

        // 反向补齐 Meta
        if (!currentFolderMeta.byId) currentFolderMeta.byId = {};
        if (!currentFolderMeta.byId[targetId]) {
          const name = fp.includes('/') ? fp.slice(fp.lastIndexOf('/') + 1) : fp;
          currentFolderMeta.byId[targetId] = { path: fp, name };
          if (!currentFolderMeta.order) currentFolderMeta.order = [];
          if (!currentFolderMeta.order.includes(targetId)) {
            currentFolderMeta.order.push(targetId);
          }
          metaChanged = true;
        }
      }

      // 统一书签的 folderId
      folderId = targetId;
    } else {
      folderId = undefined; // 未分类
    }

    // 更新 order（同文件夹内）
    const key = fp || '';
    const next = counters.get(key) || 0;
    counters.set(key, next + 1);
    const order = (typeof b.order === 'number') ? b.order : next;

    if (b.folderId === folderId && b.order === order) return b;
    return { ...b, folderId, order };
  });

  if (metaChanged) {
    // 如果补齐了元数据，确保持久化到本地，防止刷新丢失
    storage.saveSceneFolderMeta(currentSceneId, currentFolderMeta).catch(() => { });
  }
}

function refreshBookmarkMetaOrderFromCurrent() {
  const out = [];
  const seen = new Set();
  (currentBookmarks || []).forEach((b) => {
    const id = b && b.id;
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  });
  currentBookmarkMeta = { order: out };
  // best-effort 落盘：不阻断 UI
  storage.saveSceneBookmarkMeta(currentSceneId, currentBookmarkMeta).catch(() => { });
}

function refreshFolderMetaOrderFromCurrent() {
  try {
    // 进行层级排序，确保云端存储顺序与树形展示一致
    if (storage && typeof storage.sortFoldersByHierarchy === 'function') {
      currentFolders = storage.sortFoldersByHierarchy(currentFolders);
    }

    const byId = (currentFolderMeta && currentFolderMeta.byId) ? currentFolderMeta.byId : {};
    const pathToId = currentFolderIdByPath instanceof Map ? currentFolderIdByPath : new Map();
    const nextById = { ...(byId || {}) };
    const nextOrder = [];
    (currentFolders || []).forEach((p) => {
      const np = normalizeFolderPath(p);
      if (!np) return;
      let id = pathToId.get(np);
      if (!id) {
        id = storage.generateStableFolderId(np, currentSceneId);
        pathToId.set(np, id);
      }
      const name = np.indexOf('/') >= 0 ? np.slice(np.lastIndexOf('/') + 1) : np;
      nextById[id] = { ...(nextById[id] || {}), path: np, name };
      nextOrder.push(id);
    });
    currentFolderMeta = { order: nextOrder, byId: nextById };
    currentFolderIdByPath = pathToId;
    storage.saveSceneFolderMeta(currentSceneId, currentFolderMeta).catch(() => { });
  } catch (_) { }
}
let currentFilter = 'all';
let currentSort = 'custom'; // 默认使用自定义排序，保持书签的原始顺序（按文件夹顺序）
let editingBookmarkId = null;
let currentSceneId = null;
// 文件夹展开状态（Set，存储展开的文件夹路径）
let expandedFolders = new Set(['']); // 默认展开根节点
let foldersInitialized = false; // 标记文件夹是否已初始化展开状态
let batchMode = false;
let selectedBookmarkIds = new Set();
let pageSource = null; // 记录页面来源（popup/floating-ball等）
let sourceTabId = null; // 记录来源标签页ID（用于关闭后恢复焦点）
let autoCloseTimer = null; // 自动关闭定时器
let orderSyncPending = false; // 标记是否有未执行的排序同步
let draggingBookmarkId = null; // 当前拖拽的书签ID（自定义排序）

function isMobileView() {
  return window.innerWidth <= 768;
}
const ORDER_SYNC_DELAY = 1000; // 文件夹/排序调整的上行防抖（毫秒），1秒内频繁操作只合并一次上行
const scheduleOrderSync = (() => {
  const debounced = debounce(async () => {
    try {
      console.log('[排序同步] 防抖触发，开始同步当前场景排序到云端', {
        sceneId: currentSceneId,
        bookmarkCount: currentBookmarks.length,
        folderCount: currentFolders.length
      });
      await syncToCloud({
        patch: {
          folderOrderIds: (currentFolderMeta && Array.isArray(currentFolderMeta.order)) ? [...currentFolderMeta.order] : [],
          bookmarkUpserts: (currentBookmarks || []).map((b) => b && b.id).filter(Boolean)
        }
      });
    } catch (e) {
      console.error('[排序同步] 同步失败', e);
    } finally {
      orderSyncPending = false;
    }
  }, ORDER_SYNC_DELAY);
  return () => {
    orderSyncPending = true;
    debounced();
  };
})();

async function flushPendingOrderSync() {
  if (!orderSyncPending) return;
  orderSyncPending = false;
  try {
    console.log('[排序同步] 页面即将隐藏/关闭，执行兜底同步');
    await syncToCloud({
      patch: {
        folderOrderIds: (currentFolderMeta && Array.isArray(currentFolderMeta.order)) ? [...currentFolderMeta.order] : [],
        bookmarkUpserts: (currentBookmarks || []).map((b) => b && b.id).filter(Boolean)
      }
    });
  } catch (e) {
    console.error('[排序同步] 兜底同步失败', e);
  }
}

function buildCurrentFolderItemsForSync() {
  const byId = (currentFolderMeta && currentFolderMeta.byId) ? currentFolderMeta.byId : {};
  const orderIds = (currentFolderMeta && Array.isArray(currentFolderMeta.order)) ? currentFolderMeta.order : [];
  const out = [];
  orderIds.forEach((id, idx) => {
    const row = byId[id];
    if (!row) return;
    const path = normalizeFolderPath(row.path || '');
    if (!path) return;
    const name = (row.name || '').trim() || (path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path);
    out.push({ id, name, path, order: idx });
  });
  return out;
}

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
const modalFormScroll = document.querySelector('.modal-form-scroll');
const formActionsBar = document.querySelector('.form-actions');
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
let modalActionBarTimer = null;
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
        try { toastEl?.remove(); } catch (_) { }
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
    const bStatus = await storage.getBrowserSyncStatus();
    
    let errorMsg = '';
    // 优先显示全局同步错误
    if (status && status.status === 'error' && status.error) {
      errorMsg = `上传失败：${status.error}`;
    } else if (bStatus && bStatus.status === 'error' && bStatus.error) {
      // 其次显示定时上传错误
      errorMsg = `定时上传失败：${bStatus.error}`;
    }

    if (errorMsg) {
      syncErrorBanner.style.display = 'block';
      syncErrorBanner.textContent = errorMsg;
      syncErrorBanner.style.backgroundColor = '#f8d7da';
      syncErrorBanner.style.color = '#721c24';
      syncErrorBanner.style.borderColor = '#f5c6cb';
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
  // 本地密码锁：未解锁前阻塞主体渲染
  if (typeof LockScreen !== 'undefined') {
    try { await LockScreen.guard({ title: '云端书签', subtitle: '已启用本地密码锁，请输入密码后查看书签' }); }
    catch (_) { /* 不阻塞 */ }
  }

  await loadSettings(); // 先加载显示设置
  await loadCurrentScene();
  await loadScenes();
  await loadBookmarks();
  await loadFolderState(); // 先加载文件夹展开状态
  await loadFolders();
  await loadTags();
  await updateSyncErrorBanner();
  initSidebarResizer();
  bindModalActionBarAutoHide();
  setupEventListeners();
  // 设置排序下拉框的默认值
  if (sortSelect) {
    sortSelect.value = currentSort;
  }
  await checkUrlParams();

  // 页面隐藏/关闭时兜底执行一次排序同步，避免防抖未触发导致顺序丢失
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushPendingOrderSync();
    }
  });
  window.addEventListener('beforeunload', () => {
    flushPendingOrderSync();
  });

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
        if (areaName === 'local' && changes.settings) {
          // 开发者日志开关变化时即时生效，不需要刷新页面。
          const nextSettings = changes.settings.newValue || {};
          enableDeveloperConsoleLogging = !!nextSettings?.developerSettings?.enableConsoleLogging;
        }
        if (areaName === 'local' && (changes.syncStatus || changes.browserSyncStatus)) {
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
function clampAddPopupMobileHeightVh(value, fallback = 83) {
  const parsed = parseInt(value, 10);
  const candidate = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(100, Math.max(50, candidate));
}

async function applyAddPopupMobileHeightForAddFlow(source) {
  try {
    const settings = await storage.getSettings();
    const unified = settings?.addBookmarkPopup || {};
    const legacy = source === 'floating-ball'
      ? (settings?.floatingBallAddPopup || {})
      : (settings?.iconAddPopup || {});
    const fallback = clampAddPopupMobileHeightVh(legacy.heightMobile, 83);
    const mobileHeightVh = clampAddPopupMobileHeightVh(unified.heightMobile, fallback);
    document.documentElement.style.setProperty('--cb-add-popup-mobile-height-vh', String(mobileHeightVh));
  } catch (_) {
    document.documentElement.style.setProperty('--cb-add-popup-mobile-height-vh', '83');
  }
}

async function checkUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const action = params.get('action');
  pageSource = params.get('source'); // 记录页面来源
  const sourceTabIdParam = params.get('sourceTabId');
  const parsedSourceTabId = parseInt(sourceTabIdParam, 10);
  sourceTabId = Number.isFinite(parsedSourceTabId) ? parsedSourceTabId : null;

  if (action === 'add' && (pageSource === 'shortcut' || pageSource === 'popup' || pageSource === 'floating-ball')) {
    await applyAddPopupMobileHeightForAddFlow(pageSource || 'popup');
  }

  // 如果是从快捷键、弹窗或悬浮球打开的，隐藏主内容，只显示添加/编辑表单
  if (pageSource === 'shortcut' || pageSource === 'popup' || pageSource === 'floating-ball') {
    document.documentElement.classList.add('cb-add-flow-lock');
    document.body.classList.add('cb-add-flow-lock');
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
      // 添加书签弹窗：优先跟随动态视口高度
      document.body.style.minHeight = '100vh';
      document.body.style.minHeight = '100dvh';
      document.body.style.margin = '0';
      document.body.style.padding = '0';
      document.body.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
    }
  } else {
    document.documentElement.classList.remove('cb-add-flow-lock');
    document.body.classList.remove('cb-add-flow-lock');
  }

  if (action === 'add') {
    const url = params.get('url');
    const title = params.get('title');
    if (url) {
      showAddForm({ url, title });
    }
  } else if (action === 'edit') {
    const bookmarkId = params.get('id');
    if (bookmarkId) {
      // 等待书签加载完成后再打开编辑表单
      const tryShowEditForm = async () => {
        const bookmark = currentBookmarks.find(b => b.id === bookmarkId);
        if (bookmark) {
          showEditForm(bookmark);
        } else {
          // 如果还没加载完成，等待一下再试
          setTimeout(tryShowEditForm, 100);
        }
      };
      // 延迟执行，确保书签已加载
      setTimeout(tryShowEditForm, 200);
    }
  } else if (action === 'locate') {
    const bookmarkId = params.get('id');
    const folderPath = params.get('folder');
    if (bookmarkId) {
      // 等待书签加载完成后再定位
      const tryLocateBookmark = async () => {
        const bookmark = currentBookmarks.find(b => b.id === bookmarkId);
        if (bookmark) {
          locateBookmarkInPage(bookmarkId, folderPath || bookmark.folder);
        } else {
          // 如果还没加载完成，等待一下再试
          setTimeout(tryLocateBookmark, 100);
        }
      };
      // 延迟执行，确保书签已加载
      setTimeout(tryLocateBookmark, 200);
    }
  }
}

/**
 * 关闭当前标签页，并尽量回到触发添加流程的来源标签页
 */
function closeCurrentTabFromAddFlow() {
  const closePayload = { action: 'closeCurrentTab' };
  if (typeof sourceTabId === 'number') {
    closePayload.targetTabId = sourceTabId;
  }
  return sendMessageCompat(closePayload);
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

  // 书签卡片拖拽排序（仅在自定义排序模式且非批量模式启用）
  if (bookmarksGrid) {
    bookmarksGrid.addEventListener('dragstart', (e) => {
      if (currentSort !== 'custom' || batchMode) return;
      const card = e.target.closest('.bookmark-card');
      if (!card) return;
      draggingBookmarkId = card.dataset.id;
      e.dataTransfer.effectAllowed = 'move';
    });

    bookmarksGrid.addEventListener('dragover', (e) => {
      if (currentSort !== 'custom' || batchMode) return;
      const card = e.target.closest('.bookmark-card');
      if (!card) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });

    bookmarksGrid.addEventListener('drop', async (e) => {
      if (currentSort !== 'custom' || batchMode) return;
      const card = e.target.closest('.bookmark-card');
      if (!card || !draggingBookmarkId) return;
      e.preventDefault();
      const targetId = card.dataset.id;
      if (!targetId || targetId === draggingBookmarkId) {
        draggingBookmarkId = null;
        return;
      }
      const movedOk = reorderBookmarksById(draggingBookmarkId, targetId);
      draggingBookmarkId = null;
      if (!movedOk) return;
      // 仅在本地完成“同文件夹内排序”，不在拖拽时拉云端，避免侧边栏文件夹顺序被重绘影响观感
      reindexBookmarkOrderByFolder();
      currentBookmarks = sortBookmarksForCustomDisplay(currentBookmarks);
      reindexBookmarkOrderByFolder();
      refreshBookmarkMetaOrderFromCurrent();
      await storage.saveBookmarks(currentBookmarks, currentFolders, currentSceneId);
      scheduleOrderSync();
      renderBookmarks(); // 重新渲染以应用新顺序
    });

    bookmarksGrid.addEventListener('dragend', () => {
      draggingBookmarkId = null;
    });
  }

  // 使用事件委托处理文件夹相关事件（避免重复绑定导致内存泄漏）
  if (foldersList) {
    // 文件夹行点击事件（筛选和展开/折叠）
    foldersList.addEventListener('click', async (e) => {
      const row = e.target.closest('.folder-row');
      if (!row) return;

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
        // 桌面端：仅执行筛选，不再切换展开/折叠（展开/折叠只由三角图标控制）
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

    // 展开/折叠按钮点击事件（移动端和桌面端都可用）
    foldersList.addEventListener('click', async (e) => {
      const btn = e.target.closest('.folder-expand-toggle');
      if (!btn) return;

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

    // 文件夹操作菜单按钮点击事件
    foldersList.addEventListener('click', (e) => {
      const btn = e.target.closest('.folder-menu');
      if (!btn) return;

      e.stopPropagation();
      const folderPath = btn.dataset.folder;
      openFolderMenu(btn, folderPath);
    });

    // 文件夹中书签链接点击事件
    foldersList.addEventListener('click', (e) => {
      const link = e.target.closest('.bookmark-in-folder a');
      if (!link) return;

      e.preventDefault();
      e.stopPropagation(); // 阻止事件冒泡到文件夹行
      const url = link.closest('.bookmark-in-folder')?.dataset.url;
      if (url) {
        tabsAPI.create({ url });
      }
    });

    // 拖拽排序事件
    foldersList.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.folder-row');
      if (!row) return;
      row.setAttribute('draggable', 'true');
      e.dataTransfer.setData('text/plain', row.dataset.folder);
    });

    foldersList.addEventListener('dragover', (e) => {
      const row = e.target.closest('.folder-row');
      if (row) {
        e.preventDefault();
      }
    });

    foldersList.addEventListener('drop', async (e) => {
      const row = e.target.closest('.folder-row');
      if (!row) return;
      e.preventDefault();
      const source = e.dataTransfer.getData('text/plain');
      const target = row.dataset.folder;
      if (!source || !target || source === target) return;
      reorderFolder(source, target);
      // 文件夹排序后，书签也要跟着排序（按新的文件夹顺序）
      currentBookmarks = sortBookmarksForCustomDisplay(currentBookmarks);
      refreshFolderMetaOrderFromCurrent();
      refreshBookmarkMetaOrderFromCurrent();
      await storage.saveBookmarks(currentBookmarks, currentFolders, currentSceneId);
      scheduleOrderSync();
      await loadBookmarks(); // 重新加载书签以显示新顺序
      await loadFolders();
      await loadTags();
    });
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
          const sceneName = (item.textContent || '').trim();
          // 与弹窗行为保持一致：点击场景后立即收起下拉列表
          sceneMenuEl.style.display = 'none';

          if (sceneId === currentSceneId) {
            return;
          }
          if (sceneSwitchBusyPage) {
            return;
          }

          sceneSwitchBusyPage = true;
          setBookmarkPageSceneSwitchUi(true, sceneName);

          try {
            await runBookmarkPageSceneSwitchTransition(async () => {
              // 切换场景：清空搜索框，避免跨场景残留（PC/移动端一致）
              try {
                if (searchInput) searchInput.value = '';
              } catch (_) {
                // ignore
              }

              await storage.saveCurrentScene(sceneId);
              currentSceneId = sceneId; // 立即更新，避免后续读取旧值

              // 检查 WebDAV 配置是否有效
              const config = await storage.getConfig();
              const hasValidConfig = config && config.serverUrl;
              // WebDAV配置有效：每次切换场景都从云端拉取最新，避免本地缓存覆盖浏览器定时同步写云结果
              if (hasValidConfig) {
                try {
                  await sendMessageCompat({ action: 'sync', sceneId });
                } catch (e) {
                  // 忽略单次同步失败，继续后续逻辑
                }
              }
              await loadCurrentScene();
              await loadScenes();
              await loadBookmarks({ lightLoading: true });
              await loadFolders();
              await loadTags();
              await sendMessageCompat({ action: 'sceneChanged' });
            });
          } finally {
            setBookmarkPageSceneSwitchUi(false);
            sceneSwitchBusyPage = false;
          }
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
/**
 * @param {{ lightLoading?: boolean }} [options] lightLoading 为 true 时不显示全屏主内容遮罩（场景切换轻反馈）
 */
async function loadBookmarks(options = {}) {
  const lightLoading = !!(options && options.lightLoading);
  try {
    if (!lightLoading) {
      const loadingEl = document.getElementById('mainLoadingOverlay');
      if (loadingEl) {
        loadingEl.style.display = 'flex';
      }
    }

    // 按当前场景过滤书签
    const data = await storage.getBookmarks(currentSceneId);
    const rawBookmarks = data.bookmarks || [];
    // 规范化书签文件夹路径
    currentBookmarks = rawBookmarks.map(b => {
      if (!b.folder) return b;
      return { ...b, folder: normalizeFolderPath(b.folder) };
    });

    // 规范化存储的文件夹列表（保留用户创建的空文件夹，保持顺序）
    // data.folders 应该只包含当前场景的文件夹（从 getBookmarks 返回的）
    const storedFolders = (data.folders || []).map(p => normalizeFolderPath(p || '')).filter(Boolean);
    const bookmarkFolders = currentBookmarks.map(b => b.folder).filter(Boolean);
    // 合并：保留所有存储的文件夹（包括空文件夹，保持顺序）+ 从书签中提取的文件夹
    const storedFoldersSet = new Set(storedFolders);
    const missing = [...new Set(bookmarkFolders)].filter(f => f && !storedFoldersSet.has(f));
    // 先保留存储的文件夹（保持顺序，包括空文件夹），再添加缺失的文件夹（不排序，保持顺序）
    const merged = [...storedFolders, ...missing];
    const dedup = [...new Set(merged)];
    // 确保 currentFolders 只包含当前场景的文件夹（防御性编程）
    // 从当前场景的书签中提取文件夹，确保不会包含其他场景的文件夹
    const currentSceneBookmarkFoldersSet = new Set(bookmarkFolders);
    currentFolders = dedup.filter(f => {
      // 保留：1) 在存储的文件夹列表中（这些应该是当前场景的）
      //       2) 在当前场景的书签中使用的文件夹
      return storedFoldersSet.has(f) || currentSceneBookmarkFoldersSet.has(f);
    });
    // 关键：补齐中间父级路径，确保树上可见但未显式存储的节点也参与排序（例如 "2.学习&娱乐"）
    currentFolders = expandFolderPathsPreserveOrder(currentFolders);

    // 加载/补齐书签排序元数据（按场景保存），并在 custom 模式下将 currentBookmarks 调整为“画面显示一致”的顺序
    try {
      const bm = await storage.getSceneBookmarkMeta(currentSceneId);
      const existing = Array.isArray(bm && bm.order) ? bm.order.filter(Boolean) : [];
      const idsInData = currentBookmarks.map(b => b && b.id).filter(Boolean);
      const idSet = new Set(idsInData);
      const dedupSeen = new Set();
      const nextOrder = [];
      existing.forEach((id) => {
        if (!idSet.has(id) || dedupSeen.has(id)) return;
        dedupSeen.add(id);
        nextOrder.push(id);
      });
      idsInData.forEach((id) => {
        if (!id || dedupSeen.has(id)) return;
        dedupSeen.add(id);
        nextOrder.push(id);
      });
      currentBookmarkMeta = { order: nextOrder };
      await storage.saveSceneBookmarkMeta(currentSceneId, currentBookmarkMeta);

      if (currentSort === 'custom') {
        // 最新策略：文件夹顺序 + 每个文件夹内书签 order 字段
        const folderRank = new Map();
        currentFolders.forEach((p, idx) => folderRank.set(normalizeFolderPath(p), idx));
        // 兜底：没有 order 的书签按当前数组顺序补齐（同 folder 内）
        const originalIdx = new Map();
        currentBookmarks.forEach((b, i) => {
          if (b && b.id) originalIdx.set(b.id, i);
        });
        currentBookmarks = [...currentBookmarks].sort((a, b) => {
          const af = getBookmarkFolderKey(a);
          const bf = getBookmarkFolderKey(b);
          if (af !== bf) {
            const ai = folderRank.has(af) ? folderRank.get(af) : Number.MAX_SAFE_INTEGER;
            const bi = folderRank.has(bf) ? folderRank.get(bf) : Number.MAX_SAFE_INTEGER;
            if (ai !== bi) return ai - bi;
            return af.localeCompare(bf);
          }
          const ao = typeof a.order === 'number' ? a.order : Number.MAX_SAFE_INTEGER;
          const bo = typeof b.order === 'number' ? b.order : Number.MAX_SAFE_INTEGER;
          if (ao !== bo) return ao - bo;
          return (originalIdx.get(a.id) || 0) - (originalIdx.get(b.id) || 0);
        });
        // 确保 order 字段与当前顺序一致并落盘
        reindexBookmarkOrderByFolder();
      }
    } catch (_) {
      currentBookmarkMeta = { order: currentBookmarks.map(b => b && b.id).filter(Boolean) };
    }

    // 加载/补齐文件夹主键元数据（按场景保存）
    try {
      const meta = await storage.getSceneFolderMeta(currentSceneId);
      const byId = (meta && meta.byId && typeof meta.byId === 'object') ? meta.byId : {};
      const pathToId = new Map();
      Object.keys(byId).forEach((id) => {
        const p = normalizeFolderPath(byId[id] && byId[id].path);
        if (p) pathToId.set(p, id);
      });

      const nextById = { ...byId };
      const nextOrder = [];
      currentFolders.forEach((p) => {
        const np = normalizeFolderPath(p);
        if (!np) return;
        let id = pathToId.get(np);
        if (!id) {
          id = storage.generateStableFolderId(np, currentSceneId);
          const name = np.indexOf('/') >= 0 ? np.slice(np.lastIndexOf('/') + 1) : np;
          nextById[id] = { path: np, name };
          pathToId.set(np, id);
        } else {
          const name = np.indexOf('/') >= 0 ? np.slice(np.lastIndexOf('/') + 1) : np;
          nextById[id] = { ...(nextById[id] || {}), path: np, name };
        }
        nextOrder.push(id);
      });

      currentFolderMeta = { order: nextOrder, byId: nextById };
      currentFolderIdByPath = pathToId;
      await storage.saveSceneFolderMeta(currentSceneId, currentFolderMeta);
    } catch (_) {
      currentFolderMeta = { order: [], byId: {} };
      currentFolderIdByPath = new Map();
    }
    // 书签绑定 folderId，并补齐旧数据的 order 字段
    ensureBookmarkFolderIdAndOrder();

    // 注意：不再在这里排序，因为：
    // 1. 保存时已经确保数据按文件夹顺序排列（添加、编辑、删除、批量操作都会排序）
    // 2. 从云端同步来的数据在后台已经按文件夹顺序排列（如果后台实现了排序）
    // 3. 如果数据已经是按文件夹顺序的，这里排序是多余的
    // 4. 如果数据不是按文件夹顺序的（比如从旧版本升级），在首次操作时会自动排序

    renderBookmarks();
  } catch (error) {
    console.error('加载书签失败:', error);
  } finally {
    if (!lightLoading) {
      const loadingEl = document.getElementById('mainLoadingOverlay');
      if (loadingEl) {
        loadingEl.style.display = 'none';
      }
    }
  }
}

/**
 * 管理页场景切换轻反馈（方案 B）
 */
function setBookmarkPageSceneSwitchUi(loading, sceneName) {
  const btn = document.getElementById('sceneSwitchBtn');
  const bar = document.getElementById('sceneSwitchingBar');
  const textEl = document.getElementById('sceneSwitchingBarText');
  if (btn) {
    if (loading) {
      btn.classList.add('is-scene-loading');
      btn.setAttribute('aria-busy', 'true');
      btn.disabled = true;
    } else {
      btn.classList.remove('is-scene-loading');
      btn.removeAttribute('aria-busy');
      btn.disabled = false;
    }
  }
  if (bar && textEl) {
    if (loading) {
      bar.classList.remove('scene-switching-bar--collapsed');
      bar.classList.add('scene-switching-bar--open');
      textEl.textContent = sceneName
        ? `正在切换到「${sceneName}」，正在同步数据…`
        : '正在切换场景…';
    } else {
      bar.classList.remove('scene-switching-bar--open');
      bar.classList.add('scene-switching-bar--collapsed');
      textEl.textContent = '';
    }
  }
}

function prefersReducedMotionBookmarks() {
  try {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) {
    return false;
  }
}

function sleepBookmarks(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForAnimationEndBookmarks(el, animationName, fallbackMs) {
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

async function nextPaintBookmarks() {
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
}

/**
 * 与 bookmarks.css 场景过渡一致；纯 DOM/CSS，与 manifest_version 2/3 无关。
 */
const SCENE_PAGE_FADE_OUT_MS = 520;
const SCENE_PAGE_FADE_IN_FALLBACK_MS = 720;

/**
 * 管理页场景切换：先完整淡出 → 再加载数据 → 再淡入（避免慢同步时长时间卡在透明空白）
 */
async function runBookmarkPageSceneSwitchTransition(workFn) {
  const container = document.querySelector('.bookmarks-container');
  if (!container || prefersReducedMotionBookmarks()) {
    await workFn();
    return;
  }
  container.classList.remove('scene-switch-fade-in');
  container.classList.add('scene-switch-fade-out');
  await nextPaintBookmarks();
  try {
    await sleepBookmarks(SCENE_PAGE_FADE_OUT_MS);
    await workFn();
  } catch (e) {
    container.classList.remove('scene-switch-fade-out', 'scene-switch-fade-in');
    throw e;
  }
  if (typeof container.classList.replace === 'function') {
    container.classList.replace('scene-switch-fade-out', 'scene-switch-fade-in');
  } else {
    container.classList.remove('scene-switch-fade-out');
    container.classList.add('scene-switch-fade-in');
  }
  await waitForAnimationEndBookmarks(container, 'bookmarksSceneGridIn', SCENE_PAGE_FADE_IN_FALLBACK_MS);
  container.classList.remove('scene-switch-fade-in');
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
      chrome.storage.local.set(state, () => { });
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
  // 并补齐中间父级路径，保证树节点与排序逻辑一致
  const folders = expandFolderPathsPreserveOrder([...normalizedCurrentFolders, ...normalizedBookmarkFolders]);

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

  // 初始化完成后，标记已初始化
  if (!foldersInitialized) {
    foldersInitialized = true; // 标记已初始化
  }

  // 设置拖拽属性（事件委托已在 setupEventListeners 中处理）
  foldersList.querySelectorAll('.folder-row').forEach(row => {
    row.setAttribute('draggable', 'true');
  });

  // 注意：上下移动功能通过文件夹菜单（.folder-menu）中的菜单项处理，
  // 不需要在这里绑定事件（菜单项的事件在 openFolderMenu 函数中处理）
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
            <button class="folder-expand-toggle" data-folder="${escapeHtml(child.path)}" title="${expanded ? '折叠' : '展开'}">
              ${expanded ? '▼' : '▶'}
            </button>
            <span class="folder-label" data-folder="${escapeHtml(child.path)}" title="${escapeHtml(child.path)}">
              <span class="folder-label-text">${icon} ${escapeHtml(child.name)}</span>
              <span class="folder-count">${totalCount}</span>
            </span>
            <button class="folder-menu" data-folder="${escapeHtml(child.path)}" title="操作">⋯</button>
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
 * 路径一律规范化后再匹配，避免 dataset/树节点路径与书签内 folder 字符串不一致导致书签未更新、云端仍存旧路径。
 */
async function renameFolderPath(oldPath, newPath) {
  // 显示全局加载遮罩
  showGlobalLoading('正在重命名文件夹…');

  try {
    await ensureSceneFreshFromCloudBeforeWrite();
    const normOld = normalizeFolderPath(oldPath);
    const normNew = normalizeFolderPath(newPath);
    if (!normNew || normOld === normNew) return;

    if (currentBookmarks.some(b => normalizeFolderPath(b.folder) === normNew)) {
      const proceed = confirm('目标路径已存在同名文件夹，是否继续移动？');
      if (!proceed) return;
    }

    currentBookmarks = currentBookmarks.map(b => {
      if (!b.folder) return b;
      const bf = normalizeFolderPath(b.folder);
      if (bf === normOld) {
        return { ...b, folder: normNew };
      }
      if (bf.startsWith(normOld + '/')) {
        const suffix = bf.slice(normOld.length);
        return { ...b, folder: normNew + suffix };
      }
      return b;
    });

    // 更新文件夹列表：保留所有现有文件夹（包括空文件夹），并更新重命名的文件夹路径
    const bookmarkFolders = [...new Set(currentBookmarks.map(b => b.folder).filter(f => f))];
    currentFolders = currentFolders.map(f => {
      const nf = normalizeFolderPath(f);
      if (nf === normOld) {
        return normNew; // 重命名文件夹
      }
      if (nf.startsWith(normOld + '/')) {
        return normNew + nf.slice(normOld.length); // 重命名子文件夹
      }
      return f; // 保留其他文件夹（含未规范化的展示用字符串，下一轮 load 会规范）
    });
    // 合并：更新后的文件夹列表 + 从书签中提取的文件夹（确保不丢失）
    currentFolders = [...new Set([...currentFolders, ...bookmarkFolders])];

    // 迁移 folderId 映射：同一文件夹（及子文件夹）改名/移动后保持原 folderId 不变
    try {
      const nextById = { ...(currentFolderMeta && currentFolderMeta.byId ? currentFolderMeta.byId : {}) };
      Object.keys(nextById).forEach((id) => {
        const p = normalizeFolderPath(nextById[id] && nextById[id].path);
        if (!p) return;
        if (p === normOld) {
          nextById[id] = { ...(nextById[id] || {}), path: normNew, name: normNew.slice(normNew.lastIndexOf('/') + 1) };
        } else if (p.startsWith(normOld + '/')) {
          const np = normNew + p.slice(normOld.length);
          nextById[id] = { ...(nextById[id] || {}), path: np, name: np.slice(np.lastIndexOf('/') + 1) };
        }
      });
      currentFolderMeta = { ...(currentFolderMeta || { order: [], byId: {} }), byId: nextById };
      const map = new Map();
      Object.keys(nextById).forEach((id) => {
        const p = normalizeFolderPath(nextById[id] && nextById[id].path);
        if (p) map.set(p, id);
      });
      currentFolderIdByPath = map;
    } catch (_) { }

    // 如果是自定义排序模式，确保移动/重命名后仍按文件夹顺序排列
    if (typeof storage.expandFolderPathsPreserveOrder === 'function') {
      currentFolders = storage.expandFolderPathsPreserveOrder(currentFolders);
    }
    
    if (currentSort === 'custom') {
      currentBookmarks = sortBookmarksForCustomDisplay(currentBookmarks);
    }

    // 1. 保存到本地
    refreshBookmarkMetaOrderFromCurrent();
    refreshFolderMetaOrderFromCurrent();
    await storage.saveBookmarks(currentBookmarks, currentFolders, currentSceneId);

    // 2. 等待上传到云端完成，避免用户立刻切场景时仍拉取旧文件导致「改名被还原」
    try {
      const renamedBookmarkIds = currentBookmarks
        .filter((b) => {
          const bf = normalizeFolderPath(b && b.folder);
          return !!bf && (bf === normNew || bf.startsWith(normNew + '/'));
        })
        .map(b => b.id)
        .filter(Boolean);
      const renamedFolderIds = Object.keys((currentFolderMeta && currentFolderMeta.byId) ? currentFolderMeta.byId : {})
        .filter((id) => {
          const row = currentFolderMeta.byId[id];
          const p = normalizeFolderPath(row && row.path);
          return !!p && (p === normNew || p.startsWith(normNew + '/'));
        });
      // 关键：文件夹“重命名”在云端合并逻辑里不会自动删除旧 folders（云端 folders 作为底座保留）
      // 因此这里显式把旧目录树当作 deletedFolderPaths 传给云端，移除旧路径并让新路径在合并时生效。
      await syncToCloud({
        deletedFolderPaths: [normOld],
        requireSuccess: true,
        patch: {
          bookmarkUpserts: renamedBookmarkIds,
          folderUpserts: renamedFolderIds,
          folderOrderIds: (currentFolderMeta && Array.isArray(currentFolderMeta.order)) ? [...currentFolderMeta.order] : []
        }
      });
    } catch (err) {
      console.error('重命名后同步到云端失败:', err);
      const msg = err && err.message ? err.message : String(err);
      showToast(`文件夹已保存到本地，但同步到云端失败：${msg}`, { title: '同步失败', type: 'error', duration: 5000 });
    }

    // 3. 刷新 UI
    await loadBookmarks();
    await loadFolders();
    await loadTags();
  } catch (error) {
    console.error('重命名文件夹失败:', error);
    alert('重命名文件夹失败: ' + error.message);
  } finally {
    // 隐藏全局加载遮罩
    hideGlobalLoading();
  }
}

/**
 * 只重命名文件夹名称（不改变父级路径）
 */
async function renameFolderName(folderPath, newName) {
  if (!folderPath || !newName || !newName.trim()) return;

  // 提取父级路径和当前文件夹名称
  const lastSlashIndex = folderPath.lastIndexOf('/');
  const parentPath = lastSlashIndex >= 0 ? folderPath.substring(0, lastSlashIndex) : '';
  const newPath = parentPath ? `${parentPath}/${newName.trim()}` : newName.trim();
  const normalizedNewPath = normalizeFolderPath(newPath);
  const normalizedOldPath = normalizeFolderPath(folderPath);

  if (normalizedNewPath === normalizedOldPath) return; // 名称未改变

  if (currentBookmarks.some(b => normalizeFolderPath(b.folder) === normalizedNewPath)) {
    const proceed = confirm('目标路径已存在同名文件夹，是否继续重命名？');
    if (!proceed) return;
  }

  await renameFolderPath(normalizedOldPath, normalizedNewPath);
}

/**
 * 移动文件夹到新的父级（保持文件夹名称不变）
 */
async function moveFolderToParent(folderPath, newParentPath) {
  if (!folderPath) return;

  const normFrom = normalizeFolderPath(folderPath);

  // 提取当前文件夹名称
  const lastSlashIndex = normFrom.lastIndexOf('/');
  const folderName = lastSlashIndex >= 0 ? normFrom.substring(lastSlashIndex + 1) : normFrom;

  // 构建新路径
  const newPath = newParentPath ? `${newParentPath}/${folderName}` : folderName;
  const normalizedNewPath = normalizeFolderPath(newPath);

  if (normalizedNewPath === normFrom) return; // 位置未改变

  // 检查是否移动到自己的子文件夹中（不允许）
  if (normalizedNewPath.startsWith(normFrom + '/')) {
    alert('不能将文件夹移动到自己的子文件夹中');
    return;
  }

  if (currentBookmarks.some(b => normalizeFolderPath(b.folder) === normalizedNewPath)) {
    const proceed = confirm('目标路径已存在同名文件夹，是否继续移动？');
    if (!proceed) return;
  }

  await renameFolderPath(normFrom, normalizedNewPath);
}

/**
 * 新增文件夹
 */
async function handleAddFolder() {
  const path = prompt('请输入文件夹路径（用/分隔，如：项目/前端/UI）') || '';
  const normalized = normalizeFolderPath(path);
  if (!normalized) return;

  // 显示全局加载遮罩
  showGlobalLoading('正在创建文件夹…');

  try {
    await ensureSceneFreshFromCloudBeforeWrite();
    if (currentFolders.includes(normalized)) {
      alert('该文件夹已存在');
      return;
    }
    currentFolders = insertFolderPathSmart(currentFolders, normalized);
    currentFolders = expandFolderPathsPreserveOrder(currentFolders);
    // 1. 保存到本地
    refreshBookmarkMetaOrderFromCurrent();
    refreshFolderMetaOrderFromCurrent();
    await storage.saveBookmarks(currentBookmarks, currentFolders, currentSceneId);

    // 2. 异步同步到云端（不仅同步当前文件夹，也包括其所有自动补齐的父级，确保云端路径树完整）
    const folderUpserts = [];
    normalized.split('/').reduce((prev, curr) => {
      const p = prev ? `${prev}/${curr}` : curr;
      const fid = currentFolderIdByPath.get(p);
      if (fid) folderUpserts.push(fid);
      return p;
    }, '');

    syncToCloud({
      patch: {
        folderUpserts,
        folderOrderIds: (currentFolderMeta && Array.isArray(currentFolderMeta.order)) ? [...currentFolderMeta.order] : []
      }
    }).catch(err => console.error('新增文件夹后台同步失败:', err));

    // 3. 立即刷新 UI
    await loadFolders();
    await loadTags();
  } catch (error) {
    console.error('创建文件夹失败:', error);
    alert('创建文件夹失败: ' + error.message);
  } finally {
    // 隐藏全局加载遮罩
    hideGlobalLoading();
  }
}

/**
 * 删除文件夹（删除其下书签）
 */
async function deleteFolderPath(folderPath) {
  // 显示全局加载遮罩
  showGlobalLoading('正在删除文件夹…');

  try {
    await ensureSceneFreshFromCloudBeforeWrite();
    const normalizedRoot = normalizeFolderPath(folderPath);
    // 删除该文件夹及子文件夹下的书签
    currentBookmarks = currentBookmarks.filter(b => {
      if (!b.folder) return true;
      const bf = normalizeFolderPath(b.folder);
      if (bf === normalizedRoot || bf.startsWith(normalizedRoot + '/')) {
        return false;
      }
      return true;
    });
    // 删除文件夹记录
    currentFolders = currentFolders.filter(f => {
      const nf = normalizeFolderPath(f);
      return nf !== normalizedRoot && !nf.startsWith(normalizedRoot + '/');
    });
    // 1. 保存到本地
    refreshBookmarkMetaOrderFromCurrent();
    refreshFolderMetaOrderFromCurrent();
    await storage.saveBookmarks(currentBookmarks, currentFolders, currentSceneId);

    // 2. 异步同步到云端（先拉云端再合并时，用 deletedFolderPaths 去掉该目录树在云端的书签与空文件夹）
    const deletedFolderIds = Object.keys((currentFolderMeta && currentFolderMeta.byId) ? currentFolderMeta.byId : {}).filter((id) => {
      const row = currentFolderMeta.byId[id];
      const p = normalizeFolderPath(row && row.path);
      return !!p && (p === normalizedRoot || p.startsWith(normalizedRoot + '/'));
    });
    syncToCloud({ deletedFolderPaths: [normalizedRoot], patch: { folderDeletes: deletedFolderIds } }).catch(err =>
      console.error('删除文件夹后台同步失败:', err)
    );

    // 3. 刷新 UI
    await loadBookmarks();
    await loadFolders();
    await loadTags();
  } catch (error) {
    console.error('删除文件夹失败:', error);
    alert('删除文件夹失败: ' + error.message);
  } finally {
    // 隐藏全局加载遮罩
    hideGlobalLoading();
  }
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
      <span>重命名</span>
    </div>
    <div class="folder-menu-item" data-action="move">
      <span style="font-size: 16px;">📂</span>
      <span>移动到</span>
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
        await ensureSceneFreshFromCloudBeforeWrite();
        if (currentFolders.includes(newPath)) {
          alert('该文件夹已存在');
          return;
        }
        currentFolders = insertFolderPathSmart(currentFolders, newPath);
        currentFolders = expandFolderPathsPreserveOrder(currentFolders);
        // 1. 保存到本地
        await storage.saveBookmarks(currentBookmarks, currentFolders, currentSceneId);

        // 2. 异步同步到云端
        syncToCloud({
          patch: {
            folderUpserts: [currentFolderIdByPath.get(newPath)].filter(Boolean),
            folderOrderIds: (currentFolderMeta && Array.isArray(currentFolderMeta.order)) ? [...currentFolderMeta.order] : []
          }
        }).catch(err => console.error('菜单新增子文件夹后台同步失败:', err));

        // 3. 刷新 UI
        await loadFolders();
        await loadTags();
      } else if (action === 'rename') {
        // 只重命名文件夹名称，不改变父级
        const lastSlashIndex = folderPath.lastIndexOf('/');
        const currentName = lastSlashIndex >= 0 ? folderPath.substring(lastSlashIndex + 1) : folderPath;
        const newName = prompt('请输入新的文件夹名称', currentName) || '';
        if (!newName.trim() || newName.trim() === currentName) return;
        await renameFolderName(folderPath, newName.trim());
        await loadBookmarks();
        await loadFolders();
        await loadTags();
      } else if (action === 'move') {
        // 移动到新的父级文件夹
        menu.remove();
        document.removeEventListener('click', closeMenu);

        // 获取当前文件夹的父级路径
        const lastSlashIndex = folderPath.lastIndexOf('/');
        const currentParentPath = lastSlashIndex >= 0 ? folderPath.substring(0, lastSlashIndex) : '';

        // 显示文件夹选择对话框，排除当前文件夹及其子文件夹
        const targetParentPath = await showFolderSelectDialog({ excludeFolderPath: folderPath });
        if (targetParentPath === null) return; // 用户取消

        // 如果选择的父级路径和当前相同，不执行移动
        const normalizedTargetParent = targetParentPath.trim() ? normalizeFolderPath(targetParentPath) : '';
        if (normalizedTargetParent === currentParentPath) return;

        await moveFolderToParent(folderPath, normalizedTargetParent);
        await loadBookmarks();
        await loadFolders();
        await loadTags();
        return; // 已经关闭菜单，直接返回
      } else if (action === 'move-up' || action === 'move-down') {
        const dir = action === 'move-up' ? -1 : 1;
        await ensureSceneFreshFromCloudBeforeWrite();
        const moved = moveFolderSameLevel(folderPath, dir);
        if (!moved) return;
        // 文件夹排序后，书签也要跟着排序（按新的文件夹顺序）
        currentBookmarks = sortBookmarksForCustomDisplay(currentBookmarks);
        await storage.saveBookmarks(currentBookmarks, currentFolders, currentSceneId);
        scheduleOrderSync();
        await loadBookmarks(); // 重新加载书签以显示新顺序
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
  currentFolders = moveFolderBlock(currentFolders, source, { before: target });
}

// 以“子树块”为单位移动文件夹，保证移动父文件夹时子文件夹一并移动，并且不会误伤其它块
function moveFolderBlock(list, srcRoot, { before = null, after = null } = {}) {
  const src = normalizeFolderPath(srcRoot || '');
  const refBefore = normalizeFolderPath(before || '');
  const refAfter = normalizeFolderPath(after || '');
  if (!src) return Array.isArray(list) ? list : [];
  if (refBefore && refAfter) return Array.isArray(list) ? list : [];
  const ref = refBefore || refAfter;
  if (ref && src === ref) return Array.isArray(list) ? list : [];

  const srcPrefix = src + '/';
  const srcBlock = [];
  const rest = [];
  (Array.isArray(list) ? list : []).forEach((p) => {
    if (p === src || (typeof p === 'string' && p.startsWith(srcPrefix))) {
      srcBlock.push(p);
    } else {
      rest.push(p);
    }
  });
  if (srcBlock.length === 0) return Array.isArray(list) ? list : [];

  // 没有参照：追加
  if (!ref) {
    return expandFolderPathsPreserveOrder([...rest, ...srcBlock]);
  }

  const insertAt = rest.indexOf(ref);
  if (insertAt === -1) {
    return expandFolderPathsPreserveOrder([...rest, ...srcBlock]);
  }

  if (refBefore) {
    return expandFolderPathsPreserveOrder([
      ...rest.slice(0, insertAt),
      ...srcBlock,
      ...rest.slice(insertAt)
    ]);
  }

  // after：插到 ref 的“子树块”之后（即 ref 及其后代之后）
  const refPrefix = ref + '/';
  let afterIdx = insertAt;
  for (let i = insertAt; i < rest.length; i++) {
    const p = rest[i];
    if (p === ref || (typeof p === 'string' && p.startsWith(refPrefix))) {
      afterIdx = i;
    } else {
      break;
    }
  }
  return expandFolderPathsPreserveOrder([
    ...rest.slice(0, afterIdx + 1),
    ...srcBlock,
    ...rest.slice(afterIdx + 1)
  ]);
}

/**
 * 重排书签顺序（自定义排序拖拽）
 */
function reorderBookmarksById(sourceId, targetId) {
  const srcIdx = currentBookmarks.findIndex(b => b.id === sourceId);
  const tgtIdx = currentBookmarks.findIndex(b => b.id === targetId);
  if (srcIdx === -1 || tgtIdx === -1) {
    console.warn('[书签排序] 未找到拖拽目标', { sourceId, targetId, srcIdx, tgtIdx });
    return false;
  }
  // 最新策略：书签排序字段按“同文件夹内”维护；跨文件夹拖拽不在此处处理（避免破坏分组）
  const srcFolder = getBookmarkFolderKey(currentBookmarks[srcIdx]);
  const tgtFolder = getBookmarkFolderKey(currentBookmarks[tgtIdx]);
  if (srcFolder !== tgtFolder) {
    console.warn('[书签排序] 跨文件夹拖拽已忽略（请用移动功能）', { sourceId, targetId, srcFolder, tgtFolder });
    return false;
  }
  const newOrder = [...currentBookmarks];
  const [item] = newOrder.splice(srcIdx, 1);
  const adjustedTarget = srcIdx < tgtIdx ? tgtIdx - 1 : tgtIdx;
  newOrder.splice(adjustedTarget, 0, item);
  currentBookmarks = newOrder;
  // 同文件夹内重排 order 字段，确保刷新/上云后一致
  reindexBookmarkOrderByFolder();
  return true;
}

function moveBookmarkByDirection(bookmarkId, direction) {
  const idx = currentBookmarks.findIndex(b => b.id === bookmarkId);
  if (idx === -1) return false;
  const targetIdx = idx + direction;
  if (targetIdx < 0 || targetIdx >= currentBookmarks.length) {
    showToast && showToast(direction < 0 ? '已经是最上面的书签了' : '已经是最下面的书签了', {
      title: '无法移动',
      type: 'info',
      duration: 1500
    });
    return false;
  }
  const newOrder = [...currentBookmarks];
  [newOrder[idx], newOrder[targetIdx]] = [newOrder[targetIdx], newOrder[idx]];
  currentBookmarks = newOrder;
  // 自定义排序：按文件夹顺序 + order 字段保持显示一致
  if (currentSort === 'custom') {
    currentBookmarks = sortBookmarksForCustomDisplay(currentBookmarks);
  }
  return true;
}

function moveFolderSameLevel(folderPath, direction) {
  console.log('[文件夹排序] 请求同层级移动', {
    folderPath,
    direction,
    currentFoldersSnapshot: [...currentFolders]
  });
  const parent = getParentFolder(folderPath);

  // 只把“同层级的根节点”当作兄弟（currentFolders 中的后代路径 parent 不等于该 parent，会被自动排除）
  const siblings = currentFolders.filter(f => getParentFolder(f) === parent);
  const pos = siblings.indexOf(folderPath);
  if (pos === -1) {
    console.warn('[文件夹排序] 未找到同层级位置，无法移动', {
      folderPath,
      parent,
      siblings
    });
    return false;
  }
  const targetPos = pos + direction;
  if (targetPos < 0 || targetPos >= siblings.length) {
    console.log('[文件夹排序] 已在边界，无法继续移动', {
      folderPath,
      direction,
      pos,
      targetPos,
      siblingCount: siblings.length
    });
    // 非阻断提示一下，让用户知道为什么“没反应”
    showToast && showToast(direction < 0 ? '已经是最上面的文件夹了' : '已经是最下面的文件夹了', {
      title: '无法移动',
      type: 'info',
      duration: 1500
    });
    return false;
  }

  const targetSibling = siblings[targetPos];
  // 用严格的块移动代替“块交换”，避免频繁操作时出现误差把无关块带跑
  if (direction < 0) {
    currentFolders = moveFolderBlock(currentFolders, folderPath, { before: targetSibling });
  } else {
    currentFolders = moveFolderBlock(currentFolders, folderPath, { after: targetSibling });
  }
  console.log('[文件夹排序] 同层级移动完成', {
    folderPath,
    direction,
    newOrder: [...currentFolders]
  });
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
 * 写操作前拉取云端最新到本地并刷新内存（与先本地保存再 syncToCloud 的书签增删改/收藏一致）
 */
async function ensureSceneFreshFromCloudBeforeWrite() {
  try {
    const res = await sendMessageCompat({ action: 'sync', sceneId: currentSceneId });
    if (res && res.success === false) {
      console.warn('[写前同步] 拉取云端失败，继续基于当前本地数据操作:', res.error);
    }
  } catch (e) {
    console.warn('[写前同步] 拉取云端异常，继续基于当前本地数据操作:', e?.message || e);
  }
  await loadBookmarks({ lightLoading: true });
  await loadFolders();
  await loadTags();
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

  // 应用排序（自定义排序 custom 时保持当前顺序，不再二次排序）
  if (currentSort !== 'custom') {
    // 先按文件夹分组排序，然后在每个文件夹内排序
    filtered.sort((a, b) => {
      const aFolder = normalizeFolderPath(a.folder || '');
      const bFolder = normalizeFolderPath(b.folder || '');

      // 如果文件夹不同，按文件夹在文件夹列表中的顺序排序
      if (aFolder !== bFolder) {
        const aFolderIndex = currentFolders.indexOf(aFolder);
        const bFolderIndex = currentFolders.indexOf(bFolder);

        // 如果文件夹不在列表中，放到最后
        if (aFolderIndex === -1 && bFolderIndex === -1) {
          // 都不在列表中，按文件夹路径字符串排序
          return aFolder.localeCompare(bFolder);
        }
        if (aFolderIndex === -1) return 1;
        if (bFolderIndex === -1) return -1;

        return aFolderIndex - bFolderIndex;
      }

      // 文件夹相同，按选择的排序方式排序
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
  }

  // 渲染
  if (filtered.length === 0) {
    bookmarksGrid.innerHTML = '';
    emptyState.style.display = 'block';
  } else {
    emptyState.style.display = 'none';
    bookmarksGrid.innerHTML = filtered.map(bookmark => renderBookmarkCard(bookmark)).join('');

    // 自定义排序模式下允许拖拽书签卡片
    bookmarksGrid.querySelectorAll('.bookmark-card').forEach(card => {
      if (currentSort === 'custom' && !batchMode) {
        card.setAttribute('draggable', 'true');
      } else {
        card.removeAttribute('draggable');
      }
    });


    // 添加事件监听
    bookmarksGrid.querySelectorAll('.bookmark-card').forEach(card => {
      const bookmarkId = card.dataset.id;
      const bookmark = currentBookmarks.find(b => b.id === bookmarkId);

      // 处理 favicon 图片加载错误（Firefox CSP 要求，不能使用内联 onerror）
      const faviconImg = card.querySelector('.bookmark-favicon[data-fallback-icon]');
      if (faviconImg) {
        faviconImg.addEventListener('error', function () {
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
        // 点击卡片打开网站（排除详情按钮）
        card.querySelector('.bookmark-info').addEventListener('click', (e) => {
          if (e.target.classList.contains('bookmark-detail-btn')) {
            return;
          }
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
        // 移动（移动端自定义排序）
        const moveUpBtn = card.querySelector('.move-up-btn');
        const moveDownBtn = card.querySelector('.move-down-btn');
        if (currentSort === 'custom' && !batchMode) {
          if (moveUpBtn) {
            moveUpBtn.addEventListener('click', async (e) => {
              e.stopPropagation();
              await ensureSceneFreshFromCloudBeforeWrite();
              const moved = moveBookmarkByDirection(bookmarkId, -1);
              if (moved) {
        reindexBookmarkOrderByFolder();
        currentBookmarks = sortBookmarksForCustomDisplay(currentBookmarks);
                await storage.saveBookmarks(currentBookmarks, currentFolders, currentSceneId);
        refreshBookmarkMetaOrderFromCurrent();
                scheduleOrderSync();
                renderBookmarks();
              }
            });
          }
          if (moveDownBtn) {
            moveDownBtn.addEventListener('click', async (e) => {
              e.stopPropagation();
              await ensureSceneFreshFromCloudBeforeWrite();
              const moved = moveBookmarkByDirection(bookmarkId, 1);
              if (moved) {
        reindexBookmarkOrderByFolder();
        currentBookmarks = sortBookmarksForCustomDisplay(currentBookmarks);
                await storage.saveBookmarks(currentBookmarks, currentFolders, currentSceneId);
        refreshBookmarkMetaOrderFromCurrent();
                scheduleOrderSync();
                renderBookmarks();
              }
            });
          }
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
  const showMobileReorder = currentSort === 'custom' && !batchMode && isMobileView();

  return `
    <div class="bookmark-card ${bookmark.starred ? 'starred' : ''} ${isSelected ? 'selected' : ''}" data-id="${bookmark.id}">
      ${batchMode ? `
        <div class="bookmark-checkbox">
          <input type="checkbox" class="bookmark-select-checkbox" data-id="${bookmark.id}" ${isSelected ? 'checked' : ''}>
        </div>
      ` : ''}
      ${showMobileReorder ? `
        <div class="bookmark-reorder-mobile">
          <button class="action-btn move-up-btn" title="上移">⬆️</button>
          <button class="action-btn move-down-btn" title="下移">⬇️</button>
        </div>
      ` : ''}
      <div class="bookmark-header">
        ${viewOptions.showIcon ? `<img src="${favicon}" alt="" class="bookmark-favicon" data-fallback-icon>` : ''}
        <div class="bookmark-info">
          <div class="bookmark-title">
            <span class="bookmark-title-text">${escapeHtml(bookmark.title || '无标题')}</span>
            <button class="bookmark-detail-btn" data-id="${bookmark.id}" title="查看详情">ℹ️</button>
          </div>
          ${viewOptions.showUrl ? `<div class="bookmark-url">${escapeHtml(domain || bookmark.url)}</div>` : ''}
        </div>
        <div class="bookmark-header-right">
          <div class="bookmark-actions" style="${batchMode ? 'display: none;' : ''}">
            <button class="action-btn edit-btn" title="编辑">✏️</button>
            <button class="action-btn delete-btn" title="删除">🗑️</button>
          </div>
          <div class="bookmark-star">${bookmark.starred ? '⭐' : '☆'}</div>
        </div>
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
  updateModalHeader('add', data);
  bookmarkForm.reset();

  if (data.url) {
    document.getElementById('bookmarkUrl').value = data.url;
  }
  if (data.title) {
    document.getElementById('bookmarkTitle').value = data.title;
  }

  // 加载文件夹选项
  loadFolderOptions();

  if (modalFormScroll) {
    modalFormScroll.scrollTop = 0;
  }
  showModalActionBarImmediately();
  bookmarkModal.style.display = 'flex';
  const titleInput = document.getElementById('bookmarkTitle');
  if (titleInput) {
    requestAnimationFrame(() => titleInput.focus());
  }
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
  updateModalHeader('edit', bookmark);

  document.getElementById('bookmarkTitle').value = bookmark.title || '';
  document.getElementById('bookmarkUrl').value = bookmark.url || '';
  document.getElementById('bookmarkDescription').value = bookmark.description || '';
  document.getElementById('bookmarkNotes').value = bookmark.notes || '';
  document.getElementById('bookmarkTags').value = bookmark.tags ? bookmark.tags.join(', ') : '';
  document.getElementById('bookmarkStarred').checked = bookmark.starred || false;

  loadFolderOptions(bookmark.folder);

  if (modalFormScroll) {
    modalFormScroll.scrollTop = 0;
  }
  showModalActionBarImmediately();
  bookmarkModal.style.display = 'flex';
  const titleInput = document.getElementById('bookmarkTitle');
  if (titleInput) {
    requestAnimationFrame(() => titleInput.focus());
  }
}

/**
 * 构建文件夹树结构
 */
function buildFolderTreeForSelect(folders) {
  const root = { name: '', path: '', children: {}, order: [] };
  folders.forEach(folder => {
    const parts = folder.split('/');
    let node = root;
    let currentPath = '';
    parts.forEach(part => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!node.children[part]) {
        node.children[part] = { name: part, path: currentPath, children: {}, order: [] };
        node.order.push(part);
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

  // 递归渲染子节点（尊重 order 数组中的顺序）
  const order = node.order || [];
  order.forEach(name => {
    const child = node.children[name];
    if (child) {
      html += renderFolderTreeOptions(child, level + 1, selected);
    }
  });

  return html;
}

/**
 * 加载文件夹选项（优化版：树形结构）
 * 包含从书签中提取的文件夹和 currentFolders 中的文件夹（确保空文件夹也能显示）
 * 注意：只显示当前场景的文件夹，不显示其他场景的文件夹
 */
function loadFolderOptions(selected = '') {
  const select = document.getElementById('bookmarkFolder');
  // 只使用当前场景的书签和文件夹（currentBookmarks 和 currentFolders 已经是当前场景的数据）
  // 合并从书签中提取的文件夹和 currentFolders 中的文件夹
  const bookmarkFolders = [...new Set(currentBookmarks.map(b => b.folder).filter(f => f))];
  // 保持 currentFolders 的顺序，并将不在 currentFolders 中的 bookmarkFolders 追加到后面
  const currentFoldersSet = new Set(currentFolders);
  const missingFolders = bookmarkFolders.filter(f => !currentFoldersSet.has(f));
  const allFolders = [...currentFolders, ...missingFolders];

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
    currentFolders = insertFolderPathSmart(currentFolders, newPath);
    currentFolders = expandFolderPathsPreserveOrder(currentFolders);

    // 仅更新内存和表单/侧边栏，不立即同步；真正保存和上行在用户点击“保存书签”时一起进行
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
  if (modalActionBarTimer) {
    clearTimeout(modalActionBarTimer);
    modalActionBarTimer = null;
  }
  bookmarkModal.style.display = 'none';
  editingBookmarkId = null;

  // 如果是从弹窗、悬浮球或快捷键打开的，关闭整个页面
  if (pageSource === 'popup' || pageSource === 'floating-ball' || pageSource === 'shortcut') {
    // 先尝试通过后台脚本关闭标签页
    closeCurrentTabFromAddFlow().then(() => {
      console.log('[书签管理] 标签页已通过后台脚本关闭');
    }).catch((error) => {
      console.warn('[书签管理] 通过后台脚本关闭标签页失败，尝试直接关闭:', error);
      // 如果后台脚本关闭失败，尝试直接关闭窗口
      try {
        window.close();
      } catch (e) {
        console.warn('[书签管理] 直接关闭窗口也失败:', e);
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
      <button type="button" id="successCloseBtn" class="btn btn-primary-blue" style="min-width: 132px;">
        关闭
      </button>
    </div>
  `;

  // 绑定关闭按钮事件
  const closeBtn = document.getElementById('successCloseBtn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      hideModal();
    });
  }
}

/**
 * 处理表单提交
 */
async function handleSubmit(e) {
  e.preventDefault();

  // 获取提交按钮并立即禁用，防止重复提交
  const submitBtn = bookmarkForm.querySelector('button[type="submit"]');
  if (submitBtn) {
    submitBtn.disabled = true;
    const originalText = submitBtn.textContent;
    submitBtn.textContent = '保存中...';
  }

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
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = '保存';
    }
    return;
  }

  if (!isValidUrl(bookmark.url)) {
    alert('请输入有效的URL');
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = '保存';
    }
    return;
  }

  // 显示全局加载遮罩
  showGlobalLoading('正在保存…');

  try {
    await ensureSceneFreshFromCloudBeforeWrite();

    const isNewBookmark = !editingBookmarkId;

    if (editingBookmarkId) {
      // 更新
      const index = currentBookmarks.findIndex(b => b.id === editingBookmarkId);
      if (index !== -1) {
        bookmark.id = editingBookmarkId;
        bookmark.createdAt = currentBookmarks[index].createdAt;
        bookmark.scene = currentBookmarks[index].scene || currentSceneId || 'home'; // 保留原有场景
        bookmark.order = typeof currentBookmarks[index].order === 'number' ? currentBookmarks[index].order : 0;
        bookmark.folderId = currentBookmarks[index].folderId || bookmark.folderId;
        currentBookmarks[index] = bookmark;
      }
    } else {
      // 新增
      bookmark.id = storage.generateBookmarkId();
      bookmark.createdAt = Date.now();
      currentBookmarks = insertBookmarkSmart(currentBookmarks, bookmark);
      // 核心修正：新增书签后立即补齐元数据（生成 f_ 开头的 folderId 并存入 metadata）
      ensureBookmarkFolderIdAndOrder();
      // 从补齐后的书签中同步更新本地对象的 folderId
      const newB = currentBookmarks.find(b => b.id === bookmark.id);
      if (newB) bookmark.folderId = newB.folderId;
    }

    // 核心修正：确保书签所在的文件夹及其父路径存在于 currentFolders 中，并更新元数据 order，以便后续同步能包含文件夹定义
    if (bookmark.folder) {
      const nf = normalizeFolderPath(bookmark.folder);
      if (!currentFolders.includes(nf)) {
        currentFolders = insertFolderPathSmart(currentFolders, nf);
        currentFolders = expandFolderPathsPreserveOrder(currentFolders);
      }
    }

    // 如果是自定义排序模式，自动按文件夹分组排序
    if (currentSort === 'custom') {
      currentBookmarks = sortBookmarksForCustomDisplay(currentBookmarks);
      reindexBookmarkOrderByFolder();
    }

    // 1. 先保存到本地存储（核心反馈点）
    refreshBookmarkMetaOrderFromCurrent();
    refreshFolderMetaOrderFromCurrent();
    await storage.saveBookmarks(currentBookmarks, currentFolders, currentSceneId);

    // 2. 异步触发云端同步，不 await，不阻塞 UI
    // 包含 folderOrderIds 确保云端文件夹顺序与本地一致，并能触发新文件夹的创建
    const patch = { 
      bookmarkUpserts: [bookmark.id],
      folderOrderIds: (currentFolderMeta && Array.isArray(currentFolderMeta.order)) ? [...currentFolderMeta.order] : []
    };
    if (bookmark.folderId) {
      // 不仅同步当前文件夹，也补齐其父级（如果有的话）
      const affectedFolderIds = [];
      const parts = normalizeFolderPath(bookmark.folder).split('/');
      let cur = '';
      parts.forEach(part => {
        cur = cur ? `${cur}/${part}` : part;
        const fid = currentFolderIdByPath.get(cur);
        if (fid) affectedFolderIds.push(fid);
      });
      patch.folderUpserts = affectedFolderIds.length > 0 ? affectedFolderIds : [bookmark.folderId];
    }
    syncToCloud({ patch }).catch(err => console.error('背景同步失败:', err));

    // 3. 立即刷新本地 UI
    await loadBookmarks();
    await loadFolders();
    await loadTags();

    // 4. 显示成功提示并快速后续处理
    showSuccessInModal(isNewBookmark ? '添加成功' : '保存成功');

    // 如果是从弹窗/悬浮球/快捷键打开的，操作完成后关闭页面
    if (pageSource === 'popup' || pageSource === 'floating-ball' || pageSource === 'shortcut') {
      if (isNewBookmark) {
        // 新增书签：显示成功提示，0.8秒后快速关闭页面（缩短时间，提高响应感）
        autoCloseTimer = setTimeout(() => {
          hideModal();
        }, 800);
      } else {
        // 编辑书签：直接关闭模态框
        hideModal();
      }
    } else if (isNewBookmark) {
      // 其他情况：新增书签显示成功提示，0.8秒后关闭模态框
      autoCloseTimer = setTimeout(() => {
        hideModal();
      }, 800);
    } else {
      // 其他情况：编辑书签直接关闭模态框
      hideModal();
    }
  } catch (error) {
    console.error('保存失败:', error);
    alert('保存失败: ' + error.message);
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = '保存';
    }
  } finally {
    // 隐藏全局加载遮罩
    hideGlobalLoading();
  }
}

/**
 * 切换收藏状态
 */
async function toggleStar(bookmarkId) {
  // 显示全局加载遮罩
  showGlobalLoading('正在更新收藏状态…');

  try {
    await ensureSceneFreshFromCloudBeforeWrite();
    const refreshed = currentBookmarks.find(b => b.id === bookmarkId);
    if (!refreshed) return;
    refreshed.starred = !refreshed.starred;
    refreshed.updatedAt = Date.now();

    // 1. 先保存到本地
    await storage.saveBookmarks(currentBookmarks, currentFolders, currentSceneId);

    // 2. 立即渲染界面
    renderBookmarks();

    // 3. 异步触发云端同步
    syncToCloud({ patch: { bookmarkUpserts: [bookmarkId] } }).catch(err => console.error('收藏状态后台同步失败:', err));
  } catch (error) {
    console.error('更新失败:', error);
  } finally {
    // 隐藏全局加载遮罩
    hideGlobalLoading();
  }
}

/**
 * 删除书签
 */
async function deleteBookmark(bookmarkId) {
  if (!confirm('确定要删除这个书签吗？')) {
    return;
  }

  // 显示全局加载遮罩
  showGlobalLoading('正在删除…');

  try {
    await ensureSceneFreshFromCloudBeforeWrite();

    currentBookmarks = currentBookmarks.filter(b => b.id !== bookmarkId);

    // 如果是自定义排序模式，确保删除后仍按文件夹顺序排列
    if (currentSort === 'custom') {
      currentBookmarks = sortBookmarksForCustomDisplay(currentBookmarks);
      reindexBookmarkOrderByFolder();
    }

    // 1. 先保存到本地并刷新 UI（乐观更新）
    refreshBookmarkMetaOrderFromCurrent();
    refreshFolderMetaOrderFromCurrent();
    await storage.saveBookmarks(currentBookmarks, currentFolders, currentSceneId);

    await loadBookmarks();
    await loadFolders();
    await loadTags();

    // 2. 异步触发云端同步（传入 deletedIds 以从云端移除该条）
    syncToCloud({ deletedIds: [bookmarkId], patch: { bookmarkDeletes: [bookmarkId] } }).catch(err => console.error('删除书签后台同步失败:', err));
  } catch (error) {
    console.error('删除失败:', error);
    alert('删除失败: ' + error.message);
  } finally {
    // 隐藏全局加载遮罩
    hideGlobalLoading();
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
  // 视图切换后刷新拖拽/移动状态
  if (currentSort === 'custom') {
    renderBookmarks();
  }

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
 * @param {{ deletedIds?: string[], deletedFolderPaths?: string[], requireSuccess?: boolean, patch?: object }} [opts]
 *   删除书签传 deletedIds；删除文件夹（含其下书签）传 deletedFolderPaths（规范化路径）
 *   requireSuccess 为 true 时，后台返回 success:false 或抛错会向上抛出，便于调用方提示用户
 */
async function syncToCloud(opts = {}) {
  const deletedIds = opts && opts.deletedIds;
  const deletedFolderPaths = opts && opts.deletedFolderPaths;
  const requireSuccess = !!(opts && opts.requireSuccess);
  const patch = opts && opts.patch;
  try {
    if (!patch || typeof patch !== 'object') {
      throw new Error('syncToCloud 必须携带 patch（仅允许单条/本次批量目标集合更新）');
    }
    ensureBookmarkFolderIdAndOrder();
    if (currentSort === 'custom') {
      currentBookmarks = sortBookmarksForCustomDisplay(currentBookmarks);
      reindexBookmarkOrderByFolder();
    }
    const payload = {
      action: 'syncToCloud',
      bookmarks: currentBookmarks,
      folders: currentFolders,
      folderItems: buildCurrentFolderItemsForSync(),
      sceneId: currentSceneId,
      patch
    };
    if (Array.isArray(deletedIds) && deletedIds.length) {
      payload.deletedIds = deletedIds;
    }
    if (Array.isArray(deletedFolderPaths) && deletedFolderPaths.length) {
      payload.deletedFolderPaths = deletedFolderPaths;
    }
    const res = await sendMessageCompat(payload);
    if (requireSuccess && res && res.success === false) {
      throw new Error(res.error || '同步到云端失败');
    }
    return res;
  } catch (error) {
    console.error('同步到云端失败:', error);
    if (requireSuccess) throw error;
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

  // 显示全局加载遮罩
  showGlobalLoading('正在批量移动…');

  try {
    await ensureSceneFreshFromCloudBeforeWrite();

    const bookmarksToMove = currentBookmarks.filter(b => selectedBookmarkIds.has(b.id));

    // 更新书签的文件夹（与单个编辑逻辑一致：空字符串转为 undefined）
    const normalizedTargetFolder = targetFolder.trim() ? normalizeFolderPath(targetFolder) : undefined;
    bookmarksToMove.forEach(bookmark => {
      bookmark.folder = normalizedTargetFolder;
      bookmark.updatedAt = Date.now();
    });

    // 纠正 ID 映射
    ensureBookmarkFolderIdAndOrder();

    // 更新 currentFolders：保留现有顺序，添加新文件夹
    const bookmarkFolders = currentBookmarks.map(b => b.folder).filter(Boolean);
    const bookmarkFoldersSet = new Set(bookmarkFolders);
    // 保留 currentFolders 中存在的文件夹（保持顺序），然后添加新文件夹
    const existingFolders = currentFolders.filter(f => bookmarkFoldersSet.has(f));
    const newFolders = bookmarkFolders.filter(f => !currentFolders.includes(f));
    currentFolders = [...existingFolders, ...newFolders];

    // 如果是自定义排序模式，确保移动后仍按文件夹顺序排列
    if (currentSort === 'custom') {
      currentBookmarks = sortBookmarksForCustomDisplay(currentBookmarks);
      reindexBookmarkOrderByFolder();
    }

    // 保存到本地
    // 1. 保存到本地存储
    refreshBookmarkMetaOrderFromCurrent();
    refreshFolderMetaOrderFromCurrent();
    await storage.saveBookmarks(currentBookmarks, currentFolders, currentSceneId);

    // 2. 立即渲染界面（乐观更新）
    toggleBatchMode();
    await loadBookmarks();
    await loadFolders();
    await loadTags();
    renderBookmarks();

    // 3. 异步触发云端同步
    const movedIds = bookmarksToMove.map(b => b.id);
    const movedFolderIds = [...new Set(currentBookmarks.filter(b => movedIds.includes(b.id)).map(b => b.folderId).filter(Boolean))];
    syncToCloud({
      patch: {
        bookmarkUpserts: movedIds,
        folderUpserts: movedFolderIds,
        folderOrderIds: (currentFolderMeta && Array.isArray(currentFolderMeta.order)) ? [...currentFolderMeta.order] : []
      }
    }).catch(err => console.error('批量移动后台同步失败:', err));

    alert(`已成功移动 ${bookmarksToMove.length} 个书签`);
  } catch (error) {
    console.error('批量移动失败:', error);
    alert('批量移动失败: ' + error.message);
  } finally {
    // 隐藏全局加载遮罩
    hideGlobalLoading();
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

  // 显示全局加载遮罩
  showGlobalLoading('正在批量删除…');

  try {
    await ensureSceneFreshFromCloudBeforeWrite();

    const deletedIdsForCloud = Array.from(selectedBookmarkIds);

    // 删除选中的书签
    currentBookmarks = currentBookmarks.filter(b => !selectedBookmarkIds.has(b.id));

    // 更新文件夹列表：保留现有顺序，移除不再使用的文件夹
    const bookmarkFolders = currentBookmarks.map(b => b.folder).filter(Boolean);
    const bookmarkFoldersSet = new Set(bookmarkFolders);
    // 保留 currentFolders 中仍然有书签使用的文件夹（保持顺序）
    currentFolders = currentFolders.filter(f => bookmarkFoldersSet.has(f));

    // 如果是自定义排序模式，确保删除后仍按文件夹顺序排列
    if (currentSort === 'custom') {
      currentBookmarks = sortBookmarksForCustomDisplay(currentBookmarks);
      reindexBookmarkOrderByFolder();
    }

    // 1. 保存到本地
    refreshBookmarkMetaOrderFromCurrent();
    refreshFolderMetaOrderFromCurrent();
    await storage.saveBookmarks(currentBookmarks, currentFolders, currentSceneId);

    // 2. 立即刷新本地 UI 状态（乐观更新）
    toggleBatchMode();
    await loadBookmarks();
    await loadFolders();
    await loadTags();
    renderBookmarks();

    // 3. 异步触发云端同步（须在 toggleBatchMode 之前拷贝 id，否则 Set 会被清空）
    syncToCloud({ deletedIds: deletedIdsForCloud, patch: { bookmarkDeletes: deletedIdsForCloud } }).catch(err =>
      console.error('批量删除后台同步失败:', err)
    );

    alert(`已成功删除 ${count} 个书签`);
  } catch (error) {
    console.error('批量删除失败:', error);
    alert('批量删除失败: ' + error.message);
  } finally {
    // 隐藏全局加载遮罩
    hideGlobalLoading();
  }
}

/**
 * 显示文件夹选择对话框
 * @param {Object} options - 选项
 * @param {string} options.excludeFolderPath - 要排除的文件夹路径（及其子文件夹）
 */
function showFolderSelectDialog(options = {}) {
  return new Promise((resolve) => {
    const { excludeFolderPath } = options;
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
    const currentFoldersSet = new Set(currentFolders);
    const missingFolders = bookmarkFolders.filter(f => !currentFoldersSet.has(f));
    let folders = [...currentFolders, ...missingFolders];

    // 如果指定了要排除的文件夹，过滤掉该文件夹及其子文件夹
    if (excludeFolderPath) {
      folders = folders.filter(f => {
        // 排除完全匹配的文件夹
        if (f === excludeFolderPath) return false;
        // 排除子文件夹
        if (f.startsWith(excludeFolderPath + '/')) return false;
        return true;
      });
    }

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

// ==================== 目录导航功能 ====================

// 目录导航相关元素
let folderNavDrawer = null;
let folderNavMask = null;
let folderNavClose = null;
let folderNavContent = null;
let folderNavBtn = null;
let currentNavFolder = ''; // 记录当前选中的文件夹路径

/**
 * 初始化目录导航功能
 */
function initFolderNav() {
  folderNavDrawer = document.getElementById('folderNavDrawer');
  folderNavMask = folderNavDrawer?.querySelector('.folder-nav-mask');
  folderNavClose = document.getElementById('folderNavClose');
  folderNavContent = document.getElementById('folderNavContent');
  folderNavBtn = document.getElementById('folderNavBtn');

  if (!folderNavDrawer || !folderNavBtn) return;

  // 绑定事件
  folderNavBtn.addEventListener('click', openFolderNav);
  folderNavClose?.addEventListener('click', closeFolderNav);
  folderNavMask?.addEventListener('click', closeFolderNav);

  // ESC 键关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && folderNavDrawer?.classList.contains('active')) {
      closeFolderNav();
    }
  });
}

/**
 * 打开目录导航抽屉
 */
function openFolderNav() {
  if (!folderNavDrawer || !folderNavContent) return;

  // 渲染文件夹列表
  renderFolderNav();

  // 显示抽屉
  folderNavDrawer.style.display = 'flex';
  // 强制重绘以确保动画生效
  folderNavDrawer.offsetHeight;
  folderNavDrawer.classList.add('active');

  // 禁止背景滚动
  document.body.style.overflow = 'hidden';
}

/**
 * 关闭目录导航抽屉
 */
function closeFolderNav() {
  if (!folderNavDrawer) return;

  folderNavDrawer.classList.remove('active');

  // 等待动画结束后隐藏
  setTimeout(() => {
    folderNavDrawer.style.display = 'none';
    document.body.style.overflow = '';
  }, 300);
}

/**
 * 渲染文件夹导航列表
 */
function renderFolderNav() {
  if (!folderNavContent) return;

  // 获取所有文件夹路径
  const folders = new Set();
  currentBookmarks.forEach(bm => {
    if (bm.folder) {
      folders.add(bm.folder);
      // 添加所有父级路径
      const parts = bm.folder.split('/').filter(Boolean);
      for (let i = 1; i < parts.length; i++) {
        folders.add(parts.slice(0, i).join('/'));
      }
    }
  });

  // 转换为数组并排序
  const folderArray = Array.from(folders).sort();

  if (folderArray.length === 0) {
    folderNavContent.innerHTML = '<div class="folder-nav-empty">暂无文件夹</div>';
    return;
  }

  // 构建文件夹树
  const tree = buildFolderTreeForNav(folderArray);

  // 统计每个文件夹的书签数量
  const folderCounts = {};
  currentBookmarks.forEach(bm => {
    if (bm.folder) {
      folderCounts[bm.folder] = (folderCounts[bm.folder] || 0) + 1;
    }
  });

  // 渲染 HTML（传入当前选中的文件夹路径）
  const html = renderFolderTreeNodes(tree, 0, folderCounts, currentNavFolder);
  folderNavContent.innerHTML = `<ul class="folder-nav-list">${html}</ul>`;

  // 绑定点击事件
  folderNavContent.querySelectorAll('.folder-nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const path = item.dataset.path;
      if (path) {
        // 记录当前选中的文件夹
        currentNavFolder = path;
        scrollToFolder(path);
        closeFolderNav();
      }
    });
  });
}

/**
 * 为导航构建文件夹树
 */
function buildFolderTreeForNav(paths) {
  const root = {};

  paths.forEach(path => {
    const parts = path.split('/').filter(Boolean);
    let current = root;

    parts.forEach((part, index) => {
      if (!current[part]) {
        current[part] = {
          name: part,
          path: parts.slice(0, index + 1).join('/'),
          children: {}
        };
      }
      current = current[part].children;
    });
  });

  return root;
}

/**
 * 递归渲染文件夹树节点
 * @param {Object} tree - 文件夹树
 * @param {number} depth - 当前深度
 * @param {Object} counts - 文件夹数量统计
 * @param {string} selectedPath - 当前选中的文件夹路径
 */
function renderFolderTreeNodes(tree, depth, counts, selectedPath = '') {
  const folders = Object.values(tree).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

  return folders.map(folder => {
    const count = counts[folder.path] || 0;
    const hasChildren = Object.keys(folder.children).length > 0;
    const isActive = folder.path === selectedPath ? 'active' : '';

    let html = `
      <li class="folder-nav-item ${isActive}" data-path="${escapeHtml(folder.path)}" data-depth="${depth}">
        <span class="folder-nav-icon">📁</span>
        <span class="folder-nav-name">${escapeHtml(folder.name)}</span>
        <span class="folder-nav-count">${count}</span>
      </li>
    `;

    // 递归渲染子文件夹
    if (hasChildren) {
      html += renderFolderTreeNodes(folder.children, depth + 1, counts, selectedPath);
    }

    return html;
  }).join('');
}

/**
 * 在页面中定位书签：展开文件夹、滚动到书签、高亮显示
 */
function locateBookmarkInPage(bookmarkId, folderPath) {
  try {
    // 清除搜索和筛选
    if (searchInput.value) {
      searchInput.value = '';
      handleSearch();
    }
    currentFilter = '';

    // 确定要选中的文件夹
    let targetFolder = '';
    if (folderPath && folderPath.trim()) {
      // 有文件夹的书签，选中该文件夹
      targetFolder = normalizeFolderPath(folderPath);

      // 展开该文件夹及所有父文件夹
      expandedFolders.add(targetFolder);

      // 展开所有父文件夹
      const parts = targetFolder.split('/');
      for (let i = 1; i < parts.length; i++) {
        const parentPath = parts.slice(0, i).join('/');
        expandedFolders.add(parentPath);
      }
    } else {
      // 没有文件夹的书签，选中"未分类"（空字符串表示根目录）
      targetFolder = '';
      expandedFolders.add('');
    }
    saveFolderState();

    // 设置文件夹筛选，自动选中对应文件夹
    if (targetFolder) {
      currentFilter = 'folder:' + targetFolder;
    } else {
      // 未分类：显示所有没有文件夹的书签
      currentFilter = 'folder:';
    }

    // 重新加载左侧文件夹列表（这会根据expandedFolders展开文件夹）
    loadFolders();

    // 重新渲染书签
    renderBookmarks();

    // 等待DOM更新后再定位和高亮
    const tryLocate = () => {
      // 更新侧边栏文件夹激活状态
      document.querySelectorAll('.folder-label').forEach(label => {
        label.classList.remove('active');
      });
      if (targetFolder) {
        const folderRow = foldersList.querySelector(`[data-folder="${CSS.escape(targetFolder)}"]`);
        if (folderRow) {
          const label = folderRow.querySelector('.folder-label');
          if (label) {
            label.classList.add('active');
          }
          // 滚动到文件夹位置
          folderRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      } else {
        // 未分类：高亮根目录
        const rootLabel = foldersList.querySelector('[data-folder=""]')?.querySelector('.folder-label');
        if (rootLabel) {
          rootLabel.classList.add('active');
        }
      }

      // 然后滚动到书签位置
      const bookmarkCard = document.querySelector(`[data-id="${CSS.escape(bookmarkId)}"]`);
      if (bookmarkCard && bookmarkCard.classList.contains('bookmark-card')) {
        // 滚动到书签位置
        bookmarkCard.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // 添加高亮类
        bookmarkCard.classList.add('highlight');

        // 2秒后移除高亮
        setTimeout(() => {
          bookmarkCard.classList.remove('highlight');
        }, 2000);
      } else {
        // 如果还没找到，再等待一下
        setTimeout(tryLocate, 100);
      }
    };

    // 延迟执行，确保DOM已更新
    setTimeout(tryLocate, 200);
  } catch (error) {
    console.error('定位书签失败:', error);
  }
}

/**
 * 跳转到指定文件夹并筛选显示其书签
 */
function scrollToFolder(path) {
  // 清除搜索
  if (searchInput.value) {
    searchInput.value = '';
    handleSearch();
  }

  // 设置文件夹筛选
  currentFilter = 'folder:' + normalizeFolderPath(path);

  // 清除导航项激活状态
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.remove('active');
  });

  // 更新侧边栏文件夹激活状态
  const normalizedPath = normalizeFolderPath(path);
  foldersList.querySelectorAll('.folder-label').forEach(label => {
    label.classList.remove('active');
  });
  const folderRow = foldersList.querySelector(`[data-folder="${CSS.escape(path)}"]`);
  if (folderRow) {
    const label = folderRow.querySelector('.folder-label');
    if (label) {
      label.classList.add('active');
    }
  }

  renderBookmarks();
}

// ========== 书签详情功能 ==========

let currentDetailBookmarkId = null;
let currentDetailBookmark = null;

/**
 * 显示书签详情画面
 */
async function showBookmarkDetail(bookmarkId) {
  try {
    const bookmarksData = await storage.getBookmarks();
    const bookmark = bookmarksData.bookmarks.find(b => b.id === bookmarkId);

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
  if (!editBtn) {
    console.error('编辑按钮未找到:', field);
    return;
  }
  const fieldElement = editBtn.closest('.detail-content');
  if (!fieldElement) {
    console.error('字段容器未找到:', field);
    return;
  }

  // 如果已经处于编辑状态，不做任何操作（保存通过 blur 或 Enter 触发）
  if (fieldElement.classList.contains('editing')) {
    return;
  }

  // 进入编辑状态
  fieldElement.classList.add('editing');

  const bookmark = currentDetailBookmark;
  if (!bookmark) {
    console.error('书签数据未找到');
    return;
  }

  // 获取预置的输入框元素
  const wrapper = fieldElement.querySelector('.detail-edit-wrapper');
  if (!wrapper) {
    console.error('编辑包装器未找到');
    return;
  }

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

  if (!input) {
    console.error('输入框未找到:', field);
    return;
  }

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
 * 保存字段
 */
async function saveField(field, fieldElement) {
  if (!fieldElement.classList.contains('editing')) return;

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
    await loadBookmarks({ lightLoading: true });
  } catch (error) {
    console.error('保存失败:', error);
    showErrorToast('保存失败: ' + (error.message || '未知错误'));
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
    const bookmarksData = await storage.getBookmarks(currentSceneId);
    const bookmarkIndex = bookmarksData.bookmarks.findIndex(b => b.id === bookmarkId);

    if (bookmarkIndex === -1) {
      throw new Error('书签未找到');
    }

    // 更新本地数据
    bookmarksData.bookmarks[bookmarkIndex][field] = value;
    bookmarksData.bookmarks[bookmarkIndex].updatedAt = Date.now();

    // 保存到本地存储
    await storage.saveBookmarks(bookmarksData.bookmarks, bookmarksData.folders, currentSceneId);

    // 更新当前书签列表变量（确保 syncToCloud 使用最新数据）
    currentBookmarks = bookmarksData.bookmarks;
    currentFolders = bookmarksData.folders;

    // 同步到云端
    await syncToCloud({
      patch: { bookmarkUpserts: [bookmarkId] }
    });
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
async function getBookmarkData() {
  // 优先使用当前详情书签数据
  if (currentDetailBookmark && currentDetailBookmark.id === currentDetailBookmarkId) {
    return currentDetailBookmark;
  }
  // 备选：从存储中查找
  try {
    const bookmarksData = await storage.getBookmarks();
    return bookmarksData.bookmarks.find(b => b.id === currentDetailBookmarkId);
  } catch (error) {
    console.error('获取书签数据失败:', error);
    return null;
  }
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
  document.getElementById('bookmarksGrid').addEventListener('click', async (e) => {
    if (e.target.classList.contains('bookmark-detail-btn')) {
      e.stopPropagation();
      const bookmarkId = e.target.dataset.id;
      await showBookmarkDetail(bookmarkId);
    }
  });
});

// 初始化目录导航
document.addEventListener('DOMContentLoaded', initFolderNav);

// 全局函数供HTML调用
window.showAddForm = showAddForm;



