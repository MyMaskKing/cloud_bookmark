/**
 * 设置页面脚本
 */

const storage = new StorageManager();
const runtimeAPI = typeof browser !== 'undefined' ? browser.runtime : chrome.runtime;

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
        // 静默处理，返回 null 而不是抛出错误
        if (callback) callback(null);
        return null;
      }

      // 其他错误正常抛出
      if (callback) callback(null);
      throw error;
    });
  } else {
    // Chrome: 使用回调
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

// 判断是否为后台未就绪的典型错误
function isReceivingEndError(err) {
  if (!err) return false;
  const msg = err.message || String(err);
  return msg.includes('Receiving end does not exist') || msg.includes('Could not establish connection');
}

// 通用带重试的消息发送（主要防 Firefox 背景未激活）
async function sendWithRetry(message, { retries = 2, delay = 300 } = {}) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await sendMessageCompat(message);
      // sendMessageCompat 在 Firefox 未就绪时会返回 null，这里也当作需重试
      if (res !== null && res !== undefined) return res;
      if (i === retries) return res;
    } catch (err) {
      if (!isReceivingEndError(err) || i === retries) throw err;
    }
    await new Promise(r => setTimeout(r, delay * (i + 1)));
  }
}

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
const checkInvalidUrlsBtn = document.getElementById('checkInvalidUrlsBtn');
const importFile = document.getElementById('importFile');
const deviceList = document.getElementById('deviceList');
const currentDeviceName = document.getElementById('currentDeviceName');
const currentDeviceId = document.getElementById('currentDeviceId');
const refreshDevicesBtn = document.getElementById('refreshDevicesBtn');
const enableDeviceDetection = document.getElementById('enableDeviceDetection');
const expandFirstLevelCheckbox = document.getElementById('expandFirstLevel');
const showUpdateButtonCheckbox = document.getElementById('showUpdateButton');
const enableFloatingBall = document.getElementById('enableFloatingBall');
const floatingBallPositionGroup = document.getElementById('floatingBallPositionGroup');
const floatingBallDefaultPosition = document.getElementById('floatingBallDefaultPosition');
const floatingBallActionGroup = document.getElementById('floatingBallActionGroup');
const floatingBallClickAction = document.getElementById('floatingBallClickAction');
const enableSyncErrorNotification = document.getElementById('enableSyncErrorNotification');
const stickySyncErrorToast = document.getElementById('stickySyncErrorToast');
const rememberScrollPosition = document.getElementById('rememberScrollPosition');
const floatingBallPopupHeightPc = document.getElementById('floatingBallPopupHeightPc');
const floatingBallPopupHeightMobile = document.getElementById('floatingBallPopupHeightMobile');
const syncFloatingBallHeightPc = document.getElementById('syncFloatingBallHeightPc');
const syncFloatingBallHeightMobile = document.getElementById('syncFloatingBallHeightMobile');
const iconPopupHeightPc = document.getElementById('iconPopupHeightPc');
const iconPopupHeightMobile = document.getElementById('iconPopupHeightMobile');
const syncIconHeightPc = document.getElementById('syncIconHeightPc');
const syncIconHeightMobile = document.getElementById('syncIconHeightMobile');
const shortcutDisplayWin = document.getElementById('shortcutDisplayWin');
const shortcutDisplayMac = document.getElementById('shortcutDisplayMac');
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
  await loadShortcutDisplay();
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

    // 判断是否是首次保存webdav配置
    const oldConfig = await storage.getConfig();
    const isFirstTime = !oldConfig || !oldConfig.serverUrl;

    await storage.saveConfig(config);
    // WebDAV配置变更后，清空已同步场景列表，让所有场景重新同步
    await storage.clearSyncedScenes();

    if (isFirstTime) {
      showMessage('配置已保存，正在归档本地书签并同步到云端…', 'success');
    } else {
      showMessage('配置已保存，正在清空本地数据并从云端重新同步…', 'success');
    }

    try {
      // 通知后台更新同步任务
      await sendMessageCompat({
        action: 'configUpdated',
        config
      });

      // Firefox 中可能需要等待 background script 准备好，添加短暂延迟
      await new Promise(resolve => setTimeout(resolve, 100));

      // 非首次保存时，先清空本地数据，避免旧数据被同步到新云端
      if (!isFirstTime) {
        console.log('[保存配置] 非首次保存，先清空本地数据');
        try {
          const clearResult = await sendMessageCompat({ action: 'clearLocalDataForReconfig' });
          if (!clearResult || !clearResult.success) {
            console.warn('[保存配置] 清空本地数据失败，继续同步:', clearResult?.error || 'unknown');
          }
        } catch (error) {
          console.warn('[保存配置] 清空本地数据时出错，继续同步:', error.message);
        }
      }

      // 从新云端同步设置（非首次保存时，本地数据已清空，会使用新云端的内容）
      // 非首次保存时，传递 forceClear: true，确保即使云端没有场景列表也清空本地场景列表
      try {
        const syncSettingsResponse = await sendMessageCompat({
          action: 'syncSettingsFromCloud',
          forceClear: !isFirstTime  // 非首次保存时，强制清空场景列表
        });
        // 如果返回 null（Firefox 中 background script 未准备好），等待后重试一次
        if (syncSettingsResponse === null) {
          await new Promise(resolve => setTimeout(resolve, 300));
          await sendMessageCompat({
            action: 'syncSettingsFromCloud',
            forceClear: !isFirstTime  // 非首次保存时，强制清空场景列表
          });
        }
      } catch (error) {
        const isReceivingEndError = error && (
          error.message?.includes('Receiving end does not exist') ||
          error.message?.includes('Could not establish connection') ||
          String(error).includes('Receiving end does not exist') ||
          String(error).includes('Could not establish connection')
        );
        if (!isReceivingEndError) {
          console.warn('同步设置失败:', error.message || error);
        }
      }

      // 等待设备注册完成（带重试机制）
      // 非首次保存时，本地数据已清空，注册设备时会从新云端拉取设备列表
      let registerSuccess = false;
      for (let retry = 0; retry < 3; retry++) {
        try {
          const registerResponse = await sendMessageCompat({ action: 'registerDevice' });
          if (registerResponse && registerResponse.success) {
            registerSuccess = true;
            break;
          } else if (registerResponse && !registerResponse.success) {
            // 明确的失败响应，不再重试
            break;
          } else if (registerResponse === null) {
            // Firefox 中，如果 background script 未准备好，sendMessage 返回 null
            if (retry < 2) {
              // 等待后重试
              await new Promise(resolve => setTimeout(resolve, 200 * (retry + 1)));
              continue;
            }
          }
        } catch (error) {
          // Firefox 中，如果 background script 未准备好，会抛出 "Receiving end does not exist" 错误
          const isReceivingEndError = error && (
            error.message?.includes('Receiving end does not exist') ||
            error.message?.includes('Could not establish connection') ||
            String(error).includes('Receiving end does not exist') ||
            String(error).includes('Could not establish connection')
          );
          if (isReceivingEndError && retry < 2) {
            // 等待后重试
            await new Promise(resolve => setTimeout(resolve, 200 * (retry + 1)));
            continue;
          } else if (!isReceivingEndError) {
            // 其他错误只记录一次
            if (retry === 0) {
              console.warn('设备注册失败:', error.message || error);
            }
            break;
          }
        }
      }

      const currentSceneId = await storage.getCurrentScene();
      try {
        // 保存配置时只注册设备，不进行设备检测（skipDeviceDetection: true）
        // 设备检测只在定时同步时进行
        // skipDeviceListSync: true - 跳过设备列表同步，避免覆盖刚注册的设备（首次保存时）
        // clearLocalFirst: false - 非首次保存时，已经在前面清空了本地数据，这里不再清空
        const syncResponse = await sendWithRetry(
          {
            action: 'sync',
            sceneId: currentSceneId,
            skipDeviceDetection: true,
            skipDeviceListSync: isFirstTime, // 首次保存时跳过设备列表同步，非首次保存时同步设备列表
            clearLocalFirst: false // 非首次保存时已经在前面清空了，这里不再清空
          },
          { retries: 2, delay: 300 }
        );
        // sendWithRetry 已处理 null/重试，这里无需额外处理
        if (syncResponse && !syncResponse.success) {
          console.warn('同步失败:', syncResponse.error || 'unknown');
        }
      } catch (error) {
        if (!isReceivingEndError(error)) {
          console.warn('同步失败:', error.message || error);
        }
      }

      // 刷新设置页面显示云端同步的最新数据
      loadScenes();
      loadDevices();
      loadUiSettings();
      loadDeviceDetectionSetting();
      loadFloatingBallSetting();
      updateSyncStatus();
    } catch (error) {
      console.error('同步过程出错:', error);
      showMessage('配置已保存，但同步过程出现错误: ' + error.message, 'error');
    }
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
    const response = await sendMessageCompat({ action: 'sync' });
    if (response && response.success) {
      showMessage('同步成功', 'success');
      setTimeout(updateSyncStatus, 1000);
    } else {
      showMessage('同步失败: ' + (response?.error || '未知错误'), 'error');
    }
  } catch (error) {
    showMessage('同步失败: ' + error.message, 'error');
  } finally {
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
    const response = await sendMessageCompat({ action: 'syncUpload' });
    if (response && response.success) {
      showMessage('上传成功', 'success');
    } else {
      showMessage('上传失败: ' + (response?.error || '未知错误'), 'error');
    }
  } catch (error) {
    showMessage('上传失败: ' + error.message, 'error');
  } finally {
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

      // 规范化路径 + 补齐父级路径（保证 folders 与画面树一致，例如补齐 “.../4.仕事&邮件”）
      const normalizeFolder = (p) => (p || '').trim().replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
      const expandFolderPathsPreserveOrder = (paths) => {
        const out = [];
        const seen = new Set();
        (paths || []).forEach((p) => {
          const n = normalizeFolder(p || '');
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
      };
      const importedBookmarks = (data.bookmarks || []).map(b => ({
        ...b,
        folder: b.folder ? normalizeFolder(b.folder) : undefined,
        scene: targetSceneId // 设置场景
      }));

      // 获取当前场景书签
      const sceneData = await storage.getBookmarks(targetSceneId);
      const sceneBookmarks = sceneData.bookmarks || [];
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

      // folders：优先使用导入返回的 folders（完整层级），并补齐父级；再补上书签中引用的 folder
      const importedFoldersRaw = (data.folders || []).map(normalizeFolder).filter(Boolean);
      const bookmarkFoldersRaw = sceneBookmarks.map(b => normalizeFolder(b.folder)).filter(Boolean);
      const foldersForScene = expandFolderPathsPreserveOrder([...importedFoldersRaw, ...bookmarkFoldersRaw]);

      // 仅更新目标场景（保留其他场景不变），并保存该场景的 folders（包含父级层级）
      await storage.saveBookmarks(sceneBookmarks, foldersForScene, targetSceneId);

      // 1. 同步到云端（异步执行，不阻塞 UI 反馈）
      sendMessageCompat({
        action: 'syncToCloud',
        bookmarks: sceneBookmarks,
        folders: foldersForScene,
        sceneId: targetSceneId
      }).catch(err => console.error('导入后后台同步失败:', err));

      const scenes = await storage.getScenes();
      const sceneName = scenes.find(s => s.id === targetSceneId)?.name || targetSceneId;
      showMessage(`导入完成，正在后台同步 ${added} 个书签到"${sceneName}"场景`, 'success');
    } else {
      showMessage('浏览器书签导入功能未加载', 'error');
    }
  } catch (error) {
    showMessage('导入失败: ' + error.message, 'error');
  }
});

