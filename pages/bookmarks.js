/**
 * 书签管理页面脚本
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
let currentView = 'grid';
let editingBookmarkId = null;

// DOM元素
const addBookmarkBtn = document.getElementById('addBookmarkBtn');
const searchInput = document.getElementById('searchInput');
const sortSelect = document.getElementById('sortSelect');
const viewToggle = document.getElementById('viewToggle');
const exportBtn = document.getElementById('exportBtn');
const syncBtn = document.getElementById('syncBtn');
const bookmarksGrid = document.getElementById('bookmarksGrid');
const emptyState = document.getElementById('emptyState');
const bookmarkModal = document.getElementById('bookmarkModal');
const bookmarkForm = document.getElementById('bookmarkForm');
const closeModal = document.getElementById('closeModal');
const cancelBtn = document.getElementById('cancelBtn');
const foldersList = document.getElementById('foldersList');
const tagsList = document.getElementById('tagsList');

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
  await loadBookmarks();
  await loadFolders();
  await loadTags();
  setupEventListeners();
  checkUrlParams();
  
  // 监听消息更新
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'bookmarksUpdated') {
      loadBookmarks();
      loadFolders();
      loadTags();
    }
  });
});

/**
 * 检查URL参数（用于添加书签）
 */
function checkUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const action = params.get('action');
  
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
  viewToggle.addEventListener('click', toggleView);
  exportBtn.addEventListener('click', handleExport);
  syncBtn.addEventListener('click', handleSync);
  closeModal.addEventListener('click', hideModal);
  cancelBtn.addEventListener('click', hideModal);
  
  bookmarkForm.addEventListener('submit', handleSubmit);
  
  // 导航项点击
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      currentFilter = item.dataset.filter;
      renderBookmarks();
    });
  });
}

/**
 * 加载书签
 */
async function loadBookmarks() {
  try {
    const data = await storage.getBookmarks();
    currentBookmarks = data.bookmarks || [];
    currentFolders = data.folders || [];
    renderBookmarks();
  } catch (error) {
    console.error('加载书签失败:', error);
  }
}

/**
 * 加载文件夹列表
 */
async function loadFolders() {
  const folders = [...new Set(currentBookmarks.map(b => b.folder).filter(f => f))];
  folders.sort();
  
  foldersList.innerHTML = folders.map(folder => `
    <div class="folder-item" data-folder="${escapeHtml(folder)}">
      <span>📁</span>
      <span>${escapeHtml(folder)}</span>
    </div>
  `).join('');
  
  foldersList.querySelectorAll('.folder-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.folder-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      currentFilter = 'folder:' + item.dataset.folder;
      renderBookmarks();
    });
  });
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
    filtered = filtered.filter(b => b.folder === folder);
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
      
      // 点击卡片打开网站
      card.querySelector('.bookmark-info').addEventListener('click', () => {
        chrome.tabs.create({ url: bookmark.url });
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
    });
  }
}

/**
 * 渲染单个书签卡片
 */
function renderBookmarkCard(bookmark) {
  const favicon = bookmark.favicon || bookmark.icon || getFaviconUrl(bookmark.url);
  const domain = getDomain(bookmark.url);
  
  return `
    <div class="bookmark-card ${bookmark.starred ? 'starred' : ''}" data-id="${bookmark.id}">
      <div class="bookmark-actions">
        <button class="action-btn edit-btn" title="编辑">✏️</button>
        <button class="action-btn delete-btn" title="删除">🗑️</button>
      </div>
      <div class="bookmark-header">
        <img src="${favicon}" alt="" class="bookmark-favicon" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27%3E%3Cpath fill=%27%23999%27 d=%27M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z%27/%3E%3C/svg%3E'">
        <div class="bookmark-info">
          <div class="bookmark-title">${escapeHtml(bookmark.title || '无标题')}</div>
          <div class="bookmark-url">${escapeHtml(domain || bookmark.url)}</div>
        </div>
        <div class="bookmark-star">${bookmark.starred ? '⭐' : '☆'}</div>
      </div>
      ${bookmark.description ? `<div class="bookmark-description">${escapeHtml(bookmark.description)}</div>` : ''}
      ${bookmark.notes ? `<div class="bookmark-notes">📝 ${escapeHtml(bookmark.notes)}</div>` : ''}
      ${bookmark.tags && bookmark.tags.length > 0 ? `
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
 * 加载文件夹选项
 */
function loadFolderOptions(selected = '') {
  const select = document.getElementById('bookmarkFolder');
  const folders = [...new Set(currentBookmarks.map(b => b.folder).filter(f => f))];
  folders.sort();
  
  select.innerHTML = '<option value="">未分类</option>' + 
    folders.map(f => `<option value="${escapeHtml(f)}" ${f === selected ? 'selected' : ''}>${escapeHtml(f)}</option>`).join('');
}

/**
 * 隐藏模态框
 */
function hideModal() {
  bookmarkModal.style.display = 'none';
  editingBookmarkId = null;
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
    if (editingBookmarkId) {
      // 更新
      const index = currentBookmarks.findIndex(b => b.id === editingBookmarkId);
      if (index !== -1) {
        bookmark.id = editingBookmarkId;
        bookmark.createdAt = currentBookmarks[index].createdAt;
        currentBookmarks[index] = bookmark;
      }
    } else {
      // 新增
      bookmark.id = storage.generateId();
      bookmark.createdAt = Date.now();
      currentBookmarks.push(bookmark);
    }
    
    await storage.saveBookmarks(currentBookmarks, currentFolders);
    
    // 同步到云端
    await syncToCloud();
    
    await loadBookmarks();
    await loadFolders();
    await loadTags();
    hideModal();
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
      await storage.saveBookmarks(currentBookmarks, currentFolders);
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
    await storage.saveBookmarks(currentBookmarks, currentFolders);
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
  currentView = currentView === 'grid' ? 'list' : 'grid';
  bookmarksGrid.className = `bookmarks-grid view-${currentView}`;
  viewToggle.textContent = currentView === 'grid' ? '📋' : '⊞';
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
 * 导出为JSON
 */
async function exportAsJson() {
  try {
    const data = await storage.getBookmarks();
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
    const data = await storage.getBookmarks();
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
    chrome.runtime.sendMessage({ action: 'sync' }, async (response) => {
      if (response && response.success) {
        await loadBookmarks();
        await loadFolders();
        await loadTags();
        alert('同步成功');
      } else {
        alert('同步失败: ' + (response?.error || '未知错误'));
      }
      syncBtn.disabled = false;
      syncBtn.textContent = '🔄';
    });
  } catch (error) {
    alert('同步失败: ' + error.message);
    syncBtn.disabled = false;
    syncBtn.textContent = '🔄';
  }
}

/**
 * 同步到云端
 */
async function syncToCloud() {
  try {
    chrome.runtime.sendMessage({
      action: 'syncToCloud',
      bookmarks: currentBookmarks,
      folders: currentFolders
    });
  } catch (error) {
    console.error('同步到云端失败:', error);
  }
}

// 全局函数供HTML调用
window.showAddForm = showAddForm;

