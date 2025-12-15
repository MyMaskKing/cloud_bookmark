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
const bookmarkList = document.getElementById('bookmarkList');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
  await loadRecentBookmarks();
  await updateSyncStatus();
  
  // 监听消息更新
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'bookmarksUpdated') {
      loadRecentBookmarks();
      updateSyncStatus();
    }
  });
});

/**
 * 加载最近的书签
 */
async function loadRecentBookmarks() {
  try {
    const data = await storage.getBookmarks();
    const bookmarks = data.bookmarks || [];
    
    // 按创建时间排序，取最近5个
    const recent = bookmarks
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 5);
    
    renderBookmarks(recent);
  } catch (error) {
    console.error('加载书签失败:', error);
  }
}

/**
 * 渲染书签列表
 */
function renderBookmarks(bookmarks) {
  if (bookmarks.length === 0) {
    bookmarkList.innerHTML = '<div class="empty-state">暂无书签</div>';
    return;
  }
  
  bookmarkList.innerHTML = bookmarks.map(bookmark => `
    <div class="bookmark-item" data-url="${escapeHtml(bookmark.url)}">
      <div class="bookmark-item-title">${escapeHtml(bookmark.title || '无标题')}</div>
      <div class="bookmark-item-url">${escapeHtml(bookmark.url)}</div>
    </div>
  `).join('');
  
  // 添加点击事件
  bookmarkList.querySelectorAll('.bookmark-item').forEach(item => {
    item.addEventListener('click', () => {
      const url = item.dataset.url;
      chrome.tabs.create({ url });
    });
  });
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
    await loadRecentBookmarks();
    return;
  }
  
  try {
    const data = await storage.getBookmarks();
    const bookmarks = data.bookmarks || [];
    const filtered = searchBookmarks(bookmarks, query);
    renderBookmarks(filtered.slice(0, 10));
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