/**
 * 检测失效网站
 */
checkInvalidUrlsBtn.addEventListener('click', async () => {
  if (!checkInvalidUrlsBtn) return;

  const originalText = checkInvalidUrlsBtn.textContent;
  checkInvalidUrlsBtn.disabled = true;
  checkInvalidUrlsBtn.textContent = '检测中...';

  try {
    // 获取当前场景的所有书签
    const currentSceneId = await storage.getCurrentScene();
    const data = await storage.getBookmarks(currentSceneId);
    let bookmarks = data.bookmarks || [];

    if (bookmarks.length === 0) {
      showMessage('当前场景没有书签', 'info');
      checkInvalidUrlsBtn.disabled = false;
      checkInvalidUrlsBtn.textContent = originalText;
      return;
    }

    // 获取已移除的失效网站列表（按场景存储）
    const settings = await storage.getSettings();
    const ignoredInvalidUrls = settings?.ignoredInvalidUrls || {}; // { sceneId: [url1, url2, ...] }
    const currentSceneIgnoredUrls = new Set(ignoredInvalidUrls[currentSceneId] || []);

    // 过滤掉已移除的失效网站
    bookmarks = bookmarks.filter(bookmark => {
      return !currentSceneIgnoredUrls.has(bookmark.url);
    });

    if (bookmarks.length === 0) {
      showMessage('当前场景没有需要检测的书签（已移除的网站已排除）', 'info');
      checkInvalidUrlsBtn.disabled = false;
      checkInvalidUrlsBtn.textContent = originalText;
      return;
    }

    // 检测每个书签的URL是否有效
    const invalidBookmarks = [];
    let checkedCount = 0;

    // 使用 Promise.all 并发检测，但限制并发数量（避免过多请求）
    const concurrency = 5;
    const checkUrl = async (bookmark) => {
      try {
        // 兼容性：检查 AbortController 是否支持
        let controller = null;
        let timeoutId = null;

        // 直接使用 GET 方法检测（更准确，因为很多网站不支持 HEAD）
        let fetchOptions = {
          method: 'GET',
          mode: 'cors',
          cache: 'no-cache'
        };

        if (typeof AbortController !== 'undefined') {
          controller = new AbortController();
          timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超时
          fetchOptions.signal = controller.signal;
        } else {
          timeoutId = setTimeout(() => {
            throw new Error('请求超时');
          }, 10000);
        }

        let response;
        try {
          response = await fetch(bookmark.url, fetchOptions);

          if (timeoutId) {
            clearTimeout(timeoutId);
          }

          // 成功获取响应，检查状态码
          const status = response.status;
          if ((status >= 200 && status < 400) || status == 403) {
            // 2xx 和 3xx 状态码视为有效
            return { bookmark, valid: true, statusCode: status };
          } else {
            // 4xx 和 5xx 视为失效
            return {
              bookmark,
              valid: false,
              statusCode: status,
              status: `HTTP ${status}`,
              error: `HTTP ${status} ${response.statusText || ''}`.trim()
            };
          }
        } catch (corsError) {
          // CORS 错误或其他网络错误，尝试使用 no-cors 模式
          if (timeoutId) {
            clearTimeout(timeoutId);
          }

          // 重新设置超时
          if (typeof AbortController !== 'undefined') {
            controller = new AbortController();
            timeoutId = setTimeout(() => controller.abort(), 10000);
            fetchOptions.signal = controller.signal;
          }

          fetchOptions.mode = 'no-cors';
          try {
            response = await fetch(bookmark.url, fetchOptions);
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
            // no-cors 模式下能发起请求说明 URL 基本有效
            // 注意：某些网站（如豆瓣）可能需要登录或反爬虫，但 URL 本身是有效的
            return { bookmark, valid: true, statusCode: null, status: 'CORS限制（无法获取状态码）' };
          } catch (noCorsError) {
            if (timeoutId) {
              clearTimeout(timeoutId);
            }

            // 检查错误类型：如果是网络错误（如 DNS 失败、连接拒绝），可能是真的失效
            // 如果是 CORS 相关错误，可能是网站有保护机制，但不一定失效
            const errorMsg = noCorsError.message || '';
            const isNetworkError = errorMsg.includes('Failed to fetch') ||
              errorMsg.includes('NetworkError') ||
              errorMsg.includes('ERR_') ||
              errorMsg.includes('aborted');

            if (isNetworkError) {
              // 真正的网络错误，可能是失效
              return {
                bookmark,
                valid: false,
                statusCode: null,
                status: '无法访问',
                error: '网络错误：' + (noCorsError.message || '无法连接到服务器')
              };
            } else {
              // 可能是 CORS 或其他限制，但不一定是失效，保守处理：标记为可能有效
              return { bookmark, valid: true, statusCode: null, status: '检测受限（可能有效）' };
            }
          }
        }
      } catch (error) {
        // 其他错误（如超时）
        return {
          bookmark,
          valid: false,
          statusCode: null,
          status: '检测失败',
          error: error.message || '无法访问'
        };
      }
    };

    // 分批检测
    for (let i = 0; i < bookmarks.length; i += concurrency) {
      const batch = bookmarks.slice(i, i + concurrency);
      const results = await Promise.all(batch.map(checkUrl));

      results.forEach(({ bookmark, valid, statusCode, status, error }) => {
        checkedCount++;
        if (!valid) {
          invalidBookmarks.push({
            bookmark,
            statusCode: statusCode,
            status: status || error || '无法访问',
            error: error || '无法访问',
            folder: bookmark.folder || '未分类'
          });
        }
      });

      // 更新进度
      checkInvalidUrlsBtn.textContent = `检测中... (${checkedCount}/${bookmarks.length})`;
    }

    checkInvalidUrlsBtn.disabled = false;
    checkInvalidUrlsBtn.textContent = originalText;

    if (invalidBookmarks.length === 0) {
      showMessage('所有网站检测通过，未发现失效网站', 'success');
      return;
    }

    // 显示失效网站确认弹窗
    showInvalidUrlsDialog(invalidBookmarks, currentSceneId);

  } catch (error) {
    checkInvalidUrlsBtn.disabled = false;
    checkInvalidUrlsBtn.textContent = originalText;
    showMessage('检测失败: ' + error.message, 'error');
  }
});

