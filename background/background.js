/**
 * 后台服务脚本
 * 处理同步、定时任务等后台逻辑
 */

importScripts('../utils/storage.js', '../utils/webdav.js');

const storage = new StorageManager();
let syncInterval = 5 * 60 * 1000; // 默认5分钟
let syncAlarmName = 'syncBookmarks';
let currentDevice = null;

function normalizeFolderPath(path) {
  if (!path) return '';
  return path.trim().replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}

function normalizeData(bookmarks = [], folders = []) {
  const normalizedBookmarks = (bookmarks || []).map(b => {
    if (!b.folder) return b;
    return { ...b, folder: normalizeFolderPath(b.folder) };
  });
  // 同步时不过度清理空文件夹，保留传入的非空文件夹
  const normalizedFolders = [...new Set(folders.map(normalizeFolderPath).filter(Boolean))];
  return { bookmarks: normalizedBookmarks, folders: normalizedFolders };
}

/**
 * 同步设置到云端（非敏感）
 */
async function syncSettingsToCloud() {
  const config = await storage.getConfig();
  if (!config || !config.serverUrl) return;
  const webdav = new WebDAVClient(config);
  const settings = await storage.getSettings();
  const devices = await storage.getDevices();
  const deviceInfo = await storage.getDeviceInfo();
  await webdav.writeSettings({
    settings: settings || {},
    devices: devices || [],
    deviceInfo: deviceInfo || null
  });
}

/**
 * 从云端同步设置到本地（非敏感）
 */
async function syncSettingsFromCloud() {
  const config = await storage.getConfig();
  if (!config || !config.serverUrl) return;
  const webdav = new WebDAVClient(config);
  try {
    const cloud = await webdav.readSettings();
    if (cloud) {
      if (cloud.settings) {
        await storage.saveSettings(cloud.settings);
      }
      if (cloud.devices) {
        await storage.saveDevices(cloud.devices);
      }
      if (cloud.deviceInfo) {
        await storage.saveDeviceInfo(cloud.deviceInfo);
      }
    }
  } catch (e) {
    // 忽略设置读取失败，不影响书签同步
    console.warn('同步设置失败（忽略）：', e.message);
  }
}

// 监听插件安装
chrome.runtime.onInstalled.addListener(async () => {
  console.log('云端书签插件已安装');
  
  // 创建右键菜单
  chrome.contextMenus.create({
    id: 'addBookmark',
    title: '添加到云端书签',
    contexts: ['page', 'link']
  });
  
  // 设置初始同步任务
  await setupSyncAlarm();
  await ensureDeviceRegistered();
});

// 监听右键菜单点击
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'addBookmark') {
    // 打开添加书签页面
    chrome.tabs.create({
      url: chrome.runtime.getURL('pages/bookmarks.html?action=add&url=' + encodeURIComponent(info.linkUrl || tab.url))
    });
  }
});

// 监听快捷键命令
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'add-bookmark') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      chrome.tabs.create({
        url: chrome.runtime.getURL(`pages/bookmarks.html?action=add&url=${encodeURIComponent(tab.url)}`)
      });
    }
  }
});

// 监听定时任务
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === syncAlarmName) {
    await syncFromCloud();
  }
});

