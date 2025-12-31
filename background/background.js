/**
 * 确保当前设备已在云端设备列表（先拉取，再判定）
 * 若缺失则添加并写回云端；若已存在则仅刷新 lastSeen
 * 仅在 WebDAV 连接正常时执行
 */
async function ensureDeviceInCloud() {
  // 先检查 WebDAV 配置是否存在
  const config = await storage.getConfig();
  if (!config || !config.serverUrl) {
    console.log('WebDAV配置未设置，跳过设备注册');
    return;
  }

  // 确保本地设备信息已初始化（deviceInfo 是本地生成的，不会被云端覆盖）
  await ensureDeviceRegistered();
  
  // 确保 currentDevice 已设置
  if (!currentDevice) {
    currentDevice = await storage.getDeviceInfo();
  }
  
  if (!currentDevice || !currentDevice.id) {
    console.error('当前设备信息未初始化，无法注册到云端');
    return;
  }

  // 从云端拉取最新的设备列表（不覆盖本地的 deviceInfo）
  // 即使拉取失败，也继续执行设备注册逻辑（可能是首次连接，云端文件不存在）
  try {
    await syncSettingsFromCloud();
  } catch (e) {
    console.warn('拉取云端设置失败，继续执行设备注册:', e.message);
  }
  
  // 获取设备列表（可能是从云端拉取的，也可能是本地已有的）
  // 确保从云端同步后，获取最新的设备列表
  let devices = await storage.getDevices() || [];
  const now = Date.now();
  
  console.log('[设备注册] 拉取云端后，本地设备列表数量:', devices.length, '当前设备ID:', currentDevice.id);
  console.log('[设备注册] 设备列表内容:', devices.map(d => ({ id: d.id, name: d.name })));

  // 检查当前设备是否在列表中
  const idx = devices.findIndex(d => d.id === currentDevice.id);
  
  if (idx === -1) {
    // 当前设备不在列表中，添加到列表
    console.log('[设备注册] 当前设备不在列表中，添加到列表:', currentDevice.id, currentDevice.name);
    devices.push({
      id: currentDevice.id,
      name: currentDevice.name,
      createdAt: currentDevice.createdAt || now,
      lastSeen: now
    });
  } else {
    // 当前设备已在列表中，仅刷新 lastSeen 和 name
    console.log('[设备注册] 当前设备已在列表中，更新 lastSeen:', currentDevice.id);
    devices[idx] = { ...devices[idx], lastSeen: now, name: currentDevice.name };
  }

  // 更新本地设备信息（仅更新 lastSeen）
  await storage.saveDeviceInfo({ ...currentDevice, lastSeen: now });
  
  // 保存更新后的设备列表到本地
  console.log('[设备注册] 保存设备列表到本地，数量:', devices.length);
  await storage.saveDevices(devices);
  
  // 验证保存是否成功
  const savedDevices = await storage.getDevices() || [];
  console.log('[设备注册] 验证保存结果，本地设备列表数量:', savedDevices.length);
  const isCurrentDeviceInList = savedDevices.find(d => d.id === currentDevice.id);
  if (!isCurrentDeviceInList) {
    console.error('[设备注册] 错误：保存后当前设备不在列表中！');
    throw new Error('设备列表保存失败：当前设备未在列表中');
  }
  
  // 同步设备列表到云端
  // 重要：直接传入刚刚修改过的 devices 变量，而不是让 syncSettingsToCloud 从存储重新读取
  // 这样可以避免时序问题，确保同步的是最新的设备列表
  try {
    console.log('[设备注册] 开始同步设备列表到云端，设备数量:', devices.length);
    await syncSettingsToCloud(devices);
    console.log('[设备注册] 设备列表已成功同步到云端，当前设备ID:', currentDevice.id);
  } catch (error) {
    console.error('[设备注册] 同步设备列表到云端失败:', error);
    throw error;
  }
}

/**
 * 后台服务脚本
 * 处理同步、定时任务等后台逻辑
 *
 * Chrome MV3: 作为 service_worker 运行，此时可以使用 importScripts 引入依赖。
 * Firefox MV2: 通过 manifest.firefox.json 的 background.scripts 数组加载依赖，
 *              在这类环境中没有 importScripts，因此需要做保护性判断。
 */
if (typeof importScripts === 'function') {
  importScripts('../utils/storage.js', '../utils/webdav.js');
}

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
 * @param {Array} devicesOverride - 可选的设备列表，如果提供则使用此列表而不是从存储读取
 */
async function syncSettingsToCloud(devicesOverride = null) {
  const config = await storage.getConfig();
  if (!config || !config.serverUrl) return;
  const webdav = new WebDAVClient(config);
  const settings = await storage.getSettings();
  // 如果提供了设备列表参数，使用参数；否则从存储读取
  const devices = devicesOverride !== null ? devicesOverride : await storage.getDevices();
  const deviceInfo = await storage.getDeviceInfo();
  const scenes = await storage.getScenes();
  
  console.log('[设置同步] 同步设置到云端，设备列表数量:', devices?.length || 0, devicesOverride !== null ? '(使用传入列表)' : '(从存储读取)');
  
  // 注意：currentScene 不同步到云端，每个设备独立维护当前场景
  await webdav.writeSettings({
    settings: settings || {},
    devices: devices || [],
    deviceInfo: deviceInfo || null,
    scenes: scenes || []
  });
  
  console.log('[设置同步] 设置已成功写入云端');
}

/**
 * 从云端同步设置到本地（非敏感）
 * @param {Boolean} skipDevices - 是否跳过设备列表同步（刚注册设备后使用，避免覆盖）
 * @param {Boolean} forceClear - 是否强制清空本地设置（非首次保存时使用，即使云端没有设置也清空本地）
 */
