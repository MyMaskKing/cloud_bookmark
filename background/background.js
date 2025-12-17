/**
 * 确保当前设备已在云端设备列表（先拉取，再判定）
 * 若缺失则添加并写回云端；若已存在则仅刷新 lastSeen
 */
async function ensureDeviceInCloud() {
  await ensureDeviceRegistered();
  await syncSettingsFromCloud(); // 拉最新设备列表
  let devices = await storage.getDevices();
  const now = Date.now();

  if (!devices || devices.length === 0) {
    devices = [{
      id: currentDevice.id,
      name: currentDevice.name,
      createdAt: currentDevice.createdAt || now,
      lastSeen: now
    }];
    await storage.saveDevices(devices);
    await storage.saveDeviceInfo({ ...currentDevice, lastSeen: now });
    await syncSettingsToCloud();
    return;
  }

  const idx = devices.findIndex(d => d.id === currentDevice.id);
  if (idx === -1) {
    // 不存在则注册
    devices.push({
      id: currentDevice.id,
      name: currentDevice.name,
      createdAt: currentDevice.createdAt || now,
      lastSeen: now
    });
    await storage.saveDevices(devices);
    await storage.saveDeviceInfo({ ...currentDevice, lastSeen: now });
    await syncSettingsToCloud();
  } else {
    // 存在则刷新 lastSeen
    devices[idx] = { ...devices[idx], lastSeen: now, name: currentDevice.name };
    await storage.saveDevices(devices);
    await storage.saveDeviceInfo({ ...currentDevice, lastSeen: now });
    await syncSettingsToCloud();
  }
}
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
  const scenes = await storage.getScenes();
  // 注意：currentScene 不同步到云端，每个设备独立维护当前场景
  await webdav.writeSettings({
    settings: settings || {},
    devices: devices || [],
    deviceInfo: deviceInfo || null,
    scenes: scenes || []
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
      // 同步场景列表
      if (cloud.scenes && Array.isArray(cloud.scenes) && cloud.scenes.length > 0) {
        await storage.saveScenes(cloud.scenes);
      }
      // 注意：currentScene 不从云端同步，每个设备独立维护当前场景
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

// 监听浏览器启动（保证每次启动都注册设备与定时任务）
chrome.runtime.onStartup.addListener(async () => {
  await setupSyncAlarm();
  await ensureDeviceRegistered();
  // 尝试同步一次设置，保证设备列表/当前场景及时更新
  await syncSettingsFromCloud().catch(() => {});
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
    syncFromCloud(request.sceneId).then(() => {
      sendResponse({ success: true });
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true; // 异步响应
  }
  
  if (request.action === 'syncToCloud') {
    syncToCloud(request.bookmarks, request.folders, request.sceneId).then(() => {
      sendResponse({ success: true });
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (request.action === 'registerDevice') {
    ensureDeviceInCloud().then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
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
  
  if (request.action === 'openPopup') {
    // 打开弹窗（在新窗口中打开popup页面）
    chrome.windows.create({
      url: chrome.runtime.getURL('popup/popup.html'),
      type: 'popup',
      width: 400,
      height: 600
    }, (window) => {
      sendResponse({ success: true, windowId: window?.id });
    });
    return true;
  }
  
  if (request.action === 'openBookmarksPage') {
    // 打开完整书签管理页面
    chrome.tabs.create({
      url: chrome.runtime.getURL('pages/bookmarks.html')
    });
    sendResponse({ success: true });
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

  if (request.action === 'deleteSceneBookmarks') {
    storage.getConfig().then(async (config) => {
      if (!config || !config.serverUrl) {
        sendResponse({ success: false, error: 'WebDAV配置未设置' });
        return;
      }
      try {
        const webdav = new WebDAVClient(config);
        await webdav.deleteSceneBookmarks(request.sceneId);
        sendResponse({ success: true });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    });
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
              return browser.tabs.query({ active: true, lastFocusedWindow: true })
                .then(res => {
                  if (res && res.length) return handleTabs(res);
                  // 继续回退：不带窗口限制
                  return browser.tabs.query({ active: true }).then(list => {
                    if (list && list.length) return handleTabs(list);
                    // 最后回退：取所有标签第一页
                    return browser.tabs.query({}).then(all => handleTabs(all));
                  });
                });
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
          chrome.tabs.query({ active: true, lastFocusedWindow: true }, (res) => {
            if (res && res.length) return handleTabs(res);
            chrome.tabs.query({ active: true }, (list) => {
              if (list && list.length) return handleTabs(list);
              chrome.tabs.query({}, handleTabs);
            });
          });
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
async function syncFromCloud(sceneId = null) {
  try {
    const config = await storage.getConfig();
    if (!config || !config.serverUrl) {
      console.log('WebDAV配置未设置');
      return;
    }

    await ensureDeviceRegistered();

    // 先拉取云端设置，获取最新设备列表
    await syncSettingsFromCloud();

    // 设备校验：严格模式，云端缺少当前设备则清理并停止；
    // 但对于“未知设备”一律跳过校验，避免在无法识别设备信息时误报。
    // 检查设备检测开关（默认关闭）
    const settings = await storage.getSettings();
    const deviceDetectionEnabled = settings?.deviceDetection?.enabled === true;
    
    // 设备校验：仅在设备检测开关开启时进行严格模式检测，云端缺少当前设备则清理并停止
    if (deviceDetectionEnabled) {
      let devices = await storage.getDevices();
      if (!devices || devices.length === 0) {
        // 云端空列表视为缺设备，清理并停
        await storage.clearAllData();
        await storage.saveSyncStatus({
          status: 'error',
          lastSync: Date.now(),
          error: '当前设备未被授权，已清理本地数据并停止同步'
        });
        return;
      }
      if (!devices.find(d => d.id === currentDevice.id)) {
        // 再次拉取确认，避免误判
        await syncSettingsFromCloud();
        devices = await storage.getDevices();
        if (!devices.find(d => d.id === currentDevice.id)) {
          await storage.clearAllData();
          await storage.saveSyncStatus({
            status: 'error',
            lastSync: Date.now(),
            error: '当前设备未被授权，已清理本地数据并停止同步'
          });
          return;
        }
      }
    }

    await storage.saveSyncStatus({
      status: 'syncing',
      lastSync: Date.now(),
      error: null
    });

    // 先同步设置（包含场景列表）
    await syncSettingsFromCloud();

    // 获取目标场景
    const currentSceneId = sceneId || await storage.getCurrentScene();
    
    const webdav = new WebDAVClient(config);
    // 只同步当前场景的书签文件
    const cloudData = await webdav.readBookmarks(currentSceneId);
    const cleaned = normalizeData(cloudData.bookmarks || [], cloudData.folders || []);
    
    // 获取所有本地书签
    const allBookmarks = await storage.getBookmarks();
    const localSceneBookmarks = (allBookmarks.bookmarks || []).filter(b => b.scene === currentSceneId);
    const otherSceneBookmarks = (allBookmarks.bookmarks || []).filter(b => b.scene !== currentSceneId);
    
    // 如果本地有书签且云端也有数据，需要归档本地书签（仅归档未在"本地_"开头的文件夹中的书签）
    if (localSceneBookmarks.length > 0 && cleaned.bookmarks.length > 0) {
      const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // 如 20240115
      const archiveFolder = `本地_${timestamp}`;
      
      // 检查哪些本地书签需要归档（不在"本地_"开头的文件夹中的）
      const bookmarksToArchive = localSceneBookmarks.filter(b => {
        const folder = b.folder || '';
        // 检查是否在任何"本地_xxx"文件夹中
        return !folder.startsWith('本地_') && !folder.match(/^本地_\d{8}/);
      });
      
      // 已经归档的书签（在任何"本地_xxx"文件夹中的）
      const alreadyArchivedBookmarks = localSceneBookmarks.filter(b => {
        const folder = b.folder || '';
        return folder.startsWith('本地_') || folder.match(/^本地_\d{8}/);
      });
      
      // 将需要归档的书签归档到"本地"文件夹
      const archivedBookmarks = bookmarksToArchive.map(b => ({
        ...b,
        folder: b.folder ? `${archiveFolder}/${b.folder}` : archiveFolder
      }));
      
      // 合并归档后的本地书签和云端书签
      const mergedSceneBookmarks = [...cleaned.bookmarks, ...alreadyArchivedBookmarks, ...archivedBookmarks];
      
      // 合并所有场景的书签
      const mergedBookmarks = [...otherSceneBookmarks, ...mergedSceneBookmarks];
      
      // 合并文件夹（包括归档文件夹）
      const archiveFolders = new Set();
      archivedBookmarks.forEach(b => {
        if (b.folder) {
          // 提取归档文件夹下的所有子文件夹路径
          const parts = b.folder.split('/');
          for (let i = 1; i <= parts.length; i++) {
            archiveFolders.add(parts.slice(0, i).join('/'));
          }
        }
      });
      
      const allFolders = [...new Set([
        ...(allBookmarks.folders || []),
        ...cleaned.folders,
        ...Array.from(archiveFolders)
      ])];
      
      // 保存合并后的数据
      await storage.saveBookmarks(mergedBookmarks, allFolders);
      
      // 同步合并后的数据到云端
      const sceneFolders = allFolders.filter(f => {
        // 只同步当前场景相关的文件夹
        return mergedSceneBookmarks.some(b => {
          const bFolder = b.folder || '';
          return bFolder === f || (bFolder.startsWith(f + '/'));
        });
      });
      await syncToCloud(mergedSceneBookmarks, sceneFolders, currentSceneId);
    } else {
      // 没有本地书签或没有云端数据，直接合并
      const mergedBookmarks = [...otherSceneBookmarks, ...cleaned.bookmarks];
      
      // 合并文件夹（所有场景的文件夹）
      const allFolders = [...new Set([
        ...(allBookmarks.folders || []),
        ...cleaned.folders
      ])];
      
      // 保存合并后的数据
      await storage.saveBookmarks(mergedBookmarks, allFolders);
    }

    // 更新设备上次同步时间
    await touchCurrentDevice();
    
    // 标记该场景为已同步
    await storage.addSyncedScene(currentSceneId);
    
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
 * @param {Array} bookmarks - 书签数组
 * @param {Array} folders - 文件夹数组
 * @param {String} sceneId - 场景ID（可选，如果不提供则从书签中推断或使用当前场景）
 */
async function syncToCloud(bookmarks, folders, sceneId = null) {
  try {
    const config = await storage.getConfig();
    if (!config || !config.serverUrl) {
      throw new Error('WebDAV配置未设置');
    }

    await ensureDeviceRegistered();
    
    // 检查设备检测开关（默认关闭）
    const settings = await storage.getSettings();
    const deviceDetectionEnabled = settings?.deviceDetection?.enabled === true;
    
    // 上行同步仅在设备检测开关开启时检查授权
    if (deviceDetectionEnabled) {
      let devices = await storage.getDevices();
      if (!devices || devices.length === 0 || !devices.find(d => d.id === currentDevice.id)) {
        // 再拉取一次云端设置确认
        await syncSettingsFromCloud();
        devices = await storage.getDevices();
        if (!devices || devices.length === 0 || !devices.find(d => d.id === currentDevice.id)) {
          throw new Error('当前设备未被授权，请在设置页重新测试连接以注册设备');
        }
      }
    }

    await storage.saveSyncStatus({
      status: 'syncing',
      lastSync: Date.now(),
      error: null
    });

    // 确定要同步的场景ID
    let targetSceneId = sceneId;
    if (!targetSceneId && bookmarks && bookmarks.length > 0) {
      // 从书签中推断场景（取第一个书签的场景）
      targetSceneId = bookmarks[0].scene;
    }
    if (!targetSceneId) {
      // 如果还是没有，使用当前场景
      targetSceneId = await storage.getCurrentScene();
    }
    
    const webdav = new WebDAVClient(config);
    const cleaned = normalizeData(bookmarks, folders);
    
    // 只同步指定场景的书签到对应的文件
    const sceneBookmarks = cleaned.bookmarks.filter(b => b.scene === targetSceneId);
    const sceneFolders = [...new Set(sceneBookmarks.map(b => b.folder).filter(Boolean))];
    
    await webdav.writeBookmarks(
      { bookmarks: sceneBookmarks, folders: sceneFolders },
      targetSceneId
    );

    // 写入设置（包含场景列表和当前场景）
    await syncSettingsToCloud();
    
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
  // 获取当前场景的书签
  const currentSceneId = await storage.getCurrentScene();
  const data = await storage.getBookmarks(currentSceneId);
  const bookmarks = data.bookmarks || [];
  const folders = data.folders || [];
  await syncToCloud(bookmarks, folders, currentSceneId);
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
      id: await generateDeviceId(),
      name: await getDeviceName(),
      createdAt: Date.now(),
      lastSeen: Date.now()
    };
    await storage.saveDeviceInfo(info);
  } else {
    // 如果名称缺失，补一个
    if (!info.name) {
      info.name = await getDeviceName();
      await storage.saveDeviceInfo(info);
    }
    // 如果设备ID格式不符合新规则，重新生成（兼容旧数据）
    if (info.id && !info.id.includes('_')) {
      info.id = await generateDeviceId();
      await storage.saveDeviceInfo(info);
    }
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
 * 检测浏览器类型
 */
function detectBrowserType() {
  try {
    const ua = navigator.userAgent || '';
    if (/chrome/i.test(ua) && !/edge|edg|opr|opera/i.test(ua)) {
      return 'chrome';
    } else if (/firefox/i.test(ua)) {
      return 'firefox';
    } else if (/edge|edg/i.test(ua)) {
      return 'edge';
    } else if (/opr|opera/i.test(ua)) {
      return 'opera';
    } else if (/safari/i.test(ua) && !/chrome/i.test(ua)) {
      return 'safari';
    }
  } catch (e) {
    // ignore
  }
  return 'unknownbrowser';
}

/**
 * 检测设备类型
 */
async function detectDeviceType() {
  try {
    // 优先使用 platformInfo
    if (chrome?.runtime?.getPlatformInfo) {
      const platform = await new Promise(resolve => chrome.runtime.getPlatformInfo(resolve));
      if (platform?.os) {
        const os = platform.os.toLowerCase();
        if (os === 'win' || os === 'mac' || os === 'linux' || os === 'openbsd' || os === 'fuchsia') {
          return 'pc';
        } else if (os === 'android') {
          return 'android';
        } else if (os === 'ios' || os === 'cros') {
          return os;
        }
      }
    }
    // 回退：使用 userAgent
    const ua = navigator.userAgent || '';
    if (/android/i.test(ua)) {
      return 'android';
    } else if (/iphone|ipad|ipod/i.test(ua)) {
      return 'ios';
    } else if (/windows|macintosh|linux/i.test(ua)) {
      return 'pc';
    }
  } catch (e) {
    // ignore
  }
  return 'unknowndevice';
}

/**
 * 生成唯一随机数
 */
function generateUniqueId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

/**
 * 生成设备ID（格式：浏览器类型_设备类型_唯一随机数）
 */
async function generateDeviceId() {
  const browserType = detectBrowserType();
  const deviceType = await detectDeviceType();
  const uniqueId = generateUniqueId();
  return `${browserType}_${deviceType}_${uniqueId}`;
}

/**
 * 获取设备名称
 */
async function getDeviceName() {
  try {
    // 优先使用 platformInfo（更可靠）
    if (chrome?.runtime?.getPlatformInfo) {
      const platform = await new Promise(resolve => chrome.runtime.getPlatformInfo(resolve));
      const parts = [];
      if (platform?.os) parts.push(platform.os);
      if (platform?.arch) parts.push(platform.arch);
      if (platform?.nacl_arch && platform?.nacl_arch !== platform.arch) parts.push(platform.nacl_arch);
      if (parts.length) return parts.join(' / ');
    }
    // 回退：navigator.userAgent
    if (typeof navigator !== 'undefined' && navigator.userAgent) {
      return navigator.userAgent.split(')')[0] || '未知设备';
    }
  } catch (e) {
    // ignore
  }
  return '未知设备';
}

/**
 * 判断是否为“未知设备”——在这种情况下跳过严格授权校验，避免误报
 */