/**
 * 显示失效网站确认弹窗
 */
function showInvalidUrlsDialog(invalidBookmarks, sceneId) {
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
  const isMobile = window.innerWidth <= 768;
  dialog.style.cssText = `
    background: #ffffff;
    border-radius: 12px;
    padding: ${isMobile ? '20px' : '24px'};
    width: ${isMobile ? '90%' : '600px'};
    max-width: 90%;
    max-height: 85vh;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    font-size: ${isMobile ? '16px' : '14px'};
    display: flex;
    flex-direction: column;
    animation: slideUp 0.3s ease-out;
  `;

  const listHtml = invalidBookmarks.map((item, index) => {
    // 根据状态码确定样式（更明显的样式）
    let statusStyle = '';
    let statusText = '';
    const isMobile = window.innerWidth <= 768;
    const padding = isMobile ? '6px 10px' : '4px 8px';
    const fontSize = isMobile ? '13px' : '12px';

    if (item.statusCode !== null && item.statusCode !== undefined) {
      if (item.statusCode >= 400 && item.statusCode < 500) {
        // 4xx 客户端错误 - 黄色警告
        statusStyle = `background: #fff3cd; color: #856404; border: 2px solid #ffc107; padding: ${padding}; border-radius: 6px; font-weight: 700; display: inline-block; font-size: ${fontSize}; box-shadow: 0 2px 4px rgba(255, 193, 7, 0.3);`;
        statusText = `HTTP ${item.statusCode}`;
      } else if (item.statusCode >= 500) {
        // 5xx 服务器错误 - 红色错误
        statusStyle = `background: #f8d7da; color: #721c24; border: 2px solid #dc3545; padding: ${padding}; border-radius: 6px; font-weight: 700; display: inline-block; font-size: ${fontSize}; box-shadow: 0 2px 4px rgba(220, 53, 69, 0.3);`;
        statusText = `HTTP ${item.statusCode}`;
      } else {
        // 其他状态码 - 蓝色信息
        statusStyle = `background: #d1ecf1; color: #0c5460; border: 2px solid #bee5eb; padding: ${padding}; border-radius: 6px; font-weight: 700; display: inline-block; font-size: ${fontSize}; box-shadow: 0 2px 4px rgba(190, 229, 235, 0.3);`;
        statusText = item.status || '未知错误';
      }
    } else {
      // 无状态码（网络错误等）- 灰色
      statusStyle = `background: #e2e3e5; color: #383d41; border: 2px solid #d6d8db; padding: ${padding}; border-radius: 6px; font-weight: 700; display: inline-block; font-size: ${fontSize}; box-shadow: 0 2px 4px rgba(214, 216, 219, 0.3);`;
      statusText = item.status || '无法访问';
    }

    return `
    <div class="invalid-bookmark-item" data-index="${index}" data-url="${escapeHtml(item.bookmark.url)}" style="
      padding: 12px;
      border-bottom: 1px solid #e0e0e0;
      display: flex;
      flex-direction: column;
      gap: 8px;
      cursor: pointer;
      transition: background-color 0.2s;
      position: relative;
    ">
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
        <div style="font-weight: 600; color: #333; flex: 1; min-width: 0;">${escapeHtml(item.bookmark.title || '无标题')}</div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="status-badge" style="${statusStyle}">${escapeHtml(statusText)}</span>
          <button class="remove-invalid-item-btn" data-index="${index}" style="
            background: #f8f9fa;
            border: 1px solid #dee2e6;
            color: #6c757d;
            cursor: pointer;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            transition: all 0.2s;
            white-space: nowrap;
          " title="从列表中移除（不删除书签）">移除</button>
        </div>
      </div>
      <a href="${escapeHtml(item.bookmark.url)}" target="_blank" rel="noopener noreferrer" class="invalid-url-link" style="
        font-size: 12px;
        color: #0066cc;
        word-break: break-all;
        text-decoration: none;
      ">${escapeHtml(item.bookmark.url)}</a>
      <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
        <span style="font-size: 12px; color: #666;">📁 ${escapeHtml(item.folder)}</span>
        <span style="font-size: 12px; color: #dc3545; font-weight: 500;">${escapeHtml(item.error || item.status)}</span>
      </div>
    </div>
  `;
  }).join('');

  dialog.innerHTML = `
    <div style="margin-bottom: 20px;">
      <h3 style="margin: 0; font-size: ${isMobile ? '20px' : '18px'}; font-weight: 600; color: #1a1a1a;">
        发现 ${invalidBookmarks.length} 个失效网站
      </h3>
    </div>
    <div id="invalidBookmarksList" style="flex: 1; overflow-y: auto; margin-bottom: 20px; border: 1px solid #e0e0e0; border-radius: 8px; max-height: 400px;">
      ${listHtml}
    </div>
    <div style="display: flex; justify-content: flex-end; gap: 10px;">
      <button id="cancelDeleteBtn" class="btn btn-secondary" style="min-width: ${isMobile ? '90px' : '80px'}; min-height: ${isMobile ? '44px' : '38px'}; font-size: ${isMobile ? '16px' : '14px'}; border-radius: 8px; font-weight: 500;">取消</button>
      <button id="confirmDeleteBtn" class="btn btn-primary" style="min-width: ${isMobile ? '90px' : '80px'}; min-height: ${isMobile ? '44px' : '38px'}; font-size: ${isMobile ? '16px' : '14px'}; border-radius: 8px; font-weight: 500; background: #dc3545;">删除所有失效网站</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const cancelBtn = dialog.querySelector('#cancelDeleteBtn');
  const confirmBtn = dialog.querySelector('#confirmDeleteBtn');

  // 存储当前显示的失效网站列表（用于移除操作）
  let currentInvalidBookmarks = [...invalidBookmarks];
  let hasPendingSync = false; // 标记是否有待同步的更改

  // 同步到云端的函数（在提交或取消时调用）
  const syncToCloud = async () => {
    if (hasPendingSync) {
      console.log('[失效网站移除] 开始同步到云端');
      try {
        const response = await sendMessageCompat({
          action: 'syncSettings'
        });
        if (response && response.success) {
          console.log('[失效网站移除] 同步到云端成功');
          hasPendingSync = false;
        } else {
          console.warn('[失效网站移除] 同步到云端返回失败:', response);
        }
      } catch (error) {
        console.error('[失效网站移除] 同步到云端失败:', error);
        // 即使同步失败，本地已保存，下次同步时会自动同步
      }
    }
  };

  // 移除失效网站项的函数
  const removeInvalidItem = async (index) => {
    if (index >= 0 && index < currentInvalidBookmarks.length) {
      const removedItem = currentInvalidBookmarks[index];
      const removedUrl = removedItem.bookmark.url;

      // 从列表中移除
      currentInvalidBookmarks.splice(index, 1);

      // 保存到已移除列表（按场景存储）
      try {
        const settings = await storage.getSettings();
        const ignoredInvalidUrls = settings?.ignoredInvalidUrls || {};
        if (!ignoredInvalidUrls[sceneId]) {
          ignoredInvalidUrls[sceneId] = [];
        }
        // 如果URL不在列表中，添加它
        if (!ignoredInvalidUrls[sceneId].includes(removedUrl)) {
          ignoredInvalidUrls[sceneId].push(removedUrl);
          settings.ignoredInvalidUrls = ignoredInvalidUrls;

          // 只保存到本地，不立即同步（在提交或取消时统一同步）
          await storage.saveSettings(settings);
          hasPendingSync = true; // 标记有待同步的更改
          console.log('[失效网站移除] 已保存到本地，场景ID:', sceneId, 'URL:', removedUrl);

          // 显示提示信息
          showMessage('已保存，关闭弹窗时将同步到云端', 'success', 2000);
        }
      } catch (error) {
        console.error('保存已移除的失效网站失败:', error);
        // 显示错误提示
        showMessage('保存失败，请重试', 'error', 2000);
      }

      // 重新渲染列表
      updateInvalidBookmarksList();
    }
  };

  // 更新失效网站列表显示
  const updateInvalidBookmarksList = () => {
    const listContainer = dialog.querySelector('#invalidBookmarksList');
    if (!listContainer) return;

    // 重新生成列表 HTML
    const listHtml = currentInvalidBookmarks.map((item, index) => {
      // 根据状态码确定样式
      let statusStyle = '';
      let statusText = '';
      const isMobile = window.innerWidth <= 768;
      const padding = isMobile ? '6px 10px' : '4px 8px';
      const fontSize = isMobile ? '13px' : '12px';

      if (item.statusCode !== null && item.statusCode !== undefined) {
        if (item.statusCode >= 400 && item.statusCode < 500) {
          statusStyle = `background: #fff3cd; color: #856404; border: 2px solid #ffc107; padding: ${padding}; border-radius: 6px; font-weight: 700; display: inline-block; font-size: ${fontSize}; box-shadow: 0 2px 4px rgba(255, 193, 7, 0.3);`;
          statusText = `HTTP ${item.statusCode}`;
        } else if (item.statusCode >= 500) {
          statusStyle = `background: #f8d7da; color: #721c24; border: 2px solid #dc3545; padding: ${padding}; border-radius: 6px; font-weight: 700; display: inline-block; font-size: ${fontSize}; box-shadow: 0 2px 4px rgba(220, 53, 69, 0.3);`;
          statusText = `HTTP ${item.statusCode}`;
        } else {
          statusStyle = `background: #d1ecf1; color: #0c5460; border: 2px solid #bee5eb; padding: ${padding}; border-radius: 6px; font-weight: 700; display: inline-block; font-size: ${fontSize}; box-shadow: 0 2px 4px rgba(190, 229, 235, 0.3);`;
          statusText = item.status || '未知错误';
        }
      } else {
        statusStyle = `background: #e2e3e5; color: #383d41; border: 2px solid #d6d8db; padding: ${padding}; border-radius: 6px; font-weight: 700; display: inline-block; font-size: ${fontSize}; box-shadow: 0 2px 4px rgba(214, 216, 219, 0.3);`;
        statusText = item.status || '无法访问';
      }

      return `
      <div class="invalid-bookmark-item" data-index="${index}" data-url="${escapeHtml(item.bookmark.url)}" style="
        padding: 12px;
        border-bottom: 1px solid #e0e0e0;
        display: flex;
        flex-direction: column;
        gap: 8px;
        cursor: pointer;
        transition: background-color 0.2s;
        position: relative;
      ">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
          <div style="font-weight: 600; color: #333; flex: 1; min-width: 0;">${escapeHtml(item.bookmark.title || '无标题')}</div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="status-badge" style="${statusStyle}">${escapeHtml(statusText)}</span>
            <button class="remove-invalid-item-btn" data-index="${index}" style="
              background: #f8f9fa;
              border: 1px solid #dee2e6;
              color: #6c757d;
              cursor: pointer;
              padding: 4px 8px;
              border-radius: 4px;
              font-size: 12px;
              transition: all 0.2s;
              white-space: nowrap;
            " title="从列表中移除（不删除书签）">移除</button>
          </div>
        </div>
        <a href="${escapeHtml(item.bookmark.url)}" target="_blank" rel="noopener noreferrer" class="invalid-url-link" style="
          font-size: 12px;
          color: #0066cc;
          word-break: break-all;
          text-decoration: none;
        ">${escapeHtml(item.bookmark.url)}</a>
        <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
          <span style="font-size: 12px; color: #666;">📁 ${escapeHtml(item.folder)}</span>
          <span style="font-size: 12px; color: #dc3545; font-weight: 500;">${escapeHtml(item.error || item.status)}</span>
        </div>
      </div>
    `;
    }).join('');

    listContainer.innerHTML = listHtml;

    // 更新标题
    const title = dialog.querySelector('h3');
    if (title) {
      title.textContent = `发现 ${currentInvalidBookmarks.length} 个失效网站`;
    }

    // 更新删除按钮状态
    if (confirmBtn) {
      if (currentInvalidBookmarks.length === 0) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = '没有可删除的网站';
      } else {
        confirmBtn.disabled = false;
        confirmBtn.textContent = `删除 ${currentInvalidBookmarks.length} 个失效网站`;
      }
    }

    // 重新绑定事件
    bindInvalidBookmarkEvents();
  };

  // 绑定失效网站项的事件
  const bindInvalidBookmarkEvents = () => {
    dialog.querySelectorAll('.invalid-bookmark-item').forEach(item => {
      // 悬停效果
      item.addEventListener('mouseenter', () => {
        item.style.backgroundColor = '#f8f9fa';
      });
      item.addEventListener('mouseleave', () => {
        item.style.backgroundColor = 'transparent';
      });

      // 点击打开网站
      item.addEventListener('click', (e) => {
        // 如果点击的是链接或移除按钮，不处理
        if (e.target.tagName === 'A' || e.target.closest('a') ||
          e.target.classList.contains('remove-invalid-item-btn') ||
          e.target.closest('.remove-invalid-item-btn')) {
          return;
        }
        const url = item.dataset.url;
        if (url) {
          window.open(url, '_blank', 'noopener,noreferrer');
        }
      });

      // 链接点击时阻止事件冒泡
      const link = item.querySelector('.invalid-url-link');
      if (link) {
        link.addEventListener('click', (e) => {
          e.stopPropagation();
        });
      }
    });

    // 绑定移除按钮事件
    dialog.querySelectorAll('.remove-invalid-item-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const index = parseInt(btn.dataset.index);
        if (!isNaN(index)) {
          removeInvalidItem(index);
        }
      });

      // 悬停效果
      btn.addEventListener('mouseenter', () => {
        btn.style.background = '#e9ecef';
        btn.style.borderColor = '#adb5bd';
        btn.style.color = '#495057';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.background = '#f8f9fa';
        btn.style.borderColor = '#dee2e6';
        btn.style.color = '#6c757d';
      });
    });
  };

  // 初始绑定事件
  bindInvalidBookmarkEvents();

  const cleanup = async () => {
    // 弹窗关闭时，如果有待同步的更改，立即同步
    await syncToCloud();

    overlay.style.animation = 'fadeIn 0.2s ease-out reverse';
    setTimeout(() => overlay.remove(), 200);
  };

  cancelBtn.onclick = cleanup;

  confirmBtn.onclick = async () => {
    try {
      // 获取当前场景的所有书签
      const data = await storage.getBookmarks(sceneId);
      const allBookmarks = data.bookmarks || [];
      const allFolders = data.folders || [];

      // 获取要删除的书签ID（使用更新后的列表）
      const invalidIds = new Set(currentInvalidBookmarks.map(item => item.bookmark.id));

      // 删除失效的书签
      const remainingBookmarks = allBookmarks.filter(b => !invalidIds.has(b.id));

      // 更新文件夹列表（移除不再使用的文件夹）
      const bookmarkFolders = new Set(remainingBookmarks.map(b => b.folder).filter(Boolean));
      const remainingFolders = allFolders.filter(f => bookmarkFolders.has(f));

      // 保存到本地
      await storage.saveBookmarks(remainingBookmarks, remainingFolders, sceneId);

      // 先同步已移除列表到云端（如果有待同步的更改）
      await syncToCloud();

      // 同步书签到云端
      await sendMessageCompat({
        action: 'syncToCloud',
        bookmarks: remainingBookmarks,
        folders: remainingFolders,
        sceneId
      });

      cleanup();
      showMessage(`已删除 ${currentInvalidBookmarks.length} 个失效网站并同步到云端`, 'success');

      // 刷新页面（如果是在书签管理页面）
      if (window.location.pathname.includes('bookmarks.html')) {
        window.location.reload();
      }
    } catch (error) {
      showMessage('删除失败: ' + error.message, 'error');
    }
  };

  // ESC键关闭
  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      cleanup();
      document.removeEventListener('keydown', onKeyDown);
    }
  };
  document.addEventListener('keydown', onKeyDown);

  // 点击背景关闭
  overlay.onclick = (e) => {
    if (e.target === overlay) {
      cleanup();
      document.removeEventListener('keydown', onKeyDown);
    }
  };
}

