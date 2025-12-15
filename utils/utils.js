/**
 * 通用工具函数
 */

/**
 * 格式化时间
 */
function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;
  
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) {
    return `${days}天前`;
  } else if (hours > 0) {
    return `${hours}小时前`;
  } else if (minutes > 0) {
    return `${minutes}分钟前`;
  } else {
    return '刚刚';
  }
}

/**
 * 防抖函数
 */
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

/**
 * 节流函数
 */
function throttle(func, limit) {
  let inThrottle;
  return function(...args) {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
}

/**
 * 深拷贝
 */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * 验证URL格式
 */
function isValidUrl(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取网站favicon
 */
function getFaviconUrl(url) {
  try {
    const urlObj = new URL(url);
    return `${urlObj.protocol}//${urlObj.host}/favicon.ico`;
  } catch {
    return '';
  }
}

/**
 * 提取域名
 */
function getDomain(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return '';
  }
}

/**
 * 搜索书签
 */
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

/**
 * 按文件夹组织书签
 */
function organizeByFolder(bookmarks) {
  const folders = {};
  
  bookmarks.forEach(bookmark => {
    const folder = bookmark.folder || '未分类';
    if (!folders[folder]) {
      folders[folder] = [];
    }
    folders[folder].push(bookmark);
  });
  
  return folders;
}

/**
 * 导出为浏览器书签HTML格式
 */
function exportToHtml(bookmarks, folders) {
  let html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file. -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>`;

  const folderMap = organizeByFolder(bookmarks);
  
  Object.keys(folderMap).sort().forEach(folder => {
    html += `    <DT><H3>${escapeHtml(folder)}</H3>\n    <DL><p>\n`;
    folderMap[folder].forEach(bookmark => {
      html += `        <DT><A HREF="${escapeHtml(bookmark.url)}" ADD_DATE="${Math.floor(bookmark.createdAt / 1000)}">${escapeHtml(bookmark.title)}</A>\n`;
    });
    html += `    </DL><p>\n`;
  });
  
  html += `</DL><p>`;
  return html;
}

/**
 * HTML转义
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 导出函数
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    formatTime,
    debounce,
    throttle,
    deepClone,
    isValidUrl,
    getFaviconUrl,
    getDomain,
    searchBookmarks,
    organizeByFolder,
    exportToHtml,
    escapeHtml
  };
}

