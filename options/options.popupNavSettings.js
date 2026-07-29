(function () {
  const storage = new StorageManager();
  const runtimeAPI = typeof browser !== 'undefined' ? browser.runtime : chrome.runtime;

  function showMessage(message, type = 'info', duration = 3000) {
    // 复用 options.js 中的样式约定，做一个精简版 toast，避免强依赖原函数
    if (!document || !document.body) return;

    let backgroundColor = '#17a2b8';
    if (type === 'success') backgroundColor = '#28a745';
    if (type === 'error') backgroundColor = '#dc3545';

    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: ${backgroundColor};
      color: #fff;
      padding: 10px 18px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      z-index: 9999;
      font-size: 14px;
      max-width: 90%;
      text-align: center;
    `;
    document.body.appendChild(toast);
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, duration);
  }

  async function loadPopupFolderNavMode() {
    const select = document.getElementById('popupFolderNavMode');
    if (!select) return;
    try {
      const settings = await storage.getSettings();
      const popup = (settings && settings.popup) || {};
      const mode = popup.folderNavMode === 'tabs' ? 'tabs' : 'tree';
      select.value = mode;
    } catch (e) {
      select.value = 'tree';
    }
  }

  async function savePopupFolderNavMode(mode) {
    try {
      const settings = await storage.getSettings();
      const popup = (settings && settings.popup) || {};
      popup.folderNavMode = mode === 'tabs' ? 'tabs' : 'tree';
      const newSettings = { ...(settings || {}), popup };
      await storage.saveSettings(newSettings);

      // 弹窗目录设置会同步到云端，必须遮罩等待上传完成后再提示成功。
      try {
        if (typeof syncSettingsToCloudWithLoading === 'function') {
          await syncSettingsToCloudWithLoading('正在同步弹窗目录设置到云端...');
        } else if (typeof sendMessageCompat === 'function') {
          if (typeof showGlobalLoading === 'function') showGlobalLoading('正在同步弹窗目录设置到云端...');
          const response = await sendMessageCompat({ action: 'syncSettings' });
          if (!response || response.success === false) {
            throw new Error(response?.error || '同步弹窗目录设置到云端失败');
          }
        } else if (runtimeAPI && runtimeAPI.sendMessage) {
          if (typeof showGlobalLoading === 'function') showGlobalLoading('正在同步弹窗目录设置到云端...');
          await new Promise((resolve, reject) => {
            runtimeAPI.sendMessage({ action: 'syncSettings' }, (response) => {
              const lastError = runtimeAPI.lastError;
              if (lastError) {
                reject(new Error(lastError.message));
                return;
              }
              if (!response || response.success === false) {
                reject(new Error(response?.error || '同步弹窗目录设置到云端失败'));
                return;
              }
              resolve(response);
            });
          });
        }
        showMessage('弹窗目录展示方式已保存（已同步至云端）', 'success');
      } catch (e) {
        showMessage('同步失败: ' + (e.message || e), 'error');
      } finally {
        if (typeof hideGlobalLoading === 'function') hideGlobalLoading();
      }

      // 通知弹窗更新设置
      try {
        if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.sendMessage) {
          browser.runtime.sendMessage({ action: 'settingsUpdated' }).catch(() => {});
        } else if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ action: 'settingsUpdated' }, () => {});
        }
      } catch (e) {
        // 忽略错误
      }
    } catch (e) {
      showMessage('保存失败: ' + (e.message || e), 'error');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    loadPopupFolderNavMode();

    const select = document.getElementById('popupFolderNavMode');
    if (!select) return;

    select.addEventListener('change', (e) => {
      const value = e.target.value === 'tabs' ? 'tabs' : 'tree';
      savePopupFolderNavMode(value);
    });
  });
})();