// 工具函数：转义HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * 界面设置 - 弹窗默认展开第一层
 */
async function loadUiSettings() {
  const settings = await storage.getSettings();
  const popup = (settings && settings.popup) || {};
  expandFirstLevelCheckbox.checked = !!popup.expandFirstLevel;

  // 加载滚动条位置记忆设置（默认选中）
  if (rememberScrollPosition) {
    rememberScrollPosition.checked = popup.rememberScrollPosition !== false; // 默认true
  }

  // 加载显示更新按钮设置（默认不显示）
  if (showUpdateButtonCheckbox) {
    showUpdateButtonCheckbox.checked = !!popup.showUpdateButton; // 默认false
  }

  // 加载同步失败通知开关（默认开启）
  const syncErrorNotification = settings?.syncErrorNotification || {};
  enableSyncErrorNotification.checked = syncErrorNotification.enabled !== false;
  if (stickySyncErrorToast) {
    stickySyncErrorToast.checked = !!syncErrorNotification.sticky;
  }

  // 加载悬浮球弹窗高度设置
  const floatingBallPopup = settings?.floatingBallPopup || {};
  if (floatingBallPopupHeightPc) {
    // PC端高度（默认640px）
    floatingBallPopupHeightPc.value = floatingBallPopup.heightPc || 640;
  }
  if (floatingBallPopupHeightMobile) {
    // 移动端高度（默认85vh）
    floatingBallPopupHeightMobile.value = floatingBallPopup.heightMobile || 85;
  }

  // 加载插件图标弹窗高度设置
  const iconPopup = settings?.iconPopup || {};
  if (iconPopupHeightPc) {
    // PC端高度（默认600px）
    iconPopupHeightPc.value = iconPopup.heightPc || 600;
  }
  if (iconPopupHeightMobile) {
    // 移动端高度（默认90vh）
    iconPopupHeightMobile.value = iconPopup.heightMobile || 90;
  }

  // 更新同步按钮状态
  updateSyncButtonStates();
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
    showMessage('界面设置已保存（后台同步中）', 'success');
    sendMessageCompat({ action: 'syncSettings' }).catch(err => console.error('设置同步失败:', err));
    // 通知所有打开的弹窗更新设置（兼容manifest v2和v3）
    try {
      if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.sendMessage) {
        // Firefox: 使用 Promise
        browser.runtime.sendMessage({ action: 'settingsUpdated' }).catch(() => {
          // 忽略错误，可能没有打开的弹窗
        });
      } else if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        // Chrome/Edge: 使用回调包装成Promise
        chrome.runtime.sendMessage({ action: 'settingsUpdated' }, () => {
          // 忽略错误，可能没有打开的弹窗
          if (chrome.runtime.lastError) {
            // 静默处理错误
          }
        });
      }
    } catch (e) {
      // 忽略错误
    }
  } catch (e) {
    showMessage('保存失败: ' + e.message, 'error');
  }
});

