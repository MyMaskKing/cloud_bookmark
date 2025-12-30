/**
 * 本地存储管理工具
 * 使用chrome.storage或browser.storage进行数据存储
 */

class StorageManager {
  constructor() {
    // 检测浏览器API
    this.storage = typeof chrome !== 'undefined' && chrome.storage 
      ? chrome.storage.local 
      : browser.storage.local;
    
    // 检测runtime API
    this.runtime = typeof chrome !== 'undefined' && chrome.runtime
      ? chrome.runtime
      : browser.runtime;
    
    this.bookmarksKey = 'bookmarks';
    this.configKey = 'webdavConfig';
    this.syncStatusKey = 'syncStatus';
    this.pendingChangesKey = 'pendingChanges';
    this.devicesKey = 'devices';
    this.deviceInfoKey = 'deviceInfo';
    this.settingsKey = 'settings'; // 非敏感设置
    this.scenesKey = 'scenes'; // 场景列表
    this.currentSceneKey = 'currentScene'; // 当前选中场景
    this.syncedScenesKey = 'syncedScenes'; // 已完成云端同步的场景列表
  }
  
  /**
   * 检查是否有错误
   */
  hasError() {
    return this.runtime.lastError !== undefined && this.runtime.lastError !== null;
  }
  
  /**
   * 获取错误消息
   */
  getError() {
    return this.hasError() ? this.runtime.lastError.message : null;
  }

  /**
   * 保存书签数据到本地
   * @param {Array} bookmarks - 书签数组（应包含scene字段）
   * @param {Array} folders - 文件夹数组
   * @param {String} sceneId - 场景ID（可选，用于兼容旧数据）
   */
  async saveBookmarks(bookmarks, folders, sceneId = null) {
    // 如果提供了sceneId，为所有书签添加scene字段
    if (sceneId && bookmarks) {
      bookmarks = bookmarks.map(b => ({ ...b, scene: b.scene || sceneId }));
    }
    
    // 检测传入的书签是否属于同一个场景
    let targetSceneId = null;
    if (bookmarks && bookmarks.length > 0) {
      // 检查所有书签的scene字段是否一致
      const scenes = [...new Set(bookmarks.map(b => b.scene).filter(Boolean))];
      if (scenes.length === 1) {
        targetSceneId = scenes[0];
      }
    } else if (sceneId) {
      // 如果书签数组为空但提供了sceneId，也使用合并模式（用于清空某个场景）
      targetSceneId = sceneId;
    }
    
    // 如果确定是某个场景的书签，需要合并而不是覆盖
    if (targetSceneId) {
      // 读取所有场景的书签
      const allData = await this.getBookmarks();
      const allBookmarks = allData.bookmarks || [];
      
      // 移除该场景的旧书签，保留其他场景的书签
      const otherSceneBookmarks = allBookmarks.filter(b => b.scene !== targetSceneId);
      
      // 合并书签：其他场景的书签 + 当前场景的新书签
      const mergedBookmarks = [...otherSceneBookmarks, ...(bookmarks || [])];
      
      // 合并文件夹列表：收集所有场景的文件夹
      const otherSceneFolders = otherSceneBookmarks.map(b => b.folder).filter(Boolean);
      const allFoldersSet = new Set([...otherSceneFolders, ...(folders || [])]);
      const mergedFolders = [...allFoldersSet].filter(Boolean);
      
      const data = {
        bookmarks: mergedBookmarks,
        folders: mergedFolders,
        lastSync: Date.now()
      };

      return new Promise((resolve, reject) => {
        this.storage.set({ [this.bookmarksKey]: data }, () => {
          if (this.hasError()) {
            reject(new Error(this.getError()));
          } else {
            resolve(data);
          }
        });
      });
    } else {
      // 如果无法确定场景，或者书签来自多个场景，直接保存（覆盖模式，用于初始化或全量更新）
      const data = {
        bookmarks: bookmarks || [],
        folders: folders || [],
        lastSync: Date.now()
      };

      return new Promise((resolve, reject) => {
        this.storage.set({ [this.bookmarksKey]: data }, () => {
          if (this.hasError()) {
            reject(new Error(this.getError()));
          } else {
            resolve(data);
          }
        });
      });
    }
  }

