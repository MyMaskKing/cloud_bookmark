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
    this.browserSyncStatusKey = 'browserSyncStatus';
    this.pendingChangesKey = 'pendingChanges';
    this.devicesKey = 'devices';
    this.deviceInfoKey = 'deviceInfo';
    this.settingsKey = 'settings'; // 非敏感设置
    this.scenesKey = 'scenes'; // 场景列表
    this.currentSceneKey = 'currentScene'; // 当前选中场景
    this.syncedScenesKey = 'syncedScenes'; // 已完成云端同步的场景列表
    this.sceneFoldersKey = 'sceneFolders'; // 每个场景的文件夹列表（用于保存空文件夹）
    this.sceneFolderMetaKey = 'sceneFolderMeta'; // 每个场景的文件夹主键映射与顺序（folderId -> path）
    this.sceneBookmarkMetaKey = 'sceneBookmarkMeta'; // 每个场景的书签排序元数据（bookmarkId 顺序）

    // 浏览器原生书签定时同步（browser -> cloud）的失败控制（本地-only，不同步到云端）
    this.browserBookmarkSyncFailureKey = 'browserBookmarkSyncFailure';
  }

  getDefaultSettings() {
    return {
      floatingBall: {
        enabled: true, // 默认开启悬浮球
        defaultPosition: 'auto',
        clickAction: 'popup'
      },
      developerSettings: {
        enableConsoleLogging: false // 默认关闭开发者控制台日志
      }
    };
  }

  mergeSettingsWithDefaults(settings) {
    const s = settings || {};
    const d = this.getDefaultSettings();
    return {
      ...d,
      ...s,
      floatingBall: {
        ...(d.floatingBall || {}),
        ...(s.floatingBall || {})
      },
      developerSettings: {
        ...(d.developerSettings || {}),
        ...(s.developerSettings || {})
      }
    };
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
    // 如果明确提供了 sceneId 参数，优先使用它（用于同步时明确指定场景）
    if (sceneId) {
      targetSceneId = sceneId;
    } else if (bookmarks && bookmarks.length > 0) {
      // 如果没有提供 sceneId，检查所有书签的scene字段是否一致
      const scenes = [...new Set(bookmarks.map(b => b.scene).filter(Boolean))];
      if (scenes.length === 1) {
        targetSceneId = scenes[0];
      }
    }
    
    // 如果确定是某个场景的书签，需要合并而不是覆盖
    if (targetSceneId) {
      const bookmarkKey = (b) => {
        const s = b?.scene || targetSceneId;
        // 使用 scene+id 作为去重键，避免不同场景同 id 覆盖彼此
        return `${s}::${b?.id}`;
      };

      // 读取所有场景的书签
      const allData = await this.getBookmarks();
      const allBookmarks = allData.bookmarks || [];
      
      // 移除该场景的旧书签，保留其他场景的书签
      // 注意：只保留明确属于其他场景的书签（有 scene 字段且不等于 targetSceneId）
      // 如果书签没有 scene 字段，说明是旧数据，应该被保留并添加 scene 字段（兼容旧数据）
      const otherSceneBookmarks = allBookmarks.filter(b => {
        // 如果书签没有 scene 字段，移除它（旧数据会被 bookmarks 参数中的书签覆盖，如果 bookmarks 中没有则会被丢失）
        // 但为了安全，我们保留它，让 Map 去重逻辑处理
        if (!b.scene) return false;
        // 如果书签的 scene 字段不等于 targetSceneId，保留它（其他场景的书签）
        return b.scene !== targetSceneId;
      });
      
      // 合并书签：其他场景的书签 + 当前场景的新书签
      // 使用 Map 按 ID 去重，避免重复（保留最后出现的书签，即当前场景的书签）
      const bookmarkMap = new Map();
      // 先添加其他场景的书签
      otherSceneBookmarks.forEach(b => {
        bookmarkMap.set(bookmarkKey(b), b);
      });
      // 再添加当前场景的新书签（会覆盖同 ID 的书签，避免重复）
      // 注意：bookmarks 参数中的书签应该已经通过第54行添加了 scene 字段
      (bookmarks || []).forEach(b => {
        // 确保书签有 scene 字段（防御性编程）
        const bookmarkWithScene = b.scene ? b : { ...b, scene: targetSceneId };
        bookmarkMap.set(bookmarkKey(bookmarkWithScene), bookmarkWithScene);
      });
      const mergedBookmarks = Array.from(bookmarkMap.values());
      
      // 合并文件夹列表：
      // 1. 从其他场景的书签中提取文件夹（只保留其他场景实际使用的文件夹）
      const otherSceneFolders = otherSceneBookmarks.map(b => b.folder).filter(Boolean);
      // 2. 从当前场景的书签中提取文件夹（确保只包含当前场景实际使用的文件夹）
      const currentSceneBookmarkFolders = (bookmarks || []).map(b => b.folder).filter(Boolean);
      
      // 格式化当前场景的书签字段顺序
      const formattedCurrentSceneBookmarks = (bookmarks || []).map(b => this.formatBookmarkJSON(b.scene ? b : { ...b, scene: targetSceneId }));

      // 3. 合并：其他场景实际使用的文件夹 + 当前场景传入的文件夹（可能包含空文件夹）+ 当前场景书签中的文件夹
      // 注意：传入的 folders 参数应该只包含当前场景的文件夹（包括空文件夹），这样每个场景的文件夹是隔离的
      const allFoldersSet = new Set([...otherSceneFolders, ...(folders || []), ...currentSceneBookmarkFolders]);
      const mergedFolders = [...allFoldersSet].filter(Boolean);
      
      // 保存当前场景的文件夹列表（包括空文件夹）到场景特定的存储中
      console.log('[Storage] saveSceneFolders', { sceneId: targetSceneId, folders: folders || [] });
      await this.saveSceneFolders(targetSceneId, folders || []);
      
      // 文件夹顺序：尊重合并后的顺序并补全层级
      const sortedFolders = this.expandFolderPathsPreserveOrder([...new Set(mergedFolders)]);

      // 文件夹顺序：尊重合并后的顺序并补全层级
      const sortedFolderPathStrings = this.expandFolderPathsPreserveOrder([...new Set(mergedFolders)]);
      const sortedFolderObjects = await this.formatFoldersForStorage(sortedFolderPathStrings, targetSceneId);

      const data = {
        bookmarks: this.bindFolderIdsToBookmarks(
          this.sortBookmarksByHierarchy(mergedBookmarks.map(b => this.formatBookmarkJSON(b)), sortedFolderPathStrings),
          sortedFolderObjects
        ),
        folders: sortedFolderObjects,
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
      const sortedFolderPathStrings = this.expandFolderPathsPreserveOrder([...new Set(folders || [])]);
      const sortedFolderObjects = await this.formatFoldersForStorage(sortedFolderPathStrings, targetSceneId || 'home');

      // 如果无法确定场景，或者书签来自多个场景，直接保存（覆盖模式，用于初始化或全量更新）
      const data = {
        bookmarks: this.bindFolderIdsToBookmarks(
          (bookmarks || []).map(b => this.formatBookmarkJSON(b)),
          sortedFolderObjects
        ),
        folders: sortedFolderObjects,
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
            // 从书签中提取文件夹（只保留当前场景实际使用的文件夹）
            const bookmarkFolders = [...new Set(filteredBookmarks.map(b => b.folder).filter(Boolean))];
            // 获取该场景保存的文件夹列表（包括空文件夹）
            // 注意：getSceneFolders 只返回当前场景的文件夹，不包含其他场景的文件夹
            this.getSceneFolders(sceneId).then(sceneFolders => {
              console.log('[Storage] getBookmarks - sceneFolders loaded', { 
                sceneId, 
                sceneFolders, 
                bookmarkFolders 
              });
              // 确保 sceneFolders 只包含当前场景的文件夹（防御性编程）
              // 合并：场景保存的文件夹（包括空文件夹）+ 从书签中提取的文件夹
              // 先保留场景保存的文件夹（保持顺序，包括空文件夹），然后添加从书签中提取的文件夹
              const sceneFoldersSet = new Set(sceneFolders);
              const missingBookmarkFolders = bookmarkFolders.filter(f => f && !sceneFoldersSet.has(f));
              const allSceneFolders = [...sceneFolders, ...missingBookmarkFolders];
              console.log('[Storage] getBookmarks - merged folders', { 
                sceneId, 
                allSceneFolders 
              });
              // 不排序，保持文件夹的创建顺序（包括空文件夹）
              // 确保返回的 folders 只包含当前场景的文件夹
              resolve({
                bookmarks: filteredBookmarks,
                folders: allSceneFolders, // 只包含当前场景的文件夹
                lastSync: data.lastSync
              });
            }).catch(reject);
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
   * 保存浏览器原生书签定时同步状态（browser -> cloud）
   */
  async saveBrowserSyncStatus(status) {
    return new Promise((resolve, reject) => {
      this.storage.set({ [this.browserSyncStatusKey]: status }, () => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          resolve(status);
        }
      });
    });
  }

  /**
   * 获取浏览器原生书签定时同步状态（browser -> cloud）
   */
  async getBrowserSyncStatus() {
    return new Promise((resolve, reject) => {
      this.storage.get([this.browserSyncStatusKey], (result) => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          resolve(result[this.browserSyncStatusKey] || {
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
   * 生成唯一ID，支持前缀 (b_ 书签, f_ 文件夹)
   * 采用 16 位随机字符，确保全局唯一性和跨设备碰撞概率极低
   * @param {string} prefix - 前缀
   */
  generateId(prefix = '') {
    const random = Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
    return prefix + random.substring(0, 16);
  }

  generateBookmarkId() {
    return this.generateId('b_');
  }

  generateFolderId() {
    return this.generateId('f_');
  }

  /**
   * 生成稳定的文件夹 ID（基于路径和场景哈希）
   * 确保多端对同一路径生成相同的 ID，提升同步稳定性
   */
  generateStableFolderId(path, sceneId) {
    if (!path) return this.generateFolderId();
    const str = `${sceneId || 'default'}_${path}`;
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(31, h) + str.charCodeAt(i) | 0;
    }
    const hashStr = Math.abs(h).toString(36);
    return `f_${hashStr}`;
  }

  /**
   * 尊重原始先后顺序的层级展开
   * 确保父文件夹在子文件夹之前，同时保持传入数组中的相对顺序（兄弟节点顺序）
   */
  expandFolderPathsPreserveOrder(paths) {
    const nodes = new Map(); // path -> { children: [], firstIdx: number }
    const roots = [];

    const getOrCreate = (path) => {
      if (!nodes.has(path)) {
        nodes.set(path, { path, children: [], firstIdx: Infinity });
      }
      return nodes.get(path);
    };

    (paths || []).forEach((p, idx) => {
      const n = (typeof p === 'string' ? p : (p.path || '')).replace(/^\/+/, '').replace(/\/+$/, '');
      if (!n) return;
      
      const parts = n.split('/').filter(Boolean);
      let cur = '';
      let parentNode = null;
      for (const part of parts) {
        cur = cur ? `${cur}/${part}` : part;
        const node = getOrCreate(cur);
        if (idx < node.firstIdx) node.firstIdx = idx;

        if (parentNode) {
          if (!parentNode.children.includes(cur)) parentNode.children.push(cur);
        } else {
          if (!roots.includes(cur)) roots.push(cur);
        }
        parentNode = node;
      }
    });

    const out = [];
    const traverse = (path) => {
      out.push(path);
      const node = nodes.get(path);
      if (node && node.children.length > 0) {
        // 同级子文件夹按首次出现顺序排序
        [...node.children]
          .sort((a, b) => nodes.get(a).firstIdx - nodes.get(b).firstIdx)
          .forEach(traverse);
      }
    };

    // 顶级文件夹按首次出现顺序排序
    roots.sort((a, b) => nodes.get(a).firstIdx - nodes.get(b).firstIdx).forEach(traverse);

    return out;
  }

  /**
   * 按照文件夹列表的物理顺序对书签进行排序
   * 确保云端 JSON 中对应的书签位置与文件夹顺序一致
   */
  sortBookmarksByHierarchy(bookmarks, folderOrder = []) {
    if (!bookmarks || !Array.isArray(bookmarks)) return [];
    const folderToIndex = new Map();
    (folderOrder || []).forEach((f, idx) => {
      const path = typeof f === 'string' ? f : (f.path || '');
      folderToIndex.set(path, idx);
    });

    return [...bookmarks].sort((a, b) => {
      const folderA = a.folder || "";
      const folderB = b.folder || "";
      const idxA = folderToIndex.has(folderA) ? folderToIndex.get(folderA) : -1;
      const idxB = folderToIndex.has(folderB) ? folderToIndex.get(folderB) : -1;

      if (idxA !== idxB) {
        return idxA - idxB;
      }
      return (a.order || 0) - (b.order || 0);
    });
  }

  /**
   * 将文件夹路径列表格式化为带 ID 和 Order 的对象数组
   */
  async formatFoldersForStorage(folderPaths, sceneId) {
    const meta = await this.getSceneFolderMeta(sceneId);
    const byId = meta && meta.byId ? meta.byId : {};
    
    // 建立 path -> id 反向索引
    const pathToId = new Map();
    Object.keys(byId).forEach(id => {
      if (byId[id].path) pathToId.set(byId[id].path, id);
    });

    const result = [];
    (folderPaths || []).forEach((path, index) => {
      let id = pathToId.get(path);
      if (!id) {
        id = this.generateStableFolderId(path, sceneId);
      }
      const name = path.includes('/') ? path.split('/').pop() : path;
      result.push({
        id: id,
        name: name,
        path: path,
        order: index
      });
    });
    return result;
  }

  /**
   * 给书签绑定对应的 folderId
   * 通过比对文件夹名字（路径），将最终生成的文件夹 ID 赋值给对应的书签
   */
  bindFolderIdsToBookmarks(bookmarks, foldersObjects) {
    if (!bookmarks || !Array.isArray(bookmarks)) return [];
    const folderPathToId = new Map();
    (foldersObjects || []).forEach(f => {
      if (f.path && f.id) {
        folderPathToId.set(f.path, f.id);
      }
    });

    return bookmarks.map(b => {
      const updated = { ...b };
      if (updated.folder && folderPathToId.has(updated.folder)) {
        updated.folderId = folderPathToId.get(updated.folder);
      } else if (!updated.folder || updated.folder.trim() === '') {
        updated.folderId = '';
        updated.folder = '';
      }
      return updated;
    });
  }

  /**
   * 按照用户强制要求的顺序格式化书签数据
   * 确保保存到本地和上传到云端时，JSON 字段顺序保持一致
   */
  formatBookmarkJSON(b) {
    if (!b || typeof b !== 'object') return b;
    return {
      createdAt: b.createdAt || Date.now(),
      id: b.id || this.generateBookmarkId(),
      title: b.title || "",
      url: b.url || "",
      description: b.description || "",
      favicon: b.favicon || "",
      folder: b.folder || "",
      folderId: b.folderId || "",
      scene: b.scene || "home",
      starred: !!b.starred,
      tags: Array.isArray(b.tags) ? b.tags : [],
      notes: b.notes || "",
      order: typeof b.order === 'number' ? b.order : 0,
      updatedAt: b.updatedAt || Date.now()
    };
  }

  /**
   * 保存场景的文件夹主键元数据（folderId 作为主键）
   * @param {String} sceneId
   * @param {{ order?: string[], byId?: Record<string, { path: string }> }} meta
   */
  async saveSceneFolderMeta(sceneId, meta) {
    return new Promise((resolve, reject) => {
      this.storage.get([this.sceneFolderMetaKey], (result) => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
          return;
        }
        const all = result[this.sceneFolderMetaKey] || {};
        all[sceneId] = meta || { order: [], byId: {} };
        this.storage.set({ [this.sceneFolderMetaKey]: all }, () => {
          if (this.hasError()) reject(new Error(this.getError()));
          else resolve(all[sceneId]);
        });
      });
    });
  }

  /**
   * 获取场景的文件夹主键元数据（folderId 作为主键）
   * @param {String} sceneId
   * @returns {{ order: string[], byId: Record<string, { path: string }> }}
   */
  async getSceneFolderMeta(sceneId) {
    return new Promise((resolve, reject) => {
      this.storage.get([this.sceneFolderMetaKey], (result) => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          const all = result[this.sceneFolderMetaKey] || {};
          const m = all[sceneId] || { order: [], byId: {} };
          resolve({
            order: Array.isArray(m.order) ? m.order : [],
            byId: m.byId && typeof m.byId === 'object' ? m.byId : {}
          });
        }
      });
    });
  }

  /**
   * 保存场景的书签排序元数据（bookmarkId 作为主键）
   * @param {String} sceneId
   * @param {{ order?: string[] }} meta
   */
  async saveSceneBookmarkMeta(sceneId, meta) {
    return new Promise((resolve, reject) => {
      this.storage.get([this.sceneBookmarkMetaKey], (result) => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
          return;
        }
        const all = result[this.sceneBookmarkMetaKey] || {};
        all[sceneId] = meta || { order: [] };
        this.storage.set({ [this.sceneBookmarkMetaKey]: all }, () => {
          if (this.hasError()) reject(new Error(this.getError()));
          else resolve(all[sceneId]);
        });
      });
    });
  }

  /**
   * 获取场景的书签排序元数据（bookmarkId 作为主键）
   * @param {String} sceneId
   * @returns {{ order: string[] }}
   */
  async getSceneBookmarkMeta(sceneId) {
    return new Promise((resolve, reject) => {
      this.storage.get([this.sceneBookmarkMetaKey], (result) => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          const all = result[this.sceneBookmarkMetaKey] || {};
          const m = all[sceneId] || { order: [] };
          resolve({ order: Array.isArray(m.order) ? m.order : [] });
        }
      });
    });
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
          resolve(this.mergeSettingsWithDefaults(result[this.settingsKey] || {}));
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
   * 清空本地书签缓存（保留 WebDAV 配置/设备/设置/场景）。
   * 用于「忘记本地密码 → 重置」时清除可能被泄露的明文书签内容；
   * 用户重新登录 WebDAV 后再次同步即可拉回云端书签。
   */
  async clearLocalBookmarkCache() {
    const keys = [
      this.bookmarksKey,
      this.pendingChangesKey,
      this.syncStatusKey,
      this.sceneBookmarkMetaKey
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
      this.browserSyncStatusKey,
      this.syncedScenesKey,
      this.sceneFoldersKey,
      this.browserBookmarkSyncFailureKey
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
    // 删除该场景的文件夹列表
    await this.deleteSceneFolders(sceneId);
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

  /**
   * 获取浏览器原生书签定时同步（browser -> cloud）的失败控制状态
   * @returns {{ consecutiveFailures: number, disabled: boolean, disabledSignature: string|null, lastFailureAt: number|null, lastError: string|null }}
   */
  async getBrowserBookmarkSyncFailureState() {
    return new Promise((resolve, reject) => {
      this.storage.get([this.browserBookmarkSyncFailureKey], (result) => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          const s = result[this.browserBookmarkSyncFailureKey] || {};
          resolve({
            consecutiveFailures: typeof s.consecutiveFailures === 'number' ? s.consecutiveFailures : 0,
            disabled: !!s.disabled,
            disabledSignature: s.disabledSignature || null,
            lastFailureAt: s.lastFailureAt || null,
            lastError: s.lastError || null
          });
        }
      });
    });
  }

  /**
   * 重置浏览器原生书签定时同步失败控制状态
   * @param {string} signature - 当前 WebDAV 配置签名（用于区分配置变更）
   */
  async resetBrowserBookmarkSyncFailureState(signature) {
    return new Promise((resolve, reject) => {
      this.storage.set({
        [this.browserBookmarkSyncFailureKey]: {
          consecutiveFailures: 0,
          disabled: false,
          disabledSignature: signature || null,
          lastFailureAt: null,
          lastError: null
        }
      }, () => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * 记录一次浏览器原生书签定时同步失败，并在失败累计到阈值后禁用
   * @param {string} errorMsg
   * @param {string} signature - 当前 WebDAV 配置签名
   * @param {number} maxFailures - 失败阈值
   * @returns {{ disabled: boolean, consecutiveFailures: number }}
   */
  async recordBrowserBookmarkSyncFailure(errorMsg, signature, maxFailures) {
    const current = await this.getBrowserBookmarkSyncFailureState();
    const nextCount = (current.consecutiveFailures || 0) + 1;
    const disabled = nextCount >= maxFailures;
    const next = {
      consecutiveFailures: nextCount,
      disabled,
      disabledSignature: disabled ? (signature || null) : current.disabledSignature || null,
      lastFailureAt: Date.now(),
      lastError: errorMsg || null
    };

    await new Promise((resolve, reject) => {
      this.storage.set({ [this.browserBookmarkSyncFailureKey]: next }, () => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          resolve();
        }
      });
    });
    return { disabled, consecutiveFailures: nextCount };
  }

  /**
   * 保存场景的文件夹列表（包括空文件夹）
   * @param {String} sceneId - 场景ID
   * @param {Array} folders - 文件夹数组
   */
  async saveSceneFolders(sceneId, folders) {
    return new Promise((resolve, reject) => {
      this.storage.get([this.sceneFoldersKey], (result) => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          const sceneFoldersMap = result[this.sceneFoldersKey] || {};
          sceneFoldersMap[sceneId] = folders || [];
          this.storage.set({ [this.sceneFoldersKey]: sceneFoldersMap }, () => {
            if (this.hasError()) {
              reject(new Error(this.getError()));
            } else {
              resolve(sceneFoldersMap);
            }
          });
        }
      });
    });
  }

  /**
   * 获取场景的文件夹列表（包括空文件夹）
   * @param {String} sceneId - 场景ID
   * @returns {Array} 文件夹数组
   */
  async getSceneFolders(sceneId) {
    return new Promise((resolve, reject) => {
      this.storage.get([this.sceneFoldersKey], (result) => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          const sceneFoldersMap = result[this.sceneFoldersKey] || {};
          resolve(sceneFoldersMap[sceneId] || []);
        }
      });
    });
  }

  /**
   * 删除场景的文件夹列表
   * @param {String} sceneId - 场景ID
   */
  async deleteSceneFolders(sceneId) {
    return new Promise((resolve, reject) => {
      this.storage.get([this.sceneFoldersKey], (result) => {
        if (this.hasError()) {
          reject(new Error(this.getError()));
        } else {
          const sceneFoldersMap = result[this.sceneFoldersKey] || {};
          delete sceneFoldersMap[sceneId];
          this.storage.set({ [this.sceneFoldersKey]: sceneFoldersMap }, () => {
            if (this.hasError()) {
              reject(new Error(this.getError()));
            } else {
              resolve();
            }
          });
        }
      });
    });
  }
}

// 导出供其他模块使用
if (typeof module !== 'undefined' && module.exports) {
  module.exports = StorageManager;
}

