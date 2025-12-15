/**
 * 后台服务脚本
 * 处理同步、定时任务等后台逻辑
 */

importScripts('../utils/storage.js', '../utils/webdav.js');

const storage = new StorageManager();
let syncInterval = 5 * 60 * 1000; // 默认5分钟
let syncAlarmName = 'syncBookmarks';

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
  
  if (request.action === 'configUpdated') {
    setupSyncAlarm().then(() => {
      sendResponse({ success: true });
    });
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

    await storage.saveSyncStatus({
      status: 'syncing',
      lastSync: Date.now(),
      error: null
    });

    const webdav = new WebDAVClient(config);
    const cloudData = await webdav.readBookmarks();
    
    // 合并数据（简单的以云端为准的策略，后续可以优化冲突处理）
    await storage.saveBookmarks(cloudData.bookmarks || [], cloudData.folders || []);
    
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

    await storage.saveSyncStatus({
      status: 'syncing',
      lastSync: Date.now(),
      error: null
    });

    const webdav = new WebDAVClient(config);
    await webdav.writeBookmarks({ bookmarks, folders });
    
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

// 导出函数供其他脚本调用
self.syncToCloud = syncToCloud;
self.syncFromCloud = syncFromCloud;

