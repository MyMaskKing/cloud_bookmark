/**
 * 设置页面脚本
 */

const storage = new StorageManager();

// DOM元素
const configForm = document.getElementById('configForm');
const testBtn = document.getElementById('testBtn');
const exportConfigBtn = document.getElementById('exportConfigBtn');
const importConfigBtn = document.getElementById('importConfigBtn');
const syncNowBtn = document.getElementById('syncNowBtn');
const syncUploadBtn = document.getElementById('syncUploadBtn');
const exportJsonBtn = document.getElementById('exportJsonBtn');
const exportHtmlBtn = document.getElementById('exportHtmlBtn');
const importBtn = document.getElementById('importBtn');
const importBrowserBtn = document.getElementById('importBrowserBtn');
const importFile = document.getElementById('importFile');
const deviceList = document.getElementById('deviceList');
const currentDeviceName = document.getElementById('currentDeviceName');
const currentDeviceId = document.getElementById('currentDeviceId');
const refreshDevicesBtn = document.getElementById('refreshDevicesBtn');
const enableDeviceDetection = document.getElementById('enableDeviceDetection');
const expandFirstLevelCheckbox = document.getElementById('expandFirstLevel');
const enableFloatingBall = document.getElementById('enableFloatingBall');
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
  await loadDeviceDetectionSetting();
  await loadFloatingBallSetting();
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
    // 先测试连接，失败则中断保存
    const tester = new WebDAVClient(config);
    const result = await tester.testConnection();
    if (!result.success) {
      showMessage('连接失败: ' + result.message, 'error');
      return;
    }

    await storage.saveConfig(config);
    // WebDAV配置变更后，清空已同步场景列表，让所有场景重新同步
    await storage.clearSyncedScenes();
    showMessage('配置已保存，正在同步数据…', 'success');
    
    // 通知后台更新同步任务
    chrome.runtime.sendMessage({ 
      action: 'configUpdated',
      config 
    });

    // 保存成功后，先拉取云端设置，再注册设备，并同步当前场景数据到本地
    chrome.runtime.sendMessage({ action: 'syncSettingsFromCloud' }, async () => {
      // 等待设备注册完成
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'registerDevice' }, (response) => {
          if (chrome.runtime.lastError) {
            console.error('设备注册失败:', chrome.runtime.lastError);
          } else if (response && !response.success) {
            console.error('设备注册失败:', response.error);
          }
          resolve(response);
        });
      });
      const currentSceneId = await storage.getCurrentScene();
      chrome.runtime.sendMessage({ action: 'sync', sceneId: currentSceneId }, () => {
        // 刷新设置页面显示云端同步的最新数据
        loadScenes();
        loadDevices();
        loadUiSettings();
        loadDeviceDetectionSetting();
        loadFloatingBallSetting();
        updateSyncStatus();
      });
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
      showMessage('连接成功', 'success');
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
 * 导出WebDAV配置到剪贴板
 */
exportConfigBtn.addEventListener('click', async () => {
  try {
    const config = await storage.getConfig();
    if (!config || !config.serverUrl) {
      showMessage('没有可导出的配置', 'error');
      return;
    }
    
    const configText = `${config.serverUrl}\n${config.username || ''}\n${config.password || ''}`;
    
    // 复制到剪贴板
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(configText);
      showMessage('配置已复制到剪贴板', 'success');
    } else {
      // 回退方案：使用传统方法
      const textarea = document.createElement('textarea');
      textarea.value = configText;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        showMessage('配置已复制到剪贴板', 'success');
      } catch (e) {
        showMessage('复制失败，请手动复制', 'error');
      }
      document.body.removeChild(textarea);
    }
  } catch (error) {
    showMessage('导出失败: ' + error.message, 'error');
  }
});

/**
 * 导入WebDAV配置
 */
importConfigBtn.addEventListener('click', async () => {
  const result = await showImportConfigDialog();
  if (!result) return;
  
  const { serverUrl, username, password } = result;
  
  // 填充到表单
  serverUrlInput.value = serverUrl || '';
  usernameInput.value = username || '';
  passwordInput.value = password || '';
  
  showMessage('配置已导入，请检查后保存', 'success');
});

/**
 * 显示导入配置对话框
 */