// 显示更新按钮设置
if (showUpdateButtonCheckbox) {
  showUpdateButtonCheckbox.addEventListener('change', async () => {
    try {
      const settings = await storage.getSettings();
      const popup = (settings && settings.popup) || {};
      popup.showUpdateButton = showUpdateButtonCheckbox.checked;
      const newSettings = { ...(settings || {}), popup };
      await storage.saveSettings(newSettings);
      showMessage('弹窗画面更新按钮显示设置已保存（后台同步中）', 'success');
      sendMessageCompat({ action: 'syncSettings' }).catch(err => console.error('设置同步失败:', err));
      // 通知所有打开的弹窗更新设置（兼容manifest v2和v3）
      try {
        if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.sendMessage) {
          // Firefox: 使用 Promise
          browser.runtime.sendMessage({ action: 'settingsUpdated' }).catch(() => {
            // 忽略错误，可能没有打开的弹窗
          });
        } else if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          // Chrome/Edge: 使用回调包装成Promise
          chrome.runtime.sendMessage({ action: 'settingsUpdated' }, () => {
            // 忽略错误，可能没有打开的弹窗
            if (chrome.runtime.lastError) {
              // 静默处理错误
            }
          });
        }
      } catch (e) {
        // 忽略错误
      }
    } catch (e) {
      showMessage('保存失败: ' + e.message, 'error');
    }
  });
}

