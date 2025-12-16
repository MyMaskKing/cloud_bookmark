/**
 * 设置页面脚本
 */

const storage = new StorageManager();

// DOM元素
const configForm = document.getElementById('configForm');
const testBtn = document.getElementById('testBtn');
const syncNowBtn = document.getElementById('syncNowBtn');
const syncUploadBtn = document.getElementById('syncUploadBtn');
const exportJsonBtn = document.getElementById('exportJsonBtn');
const exportHtmlBtn = document.getElementById('exportHtmlBtn');
const importBtn = document.getElementById('importBtn');
const importBrowserBtn = document.getElementById('importBrowserBtn');
const importFile = document.getElementById('importFile');
const deviceList = document.getElementById('deviceList');
const currentDeviceName = document.getElementById('currentDeviceName');
const refreshDevicesBtn = document.getElementById('refreshDevicesBtn');
const expandFirstLevelCheckbox = document.getElementById('expandFirstLevel');
const sceneList = document.getElementById('sceneList');
const currentSceneName = document.getElementById('currentSceneName');
const addSceneBtn = document.getElementById('addSceneBtn');
const sceneSelectModal = document.getElementById('sceneSelectModal');
const sceneSelectList = document.getElementById('sceneSelectList');
const sceneSelectClose = document.getElementById('sceneSelectClose');
const sceneSelectCancel = document.getElementById('sceneSelectCancel');
const sceneSelectConfirm = document.getElementById('sceneSelectConfirm');

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
  await loadUiSettings();
  await loadScenes();
  
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

    // 保存/测试成功后，尝试拉取云端设置
    chrome.runtime.sendMessage({ action: 'syncSettingsFromCloud' });
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

      // 测试成功后尝试拉取云端设置
      chrome.runtime.sendMessage({ action: 'syncSettingsFromCloud' });
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
 * 立即上传（本地 -> 云端）
 */
syncUploadBtn.addEventListener('click', async () => {
  syncUploadBtn.disabled = true;
  syncUploadBtn.textContent = '上传中...';
  try {
    chrome.runtime.sendMessage({ action: 'syncUpload' }, (response) => {
      if (response && response.success) {
        showMessage('上传成功', 'success');
      } else {
        showMessage('上传失败: ' + (response?.error || '未知错误'), 'error');
      }
      syncUploadBtn.disabled = false;
      syncUploadBtn.textContent = '立即上传';
    });
  } catch (error) {
    showMessage('上传失败: ' + error.message, 'error');
    syncUploadBtn.disabled = false;
    syncUploadBtn.textContent = '立即上传';
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
    // 只导出当前场景的书签
    const currentSceneId = await storage.getCurrentScene();
    const data = await storage.getBookmarks(currentSceneId);
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
    // 只导出当前场景的书签
    const currentSceneId = await storage.getCurrentScene();
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
    // 选择导入场景
    const targetSceneId = await showSceneSelectDialog();
    if (!targetSceneId) {
      // 用户取消了选择
      return;
    }
    
    if (typeof importFromBrowserBookmarks === 'function') {
      const data = await importFromBrowserBookmarks();
      if (data.unsupported) {
        showMessage(data.reason || '当前浏览器不支持书签 API，请改用 HTML 导入或桌面浏览器', 'error');
        return;
      }
      
      // 规范化路径，合并到现有书签，清理空文件夹
      const normalizeFolder = (p) => (p || '').trim().replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
      const importedBookmarks = (data.bookmarks || []).map(b => ({
        ...b,
        folder: b.folder ? normalizeFolder(b.folder) : undefined,
        scene: targetSceneId // 设置场景
      }));

      // 获取所有书签（包括其他场景）
      const allBookmarks = await storage.getBookmarks();
      const otherSceneBookmarks = (allBookmarks.bookmarks || []).filter(b => b.scene !== targetSceneId);
      
      // 合并书签（避免重复 URL，仅在同一场景内检测）
      const sceneBookmarks = (allBookmarks.bookmarks || []).filter(b => b.scene === targetSceneId);
      const urlMap = new Map();
      sceneBookmarks.forEach(b => urlMap.set(b.url, b));
      
      let added = 0;
      importedBookmarks.forEach(b => {
        if (!urlMap.has(b.url)) {
          sceneBookmarks.push(b);
          urlMap.set(b.url, b);
          added += 1;
        }
      });
      
      // 合并所有场景的书签
      const mergedBookmarks = [...otherSceneBookmarks, ...sceneBookmarks];
      
      // 仅保留有书签引用的文件夹（清理空文件夹）
      const usedFolders = new Set(
        mergedBookmarks.map(b => normalizeFolder(b.folder)).filter(Boolean)
      );
      const allFolders = [...usedFolders];

      await storage.saveBookmarks(mergedBookmarks, allFolders);
      
      // 同步到云端（同步到选择的场景）
      chrome.runtime.sendMessage({ 
        action: 'syncToCloud', 
        bookmarks: sceneBookmarks,
        folders: [...new Set(sceneBookmarks.map(b => normalizeFolder(b.folder)).filter(Boolean))],
        sceneId: targetSceneId // 明确指定场景ID
      });
      
      const scenes = await storage.getScenes();
      const sceneName = scenes.find(s => s.id === targetSceneId)?.name || targetSceneId;
      showMessage(`导入成功，新增 ${added} 个书签到"${sceneName}"场景`, 'success');
    } else {
      showMessage('浏览器书签导入功能未加载', 'error');
    }
  } catch (error) {
    showMessage('导入失败: ' + error.message, 'error');
  }
});