async function syncSettingsFromCloud(skipDevices = false, forceClear = false) {
  const config = await storage.getConfig();
  if (!config || !config.serverUrl) return;
  const webdav = new WebDAVClient(config);
  try {
    const cloud = await webdav.readSettings();
    if (cloud) {
      if (cloud.settings) {
        await storage.saveSettings(cloud.settings);
      } else if (forceClear) {
        // 非首次保存时，即使云端没有设置，也清空本地设置
        await storage.saveSettings({});
      }
      // 同步设备列表：如果云端有设备列表，同步到本地（覆盖本地列表）
      // 如果云端没有设备列表（undefined），不覆盖本地列表（除非forceClear为true）
      // skipDevices 为 true 时跳过设备列表同步（刚注册设备后避免覆盖）
      if (!skipDevices) {
        if (cloud.devices && Array.isArray(cloud.devices)) {
          console.log('[设置同步] 从云端同步设备列表，数量:', cloud.devices.length);
          await storage.saveDevices(cloud.devices);
        } else if (forceClear) {
          // 非首次保存时，即使云端没有设备列表，也清空本地设备列表
          console.log('[设置同步] 非首次保存，清空本地设备列表');
          await storage.saveDevices([]);
        } else {
          console.log('[设置同步] 云端没有设备列表，保留本地设备列表');
        }
      } else {
        console.log('[设置同步] 跳过设备列表同步（避免覆盖刚注册的设备）');
      }
      // 注意：deviceInfo 是每个设备本地的信息，不应该从云端覆盖
      // 每个设备的 deviceInfo 由本地生成和维护
      // 同步场景列表
      if (cloud.scenes && Array.isArray(cloud.scenes) && cloud.scenes.length > 0) {
        await storage.saveScenes(cloud.scenes);
      } else if (forceClear) {
        // 非首次保存时，如果云端没有场景列表，清空本地场景列表
        // 但getScenes会自动创建默认场景，所以这里不需要手动创建
        await storage.saveScenes([]);
      }
      // 注意：currentScene 不从云端同步，每个设备独立维护当前场景
    } else if (forceClear) {
      // 非首次保存时，如果云端没有设置文件，也清空本地设置、设备列表和场景列表
      await storage.saveSettings({});
      if (!skipDevices) {
        await storage.saveDevices([]);
      }
      // 清空场景列表，确保使用新的云端数据
      await storage.saveScenes([]);
    }
  } catch (e) {
    // 忽略设置读取失败，不影响书签同步
    console.warn('同步设置失败（忽略）：', e.message);
  }
}

// 兼容的 API 对象（部分 API 在移动端可能不存在，例如 Firefox Android 不支持 contextMenus/commands）
const runtimeAPI = typeof browser !== 'undefined' ? browser.runtime : chrome.runtime;
const contextMenusAPI = (typeof browser !== 'undefined' ? browser.contextMenus : chrome.contextMenus) || null;
const tabsAPI = typeof browser !== 'undefined' ? browser.tabs : chrome.tabs;
const commandsAPI = (typeof browser !== 'undefined' ? browser.commands : chrome.commands) || null;
const alarmsAPI = typeof browser !== 'undefined' ? browser.alarms : chrome.alarms;

// 同步失败提示（Toast）防泛滥机制：本地持久化（兼容 MV3 service worker 可能被唤醒/休眠）
const SYNC_ERROR_TOAST_STATE_KEY = 'syncErrorToastState'; // local-only，不同步云端
const NOTIFICATION_COOLDOWN = 5 * 60 * 1000; // 5分钟内相同错误只提示一次
const MAX_TOAST_STATE_ENTRIES = 20;

function getStorageLocalCompat() {
  return (typeof browser !== 'undefined' && browser.storage && browser.storage.local)
    ? browser.storage.local
    : (typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.local : null);
}

async function getLocalValueCompat(key) {
  const local = getStorageLocalCompat();
  if (!local) return undefined;
  if (typeof browser !== 'undefined' && browser.storage && browser.storage.local) {
    const result = await local.get([key]);
    return result ? result[key] : undefined;
  }
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => resolve(result ? result[key] : undefined));
  });
}

async function setLocalValueCompat(obj) {
  const local = getStorageLocalCompat();
  if (!local) return;
  if (typeof browser !== 'undefined' && browser.storage && browser.storage.local) {
    await local.set(obj);
    return;
  }
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, () => resolve());
  });
}

async function queryTabsCompat(query) {
  if (!tabsAPI || typeof tabsAPI.query !== 'function') return [];
  if (typeof browser !== 'undefined' && browser.tabs && browser.tabs.query) {
    return await tabsAPI.query(query);
  }
  return new Promise((resolve) => {
    tabsAPI.query(query, (tabs) => resolve(Array.isArray(tabs) ? tabs : []));
  });
}

async function sendMessageToTabCompat(tabId, message) {
  if (!tabsAPI || typeof tabsAPI.sendMessage !== 'function') return null;
  if (typeof browser !== 'undefined' && browser.tabs && browser.tabs.sendMessage) {
    try {
      return await tabsAPI.sendMessage(tabId, message);
    } catch (_) {
      return null; // 可能是特殊页面/无 content script，忽略
    }
  }
  // Chrome (MV2/MV3): 用回调封装 Promise（避免双发）
  return new Promise((resolve) => {
    try {
      tabsAPI.sendMessage(tabId, message, (response) => {
        const lastError = chrome.runtime && chrome.runtime.lastError;
        if (lastError) return resolve(null);
        resolve(response || { success: true });
      });
    } catch (_) {
      resolve(null);
    }
  });
}

/**
 * 显示同步失败提示（页面内 Toast，2秒自动消失，不抢焦点、不阻断点击）
 * 形式：通过 content script 在所有普通网页显示（类似悬浮球的覆盖层）。
 * 说明：浏览器内置页面（chrome://、about:、扩展商店页等）无法注入 content script，因此不会显示。
 * @param {string} message - 错误消息
 */
