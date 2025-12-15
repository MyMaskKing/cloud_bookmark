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
   */
  async saveBookmarks(bookmarks, folders) {
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

  /**
   * 从本地读取书签数据
   */
  async getBookmarks() {
    return new Promise((resolve, reject) => {
      this.storage.get([this.bookmarksKey], (result) => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          const data = result[this.bookmarksKey] || { bookmarks: [], folders: [] };
          resolve(data);
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
}

// 导出供其他模块使用
if (typeof module !== 'undefined' && module.exports) {
  module.exports = StorageManager;
}