/**
 * 界面设置 - 弹窗默认展开第一层
 */
async function loadUiSettings() {
  const settings = await storage.getSettings();
  const popup = (settings && settings.popup) || {};
  expandFirstLevelCheckbox.checked = !!popup.expandFirstLevel;
}

expandFirstLevelCheckbox.addEventListener('change', async () => {
  try {
    const settings = await storage.getSettings();
    const popup = (settings && settings.popup) || {};
    popup.expandFirstLevel = expandFirstLevelCheckbox.checked;
    const newSettings = { ...(settings || {}), popup };
    await storage.saveSettings(newSettings);
    // 重置弹窗文件夹展开状态，下次按新设置重新计算
    chrome.storage.local.set({
      popupFolderState: {
        expanded: [''],
        lastExpandFirstLevel: !!popup.expandFirstLevel
      }
    });
    showMessage('界面设置已保存（已同步至云端）', 'success');
    chrome.runtime.sendMessage({ action: 'syncSettings' });
  } catch (e) {
    showMessage('保存失败: ' + e.message, 'error');
  }
});

/**
 * 显示场景选择对话框
 * @returns {Promise<String|null>} 返回选中的场景ID，取消返回null
 */
function showSceneSelectDialog() {
  return new Promise(async (resolve) => {
    try {
      const scenes = await storage.getScenes();
      const currentSceneId = await storage.getCurrentScene();
      
      // 渲染场景列表
      sceneSelectList.innerHTML = scenes.map(scene => {
        const isCurrent = scene.id === currentSceneId;
        return `
          <div class="scene-select-item ${isCurrent ? 'selected' : ''}" data-id="${scene.id}">
            <div class="scene-select-item-name">${scene.name || scene.id}</div>
            <div class="scene-select-item-id">ID: ${scene.id}</div>
          </div>
        `;
      }).join('');
      
      // 绑定点击事件
      let selectedSceneId = currentSceneId;
      sceneSelectList.querySelectorAll('.scene-select-item').forEach(item => {
        item.addEventListener('click', () => {
          sceneSelectList.querySelectorAll('.scene-select-item').forEach(i => i.classList.remove('selected'));
          item.classList.add('selected');
          selectedSceneId = item.dataset.id;
        });
      });
      
      // 显示对话框
      sceneSelectModal.style.display = 'flex';
      
      // 关闭对话框的处理函数
      const closeDialog = (result) => {
        sceneSelectModal.style.display = 'none';
        resolve(result);
      };
      
      // 绑定关闭事件（只绑定一次）
      const handleClose = () => closeDialog(null);
      const handleConfirm = () => closeDialog(selectedSceneId);
      
      sceneSelectClose.onclick = handleClose;
      sceneSelectCancel.onclick = handleClose;
      sceneSelectConfirm.onclick = handleConfirm;
      
      // 点击背景关闭
      sceneSelectModal.onclick = (e) => {
        if (e.target === sceneSelectModal) {
          handleClose();
        }
      };
      
      // ESC键关闭
      const handleEsc = (e) => {
        if (e.key === 'Escape') {
          handleClose();
          document.removeEventListener('keydown', handleEsc);
        }
      };
      document.addEventListener('keydown', handleEsc);
      
    } catch (error) {
      console.error('显示场景选择对话框失败:', error);
      resolve(null);
    }
  });
}

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
      // 选择导入场景
      const targetSceneId = await showSceneSelectDialog();
      if (!targetSceneId) {
        // 用户取消了选择
        importFile.value = '';
        return;
      }
      
      // 规范化并仅保留实际使用的文件夹
      const normalizeFolder = (p) => (p || '').trim().replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
      const importedBookmarks = data.bookmarks.map(b => ({
        ...b,
        folder: b.folder ? normalizeFolder(b.folder) : undefined,
        scene: targetSceneId // 设置场景
      }));

      // 获取所有书签（包括其他场景）
      const allBookmarks = await storage.getBookmarks();
      const otherSceneBookmarks = (allBookmarks.bookmarks || []).filter(b => b.scene !== targetSceneId);
      
      // 合并书签（避免重复 URL，仅在同一场景内检测）
      const sceneBookmarks = (allBookmarks.bookmarks || []).filter(b => b.scene === targetSceneId);
      const urlMap = new Map();
      sceneBookmarks.forEach(b => urlMap.set(b.url, b));
      
      let added = 0;
      importedBookmarks.forEach(b => {
        if (!urlMap.has(b.url)) {
          sceneBookmarks.push(b);
          urlMap.set(b.url, b);
          added += 1;
        }
      });
      
      // 合并所有场景的书签
      const mergedBookmarks = [...otherSceneBookmarks, ...sceneBookmarks];
      
      // 导入时清空空文件夹：仅保留有书签引用的文件夹
      const usedFolders = new Set(
        mergedBookmarks.map(b => normalizeFolder(b.folder)).filter(Boolean)
      );
      const allFolders = [...usedFolders];
      
      await storage.saveBookmarks(mergedBookmarks, allFolders);
      
      // 同步到云端（同步到选择的场景）
      chrome.runtime.sendMessage({ 
        action: 'syncToCloud', 
        bookmarks: sceneBookmarks,
        folders: [...new Set(sceneBookmarks.map(b => normalizeFolder(b.folder)).filter(Boolean))],
        sceneId: targetSceneId // 明确指定场景ID
      });
      
      const scenes = await storage.getScenes();
      const sceneName = scenes.find(s => s.id === targetSceneId)?.name || targetSceneId;
      showMessage(`导入成功，新增 ${added} 个书签到"${sceneName}"场景`, 'success');
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
            <button class="btn btn-secondary btn-small device-remove" data-id="${dev.id}" data-current="${isCurrent ? '1' : '0'}">移除</button>
          </div>
        </div>
      `;
    }).join('');

    deviceList.querySelectorAll('.device-remove').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const isCurrent = btn.dataset.current === '1';
        if (!confirm('确定移除该设备？移除后该设备将无法同步。')) return;
        if (isCurrent) {
          const doubleCheck = confirm('这是当前设备，移除后本机会在下一次同步清空本地数据并停止同步，确定继续？');
          if (!doubleCheck) return;
        }
        const newDevices = devices.filter(d => d.id !== id);
        const saveRes = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: 'saveDevices', devices: newDevices }, resolve);
        });
        if (saveRes?.success) {
          showMessage('已移除设备', 'success');
          chrome.runtime.sendMessage({ action: 'syncSettings' });
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
 * 加载场景列表
 */
async function loadScenes() {
  try {
    const scenes = await storage.getScenes();
    const currentSceneId = await storage.getCurrentScene();
    const currentScene = scenes.find(s => s.id === currentSceneId);
    currentSceneName.textContent = currentScene ? currentScene.name : '-';

    if (!scenes.length) {
      sceneList.innerHTML = '<div class="empty-state">暂无场景</div>';
      return;
    }

    sceneList.innerHTML = scenes.map(scene => {
      const isCurrent = scene.id === currentSceneId;
      const isDefault = scene.isDefault;
      return `
        <div class="scene-item ${isCurrent ? 'current' : ''}" data-id="${scene.id}">
          <div class="scene-info">
            <span class="scene-name">${scene.name || scene.id}</span>
            ${isCurrent ? '<span class="scene-badge">当前</span>' : ''}
            ${isDefault ? '<span class="scene-badge default">默认</span>' : ''}
          </div>
          <div class="scene-actions">
            ${!isDefault ? `
              <button class="scene-action-btn" data-action="rename" data-id="${scene.id}">重命名</button>
              <button class="scene-action-btn" data-action="delete" data-id="${scene.id}">删除</button>
            ` : '<span style="color: #999; font-size: 12px;">默认场景不可编辑</span>'}
            ${!isCurrent ? `<button class="scene-action-btn" data-action="switch" data-id="${scene.id}">切换</button>` : ''}
          </div>
        </div>
      `;
    }).join('');

    // 绑定事件
    sceneList.querySelectorAll('.scene-action-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        const sceneId = btn.dataset.id;
        const scene = scenes.find(s => s.id === sceneId);
        
        if (action === 'switch') {
          await storage.saveCurrentScene(sceneId);
          showMessage(`已切换到"${scene.name}"场景`, 'success');
          chrome.runtime.sendMessage({ action: 'syncSettings' });
          // 如果本地该场景无数据，再从云端同步
          const localData = await storage.getBookmarks(sceneId);
          const hasLocal = (localData.bookmarks && localData.bookmarks.length) || (localData.folders && localData.folders.length);
          if (!hasLocal) {
            await new Promise(resolve => {
              chrome.runtime.sendMessage({ action: 'sync', sceneId }, resolve);
            });
          }
          await loadScenes();
        } else if (action === 'rename') {
          const newName = prompt(`重命名场景"${scene.name}"：`, scene.name);
          if (newName && newName.trim() && newName !== scene.name) {
            try {
              await storage.updateScene(sceneId, { name: newName.trim() });
              showMessage('场景已重命名', 'success');
              chrome.runtime.sendMessage({ action: 'syncSettings' });
              await loadScenes();
            } catch (e) {
              showMessage('重命名失败: ' + e.message, 'error');
            }
          }
        } else if (action === 'delete') {
          if (!confirm(`确定删除场景"${scene.name}"？\n\n删除后该场景下的所有书签将被删除，此操作不可恢复。`)) {
            return;
          }
          const confirmDelete = confirm('再次确认：删除场景将同时删除云端和本地的所有相关书签，确定继续？');
          if (!confirmDelete) return;
          
          try {
            // 删除场景
            await storage.deleteScene(sceneId);
            // 删除本地该场景的书签
            const allBookmarks = await storage.getBookmarks();
            const filteredBookmarks = (allBookmarks.bookmarks || []).filter(b => b.scene !== sceneId);
            const filteredFolders = [...new Set(filteredBookmarks.map(b => b.folder).filter(Boolean))];
            await storage.saveBookmarks(filteredBookmarks, filteredFolders);
            // 通知后台删除云端文件
            chrome.runtime.sendMessage({ action: 'deleteSceneBookmarks', sceneId });
            showMessage('场景已删除', 'success');
            chrome.runtime.sendMessage({ action: 'syncSettings' });
            await loadScenes();
          } catch (e) {
            showMessage('删除失败: ' + e.message, 'error');
          }
        }
      });
    });
  } catch (error) {
    showMessage('加载场景失败: ' + error.message, 'error');
    sceneList.innerHTML = '<div class="empty-state">加载失败</div>';
  }
}

/**
 * 添加场景
 */
addSceneBtn.addEventListener('click', async () => {
  const name = prompt('请输入场景名称：');
  if (!name || !name.trim()) return;
  
  // 生成场景ID（基于名称，转换为小写，替换空格为下划线）
  let sceneId = name.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  if (!sceneId) {
    sceneId = 'scene_' + Date.now().toString(36);
  }
  
  // 检查ID是否已存在
  const scenes = await storage.getScenes();
  if (scenes.find(s => s.id === sceneId)) {
    sceneId = sceneId + '_' + Date.now().toString(36);
  }
  
  try {
    await storage.addScene({
      id: sceneId,
      name: name.trim(),
      isDefault: false
    });
    showMessage('场景已添加', 'success');
    chrome.runtime.sendMessage({ action: 'syncSettings' });
    await loadScenes();
  } catch (e) {
    showMessage('添加失败: ' + e.message, 'error');
  }
});

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