async function showSyncErrorNotification(message) {
  try {
    // 检查是否开启提示（默认开启）
    const settings = await storage.getSettings();
    const enabled = settings?.syncErrorNotification?.enabled !== false;
    if (!enabled) {
      console.log('[Toast] disabled by setting, skip', { message: message || '' });
      return;
    }

    const now = Date.now();
    const msg = (message || '同步过程中发生错误，请检查网络连接或WebDAV配置');
    // 用前80字符做 key，足够稳定且避免存太大
    const hashKey = String(msg).slice(0, 80);

    // 防泛滥：从本地读取状态（MV3 也能跨唤醒持久）
    const state = (await getLocalValueCompat(SYNC_ERROR_TOAST_STATE_KEY)) || {};
    const lastShown = state[hashKey];
    if (lastShown && (now - lastShown) < NOTIFICATION_COOLDOWN) {
      console.log('[Toast] cooldown skip', { secondsSinceLast: Math.floor((now - lastShown) / 1000), hashKey });
      return;
    }

    // 更新状态并清理
    state[hashKey] = now;
    for (const [k, t] of Object.entries(state)) {
      if (!t || (now - t) > NOTIFICATION_COOLDOWN) delete state[k];
    }
    // 控制最大条数
    const entries = Object.entries(state).sort((a, b) => (b[1] || 0) - (a[1] || 0));
    const trimmed = entries.slice(0, MAX_TOAST_STATE_ENTRIES);
    const newState = {};
    trimmed.forEach(([k, t]) => { newState[k] = t; });
    await setLocalValueCompat({ [SYNC_ERROR_TOAST_STATE_KEY]: newState });

    // 广播给所有标签页的 content script 显示 toast
    const tabs = await queryTabsCompat({});
    if (!Array.isArray(tabs) || tabs.length === 0) return;

    const payload = {
      action: 'showSyncErrorToast',
      title: '云端书签同步失败',
      message: msg,
      duration: settings?.syncErrorNotification?.sticky ? 0 : 2000
    };

    const results = await Promise.all((tabs || []).map(async tab => {
      if (!tab || typeof tab.id !== 'number') return { tab, resp: null };
      const resp = await sendMessageToTabCompat(tab.id, payload);
      return { tab, resp };
    }));
    const deliveredTabs = (results || []).filter(r => r && r.resp && (r.resp.success === true || r.resp.ok === true));
    const delivered = deliveredTabs.length;
    console.log('[Toast] sent to tabs', { attempted: (tabs || []).length, delivered });

    // 额外调试：打印“哪些 tab 收到了/哪些没收到”（只打印协议，避免泄露完整 URL）
    try {
      const deliveredIds = new Set(deliveredTabs.map(r => r.tab?.id).filter(id => typeof id === 'number'));
      const missed = (tabs || []).filter(t => t && typeof t.id === 'number' && !deliveredIds.has(t.id));
      const summarizeProto = (u) => {
        try { return new URL(u).protocol; } catch (_) { return 'unknown:'; }
      };
      const missedSummary = missed.map(t => ({ id: t.id, proto: summarizeProto(t.url) })).slice(0, 12);
      if (missedSummary.length) {
        console.log('[Toast] not delivered sample', missedSummary);
      }
    } catch (_) {}

    // 同时通知扩展页面（options/bookmarks/popup 等扩展页面不是 content script，收不到 tabs.sendMessage）
    try {
      const ret = runtimeAPI.sendMessage(payload);
      if (ret && typeof ret.then === 'function') {
        await ret;
      }
    } catch (_) {
      // 没有接收端或某些环境不支持，忽略
    }
  } catch (error) {
    console.error('[Toast] 显示同步失败提示时出错:', error);
  }
}

// 监听插件安装
runtimeAPI.onInstalled.addListener(async () => {
  console.log('云端书签插件已安装');
  
  // 创建右键菜单（某些环境如 Firefox Android 不支持 contextMenus，需判断）
  // 检查 contextMenus API 是否真的可用（不仅仅是存在）
  if (contextMenusAPI && typeof contextMenusAPI.create === 'function') {
    try {
      // 先检查是否支持（某些平台 API 存在但不可用）
      if (typeof browser !== 'undefined' && browser.contextMenus) {
        await browser.contextMenus.create({
          id: 'addBookmark',
          title: '添加到云端书签',
          contexts: ['page', 'link']
        });
      } else if (chrome.contextMenus && typeof chrome.contextMenus.create === 'function') {
        chrome.contextMenus.create({
          id: 'addBookmark',
          title: '添加到云端书签',
          contexts: ['page', 'link']
        });
      }
    } catch (e) {
      // 静默失败，某些平台不支持 contextMenus（如 Firefox Android）
      console.warn('创建右键菜单失败（可能当前平台不支持 contextMenus）:', e?.message || e);
    }
  }
  
  // 设置初始同步任务
  await setupSyncAlarm();
  await ensureDeviceRegistered();
});

// 监听浏览器启动（保证每次启动都注册设备与定时任务）
runtimeAPI.onStartup.addListener(async () => {
  await setupSyncAlarm();
  await ensureDeviceRegistered();
  // 尝试同步一次设置，保证设备列表/当前场景及时更新
  await syncSettingsFromCloud().catch(() => {});
});

// 监听右键菜单点击（仅在支持 contextMenus 的平台生效）
if (contextMenusAPI && contextMenusAPI.onClicked && typeof contextMenusAPI.onClicked.addListener === 'function') {
  try {
    contextMenusAPI.onClicked.addListener(async (info, tab) => {
      if (info.menuItemId === 'addBookmark') {
        try {
          // 验证 tab 是否存在且有效
          const targetUrl = info.linkUrl || (tab && tab.url ? tab.url : '');
          if (!targetUrl) {
            console.error('[后台] 无法获取目标URL');
            return;
          }
          
          // 打开添加书签页面
          if (typeof browser !== 'undefined' && browser.tabs) {
            await tabsAPI.create({
              url: runtimeAPI.getURL('pages/bookmarks.html?action=add&url=' + encodeURIComponent(targetUrl))
            });
          } else {
            tabsAPI.create({
              url: runtimeAPI.getURL('pages/bookmarks.html?action=add&url=' + encodeURIComponent(targetUrl))
            });
          }
        } catch (error) {
          console.error('[后台] 打开书签页面失败:', error);
        }
      }
    });
  } catch (e) {
    // 某些平台不支持 contextMenus.onClicked，静默失败
    console.warn('注册右键菜单监听失败（可能当前平台不支持）:', e?.message || e);
  }
}

