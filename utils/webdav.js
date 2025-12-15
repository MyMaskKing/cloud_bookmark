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
  }

  /**
   * 构建完整的文件路径
   */
  getFilePath() {
    const path = this.path.endsWith('/') ? this.path : this.path + '/';
    return path + this.fileName;
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
    const pathParts = this.path.split('/').filter(p => p);
    let currentPath = '';

    for (const part of pathParts) {
      currentPath += '/' + part;
      try {
        await fetch(this.serverUrl + currentPath, {
          method: 'MKCOL',
          headers: {
            'Authorization': this.getAuthHeader()
          }
        });
      } catch (error) {
        // 目录可能已存在，忽略错误
      }
    }
  }

  /**
   * 从WebDAV服务器读取书签数据
   */
  async readBookmarks() {
    try {
      await this.ensureDirectory();
      
      const filePath = this.getFilePath();
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
      return data;
    } catch (error) {
      console.error('读取书签失败:', error);
      throw error;
    }
  }

  /**
   * 将书签数据写入WebDAV服务器
   */
  async writeBookmarks(data) {
    try {
      await this.ensureDirectory();
      
      const filePath = this.getFilePath();
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
   * 获取文件最后修改时间
   */
  async getLastModified() {
    try {
      const filePath = this.getFilePath();
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
}

// 导出供其他模块使用
if (typeof module !== 'undefined' && module.exports) {
  module.exports = WebDAVClient;
}

