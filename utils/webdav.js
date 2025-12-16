/**
 * WebDAV客户端工具
 * 用于与WebDAV服务器进行数据同步
 */

class WebDAVClient {
  constructor(config) {
    this.serverUrl = config.serverUrl;
    this.username = config.username;
    this.password = config.password;
    this.path = config.path || '/bookmarks/';
    this.fileName = 'bookmarks.json';
    this.settingsFileName = 'settings.json';
  }

  /**
   * 构建完整的文件路径
   * @param {String} sceneId - 场景ID（可选，如果提供则使用场景文件命名）
   */
  getFilePath(sceneId = null) {
    const path = this.path.endsWith('/') ? this.path : this.path + '/';
    if (sceneId) {
      // 场景文件命名：{sceneId}_bookmarks.json
      return path + `${sceneId}_bookmarks.json`;
    }
    // 兼容旧版本：bookmarks.json
    return path + this.fileName;
  }

  getSettingsPath() {
    const path = this.path.endsWith('/') ? this.path : this.path + '/';
    return path + this.settingsFileName;
  }

  /**
   * 构建认证头
   */
  getAuthHeader() {
    const credentials = btoa(`${this.username}:${this.password}`);
    return `Basic ${credentials}`;
  }

  /**
   * 测试WebDAV连接
   */
  async testConnection() {
    try {
      const response = await fetch(this.serverUrl, {
        method: 'PROPFIND',
        headers: {
          'Authorization': this.getAuthHeader(),
          'Depth': '0'
        }
      });

      if (response.status === 401 || response.status === 403) {
        throw new Error('认证失败，请检查用户名和密码');
      }

      if (response.status >= 200 && response.status < 300) {
        return { success: true, message: '连接成功' };
      }

      throw new Error(`连接失败: HTTP ${response.status}`);
    } catch (error) {
      return { 
        success: false, 
        message: error.message || '无法连接到WebDAV服务器' 
      };
    }
  }

  /**
   * 确保目录存在
   */
  async ensureDirectory() {
    // 规范化路径：移除开头的斜杠，确保路径格式正确
    let normalizedPath = this.path.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!normalizedPath) {
      // 如果路径为空，不需要创建目录
      return;
    }
    
    const pathParts = normalizedPath.split('/').filter(p => p);
    let currentPath = '';