// 滚动条位置记忆设置
if (rememberScrollPosition) {
  rememberScrollPosition.addEventListener('change', async () => {
    try {
      const settings = await storage.getSettings();
      const popup = (settings && settings.popup) || {};
      popup.rememberScrollPosition = rememberScrollPosition.checked;
      const newSettings = { ...(settings || {}), popup };
      await storage.saveSettings(newSettings);
      showMessage('界面设置已保存（后台同步中）', 'success');
      sendMessageCompat({ action: 'syncSettings' }).catch(err => console.error('设置同步失败:', err));
      // 通知所有打开的弹窗更新设置（兼容manifest v2和v3）
      try {
        if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.sendMessage) {
          // Firefox: 使用 Promise
          browser.runtime.sendMessage({ action: 'settingsUpdated' }).catch(() => {
            // 忽略错误，可能没有打开的弹窗
          });
        } else if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          // Chrome/Edge: 使用回调包装成Promise
          chrome.runtime.sendMessage({ action: 'settingsUpdated' }, () => {
            // 忽略错误，可能没有打开的弹窗
            if (chrome.runtime.lastError) {
              // 静默处理错误
            }
          });
        }
      } catch (e) {
        // 忽略错误
      }
    } catch (e) {
      showMessage('保存失败: ' + e.message, 'error');
    }
  });
}

/**
 * 更新同步按钮状态
 */
function updateSyncButtonStates() {
  // 检查是否有未同步的本地更改
  // 这里可以根据需要添加逻辑来检测是否有未同步的更改
  // 暂时不实现，因为用户需要手动点击同步按钮
}

/**
 * 保存悬浮球弹窗高度设置（仅本地）
 */
async function saveFloatingBallPopupHeightLocal() {
  try {
    const settings = await storage.getSettings();
    const floatingBallPopup = {
      heightPc: floatingBallPopupHeightPc ? parseInt(floatingBallPopupHeightPc.value) || 640 : 640,
      heightMobile: floatingBallPopupHeightMobile ? parseInt(floatingBallPopupHeightMobile.value) || 85 : 85
    };
    const newSettings = { ...(settings || {}), floatingBallPopup };
    await storage.saveSettings(newSettings);
    showMessage('高度设置已保存（本地）', 'success');
    updateSyncButtonStates();
  } catch (e) {
    showMessage('保存失败: ' + e.message, 'error');
  }
}

/**
 * 同步悬浮球弹窗高度设置到云端
 */
async function syncFloatingBallPopupHeightToCloud() {
  try {
    const settings = await storage.getSettings();
    const floatingBallPopup = {
      heightPc: floatingBallPopupHeightPc ? parseInt(floatingBallPopupHeightPc.value) || 640 : 640,
      heightMobile: floatingBallPopupHeightMobile ? parseInt(floatingBallPopupHeightMobile.value) || 85 : 85
    };
    const newSettings = { ...(settings || {}), floatingBallPopup };
    await storage.saveSettings(newSettings);
    showMessage('高度设置已保存，正在后台同步到云端...', 'success');
    sendMessageCompat({ action: 'syncSettings' }).catch(err => console.error('高度设置同步失败:', err));
  } catch (e) {
    showMessage('同步失败: ' + e.message, 'error');
  }
}

/**
 * 保存插件图标弹窗高度设置（仅本地）
 */
async function saveIconPopupHeightLocal() {
  try {
    const settings = await storage.getSettings();
    const iconPopup = {
      heightPc: iconPopupHeightPc ? parseInt(iconPopupHeightPc.value) || 600 : 600,
      heightMobile: iconPopupHeightMobile ? parseInt(iconPopupHeightMobile.value) || 90 : 90
    };
    const newSettings = { ...(settings || {}), iconPopup };
    await storage.saveSettings(newSettings);
    showMessage('高度设置已保存（本地）', 'success');
    updateSyncButtonStates();
  } catch (e) {
    showMessage('保存失败: ' + e.message, 'error');
  }
}

/**
 * 同步插件图标弹窗高度设置到云端
 */
async function syncIconPopupHeightToCloud() {
  try {
    const settings = await storage.getSettings();
    const iconPopup = {
      heightPc: iconPopupHeightPc ? parseInt(iconPopupHeightPc.value) || 600 : 600,
      heightMobile: iconPopupHeightMobile ? parseInt(iconPopupHeightMobile.value) || 90 : 90
    };
    const newSettings = { ...(settings || {}), iconPopup };
    await storage.saveSettings(newSettings);
    showMessage('高度设置已保存，正在后台同步到云端...', 'success');
    sendMessageCompat({ action: 'syncSettings' }).catch(err => console.error('高度设置同步失败:', err));
  } catch (e) {
    showMessage('同步失败: ' + e.message, 'error');
  }
}

// 悬浮球弹窗高度设置 - PC端
if (floatingBallPopupHeightPc) {
  floatingBallPopupHeightPc.addEventListener('change', () => {
    saveFloatingBallPopupHeightLocal();
  });
}

if (syncFloatingBallHeightPc) {
  syncFloatingBallHeightPc.addEventListener('click', async () => {
    await syncFloatingBallPopupHeightToCloud();
  });
}

// 悬浮球弹窗高度设置 - 移动端
if (floatingBallPopupHeightMobile) {
  floatingBallPopupHeightMobile.addEventListener('change', () => {
    saveFloatingBallPopupHeightLocal();
  });
}

if (syncFloatingBallHeightMobile) {
  syncFloatingBallHeightMobile.addEventListener('click', async () => {
    await syncFloatingBallPopupHeightToCloud();
  });
}

// 插件图标弹窗高度设置 - PC端
if (iconPopupHeightPc) {
  iconPopupHeightPc.addEventListener('change', () => {
    saveIconPopupHeightLocal();
  });
}

if (syncIconHeightPc) {
  syncIconHeightPc.addEventListener('click', async () => {
    await syncIconPopupHeightToCloud();
  });
}

// 插件图标弹窗高度设置 - 移动端
if (iconPopupHeightMobile) {
  iconPopupHeightMobile.addEventListener('change', () => {
    saveIconPopupHeightLocal();
  });
}

if (syncIconHeightMobile) {
  syncIconHeightMobile.addEventListener('click', async () => {
    await syncIconPopupHeightToCloud();
  });
}

/**
 * 加载快捷键显示（动态读取 commands 配置）
 */
