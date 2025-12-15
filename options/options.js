/**
 * 设置页面脚本
 */

const storage = new StorageManager();

// DOM元素
const configForm = document.getElementById('configForm');
const testBtn = document.getElementById('testBtn');
const syncNowBtn = document.getElementById('syncNowBtn');
const exportJsonBtn = document.getElementById('exportJsonBtn');
const exportHtmlBtn = document.getElementById('exportHtmlBtn');
const importBtn = document.getElementById('importBtn');
const importBrowserBtn = document.getElementById('importBrowserBtn');
const importFile = document.getElementById('importFile');
const deviceList = document.getElementById('deviceList');
const currentDeviceName = document.getElementById('currentDeviceName');
const refreshDevicesBtn = document.getElementById('refreshDevicesBtn');

const serverUrlInput = document.getElementById('serverUrl');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const pathInput = document.getElementById('path');
const syncIntervalInput = document.getElementById('syncInterval');

const statusText = document.getElementById('statusText');
const lastSync = document.getElementById('lastSync');
const errorItem = document.getElementById('errorItem');
const errorText = document.getElementById('errorText');

// 页面加载时初始化
document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  await updateSyncStatus();
  await loadDevices();
  
  // 定时更新同步状态
  setInterval(updateSyncStatus, 5000);
});

/**
 * 加载配置
 */
async function loadConfig() {
  const config = await storage.getConfig();
  if (config) {
    serverUrlInput.value = config.serverUrl || '';
    usernameInput.value = config.username || '';
    passwordInput.value = config.password || '';
    pathInput.value = config.path || '/bookmarks/';
    syncIntervalInput.value = config.syncInterval || 5;
  }
}

/**
 * 保存配置
 */
configForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const config = {
    serverUrl: serverUrlInput.value.trim(),
    username: usernameInput.value.trim(),
    password: passwordInput.value,
    path: pathInput.value.trim() || '/bookmarks/',
    syncInterval: parseInt(syncIntervalInput.value) || 5
  };
  
  try {
    await storage.saveConfig(config);
    showMessage('配置已保存', 'success');
    
    // 通知后台更新同步任务
    chrome.runtime.sendMessage({ 
      action: 'configUpdated',
      config 
    });
  } catch (error) {
    showMessage('保存失败: ' + error.message, 'error');
  }
});

/**
 * 测试连接
 */
testBtn.addEventListener('click', async () => {
  const config = {
    serverUrl: serverUrlInput.value.trim(),
    username: usernameInput.value.trim(),
    password: passwordInput.value,
    path: pathInput.value.trim() || '/bookmarks/'
  };
  
  if (!config.serverUrl || !config.username || !config.password) {
    showMessage('请填写完整的配置信息', 'error');
    return;
  }
  
  testBtn.disabled = true;
  testBtn.textContent = '测试中...';
  
  try {
    const webdav = new WebDAVClient(config);
    const result = await webdav.testConnection();
    
    if (result.success) {
      showMessage('连接成功！', 'success');
    } else {
      showMessage('连接失败: ' + result.message, 'error');
    }
  } catch (error) {
    showMessage('测试失败: ' + error.message, 'error');
  } finally {
    testBtn.disabled = false;
    testBtn.textContent = '测试连接';
  }
});

/**
 * 立即同步
 */
syncNowBtn.addEventListener('click', async () => {
  syncNowBtn.disabled = true;
  syncNowBtn.textContent = '同步中...';
  
  try {
    chrome.runtime.sendMessage({ action: 'sync' }, (response) => {
      if (response && response.success) {
        showMessage('同步成功', 'success');
        setTimeout(updateSyncStatus, 1000);
      } else {
        showMessage('同步失败: ' + (response?.error || '未知错误'), 'error');
      }
      syncNowBtn.disabled = false;
      syncNowBtn.textContent = '立即同步';
    });
  } catch (error) {
    showMessage('同步失败: ' + error.message, 'error');
    syncNowBtn.disabled = false;
    syncNowBtn.textContent = '立即同步';
  }
});

/**
 * 更新同步状态
 */
async function updateSyncStatus() {
  const status = await storage.getSyncStatus();
  
  const statusMap = {
    'idle': '空闲',
    'syncing': '同步中',
    'success': '成功',
    'error': '错误'
  };
  
  statusText.textContent = statusMap[status.status] || '-';
  statusText.className = 'value ' + status.status;
  
  if (status.lastSync) {
    lastSync.textContent = formatTime(status.lastSync);
  } else {
    lastSync.textContent = '从未同步';
  }
  
  if (status.error) {
    errorItem.style.display = 'flex';
    errorText.textContent = status.error;
  } else {
    errorItem.style.display = 'none';
  }
}

/**
 * 导出书签为JSON格式
 */
exportJsonBtn.addEventListener('click', async () => {
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
    
    showMessage('导出成功', 'success');
  } catch (error) {
    showMessage('导出失败: ' + error.message, 'error');
  }
});

/**
 * 导出书签为HTML格式
 */
exportHtmlBtn.addEventListener('click', async () => {
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
      
      showMessage('导出成功', 'success');
    } else {
      showMessage('HTML导出功能未加载', 'error');
    }
  } catch (error) {
    showMessage('导出失败: ' + error.message, 'error');
  }
});

/**
 * 从浏览器书签栏导入
 */