// 监听来自popup或pages的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'sync') {
    syncFromCloud().then(() => {
      sendResponse({ success: true });
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true; // 异步响应
  }
  
  if (request.action === 'syncToCloud') {
    syncToCloud(request.bookmarks, request.folders).then(() => {
      sendResponse({ success: true });
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }
  
  if (request.action === 'getSyncStatus') {
    storage.getSyncStatus().then(status => {
      sendResponse({ status });
    });
    return true;
  }
  
  if (request.action === 'getConfig') {
    storage.getConfig().then(config => {
      sendResponse({ config });
    });
    return true;
  }
  
  if (request.action === 'syncSettings') {
    syncSettingsToCloud().then(() => {
      sendResponse({ success: true });
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }
  
  if (request.action === 'syncSettingsFromCloud') {
    syncSettingsFromCloud().then(() => {
      sendResponse({ success: true });
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (request.action === 'syncUpload') {
    syncUpload().then(() => {
      sendResponse({ success: true });
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }
  
  if (request.action === 'configUpdated') {
    setupSyncAlarm().then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.action === 'getDevices') {
    Promise.all([storage.getDevices(), storage.getDeviceInfo()]).then(([devices, info]) => {
      sendResponse({ devices, deviceInfo: info });
    }).catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (request.action === 'saveDevices') {
    storage.saveDevices(request.devices || []).then(() => {
      sendResponse({ success: true });
    }).catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'getActiveTab') {
    try {
      const handleTabs = (tabs) => {
        const tab = Array.isArray(tabs) ? tabs[0] : null;
        if (tab) {
          sendResponse({ tab: { id: tab.id, url: tab.url, title: tab.title } });
        } else {
          sendResponse({ tab: null, error: 'no-active-tab' });
        }
      };

      if (typeof browser !== 'undefined' && browser.tabs && browser.tabs.query) {
        browser.tabs.query({ active: true, currentWindow: true })
          .then(tabs => {
            if (tabs && tabs.length) {
              handleTabs(tabs);
            } else {
              return browser.tabs.query({ active: true, lastFocusedWindow: true }).then(handleTabs);
            }
          })
          .catch(err => {
            sendResponse({ tab: null, error: err.message || 'query-failed' });
          });
        return true;
      }

      // chrome 回退：callback 形式
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs.length) {
          handleTabs(tabs);
        } else {
          chrome.tabs.query({ active: true, lastFocusedWindow: true }, handleTabs);
        }
      });
      return true;
    } catch (error) {
      sendResponse({ tab: null, error: error.message || 'query-failed' });
    }
    return true;
  }
});

/**
 * 设置同步定时任务
 */
async function setupSyncAlarm() {
  const config = await storage.getConfig();
  if (config && config.syncInterval) {
    syncInterval = config.syncInterval * 60 * 1000;
  }
  
  chrome.alarms.create(syncAlarmName, {
    periodInMinutes: syncInterval / (60 * 1000)
  });
}

/**
 * 从云端同步到本地
 */
async function syncFromCloud() {
  try {
    const config = await storage.getConfig();
    if (!config || !config.serverUrl) {
      console.log('WebDAV配置未设置');
      return;
    }

    await ensureDeviceRegistered();

    // 设备校验：如果当前设备不在设备列表，清除本地数据并停止同步
    const devices = await storage.getDevices();
    if (!devices.find(d => d.id === currentDevice.id)) {
      await storage.clearLocalData();
      await storage.saveSyncStatus({
        status: 'error',
        lastSync: Date.now(),
        error: '当前设备未被授权，已清理本地数据'
      });
      return;
    }

    await storage.saveSyncStatus({
      status: 'syncing',
      lastSync: Date.now(),
      error: null
    });

    const webdav = new WebDAVClient(config);
    const cloudData = await webdav.readBookmarks();
    const cleaned = normalizeData(cloudData.bookmarks || [], cloudData.folders || []);
    
    // 合并数据（简单的以云端为准的策略，后续可以优化冲突处理）
    await storage.saveBookmarks(cleaned.bookmarks, cleaned.folders);

    // 同步设置（非敏感）
    await syncSettingsFromCloud();

    // 更新设备上次同步时间
    await touchCurrentDevice();
    
    await storage.saveSyncStatus({
      status: 'success',
      lastSync: Date.now(),
      error: null
    });

    // 通知所有打开的页面更新
    chrome.runtime.sendMessage({ action: 'bookmarksUpdated' }).catch(() => {
      // 忽略错误，可能没有打开的页面
    });
    
  } catch (error) {
    console.error('同步失败:', error);
    await storage.saveSyncStatus({
      status: 'error',
      lastSync: Date.now(),
      error: error.message
    });
  }
}

/**
 * 同步本地变更到云端
 */
async function syncToCloud(bookmarks, folders) {
  try {
    const config = await storage.getConfig();
    if (!config || !config.serverUrl) {
      throw new Error('WebDAV配置未设置');
    }

    await ensureDeviceRegistered();
    // 设备校验
    const devices = await storage.getDevices();
    if (!devices.find(d => d.id === currentDevice.id)) {
      await storage.clearLocalData();
      await storage.saveSyncStatus({
        status: 'error',
        lastSync: Date.now(),
        error: '当前设备未被授权，已清理本地数据'
      });
      return;
    }

    await storage.saveSyncStatus({
      status: 'syncing',
      lastSync: Date.now(),
      error: null
    });

    const webdav = new WebDAVClient(config);
    const cleaned = normalizeData(bookmarks, folders);
    await webdav.writeBookmarks({ bookmarks: cleaned.bookmarks, folders: cleaned.folders });

    // 写入设置（非敏感）
    const settings = await storage.getSettings();
    await webdav.writeSettings(settings || {});
    
    await touchCurrentDevice();

    await storage.saveSyncStatus({
      status: 'success',
      lastSync: Date.now(),
      error: null
    });

    // 清空待同步队列
    await storage.clearPendingChanges();
    
  } catch (error) {
    console.error('同步到云端失败:', error);
    await storage.saveSyncStatus({
      status: 'error',
      lastSync: Date.now(),
      error: error.message
    });
    
    // 保存到待同步队列
    await storage.addPendingChange({
      type: 'sync',
      bookmarks,
      folders
    });
    
    throw error;
  }
}

/**
 * 主动上传：读取本地书签与设置，上行到云端
 */
async function syncUpload() {
  const data = await storage.getBookmarks();
  const bookmarks = data.bookmarks || [];
  const folders = data.folders || [];
  await syncToCloud(bookmarks, folders);
}

// 导出函数供其他脚本调用
self.syncToCloud = syncToCloud;
self.syncFromCloud = syncFromCloud;

/**
 * 确保当前设备注册
 */
async function ensureDeviceRegistered() {
  if (currentDevice) return;
  let info = await storage.getDeviceInfo();
  if (!info) {
    info = {
      id: storage.generateId(),
      name: await getDeviceName(),
      createdAt: Date.now(),
      lastSeen: Date.now()
    };
    await storage.saveDeviceInfo(info);
  }
  currentDevice = info;

  let devices = await storage.getDevices();
  if (!devices.find(d => d.id === info.id)) {
    devices.push({
      id: info.id,
      name: info.name,
      createdAt: info.createdAt,
      lastSeen: info.lastSeen
    });
    await storage.saveDevices(devices);
    // 设备列表变动，立即同步设置到云端
    await syncSettingsToCloud();
  }
}

/**
 * 更新当前设备lastSeen
 */
async function touchCurrentDevice() {
  if (!currentDevice) return;
  currentDevice.lastSeen = Date.now();
  await storage.saveDeviceInfo(currentDevice);
  const devices = await storage.getDevices();
  const idx = devices.findIndex(d => d.id === currentDevice.id);
  if (idx !== -1) {
    devices[idx] = { ...devices[idx], lastSeen: currentDevice.lastSeen, name: currentDevice.name };
    await storage.saveDevices(devices);
  }
  // 设备信息更新后也同步设置到云端
  await syncSettingsToCloud();
}

/**
 * 获取设备名称
 */
async function getDeviceName() {
  try {
    if (typeof navigator !== 'undefined' && navigator.userAgent) {
      return navigator.userAgent.split(')')[0] || '未知设备';
    }
  } catch (e) {
    // ignore
  }
  return '未知设备';
}