// 监听快捷键命令（某些平台如移动端可能不支持 commands，需要判断）
// 复用既存的 getActiveTab 消息处理逻辑
if (commandsAPI && commandsAPI.onCommand && typeof commandsAPI.onCommand.addListener === 'function') {
  try {
    commandsAPI.onCommand.addListener(async (command) => {
      if (command === 'add-bookmark') {
        try {
          // 复用既存的 getActiveTab 逻辑（通过内部调用）
          // 使用与 popup.js 相同的逻辑：通过消息获取活动标签页
          const handleTabs = (tabs) => {
            const tab = Array.isArray(tabs) ? tabs[0] : null;
            // 验证 tab 和 tab.id 是否有效
            if (tab && typeof tab.id !== 'undefined' && tab.id !== null && !isNaN(tab.id) && tab.id >= 0) {
              return { id: tab.id, url: tab.url || '', title: tab.title || '' };
            }
            return null;
          };

          const isExtensionUrl = (url) => {
            return typeof url === 'string' && (
              url.startsWith('chrome-extension://') ||
              url.startsWith('moz-extension://') ||
              url.startsWith('edge-extension://')
            );
          };

          const findValidTab = (tabs) => {
            if (!tabs || tabs.length === 0) return null;
            const tab = handleTabs(tabs);
            if (tab && tab.url && !isExtensionUrl(tab.url)) {
              return tab;
            }
            return null;
          };

          let tab = null;

          if (typeof browser !== 'undefined' && browser.tabs && browser.tabs.query) {
            // Firefox: 使用 Promise
            tab = findValidTab(await tabsAPI.query({ active: true, currentWindow: true }));
            if (!tab) {
              tab = findValidTab(await tabsAPI.query({ active: true, lastFocusedWindow: true }));
            }
            if (!tab) {
              const allTabs = await tabsAPI.query({ active: true });
              tab = allTabs ? findValidTab(allTabs) : null;
            }
            if (!tab) {
              const allTabs = await tabsAPI.query({});
              tab = allTabs ? findValidTab(allTabs) : null;
            }
          } else {
            // Chrome: 使用回调，需要转换为 Promise
            tab = await new Promise((resolve) => {
              tabsAPI.query({ active: true, currentWindow: true }, (tabs) => {
                if (chrome.runtime.lastError) {
                  return resolve(null);
                }
                const result = findValidTab(tabs);
                if (result) return resolve(result);
                
                tabsAPI.query({ active: true, lastFocusedWindow: true }, (tabs) => {
                  if (chrome.runtime.lastError) {
                    return resolve(null);
                  }
                  const result = findValidTab(tabs);
                  if (result) return resolve(result);
                  
                  tabsAPI.query({ active: true }, (tabs) => {
                    if (chrome.runtime.lastError) {
                      return resolve(null);
                    }
                    const result = findValidTab(tabs);
                    if (result) return resolve(result);
                    
                    tabsAPI.query({}, (tabs) => {
                      if (chrome.runtime.lastError) {
                        return resolve(null);
                      }
                      resolve(findValidTab(tabs));
                    });
                  });
                });
              });
            });
          }
          
          if (tab && tab.url) {
            // 构建URL参数，包含URL和标题，使用 source=shortcut 以便自动关闭
            const params = new URLSearchParams({
              action: 'add',
              url: tab.url,
              source: 'shortcut'
            });
            if (tab.title) {
              params.set('title', tab.title);
            }
            
            const targetUrl = runtimeAPI.getURL(`pages/bookmarks.html?${params.toString()}`);
            
            if (typeof browser !== 'undefined' && browser.tabs) {
              await tabsAPI.create({ url: targetUrl });
            } else {
              tabsAPI.create({ url: targetUrl });
            }
          } else {
            console.error('[后台] 无法获取有效的活动标签页（快捷键）');
          }
        } catch (error) {
          console.error('[后台] 快捷键添加书签失败:', error);
        }
      }
    });
  } catch (e) {
    // 某些平台不支持 commands，静默失败
    console.warn('注册快捷键监听失败（可能当前平台不支持）:', e?.message || e);
  }
}

// 监听定时任务
alarmsAPI.onAlarm.addListener(async (alarm) => {
  if (alarm.name === syncAlarmName) {
    await syncFromCloud();
  }
});