importBrowserBtn.addEventListener('click', async () => {
  if (!confirm('这将导入浏览器书签栏中的所有书签，是否继续？')) {
    return;
  }
  
  try {
    if (typeof importFromBrowserBookmarks === 'function') {
      const data = await importFromBrowserBookmarks();
      
      // 合并到现有书签
      const existing = await storage.getBookmarks();
      const existingBookmarks = existing.bookmarks || [];
      const existingFolders = existing.folders || [];
      
      // 合并书签（避免重复）
      const urlMap = new Map();
      existingBookmarks.forEach(b => urlMap.set(b.url, b));
      
      data.bookmarks.forEach(b => {
        if (!urlMap.has(b.url)) {
          existingBookmarks.push(b);
          urlMap.set(b.url, b);
        }
      });
      
      // 合并文件夹
      const allFolders = [...new Set([...existingFolders, ...(data.folders || [])])];
      
      await storage.saveBookmarks(existingBookmarks, allFolders);
      
      // 同步到云端
      chrome.runtime.sendMessage({ 
        action: 'syncToCloud', 
        bookmarks: existingBookmarks,
        folders: allFolders
      });
      
      showMessage(`导入成功，共导入 ${data.bookmarks.length} 个书签`, 'success');
    } else {
      showMessage('浏览器书签导入功能未加载', 'error');
    }
  } catch (error) {
    showMessage('导入失败: ' + error.message, 'error');
  }
});

/**
 * 导入书签
 */
importBtn.addEventListener('click', () => {
  importFile.click();
});

importFile.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  
  try {
    const text = await file.text();
    let data;
    
    if (file.name.endsWith('.json')) {
      data = JSON.parse(text);
    } else if (file.name.endsWith('.html')) {
      // 解析HTML格式的书签
      if (typeof parseHtmlBookmarks === 'function') {
        data = parseHtmlBookmarks(text);
      } else {
        showMessage('HTML解析功能未加载', 'error');
        return;
      }
    } else {
      showMessage('不支持的文件格式', 'error');
      return;
    }
    
    if (data.bookmarks && Array.isArray(data.bookmarks)) {
      // 合并到现有书签
      const existing = await storage.getBookmarks();
      const existingBookmarks = existing.bookmarks || [];
      const existingFolders = existing.folders || [];
      
      // 合并书签（避免重复）
      const urlMap = new Map();
      existingBookmarks.forEach(b => urlMap.set(b.url, b));
      
      data.bookmarks.forEach(b => {
        if (!urlMap.has(b.url)) {
          existingBookmarks.push(b);
          urlMap.set(b.url, b);
        }
      });
      
      // 合并文件夹
      const allFolders = [...new Set([...existingFolders, ...(data.folders || [])])];
      
      await storage.saveBookmarks(existingBookmarks, allFolders);
      
      // 同步到云端
      chrome.runtime.sendMessage({ 
        action: 'syncToCloud', 
        bookmarks: existingBookmarks,
        folders: allFolders
      });
      
      showMessage(`导入成功，共导入 ${data.bookmarks.length} 个书签`, 'success');
    } else {
      showMessage('文件格式不正确', 'error');
    }
  } catch (error) {
    showMessage('导入失败: ' + error.message, 'error');
  }
  
  importFile.value = '';
});

/**
 * 加载设备列表
 */
async function loadDevices() {
  try {
    const res = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'getDevices' }, resolve);
    });
    if (res?.error) throw new Error(res.error);
    const devices = res?.devices || [];
    const deviceInfo = res?.deviceInfo;
    currentDeviceName.textContent = deviceInfo?.name || '未知设备';

    if (!devices.length) {
      deviceList.innerHTML = '<div class="empty-state">暂无设备</div>';
      return;
    }

    deviceList.innerHTML = devices.map(dev => {
      const last = dev.lastSeen ? new Date(dev.lastSeen).toLocaleString() : '-';
      const created = dev.createdAt ? new Date(dev.createdAt).toLocaleString() : '-';
      const isCurrent = deviceInfo && dev.id === deviceInfo.id;
      return `
        <div class="device-item" data-id="${dev.id}">
          <div class="device-info">
            <div class="device-name">${dev.name || '未命名设备'} ${isCurrent ? '(当前设备)' : ''}</div>
            <div class="device-meta">创建：${created}</div>
            <div class="device-meta">上次在线：${last}</div>
          </div>
          <div>
            <button class="btn btn-secondary btn-small device-remove" data-id="${dev.id}" ${isCurrent ? 'disabled' : ''}>移除</button>
          </div>
        </div>
      `;
    }).join('');

    deviceList.querySelectorAll('.device-remove').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        if (!confirm('确定移除该设备？移除后该设备将无法同步。')) return;
        const newDevices = devices.filter(d => d.id !== id);
        const saveRes = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: 'saveDevices', devices: newDevices }, resolve);
        });
        if (saveRes?.success) {
          showMessage('已移除设备', 'success');
          loadDevices();
        } else {
          showMessage('移除失败: ' + (saveRes?.error || '未知错误'), 'error');
        }
      });
    });
  } catch (error) {
    showMessage('加载设备失败: ' + error.message, 'error');
  }
}

refreshDevicesBtn.addEventListener('click', loadDevices);

/**
 * 显示消息
 */
function showMessage(message, type) {
  const messageEl = document.createElement('div');
  messageEl.className = `message ${type}`;
  messageEl.textContent = message;
  
  const section = document.querySelector('.section');
  section.insertBefore(messageEl, section.firstChild);
  
  setTimeout(() => {
    messageEl.remove();
  }, 3000);
}