function showImportConfigDialog() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.35);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2000;
    `;
    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: #fff;
      border-radius: 8px;
      padding: 20px;
      width: 480px;
      max-width: 90%;
      box-shadow: 0 8px 24px rgba(0,0,0,0.18);
      font-size: 14px;
    `;
    dialog.innerHTML = `
      <h3 style="margin: 0 0 12px; font-size: 16px;">导入WebDAV配置</h3>
      <div style="margin-bottom: 12px;">
        <label style="display:block; margin-bottom:6px;">请粘贴配置信息（格式：每行一个，依次为地址、用户名、密码）</label>
        <textarea id="importConfigText" style="width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:6px;font-size:14px;min-height:100px;font-family:monospace;" placeholder="https://example.com/webdav&#10;username&#10;password"></textarea>
      </div>
      <div style="display:flex; justify-content:flex-end; gap:10px;">
        <button id="importConfigCancelBtn" class="btn btn-secondary" style="min-width:70px;">取消</button>
        <button id="importConfigOkBtn" class="btn btn-primary" style="min-width:70px;">导入</button>
      </div>
    `;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const textInput = dialog.querySelector('#importConfigText');
    const cancelBtn = dialog.querySelector('#importConfigCancelBtn');
    const okBtn = dialog.querySelector('#importConfigOkBtn');

    const cleanup = () => {
      overlay.remove();
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
      const text = textInput.value.trim();
      if (!text) {
        alert('请输入配置信息');
        return;
      }
      
      const lines = text.split('\n').map(line => line.trim()).filter(line => line);
      if (lines.length < 1) {
        alert('配置格式不正确，至少需要提供服务器地址');
        return;
      }
      
      const serverUrl = lines[0];
      const username = lines[1] || '';
      const password = lines[2] || '';
      
      cleanup();
      resolve({ serverUrl, username, password });
    };

    textInput.focus();
  });
}

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
    let devices = res?.devices || [];
    const deviceInfo = res?.deviceInfo;
    currentDeviceName.textContent = deviceInfo?.name || '未知设备';
    currentDeviceId.textContent = deviceInfo?.id || '-';

    if (!devices.length) {
      deviceList.innerHTML = '<div class="empty-state">暂无设备</div>';
      return;
    }

    // 按创建时间倒序排列（最新的在前）
    devices = devices.sort((a, b) => {
      const timeA = a.createdAt || 0;
      const timeB = b.createdAt || 0;
      return timeB - timeA;
    });

    deviceList.innerHTML = devices.map(dev => {
      const last = dev.lastSeen ? new Date(dev.lastSeen).toLocaleString() : '-';
      const created = dev.createdAt ? new Date(dev.createdAt).toLocaleString() : '-';
      const isCurrent = deviceInfo && dev.id === deviceInfo.id;
      return `
        <div class="device-item" data-id="${dev.id}">
          <div class="device-info">
            <div class="device-name">${dev.name || '未命名设备'} ${isCurrent ? '(当前设备)' : ''}</div>
            <div class="device-meta">设备ID：${dev.id || '-'}</div>
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
 * 加载设备检测设置
 */
async function loadDeviceDetectionSetting() {
  try {
    const settings = await storage.getSettings();
    const deviceDetection = (settings && settings.deviceDetection) || {};
    // 默认关闭
    enableDeviceDetection.checked = deviceDetection.enabled === true;
  } catch (e) {
    console.warn('加载设备检测设置失败', e);
    enableDeviceDetection.checked = false;
  }
}

/**
 * 设备检测开关变更
 */
enableDeviceDetection.addEventListener('change', async () => {
  try {
    const settings = await storage.getSettings();
    const deviceDetection = { enabled: enableDeviceDetection.checked };
    const newSettings = { ...(settings || {}), deviceDetection };
    await storage.saveSettings(newSettings);
    // 立即同步到云端
    chrome.runtime.sendMessage({ action: 'syncSettings' });
    showMessage('设备检测设置已保存（已同步至云端）', 'success');
  } catch (e) {
    showMessage('保存失败: ' + e.message, 'error');
  }
});

/**
 * 加载悬浮球设置
 */
async function loadFloatingBallSetting() {
  try {
    const settings = await storage.getSettings();
    const floatingBall = (settings && settings.floatingBall) || {};
    enableFloatingBall.checked = !!floatingBall.enabled;
  } catch (e) {
    console.warn('加载悬浮球设置失败', e);
    enableFloatingBall.checked = false;
  }
}

/**
 * 悬浮球开关变更
 */
enableFloatingBall.addEventListener('change', async () => {
  try {
    const settings = await storage.getSettings();
    const floatingBall = { enabled: enableFloatingBall.checked };
    const newSettings = { ...(settings || {}), floatingBall };
    await storage.saveSettings(newSettings);
    // 立即同步到云端
    chrome.runtime.sendMessage({ action: 'syncSettings' });
    // 通知所有标签页更新悬浮球状态
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, { action: 'updateFloatingBall' }).catch(() => {});
      });
    });
    showMessage('悬浮球设置已保存（已同步至云端）', 'success');
  } catch (e) {
    showMessage('保存失败: ' + e.message, 'error');
  }
});

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
            <span class="scene-id">ID: ${scene.id}</span>
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
          
          // 检查 WebDAV 配置是否有效
          const config = await storage.getConfig();
          const hasValidConfig = config && config.serverUrl;
          // 检查该场景是否已同步过
          const isSceneSynced = await storage.isSceneSynced(sceneId);
          
          // WebDAV配置有效且该场景从未同步过，需要执行云端同步
          if (hasValidConfig && !isSceneSynced) {
            try {
              await new Promise(resolve => {
                chrome.runtime.sendMessage({ action: 'sync', sceneId }, resolve);
              });
            } catch (e) {
              // 忽略单次同步失败，继续后续逻辑
            }
            const afterSync = await storage.getBookmarks(sceneId);
            const hasAfter = (afterSync.bookmarks && afterSync.bookmarks.length) || (afterSync.folders && afterSync.folders.length);
            if (!hasAfter) {
              // 云端也没有，创建一个空文件以便后续同步
              try {
                await new Promise(resolve => {
                  chrome.runtime.sendMessage({ action: 'syncToCloud', bookmarks: [], folders: [], sceneId }, resolve);
                });
              } catch (e) {
                // 忽略，等待用户后续添加书签再同步
              }
            }
            // 场景切换不同步到云端，只保存在本地
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
 * 弹出创建场景对话框（名称+ID）
 * @returns {Promise<{name: string, id: string} | null>}
 */
function showCreateSceneDialog() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.35);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2000;
    `;
    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: #fff;
      border-radius: 8px;
      padding: 20px;
      width: 360px;
      max-width: 90%;
      box-shadow: 0 8px 24px rgba(0,0,0,0.18);
      font-size: 14px;
    `;
    dialog.innerHTML = `
      <h3 style="margin: 0 0 12px; font-size: 16px;">创建场景</h3>
      <div style="margin-bottom: 12px;">
        <label style="display:block; margin-bottom:6px;">场景名称</label>
        <input id="sceneNameInput" type="text" style="width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:6px;font-size:14px;" placeholder="请输入场景名称">
      </div>
      <div style="margin-bottom: 16px;">
        <label style="display:block; margin-bottom:6px;">场景ID（唯一，仅字母/数字/下划线）</label>
        <input id="sceneIdInput" type="text" style="width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:6px;font-size:14px;" placeholder="例如：work_01">
      </div>
      <div style="display:flex; justify-content:flex-end; gap:10px;">
        <button id="sceneCancelBtn" class="btn btn-secondary" style="min-width:70px;">取消</button>
        <button id="sceneOkBtn" class="btn btn-primary" style="min-width:70px;">确定</button>
      </div>
    `;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const nameInput = dialog.querySelector('#sceneNameInput');
    const idInput = dialog.querySelector('#sceneIdInput');
    const cancelBtn = dialog.querySelector('#sceneCancelBtn');
    const okBtn = dialog.querySelector('#sceneOkBtn');

    const cleanup = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKeyDown);
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        cleanup();
        resolve(null);
      } else if (e.key === 'Enter') {
        okBtn.click();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    cancelBtn.onclick = () => {
      cleanup();
      resolve(null);
    };

    okBtn.onclick = () => {
      const name = nameInput.value.trim();
      const idRaw = idInput.value.trim();
      if (!name) {
        alert('场景名称不能为空');
        return;
      }
      if (!idRaw) {
        alert('场景ID不能为空');
        return;
      }
      if (!/^[a-zA-Z0-9_]+$/.test(idRaw)) {
        alert('场景ID 只能包含字母、数字和下划线');
        return;
      }
      cleanup();
      resolve({ name, id: idRaw });
    };

    nameInput.focus();
  });
}

/**
 * 添加场景
 */
addSceneBtn.addEventListener('click', async () => {
  const result = await showCreateSceneDialog();
  if (!result) return;
  const { name, id: sceneId } = result;

  const scenes = await storage.getScenes();
  if (scenes.find(s => s.id === sceneId)) {
    alert('场景ID已存在，请换一个');
    return;
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