// 监听来自popup或pages的消息
runtimeAPI.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'sync') {
    // skipDeviceDetection: 保存配置时使用，只注册设备不进行设备检测
    // skipDeviceListSync: 刚注册设备后使用，避免覆盖刚注册的设备列表
    // clearLocalFirst: 非首次保存时，先清空本地数据再同步
    syncFromCloud(request.sceneId, request.skipDeviceDetection, request.skipDeviceListSync, request.clearLocalFirst).then((result) => {
      // syncFromCloud 现在会返回 {success, error, ...}
      if (result && typeof result.success === 'boolean') {
        sendResponse(result);
      } else {
        // 兜底：旧逻辑
        sendResponse({ success: true });
      }
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
    console.log('[后台] 收到 openPopup 请求', { hasCurrentUrl: !!request.currentUrl, hasCurrentTitle: !!request.currentTitle });
    // 打开弹窗（在新窗口中打开popup页面）
    // 注意：某些平台如 Firefox Android 可能不支持 windows API 或 type: 'popup'
    const windowsAPI = (typeof browser !== 'undefined' ? browser.windows : chrome.windows) || null;
    const runtimeAPI = typeof browser !== 'undefined' ? browser.runtime : chrome.runtime;
    const tabsAPI = typeof browser !== 'undefined' ? browser.tabs : chrome.tabs;
    
    // 如果传递了当前页面信息，直接打开添加书签页面
    if (request.currentUrl && request.currentTitle) {
      const params = new URLSearchParams({
        action: 'add',
        url: request.currentUrl,
        title: request.currentTitle,
        source: 'floating-ball'
      });
      const targetUrl = runtimeAPI.getURL(`pages/bookmarks.html?${params.toString()}`);
      
      if (typeof browser !== 'undefined' && browser.tabs) {
        tabsAPI.create({ url: targetUrl }).then(() => {
          sendResponse({ success: true });
        }).catch(error => {
          console.error('[后台] 打开添加书签页面失败:', error);
          sendResponse({ success: false, error: error.message });
        });
      } else {
        tabsAPI.create({ url: targetUrl });
        sendResponse({ success: true });
      }
      return true;
    }
    
    console.log('[后台] windowsAPI 存在:', !!windowsAPI, 'tabsAPI 存在:', !!tabsAPI);
    
    // 如果 windows API 不存在或不支持，直接回退到打开标签页
    if (!windowsAPI || !windowsAPI.create) {
      console.log('[后台] windows API 不存在，使用 tabs.create 打开标签页');
      tabsAPI.create({
        url: runtimeAPI.getURL('popup/popup.html')
      }).then(() => {
        console.log('[后台] tabs.create 成功');
        sendResponse({ success: true });
      }).catch(error => {
        console.error('[后台] tabs.create 失败:', error);
        sendResponse({ success: false, error: error.message });
      });
      return true;
    }
    
    // 计算弹窗居中位置
    const popupWidth = 400;
    const popupHeight = 600;
    
    // 获取当前活动窗口，用于计算居中位置
    const getCurrentWindow = () => {
      if (typeof browser !== 'undefined' && browser.windows && browser.windows.getCurrent) {
        // Firefox: 使用 Promise
        return windowsAPI.getCurrent().catch(error => {
          console.warn('[后台] getCurrent 失败:', error);
          return null;
        });
      } else if (windowsAPI && windowsAPI.getCurrent) {
        // Chrome: 使用回调，转换为 Promise
        return new Promise((resolve) => {
          try {
            windowsAPI.getCurrent((window) => {
              if (chrome.runtime.lastError) {
                console.warn('[后台] getCurrent 失败:', chrome.runtime.lastError.message);
                resolve(null);
              } else {
                resolve(window);
              }
            });
          } catch (error) {
            console.warn('[后台] getCurrent 异常:', error);
            resolve(null);
          }
        });
      } else {
        // windows API 不可用（如移动端）
        return Promise.resolve(null);
      }
    };
    
    const createCenteredPopup = (left, top) => {
      const popupOptions = {
        url: runtimeAPI.getURL('popup/popup.html'),
        type: 'popup',
        width: popupWidth,
        height: popupHeight,
        left: left,
        top: top
      };
      
      if (typeof browser !== 'undefined' && browser.windows) {
        // Firefox: 使用 Promise
        return windowsAPI.create(popupOptions).then(window => {
          sendResponse({ success: true, windowId: window?.id });
        }).catch(error => {
          // 如果 popup 类型失败，回退到普通标签页
          tabsAPI.create({
            url: runtimeAPI.getURL('popup/popup.html')
          }).then(() => {
            sendResponse({ success: true });
          }).catch(err => {
            sendResponse({ success: false, error: err.message || error.message });
          });
        });
      } else {
        // Chrome: 使用回调
        return new Promise((resolve) => {
          windowsAPI.create(popupOptions, (window) => {
            if (chrome.runtime.lastError) {
              // 如果 popup 类型失败，回退到普通标签页
              tabsAPI.create({
                url: runtimeAPI.getURL('popup/popup.html')
              }, () => {
                sendResponse({ success: true });
                resolve();
              });
            } else {
              sendResponse({ success: true, windowId: window?.id });
              resolve();
            }
          });
        });
      }
    };
    
    // 获取当前窗口并计算居中位置
    getCurrentWindow().then(currentWindow => {
      let left, top;
      
      if (currentWindow && currentWindow.left !== undefined && currentWindow.width !== undefined) {
        // 使用当前窗口的位置和大小计算居中
        left = Math.floor(currentWindow.left + (currentWindow.width - popupWidth) / 2);
        // 计算垂直居中，确保至少距离顶部 50px（避免被任务栏遮挡）
        const windowTop = currentWindow.top || 0;
        const windowHeight = currentWindow.height || 600;
        const centerTop = windowTop + (windowHeight - popupHeight) / 2;
        top = Math.max(50, Math.floor(centerTop));
      } else {
        // 回退：使用屏幕中心（假设常见屏幕尺寸）
        // 大多数屏幕至少 1024px 宽，我们使用 1280 作为默认值
        const screenWidth = 1280;
        const screenHeight = 720;
        left = Math.floor((screenWidth - popupWidth) / 2);
        top = Math.floor((screenHeight - popupHeight) / 2);
      }
      
      return createCenteredPopup(left, top);
    }).catch(error => {
      console.error('[后台] 获取当前窗口失败，使用默认位置:', error);
      // 如果获取窗口失败，使用默认居中位置
      const defaultLeft = Math.floor((1280 - popupWidth) / 2);
      const defaultTop = Math.floor((720 - popupHeight) / 2);
      return createCenteredPopup(defaultLeft, defaultTop);
    });
    
    return true; // 异步响应，保持消息通道开放
  }
  
  if (request.action === 'openBookmarksPage') {
    console.log('[后台] 收到 openBookmarksPage 请求', { hasCurrentUrl: !!request.currentUrl, hasCurrentTitle: !!request.currentTitle });
    // 打开完整书签管理页面
    const tabsAPI = typeof browser !== 'undefined' ? browser.tabs : chrome.tabs;
    const runtimeAPI = typeof browser !== 'undefined' ? browser.runtime : chrome.runtime;
    
    // 如果传递了当前页面信息，打开添加书签页面；否则打开完整管理页面
    let targetUrl = runtimeAPI.getURL('pages/bookmarks.html');
    if (request.currentUrl && request.currentTitle) {
      const params = new URLSearchParams({
        action: 'add',
        url: request.currentUrl,
        title: request.currentTitle,
        source: 'floating-ball'
      });
      targetUrl = runtimeAPI.getURL(`pages/bookmarks.html?${params.toString()}`);
    }
    
    if (typeof browser !== 'undefined' && browser.tabs) {
      // Firefox: 使用 Promise
      tabsAPI.create({
        url: targetUrl
      }).then(() => {
        console.log('[后台] openBookmarksPage 成功');
        sendResponse({ success: true });
      }).catch(error => {
        console.error('[后台] openBookmarksPage 失败:', error);
        sendResponse({ success: false, error: error.message });
      });
    } else {
      // Chrome: 使用回调
      tabsAPI.create({
        url: targetUrl
      });
      console.log('[后台] openBookmarksPage 成功 (Chrome)');
      sendResponse({ success: true });
    }
    return true;
  }
  
  if (request.action === 'closeCurrentTab') {
    console.log('[后台] 收到 closeCurrentTab 请求');
    const tabsAPI = typeof browser !== 'undefined' ? browser.tabs : chrome.tabs;
    
    // 获取发送消息的标签页ID
    if (sender && sender.tab && sender.tab.id) {
      const tabId = sender.tab.id;
      if (typeof browser !== 'undefined' && browser.tabs) {
        // Firefox: 使用 Promise
        tabsAPI.remove(tabId).then(() => {
          console.log('[后台] closeCurrentTab 成功');
          sendResponse({ success: true });
        }).catch(error => {
          console.error('[后台] closeCurrentTab 失败:', error);
          sendResponse({ success: false, error: error.message });
        });
      } else {
        // Chrome: 使用回调
        tabsAPI.remove(tabId, () => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            console.error('[后台] closeCurrentTab 失败:', lastError.message);
            sendResponse({ success: false, error: lastError.message });
          } else {
            console.log('[后台] closeCurrentTab 成功');
            sendResponse({ success: true });
          }
        });
      }
    } else {
      console.warn('[后台] closeCurrentTab: 无法获取标签页ID');
      sendResponse({ success: false, error: '无法获取标签页ID' });
    }
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
    // 支持传递 skipDevices 和 forceClear 参数
    const skipDevices = request.skipDevices || false;
    const forceClear = request.forceClear || false;
    syncSettingsFromCloud(skipDevices, forceClear).then(() => {
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

  if (request.action === 'clearLocalDataForReconfig') {
    // 清空本地书签、设备列表、设置（但保留配置和deviceInfo）
    // 用于非首次保存webdav配置时，先清空本地数据，避免旧数据被同步到新云端
    (async () => {
      try {
        console.log('[清空本地数据] 开始清空本地书签、设备列表、设置');
        
        // 清空书签
        await storage.saveBookmarks([], []);
        
        // 清空设备列表
        await storage.saveDevices([]);
        
        // 清空设置（但保留deviceInfo，因为它是本地生成的）
        await storage.saveSettings({});
        
        // 清空已同步场景列表
        await storage.clearSyncedScenes();
        
        console.log('[清空本地数据] 清空完成');
        sendResponse({ success: true, message: '清空完成' });
      } catch (error) {
        console.error('[清空本地数据] 清空过程出错:', error);
        sendResponse({ success: false, error: error.message });
      }
    })().catch(error => {
      console.error('[清空本地数据] 未捕获的错误:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (request.action === 'getActiveTab') {
    try {
      const handleTabs = (tabs) => {
        const tab = Array.isArray(tabs) ? tabs[0] : null;
        // 验证 tab 和 tab.id 是否有效（tab.id 必须是有效数字）
        if (tab && typeof tab.id !== 'undefined' && tab.id !== null && !isNaN(tab.id) && tab.id >= 0) {
          sendResponse({ tab: { id: tab.id, url: tab.url || '', title: tab.title || '' } });
        } else {
          sendResponse({ tab: null, error: 'no-active-tab' });
        }
      };

      if (typeof browser !== 'undefined' && browser.tabs && browser.tabs.query) {
        // Firefox: 使用 Promise
        tabsAPI.query({ active: true, currentWindow: true })
          .then(tabs => {
            if (tabs && tabs.length) {
              handleTabs(tabs);
            } else {
              return tabsAPI.query({ active: true, lastFocusedWindow: true })
                .then(res => {
                  if (res && res.length) return handleTabs(res);
                  // 继续回退：不带窗口限制
                  return tabsAPI.query({ active: true }).then(list => {
                    if (list && list.length) return handleTabs(list);
                    // 最后回退：取所有标签第一页
                    return tabsAPI.query({}).then(all => {
                      if (all && all.length) return handleTabs(all);
                      sendResponse({ tab: null, error: 'no-active-tab' });
                    });
                  });
                });
            }
          })
          .catch(err => {
            console.error('[后台] getActiveTab 查询失败:', err);
            sendResponse({ tab: null, error: err.message || 'query-failed' });
          });
        return true;
      }

      // Chrome 回退：callback 形式
      tabsAPI.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError) {
          console.error('[后台] getActiveTab 查询失败:', chrome.runtime.lastError);
          sendResponse({ tab: null, error: chrome.runtime.lastError.message || 'query-failed' });
          return;
        }
        if (tabs && tabs.length) {
          handleTabs(tabs);
        } else {
          tabsAPI.query({ active: true, lastFocusedWindow: true }, (res) => {
            if (chrome.runtime.lastError) {
              sendResponse({ tab: null, error: chrome.runtime.lastError.message || 'query-failed' });
              return;
            }
            if (res && res.length) return handleTabs(res);
            tabsAPI.query({ active: true }, (list) => {
              if (chrome.runtime.lastError) {
                sendResponse({ tab: null, error: chrome.runtime.lastError.message || 'query-failed' });
                return;
              }
              if (list && list.length) return handleTabs(list);
              tabsAPI.query({}, (all) => {
                if (chrome.runtime.lastError) {
                  sendResponse({ tab: null, error: chrome.runtime.lastError.message || 'query-failed' });
                  return;
                }
                if (all && all.length) return handleTabs(all);
                sendResponse({ tab: null, error: 'no-active-tab' });
              });
            });
          });
        }
      });
      return true;
    } catch (error) {
      console.error('[后台] getActiveTab 异常:', error);
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
  
  alarmsAPI.create(syncAlarmName, {
    periodInMinutes: syncInterval / (60 * 1000)
  });
}

/**
 * 从云端同步到本地
 * @param {String} sceneId - 场景ID（可选）
 * @param {Boolean} skipDeviceDetection - 是否跳过设备检测（保存配置时使用，只注册设备不检测）
 * @param {Boolean} skipDeviceListSync - 是否跳过设备列表同步（刚注册设备后使用，避免覆盖）
 * @param {Boolean} clearLocalFirst - 是否先清空本地数据（非首次保存时使用）
 */
async function syncFromCloud(sceneId = null, skipDeviceDetection = false, skipDeviceListSync = false, clearLocalFirst = false) {
  try {
    const config = await storage.getConfig();
    if (!config || !config.serverUrl) {
      console.log('WebDAV配置未设置');
      return { success: false, skipped: true, error: 'WebDAV配置未设置' };
    }

    await ensureDeviceRegistered();

    // 如果非首次保存且需要清空本地数据，先清空本地书签、设备列表、设置
    // 必须在同步设置之前清空，确保使用新的云端内容
    if (clearLocalFirst) {
      console.log('[SYNC] 非首次保存，清空本地数据');
      // 清空书签
      await storage.saveBookmarks([], []);
      // 清空设备列表
      await storage.saveDevices([]);
      // 清空设置（但保留deviceInfo，因为它是本地生成的）
      await storage.saveSettings({});
    }

    // 先拉取云端设置，获取最新设备列表
    // skipDeviceListSync 为 true 时跳过设备列表同步（刚注册设备后避免覆盖）
    // forceClear 为 true 时，即使云端没有设置也清空本地设置和设备列表（非首次保存时使用）
    await syncSettingsFromCloud(skipDeviceListSync, clearLocalFirst);

    // 设备校验：严格模式，云端缺少当前设备则清理并停止；
    // 但对于"未知设备"一律跳过校验，避免在无法识别设备信息时误报。
    // 检查设备检测开关（默认关闭）
    // 注意：保存配置时跳过设备检测，只注册设备；设备检测仅在定时同步时进行
    const settings = await storage.getSettings();
    const deviceDetectionEnabled = settings?.deviceDetection?.enabled === true;
    
    // 设备校验：仅在设备检测开关开启时进行严格模式检测，云端缺少当前设备则清理并停止
    // 保存配置时（skipDeviceDetection=true）跳过设备检测，只注册设备
    if (deviceDetectionEnabled && !skipDeviceDetection) {
      let devices = await storage.getDevices();
      if (!devices || devices.length === 0) {
        // 云端空列表视为缺设备，清理并停
        const errorMsg = '当前设备未被授权，已清理本地数据并停止同步';
        await storage.clearAllData();
        await storage.saveSyncStatus({
          status: 'error',
          lastSync: Date.now(),
          error: errorMsg
        });
        await showSyncErrorNotification(errorMsg);
        return;
      }
      if (!devices.find(d => d.id === currentDevice.id)) {
        // 再次拉取确认，避免误判
        await syncSettingsFromCloud();
        devices = await storage.getDevices();
        if (!devices.find(d => d.id === currentDevice.id)) {
          const errorMsg = '当前设备未被授权，已清理本地数据并停止同步';
          await storage.clearAllData();
          await storage.saveSyncStatus({
            status: 'error',
            lastSync: Date.now(),
            error: errorMsg
          });
          await showSyncErrorNotification(errorMsg);
          return;
        }
      }
    }

    await storage.saveSyncStatus({
      status: 'syncing',
      lastSync: Date.now(),
      error: null
    });

    // 获取目标场景
    const currentSceneId = sceneId || await storage.getCurrentScene();
    console.log('[SYNC] syncFromCloud start', { sceneId: currentSceneId, clearLocalFirst });
    
    const webdav = new WebDAVClient(config);
    // 只同步当前场景的书签文件
    const cloudData = await webdav.readBookmarks(currentSceneId);
    
    // 获取所有本地书签
    const allBookmarks = await storage.getBookmarks();
    const localSceneBookmarks = (allBookmarks.bookmarks || []).filter(b => b.scene === currentSceneId);
    const otherSceneBookmarks = (allBookmarks.bookmarks || []).filter(b => b.scene !== currentSceneId);
    
    // 检查该场景是否已同步过
    const isSceneSynced = await storage.isSceneSynced(currentSceneId);

    // 云端文件缺失(404)的处理：避免误删本地数据
    if (cloudData && cloudData._notFound) {
      const hasLocal = localSceneBookmarks.length > 0;
      if (isSceneSynced || hasLocal) {
        const filePath = cloudData._filePath || `${currentSceneId}_bookmarks.json`;
        const errorMsg = `云端场景文件不存在（可能被删除）：${filePath}`;
        console.warn('[SYNC] cloud file missing -> fail', { sceneId: currentSceneId, isSceneSynced, localCount: localSceneBookmarks.length, filePath });

        await storage.saveSyncStatus({
          status: 'error',
          lastSync: Date.now(),
          error: errorMsg
        });
        await showSyncErrorNotification(errorMsg);
        return { success: false, error: errorMsg, code: 'CLOUD_FILE_MISSING' };
      } else {
        console.log('[SYNC] cloud file missing but scene not synced and local empty -> treat as empty', { sceneId: currentSceneId });
        // 尝试创建空文件，避免后续继续 404（如果失败，应视为同步失败，否则会误报成功）
        try {
          const r = await webdav.writeBookmarks({ bookmarks: [], folders: [] }, currentSceneId);
          console.log('[SYNC] created empty cloud file', { sceneId: currentSceneId, ok: !!r?.success });
        } catch (e) {
          const errorMsg = `云端场景文件不存在，且创建空文件失败：${e?.message || e}`;
          console.warn('[SYNC] create empty cloud file failed -> fail', { sceneId: currentSceneId, error: e?.message || e });
          await storage.saveSyncStatus({
            status: 'error',
            lastSync: Date.now(),
            error: errorMsg
          });
          await showSyncErrorNotification(errorMsg);
          return { success: false, error: errorMsg, code: 'CLOUD_FILE_CREATE_FAILED' };
        }
      }
    }

    const cleaned = normalizeData(cloudData.bookmarks || [], cloudData.folders || []);
    console.log('[SYNC] cloud data loaded', { sceneId: currentSceneId, cloudBookmarks: cleaned.bookmarks.length, cloudFolders: cleaned.folders.length });
    
    // 检查本地书签是否已经包含在云端书签中（避免重复合并）
    // 通过比较书签ID来判断是否已经合并过
    const cloudBookmarkIds = new Set((cleaned.bookmarks || []).map(b => b.id));
    const localBookmarkIds = new Set((localSceneBookmarks || []).map(b => b.id));
    
    // 检查本地书签是否已经与云端书签合并过
    // 如果本地书签的ID都在云端书签中，说明已经合并过，不需要再次归档
    const allLocalInCloud = localBookmarkIds.size > 0 && 
                            Array.from(localBookmarkIds).every(id => cloudBookmarkIds.has(id));
    
    if (!isSceneSynced && localSceneBookmarks.length > 0 && cleaned.bookmarks.length > 0) {
      // 首次同步：如果本地有书签且云端也有数据，需要归档本地书签
      // 但如果本地书签已经全部在云端（说明已经合并过），则不需要再次归档
      if (allLocalInCloud) {
        // 本地书签已经全部在云端，直接使用云端数据（避免重复合并）
        // 云端数据已经包含了所有本地书签，不需要再次归档
        const mergedBookmarks = [...otherSceneBookmarks, ...cleaned.bookmarks];
        const allFolders = [...new Set([
          ...(allBookmarks.folders || []),
          ...cleaned.folders
        ])];
        await storage.saveBookmarks(mergedBookmarks, allFolders);
      } else {
        // 需要归档：本地有书签不在云端（需要归档）
        const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // 如 20240115
        const archiveFolder = `本地_${timestamp}`;
        
        // 检查哪些本地书签需要归档（不在"本地_"开头的文件夹中，且不在云端的）
        const bookmarksToArchive = localSceneBookmarks.filter(b => {
          // 只归档不在云端的书签
          if (cloudBookmarkIds.has(b.id)) {
            return false; // 云端已有，不需要归档
          }
          const folder = b.folder || '';
          return !folder.startsWith('本地_') && !folder.match(/^本地_\d{8}/);
        });
        
        // 已经归档的书签（在任何"本地_xxx"文件夹中的）
        const alreadyArchivedBookmarks = localSceneBookmarks.filter(b => {
          const folder = b.folder || '';
          return folder.startsWith('本地_') || folder.match(/^本地_\d{8}/);
        });
        
        // 将需要归档的书签归档到"本地_时间戳"文件夹
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
          return mergedSceneBookmarks.some(b => {
            const bFolder = b.folder || '';
            return bFolder === f || (bFolder.startsWith(f + '/'));
          });
        });
        await syncToCloud(mergedSceneBookmarks, sceneFolders, currentSceneId);
      }
    } else {
      // 定时同步或首次同步无冲突：云端数据直接覆盖本地当前场景
      const mergedBookmarks = [...otherSceneBookmarks, ...cleaned.bookmarks];
      
      // 合并文件夹
      const allFolders = [...new Set([
        ...(allBookmarks.folders || []),
        ...cleaned.folders
      ])];
      
      // 保存数据（云端覆盖本地）
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
    runtimeAPI.sendMessage({ action: 'bookmarksUpdated' }).catch(() => {
      // 忽略错误，可能没有打开的页面
    });

    console.log('[SYNC] syncFromCloud success', { sceneId: currentSceneId });
    return { success: true };
    
  } catch (error) {
    console.error('同步失败:', error);
    await storage.saveSyncStatus({
      status: 'error',
      lastSync: Date.now(),
      error: error.message
    });
    
    // 显示同步失败通知
    // 注意：配置未设置的情况已经在上面直接return了，不会进入catch
    // 所以这里捕获的都是真正的同步失败（包括连接失败、网络错误等）
    await showSyncErrorNotification(error.message);
    return { success: false, error: error.message };
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
      // 没有配置WebDAV，直接返回，不通知
      console.log('WebDAV配置未设置，跳过同步');
      return;
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
    
    // 合并文件夹：从书签中提取的文件夹 + 传入的文件夹列表（确保空文件夹也能同步）
    const bookmarkFolders = [...new Set(sceneBookmarks.map(b => b.folder).filter(Boolean))];
    const passedFolders = cleaned.folders || [];
    // 合并并去重，确保空文件夹也能同步到云端
    const sceneFolders = [...new Set([...bookmarkFolders, ...passedFolders])];
    
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
    
    // 显示同步失败通知
    // 注意：配置未设置的情况已经在上面直接return了，不会进入catch
    // 所以这里捕获的都是真正的同步失败（包括连接失败、网络错误等）
    await showSyncErrorNotification(error.message);
    
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
  
  // 注意：不在这里添加设备到列表，由 ensureDeviceInCloud() 统一处理
  // 这样可以确保先从云端拉取最新列表，避免覆盖云端已有的设备
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
    // 优先使用 platformInfo（兼容 MV2/MV3）
    const platformInfoAPI = (typeof browser !== 'undefined' && browser.runtime && browser.runtime.getPlatformInfo) 
      ? browser.runtime 
      : (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getPlatformInfo) 
        ? chrome.runtime 
        : null;
    
    if (platformInfoAPI && platformInfoAPI.getPlatformInfo) {
      let platform;
      if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.getPlatformInfo) {
        // Firefox: 使用 Promise
        platform = await browser.runtime.getPlatformInfo();
      } else {
        // Chrome: 使用回调（兼容 MV2/MV3）
        platform = await new Promise(resolve => {
          chrome.runtime.getPlatformInfo(resolve);
        });
      }
      
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
    // 优先使用 platformInfo（更可靠，兼容 MV2/MV3）
    const platformInfoAPI = (typeof browser !== 'undefined' && browser.runtime && browser.runtime.getPlatformInfo) 
      ? browser.runtime 
      : (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getPlatformInfo) 
        ? chrome.runtime 
        : null;
    
    if (platformInfoAPI && platformInfoAPI.getPlatformInfo) {
      let platform;
      if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.getPlatformInfo) {
        // Firefox: 使用 Promise
        platform = await browser.runtime.getPlatformInfo();
      } else {
        // Chrome: 使用回调（兼容 MV2/MV3）
        platform = await new Promise(resolve => {
          chrome.runtime.getPlatformInfo(resolve);
        });
      }
      
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