  /**
   * 从本地读取书签数据
   * @param {String} sceneId - 场景ID（可选，如果提供则只返回该场景的书签）
   */
  async getBookmarks(sceneId = null) {
    return new Promise((resolve, reject) => {
      this.storage.get([this.bookmarksKey], (result) => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          const data = result[this.bookmarksKey] || { bookmarks: [], folders: [] };
          
          // 如果指定了场景ID，过滤书签和文件夹
          if (sceneId) {
            const filteredBookmarks = (data.bookmarks || []).filter(b => b.scene === sceneId);
            const filteredFolders = [...new Set(filteredBookmarks.map(b => b.folder).filter(Boolean))];
            resolve({
              bookmarks: filteredBookmarks,
              folders: filteredFolders,
              lastSync: data.lastSync
            });
          } else {
            resolve(data);
          }
        }
      });
    });
  }

  /**
   * 保存WebDAV配置
   */
  async saveConfig(config) {
    return new Promise((resolve, reject) => {
      this.storage.set({ [this.configKey]: config }, () => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          resolve(config);
        }
      });
    });
  }

  /**
   * 获取WebDAV配置
   */
  async getConfig() {
    return new Promise((resolve, reject) => {
      this.storage.get([this.configKey], (result) => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          resolve(result[this.configKey] || null);
        }
      });
    });
  }

  /**
   * 保存同步状态
   */
  async saveSyncStatus(status) {
    return new Promise((resolve, reject) => {
      this.storage.set({ [this.syncStatusKey]: status }, () => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          resolve(status);
        }
      });
    });
  }

  /**
   * 获取同步状态
   */
  async getSyncStatus() {
    return new Promise((resolve, reject) => {
      this.storage.get([this.syncStatusKey], (result) => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          resolve(result[this.syncStatusKey] || { 
            lastSync: null, 
            status: 'idle', 
            error: null 
          });
        }
      });
    });
  }

  /**
   * 添加待同步的变更
   */
  async addPendingChange(change) {
    const pending = await this.getPendingChanges();
    pending.push({
      ...change,
      timestamp: Date.now()
    });
    
    return new Promise((resolve, reject) => {
      this.storage.set({ [this.pendingChangesKey]: pending }, () => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          resolve(pending);
        }
      });
    });
  }

  /**
   * 获取待同步的变更
   */
  async getPendingChanges() {
    return new Promise((resolve, reject) => {
      this.storage.get([this.pendingChangesKey], (result) => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          resolve(result[this.pendingChangesKey] || []);
        }
      });
    });
  }

  /**
   * 清空待同步的变更
   */
  async clearPendingChanges() {
    return new Promise((resolve, reject) => {
      this.storage.set({ [this.pendingChangesKey]: [] }, () => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * 生成唯一ID
   */
  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }

  /**
   * 获取设备列表
   */
  async getDevices() {
    return new Promise((resolve, reject) => {
      this.storage.get([this.devicesKey], (result) => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          resolve(result[this.devicesKey] || []);
        }
      });
    });
  }

  /**
   * 保存设备列表
   */
  async saveDevices(devices) {
    return new Promise((resolve, reject) => {
      this.storage.set({ [this.devicesKey]: devices }, () => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          resolve(devices);
        }
      });
    });
  }

  /**
   * 获取当前设备信息
   */
  async getDeviceInfo() {
    return new Promise((resolve, reject) => {
      this.storage.get([this.deviceInfoKey], (result) => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          resolve(result[this.deviceInfoKey] || null);
        }
      });
    });
  }

  /**
   * 保存当前设备信息
   */
  async saveDeviceInfo(info) {
    return new Promise((resolve, reject) => {
      this.storage.set({ [this.deviceInfoKey]: info }, () => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          resolve(info);
        }
      });
    });
  }

  /**
   * 保存非敏感设置
   */
  async saveSettings(settings) {
    return new Promise((resolve, reject) => {
      this.storage.set({ [this.settingsKey]: settings }, () => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          resolve(settings);
        }
      });
    });
  }

  /**
   * 获取非敏感设置
   */
  async getSettings() {
    return new Promise((resolve, reject) => {
      this.storage.get([this.settingsKey], (result) => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          resolve(result[this.settingsKey] || {});
        }
      });
    });
  }

  /**
   * 清空本地书签相关数据
   */
  async clearLocalData() {
    return new Promise((resolve, reject) => {
      this.storage.remove([this.bookmarksKey, this.pendingChangesKey], () => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * 清空本地所有数据（包括配置/设备/设置/场景）
   */
  async clearAllData() {
    const keys = [
      this.bookmarksKey,
      this.pendingChangesKey,
      this.configKey,
      this.devicesKey,
      this.deviceInfoKey,
      this.settingsKey,
      this.scenesKey,
      this.currentSceneKey,
      this.syncStatusKey,
      this.syncedScenesKey
    ];
    return new Promise((resolve, reject) => {
      this.storage.remove(keys, () => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * 获取场景列表
   */
  async getScenes() {
    return new Promise((resolve, reject) => {
      this.storage.get([this.scenesKey], (result) => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          const scenes = result[this.scenesKey];
          // 如果没有场景，初始化默认场景
          if (!scenes || !Array.isArray(scenes) || scenes.length === 0) {
            const defaultScenes = [
              { id: 'home', name: '家庭', isDefault: true, createdAt: Date.now(), updatedAt: Date.now() },
              { id: 'work', name: '公司', isDefault: true, createdAt: Date.now(), updatedAt: Date.now() }
            ];
            this.saveScenes(defaultScenes).then(() => resolve(defaultScenes)).catch(reject);
          } else {
            resolve(scenes);
          }
        }
      });
    });
  }

  /**
   * 保存场景列表
   */
  async saveScenes(scenes) {
    return new Promise((resolve, reject) => {
      this.storage.set({ [this.scenesKey]: scenes }, () => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          resolve(scenes);
        }
      });
    });
  }

  /**
   * 获取当前选中场景
   */
  async getCurrentScene() {
    return new Promise((resolve, reject) => {
      this.storage.get([this.currentSceneKey], (result) => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          const currentScene = result[this.currentSceneKey];
          // 如果没有当前场景，默认使用第一个场景
          if (!currentScene) {
            this.getScenes().then(scenes => {
              const defaultScene = scenes[0]?.id || 'home';
              this.saveCurrentScene(defaultScene).then(() => resolve(defaultScene)).catch(reject);
            }).catch(reject);
          } else {
            resolve(currentScene);
          }
        }
      });
    });
  }

  /**
   * 保存当前选中场景
   */
  async saveCurrentScene(sceneId) {
    return new Promise((resolve, reject) => {
      this.storage.set({ [this.currentSceneKey]: sceneId }, () => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          resolve(sceneId);
        }
      });
    });
  }

  /**
   * 添加场景
   */
  async addScene(scene) {
    const scenes = await this.getScenes();
    // 检查ID是否已存在
    if (scenes.find(s => s.id === scene.id)) {
      throw new Error('场景ID已存在');
    }
    scenes.push({
      ...scene,
      createdAt: scene.createdAt || Date.now(),
      updatedAt: Date.now()
    });
    return await this.saveScenes(scenes);
  }

  /**
   * 更新场景
   */
  async updateScene(sceneId, updates) {
    const scenes = await this.getScenes();
    const index = scenes.findIndex(s => s.id === sceneId);
    if (index === -1) {
      throw new Error('场景不存在');
    }
    scenes[index] = {
      ...scenes[index],
      ...updates,
      updatedAt: Date.now()
    };
    return await this.saveScenes(scenes);
  }

  /**
   * 删除场景
   */
  async deleteScene(sceneId) {
    const scenes = await this.getScenes();
    // 检查是否是默认场景
    const scene = scenes.find(s => s.id === sceneId);
    if (scene && scene.isDefault) {
      throw new Error('默认场景不能删除');
    }
    const filtered = scenes.filter(s => s.id !== sceneId);
    // 同时从已同步列表中移除
    await this.removeSyncedScene(sceneId);
    return await this.saveScenes(filtered);
  }

  /**
   * 获取已同步的场景列表
   */
  async getSyncedScenes() {
    return new Promise((resolve, reject) => {
      this.storage.get([this.syncedScenesKey], (result) => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          resolve(result[this.syncedScenesKey] || []);
        }
      });
    });
  }

  /**
   * 检查场景是否已同步过
   */
  async isSceneSynced(sceneId) {
    const syncedScenes = await this.getSyncedScenes();
    return syncedScenes.includes(sceneId);
  }

  /**
   * 标记场景为已同步
   */
  async addSyncedScene(sceneId) {
    const syncedScenes = await this.getSyncedScenes();
    if (!syncedScenes.includes(sceneId)) {
      syncedScenes.push(sceneId);
      return new Promise((resolve, reject) => {
        this.storage.set({ [this.syncedScenesKey]: syncedScenes }, () => {
          if (this.hasError()) {
            reject(new Error(this.getError()));
          } else {
            resolve(syncedScenes);
          }
        });
      });
    }
    return syncedScenes;
  }

  /**
   * 移除场景的已同步标记
   */
  async removeSyncedScene(sceneId) {
    const syncedScenes = await this.getSyncedScenes();
    const filtered = syncedScenes.filter(id => id !== sceneId);
    return new Promise((resolve, reject) => {
      this.storage.set({ [this.syncedScenesKey]: filtered }, () => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          resolve(filtered);
        }
      });
    });
  }

  /**
   * 清空已同步场景列表（WebDAV配置变更时调用）
   */
  async clearSyncedScenes() {
    return new Promise((resolve, reject) => {
      this.storage.set({ [this.syncedScenesKey]: [] }, () => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          resolve([]);
        }
      });
    });
  }
}

// 导出供其他模块使用
if (typeof module !== 'undefined' && module.exports) {
  module.exports = StorageManager;
}