async function loadShortcutDisplay() {
  const setText = (el, text) => {
    if (!el) return;
    el.textContent = text;
  };

  // 默认值
  setText(shortcutDisplayWin, 'Windows / Linux：Ctrl + Shift + V');
  setText(shortcutDisplayMac, 'macOS：Command + Shift + V');

  try {
    const cmds = await getCommandsCompat();
    if (!cmds || !Array.isArray(cmds)) return;
    const addCmd = cmds.find(c => c.name === 'add-bookmark');
    if (addCmd && addCmd.shortcut) {
      // Firefox 返回如 "Ctrl+Shift+V"
      const shortcut = addCmd.shortcut.replace(/\+/g, ' + ');
      setText(shortcutDisplayWin, `Windows / Linux：${shortcut}`);
      setText(shortcutDisplayMac, `macOS：${shortcut.replace(/^Ctrl/, 'Command')}`);
    } else {
      setText(shortcutDisplayWin, '未设置（请在 about:addons 设置）');
      setText(shortcutDisplayMac, '未设置（请在 about:addons 设置）');
    }
  } catch (e) {
    console.warn('加载快捷键配置失败', e);
  }
}

/**
 * 兼容获取 commands 列表（Firefox/Chrome, MV2/MV3）
 */
function getCommandsCompat() {
  return new Promise((resolve) => {
    try {
      if (typeof browser !== 'undefined' && browser.commands && browser.commands.getAll) {
        browser.commands.getAll().then(resolve).catch(() => resolve(null));
        return;
      }
      if (typeof chrome !== 'undefined' && chrome.commands && chrome.commands.getAll) {
        chrome.commands.getAll((cmds) => {
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve(null);
          } else {
            resolve(cmds);
          }
        });
        return;
      }
    } catch (_) { }
    resolve(null);
  });
}

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

      // 规范化路径 + 补齐父级路径（保证 folders 与画面树一致）
      const normalizeFolder = (p) => (p || '').trim().replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
      const expandFolderPathsPreserveOrder = (paths) => {
        const out = [];
        const seen = new Set();
        (paths || []).forEach((p) => {
          const n = normalizeFolder(p || '');
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
      };
      const importedBookmarks = data.bookmarks.map(b => ({
        ...b,
        folder: b.folder ? normalizeFolder(b.folder) : undefined,
        scene: targetSceneId // 设置场景
      }));

      // 获取当前场景书签
      const sceneData = await storage.getBookmarks(targetSceneId);
      const sceneBookmarks = sceneData.bookmarks || [];
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

      // folders：优先使用导入数据携带的 folders（若有），并补齐父级；再补上书签引用的 folder
      const importedFoldersRaw = (data.folders || []).map(normalizeFolder).filter(Boolean);
      const bookmarkFoldersRaw = sceneBookmarks.map(b => normalizeFolder(b.folder)).filter(Boolean);
      const foldersForScene = expandFolderPathsPreserveOrder([...importedFoldersRaw, ...bookmarkFoldersRaw]);

      // 仅更新目标场景（保留其他场景不变），并保存该场景的 folders（包含父级层级）
      await storage.saveBookmarks(sceneBookmarks, foldersForScene, targetSceneId);

      // 1. 同步到云端（异步执行，不阻塞 UI 反馈）
      sendMessageCompat({
        action: 'syncToCloud',
        bookmarks: sceneBookmarks,
        folders: foldersForScene,
        sceneId: targetSceneId
      }).catch(err => console.error('导入后后台同步失败:', err));

      const scenes = await storage.getScenes();
      const sceneName = scenes.find(s => s.id === targetSceneId)?.name || targetSceneId;
      showMessage(`导入完成，正在后台同步 ${added} 个书签到"${sceneName}"场景`, 'success');
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
    const res = await sendWithRetry({ action: 'getDevices' }, { retries: 2, delay: 300 });
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
        const saveRes = await sendWithRetry({ action: 'saveDevices', devices: newDevices }, { retries: 2, delay: 300 });
        if (saveRes?.success) {
          showMessage('已移除设备', 'success');
          await sendWithRetry({ action: 'syncSettings' }, { retries: 2, delay: 300 });
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
    // 立即同步到云端（不阻塞）
    sendWithRetry({ action: 'syncSettings' }, { retries: 2, delay: 300 }).catch(e => console.error('设备检测设置同步失败:', e));
    showMessage('设备检测设置已保存（后台同步中）', 'success');
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

    // 加载默认位置设置（默认值为 'auto'）
    floatingBallDefaultPosition.value = floatingBall.defaultPosition || 'auto';
    // 加载点击行为设置（默认值为 popup）
    floatingBallClickAction.value = floatingBall.clickAction || 'popup';

    // 根据是否启用悬浮球显示/隐藏默认位置选择器
    const visible = enableFloatingBall.checked;
    floatingBallPositionGroup.style.display = visible ? 'block' : 'none';
    floatingBallActionGroup.style.display = visible ? 'block' : 'none';
  } catch (e) {
    console.warn('加载悬浮球设置失败', e);
    enableFloatingBall.checked = false;
    floatingBallDefaultPosition.value = 'auto';
    floatingBallClickAction.value = 'popup';
    floatingBallPositionGroup.style.display = 'none';
    floatingBallActionGroup.style.display = 'none';
  }
}

/**
 * 悬浮球开关变更
 */
enableFloatingBall.addEventListener('change', async () => {
  try {
    const settings = await storage.getSettings();
    const floatingBall = (settings && settings.floatingBall) || {};
    floatingBall.enabled = enableFloatingBall.checked;
    // 保留默认位置设置（如果存在）
    if (!floatingBall.defaultPosition) {
      floatingBall.defaultPosition = 'auto';
    }
    if (!floatingBall.clickAction) {
      floatingBall.clickAction = 'popup';
    }
    const newSettings = { ...(settings || {}), floatingBall };
    await storage.saveSettings(newSettings);

    // 显示/隐藏默认位置选择器
    const visible = enableFloatingBall.checked;
    floatingBallPositionGroup.style.display = visible ? 'block' : 'none';
    floatingBallActionGroup.style.display = visible ? 'block' : 'none';

    // 立即同步到云端（不阻塞）
    sendWithRetry({ action: 'syncSettings' }, { retries: 2, delay: 300 }).catch(e => console.error('悬浮球启用同步失败:', e));
    // 通知所有标签页更新悬浮球状态
    const tabsAPI = typeof browser !== 'undefined' ? browser.tabs : chrome.tabs;
    try {
      const tabs = await tabsAPI.query({});
      tabs.forEach(tab => {
        tabsAPI.sendMessage(tab.id, { action: 'updateFloatingBall' }).catch(() => { });
      });
    } catch (e) {
      // 忽略错误
    }
    showMessage('悬浮球设置已保存（已同步至云端）', 'success');
  } catch (e) {
    showMessage('保存失败: ' + e.message, 'error');
  }
});

/**
 * 悬浮球默认位置变更
 */
floatingBallDefaultPosition.addEventListener('change', async () => {
  try {
    const settings = await storage.getSettings();
    const floatingBall = (settings && settings.floatingBall) || {};
    floatingBall.defaultPosition = floatingBallDefaultPosition.value;
    const newSettings = { ...(settings || {}), floatingBall };
    await storage.saveSettings(newSettings);

    // 立即同步到云端（不阻塞）
    sendWithRetry({ action: 'syncSettings' }, { retries: 2, delay: 300 }).catch(e => console.error('悬浮球位置同步失败:', e));

    // 通知所有标签页更新悬浮球状态
    const tabsAPI = typeof browser !== 'undefined' ? browser.tabs : chrome.tabs;
    try {
      const tabs = await tabsAPI.query({});
      tabs.forEach(tab => {
        tabsAPI.sendMessage(tab.id, { action: 'updateFloatingBall' }).catch(() => { });
      });
    } catch (e) {
      // 忽略错误
    }
    showMessage('悬浮球默认位置已保存（已同步至云端）', 'success');
  } catch (e) {
    showMessage('保存失败: ' + e.message, 'error');
  }
});

/**
 * 悬浮球点击行为变更
 */
floatingBallClickAction.addEventListener('change', async () => {
  try {
    const settings = await storage.getSettings();
    const floatingBall = (settings && settings.floatingBall) || {};
    floatingBall.clickAction = floatingBallClickAction.value || 'popup';
    const newSettings = { ...(settings || {}), floatingBall };
    await storage.saveSettings(newSettings);

    // 立即同步到云端（不阻塞）
    sendWithRetry({ action: 'syncSettings' }, { retries: 2, delay: 300 }).catch(e => console.error('悬浮球点击行为同步失败:', e));

    // 通知所有标签页更新悬浮球状态
    const tabsAPI = typeof browser !== 'undefined' ? browser.tabs : chrome.tabs;
    try {
      const tabs = await tabsAPI.query({});
      tabs.forEach(tab => {
        tabsAPI.sendMessage(tab.id, { action: 'updateFloatingBall' }).catch(() => { });
      });
    } catch (e) {
      // 忽略错误
    }
    showMessage('悬浮球点击行为已保存（已同步至云端）', 'success');
  } catch (e) {
    showMessage('保存失败: ' + e.message, 'error');
  }
});

/**
 * 同步失败通知开关变更
 */
enableSyncErrorNotification.addEventListener('change', async () => {
  try {
    const settings = await storage.getSettings();
    const syncErrorNotification = { ...(settings?.syncErrorNotification || {}), enabled: enableSyncErrorNotification.checked };
    const newSettings = { ...(settings || {}), syncErrorNotification };
    await storage.saveSettings(newSettings);
    // 立即同步到云端（不阻塞）
    sendWithRetry({ action: 'syncSettings' }, { retries: 2, delay: 300 }).catch(e => console.error('同步失败通知同步失败:', e));
    showMessage('同步失败通知设置已保存（后台同步中）', 'success');
  } catch (e) {
    showMessage('保存失败: ' + e.message, 'error');
  }
});

// 调试：Toast 不自动消失
if (stickySyncErrorToast) {
  stickySyncErrorToast.addEventListener('change', async () => {
    try {
      const settings = await storage.getSettings();
      const syncErrorNotification = { ...(settings?.syncErrorNotification || {}), sticky: !!stickySyncErrorToast.checked };
      const newSettings = { ...(settings || {}), syncErrorNotification };
      await storage.saveSettings(newSettings);
      sendWithRetry({ action: 'syncSettings' }, { retries: 2, delay: 300 }).catch(e => console.error('调试设置同步失败:', e));
      showMessage('调试设置已保存（后台同步中）', 'success');
    } catch (e) {
      showMessage('保存失败: ' + (e?.message || e), 'error');
    }
  });
}

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
              await sendMessageCompat({ action: 'sync', sceneId });
            } catch (e) {
              // 忽略单次同步失败，继续后续逻辑
            }
          }
          await loadScenes();
        } else if (action === 'rename') {
          const newName = prompt(`重命名场景"${scene.name}"：`, scene.name);
          if (newName && newName.trim() && newName !== scene.name) {
            try {
              // 1. 立即更新本地并加载
              await storage.updateScene(sceneId, { name: newName.trim() });
              await loadScenes();
              showMessage('场景已重命名', 'success');

              // 2. 背景同步设置
              sendMessageCompat({ action: 'syncSettings' }).catch(err => console.error('重命名场景同步失败:', err));
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
            const normalizeFolder = (p) => (p || '').trim().replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
            const expandFolderPathsPreserveOrder = (paths) => {
              const out = [];
              const seen = new Set();
              (paths || []).forEach((p) => {
                const n = normalizeFolder(p || '');
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
            };

            const filteredBookmarks = (allBookmarks.bookmarks || []).filter(b => b.scene !== sceneId);
            // 保留父级层级，避免云端 folders 缺层（跨场景全量保存时同样适用）
            const filteredFolders = expandFolderPathsPreserveOrder(filteredBookmarks.map(b => normalizeFolder(b.folder)).filter(Boolean));
            // 1. 立即执行本地删除并反馈 UI
            await storage.saveBookmarks(filteredBookmarks, filteredFolders);
            await loadScenes();
            showMessage('场景已删除', 'success');

            // 2. 后台通知删除云端文件和同步设置
            sendMessageCompat({ action: 'deleteSceneBookmarks', sceneId }).catch(err => console.error('后台删除场景书签失败:', err));
            sendMessageCompat({ action: 'syncSettings' }).catch(err => console.error('删除场景后同步设置失败:', err));
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
    // 1. 本地增加并立即显示
    await storage.addScene({
      id: sceneId,
      name: name.trim(),
      isDefault: false
    });
    await loadScenes();
    showMessage('场景已添加', 'success');

    // 2. 后台触发设置同步
    sendMessageCompat({ action: 'syncSettings' }).catch(err => console.error('添加场景后台同步失败:', err));
  } catch (e) {
    showMessage('添加失败: ' + e.message, 'error');
  }
});

/**
 * 显示冒泡提示（统一使用 toast 样式）
 * @param {string} message - 提示消息
 * @param {string} type - 类型：'success', 'error', 'info'（默认）
 * @param {number} duration - 显示时长（毫秒），默认 3000
 */
function showMessage(message, type = 'info', duration = 3000) {
  // 确保 DOM 已加载
  if (!document || !document.body) {
    // 如果 DOM 未加载，等待加载完成
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        showMessage(message, type, duration);
      });
      return;
    }
    // 如果 document 不存在，延迟执行
    setTimeout(() => {
      if (document && document.body) {
        showMessage(message, type, duration);
      }
    }, 100);
    return;
  }

  // 根据类型设置颜色
  let backgroundColor, textColor;
  switch (type) {
    case 'success':
      backgroundColor = '#28a745';
      textColor = 'white';
      break;
    case 'error':
      backgroundColor = '#dc3545';
      textColor = 'white';
      break;
    case 'info':
    default:
      backgroundColor = '#17a2b8';
      textColor = 'white';
      break;
  }

  // 检测是否为移动设备
  const isMobile = window.innerWidth <= 768 || /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

  const toast = document.createElement('div');
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    top: ${isMobile ? '10px' : '20px'};
    left: 50%;
    transform: translateX(-50%);
    background: ${backgroundColor};
    color: ${textColor};
    padding: ${isMobile ? '10px 16px' : '12px 24px'};
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 10000;
    font-size: ${isMobile ? '14px' : '14px'};
    font-weight: 500;
    animation: fadeInOut ${duration}ms ease-in-out;
    pointer-events: none;
    max-width: ${isMobile ? 'calc(100% - 20px)' : '90%'};
    word-wrap: break-word;
    text-align: center;
    line-height: 1.5;
  `;

  try {
    document.body.appendChild(toast);

    setTimeout(() => {
      if (toast && toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, duration);
  } catch (error) {
    console.error('显示提示失败:', error);
  }
}

// 接收后台同步失败 toast（扩展页面不是 content script，收不到 tabs.sendMessage）
try {
  runtimeAPI.onMessage.addListener((request, sender, sendResponse) => {
    if (request && request.action === 'showSyncErrorToast') {
      // 设置页用顶部 message 条提示（不阻断操作）
      showMessage(request.message || '同步失败', 'error');
      // 同时刷新同步状态栏里的错误信息
      updateSyncStatus();
      sendResponse({ success: true });
      return true;
    }
  });
} catch (e) {
  // 忽略：部分环境可能不允许在此处注册
}