    for (const part of pathParts) {
      currentPath += '/' + part;
      try {
        const response = await fetch(this.serverUrl + currentPath, {
          method: 'MKCOL',
          headers: {
            'Authorization': this.getAuthHeader()
          }
        });
        
        // 201 Created: 目录创建成功
        // 405 Method Not Allowed: 目录已存在（某些服务器返回此状态）
        // 409 Conflict: 目录已存在（坚果云等服务器返回此状态）
        // 这些状态都应该视为成功
        if (response.status === 201 || response.status === 405 || response.status === 409) {
          // 目录创建成功或已存在，继续
          continue;
        }
        
        // 其他状态码可能需要处理
        if (response.status >= 400 && response.status !== 405 && response.status !== 409) {
          console.warn(`创建目录失败: ${currentPath}, HTTP ${response.status}`);
        }
      } catch (error) {
        // 网络错误或其他异常，记录但不中断流程
        console.warn(`创建目录时发生错误: ${currentPath}`, error);
      }
    }
  }

  /**
   * 从WebDAV服务器读取书签数据
   * @param {String} sceneId - 场景ID（可选，如果提供则读取对应场景的文件）
   */
  async readBookmarks(sceneId = null) {
    try {
      await this.ensureDirectory();
      
      const filePath = this.getFilePath(sceneId);
      const response = await fetch(this.serverUrl + filePath, {
        method: 'GET',
        headers: {
          'Authorization': this.getAuthHeader()
        }
      });

      if (response.status === 404) {
        // 文件不存在，返回空数据
        return { bookmarks: [], folders: [] };
      }

      if (!response.ok) {
        throw new Error(`读取失败: HTTP ${response.status}`);
      }

      const data = await response.json();
      // 确保返回的数据包含scene字段
      if (sceneId && data.bookmarks) {
        data.bookmarks = data.bookmarks.map(b => ({ ...b, scene: b.scene || sceneId }));
      }
      return data;
    } catch (error) {
      console.error('读取书签失败:', error);
      throw error;
    }
  }

  /**
   * 将书签数据写入WebDAV服务器
   * @param {Object} data - 书签数据
   * @param {String} sceneId - 场景ID（可选，如果提供则写入对应场景的文件）
   */
  async writeBookmarks(data, sceneId = null) {
    try {
      await this.ensureDirectory();
      
      const filePath = this.getFilePath(sceneId);
      // 确保数据中的书签包含scene字段
      if (sceneId && data.bookmarks) {
        data = {
          ...data,
          bookmarks: data.bookmarks.map(b => ({ ...b, scene: b.scene || sceneId }))
        };
      }
      const jsonData = JSON.stringify(data, null, 2);
      
      const response = await fetch(this.serverUrl + filePath, {
        method: 'PUT',
        headers: {
          'Authorization': this.getAuthHeader(),
          'Content-Type': 'application/json'
        },
        body: jsonData
      });

      if (!response.ok) {
        throw new Error(`写入失败: HTTP ${response.status}`);
      }

      return { success: true };
    } catch (error) {
      console.error('写入书签失败:', error);
      throw error;
    }
  }

  /**
   * 从WebDAV服务器读取设置
   */
  async readSettings() {
    try {
      await this.ensureDirectory();
      
      const filePath = this.getSettingsPath();
      const response = await fetch(this.serverUrl + filePath, {
        method: 'GET',
        headers: {
          'Authorization': this.getAuthHeader()
        }
      });

      if (response.status === 404) {
        // 文件不存在，返回空设置
        return {};
      }

      if (!response.ok) {
        throw new Error(`读取设置失败: HTTP ${response.status}`);
      }

      const data = await response.json();
      return data || {};
    } catch (error) {
      console.error('读取设置失败:', error);
      throw error;
    }
  }

  /**
   * 将设置写入WebDAV服务器
   */
  async writeSettings(settings) {
    try {
      await this.ensureDirectory();
      
      const filePath = this.getSettingsPath();
      const jsonData = JSON.stringify(settings || {}, null, 2);
      
      const response = await fetch(this.serverUrl + filePath, {
        method: 'PUT',
        headers: {
          'Authorization': this.getAuthHeader(),
          'Content-Type': 'application/json'
        },
        body: jsonData
      });

      if (!response.ok) {
        throw new Error(`写入设置失败: HTTP ${response.status}`);
      }

      return { success: true };
    } catch (error) {
      console.error('写入设置失败:', error);
      throw error;
    }
  }

  /**
   * 获取文件最后修改时间
   * @param {String} sceneId - 场景ID（可选，如果提供则获取对应场景文件的修改时间）
   */
  async getLastModified(sceneId = null) {
    try {
      const filePath = this.getFilePath(sceneId);
      const response = await fetch(this.serverUrl + filePath, {
        method: 'HEAD',
        headers: {
          'Authorization': this.getAuthHeader()
        }
      });

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        return null;
      }

      const lastModified = response.headers.get('Last-Modified');
      return lastModified ? new Date(lastModified).getTime() : null;
    } catch (error) {
      console.error('获取最后修改时间失败:', error);
      return null;
    }
  }

  /**
   * 删除场景书签文件
   * @param {String} sceneId - 场景ID
   */
  async deleteSceneBookmarks(sceneId) {
    try {
      const filePath = this.getFilePath(sceneId);
      const response = await fetch(this.serverUrl + filePath, {
        method: 'DELETE',
        headers: {
          'Authorization': this.getAuthHeader()
        }
      });

      if (response.status === 404) {
        // 文件不存在，视为成功
        return { success: true };
      }

      if (!response.ok) {
        throw new Error(`删除失败: HTTP ${response.status}`);
      }

      return { success: true };
    } catch (error) {
      console.error('删除场景书签文件失败:', error);
      throw error;
    }
  }
}

// 导出供其他模块使用
if (typeof module !== 'undefined' && module.exports) {
  module.exports = WebDAVClient;
}

