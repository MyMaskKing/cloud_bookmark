/**
 * 弹出窗口脚本
 */

const storage = new StorageManager();

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
const MAX_BOOKMARKS_DISPLAY = 100;
const expandedFolders = new Set(['']); // 根默认展开
let lastRenderedBookmarks = [];

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
  await loadBookmarksForPopup();
  await updateSyncStatus();
  
  // 监听消息更新
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'bookmarksUpdated') {
      loadBookmarksForPopup();
      updateSyncStatus();
    }
  });
});

/**
 * 加载弹窗展示的书签（默认按时间倒序，最多显示 MAX_BOOKMARKS_DISPLAY 条）
 */
async function loadBookmarksForPopup() {
  try {
    const data = await storage.getBookmarks();
    const bookmarks = data.bookmarks || [];
    
    // 按更新/创建时间排序，默认展示最新的
    const sorted = bookmarks
      .map(b => ({ ...b }))
      .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
      .slice(0, MAX_BOOKMARKS_DISPLAY);
    
    lastRenderedBookmarks = sorted;
    renderBookmarks(sorted, { searchMode: false });
  } catch (error) {
    console.error('加载书签失败:', error);
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

    // 点击事件
    bookmarkList.querySelectorAll('.bookmark-item').forEach(item => {
      item.addEventListener('click', () => {
        const url = item.dataset.url;
        chrome.tabs.create({ url });
      });
    });
    return;
  }

  // 初次加载时默认展开第一层文件夹
  if (expandedFolders.size === 1 && expandedFolders.has('')) {
    getFirstLevelFolders(bookmarks).forEach(p => expandedFolders.add(p));
  }

  const tree = buildFolderTree(bookmarks);
  bookmarkList.innerHTML = renderFolderTreeHtml(tree, '');

  // 绑定文件夹展开/折叠
  bookmarkList.querySelectorAll('.folder-row').forEach(row => {
    row.addEventListener('click', () => {
      const path = row.dataset.folder || '';
      if (expandedFolders.has(path)) {
        expandedFolders.delete(path);
      } else {
        expandedFolders.add(path);
      }
      bookmarkList.innerHTML = renderFolderTreeHtml(tree, '');
      bindFolderEvents();
    });
  });

  bindBookmarkClick();

  function bindFolderEvents() {
    bookmarkList.querySelectorAll('.folder-row').forEach(row => {
      row.addEventListener('click', () => {
        const path = row.dataset.folder || '';
        if (expandedFolders.has(path)) {
          expandedFolders.delete(path);
        } else {
          expandedFolders.add(path);
        }
        bookmarkList.innerHTML = renderFolderTreeHtml(tree, '');
        bindFolderEvents();
        bindBookmarkClick();
      });
    });
  }

  function bindBookmarkClick() {
    bookmarkList.querySelectorAll('.bookmark-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const url = item.dataset.url;
        chrome.tabs.create({ url });
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

function renderFolderTreeHtml(node, indentPath) {
  const folderEntries = Object.values(node.folders).sort((a, b) => a.name.localeCompare(b.name));
  const items = node.items || [];

  const folderHtml = folderEntries.map(child => {
    const expanded = expandedFolders.has(child.path);
    const icon = expanded ? '📂' : '📁';
    const childContent = expanded ? renderFolderTreeHtml(child, child.path) : '';
    return `
      <div class="folder-block">
        <div class="folder-row" data-folder="${escapeHtml(child.path)}">
          <span class="folder-icon">${icon}</span>
          <span class="folder-name">${escapeHtml(child.name)}</span>
          <span class="folder-count">${(child.items || []).length}</span>
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
    const data = await storage.getBookmarks();
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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    chrome.tabs.create({
      url: chrome.runtime.getURL(`pages/bookmarks.html?action=add&url=${encodeURIComponent(tab.url)}&title=${encodeURIComponent(tab.title)}`)
    });
    window.close();
  }
});

/**
 * 打开完整界面
 */
openFullBtn.addEventListener('click', () => {
  chrome.tabs.create({
    url: chrome.runtime.getURL('pages/bookmarks.html')
  });
  window.close();
});

/**
 * 打开设置
 */
settingsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
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

    const manifest = chrome.runtime.getManifest ? chrome.runtime.getManifest() : {};
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
      userAgent: navigator.userAgent,
      syncStatus,
      pendingChangesCount: pendingChanges.length,
      pendingChanges,
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

    const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cloud-bookmark-log-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('导出日志失败:', error);
    alert('导出日志失败：' + error.message);
  }
});

