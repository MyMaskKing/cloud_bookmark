/**
 * 书签解析工具
 * 用于解析浏览器书签HTML格式
 */

/**
 * 解析HTML格式的书签文件
 */
function parseHtmlBookmarks(htmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlText, 'text/html');
  
  const bookmarks = [];
  const folders = [];

  const normalizeFolder = (p) => (p || '').trim().replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  
  // 递归解析书签节点
  function parseNode(node, currentFolder = '') {
    if (!node) return;
    
    // 处理文件夹（H3标签）
    const folderNodes = node.querySelectorAll('H3');
    folderNodes.forEach(folderNode => {
      const folderName = folderNode.textContent.trim();
      const folderPath = normalizeFolder(currentFolder ? `${currentFolder}/${folderName}` : folderName);
      if (folderPath && !folders.includes(folderPath)) {
        folders.push(folderPath);
      }
      
      // 查找文件夹下的DL节点
      let dlNode = folderNode.nextElementSibling;
      while (dlNode && dlNode.tagName !== 'DL') {
        dlNode = dlNode.nextElementSibling;
      }
      
      if (dlNode) {
        parseNode(dlNode, folderPath);
      }
    });
    
    // 处理书签链接（A标签）
    const linkNodes = node.querySelectorAll('A');
    linkNodes.forEach(linkNode => {
      const href = linkNode.getAttribute('HREF');
      const title = linkNode.textContent.trim();
      const addDate = linkNode.getAttribute('ADD_DATE');
      const icon = linkNode.getAttribute('ICON');
      
      if (href && title) {
        const bookmark = {
          id: Date.now().toString(36) + Math.random().toString(36).substr(2),
          title: title,
          url: href,
          folder: currentFolder || undefined,
          favicon: icon || undefined,
          createdAt: addDate ? parseInt(addDate) * 1000 : Date.now(),
          updatedAt: Date.now(),
          starred: false
        };
        
        bookmarks.push(bookmark);
      }
    });
  }
  
  // 查找所有DL节点
  const dlNodes = doc.querySelectorAll('DL');
  dlNodes.forEach(dlNode => {
    parseNode(dlNode);
  });
  
  // 如果没有找到DL节点，尝试直接查找A标签
  if (bookmarks.length === 0) {
    const allLinks = doc.querySelectorAll('A');
    allLinks.forEach(link => {
      const href = link.getAttribute('HREF');
      const title = link.textContent.trim();
      
      if (href && title) {
        const bookmark = {
          id: Date.now().toString(36) + Math.random().toString(36).substr(2),
          title: title,
          url: href,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          starred: false
        };
        
        bookmarks.push(bookmark);
      }
    });
  }
  
  return {
    bookmarks: bookmarks,
    folders: folders
  };
}

/**
 * 从浏览器书签API导入书签
 */
async function importFromBrowserBookmarks() {
  return new Promise((resolve, reject) => {
    const bookmarks = [];
    const folders = [];
    const isMobile = /android|iphone|ipad|mobile/i.test(navigator.userAgent || '');
    const isFirefoxMobile = isMobile && /firefox/i.test(navigator.userAgent || '');
    
    function processBookmarkTree(nodes, currentFolder = '') {
      if (!nodes) return;
      
      nodes.forEach(node => {
        if (node.url) {
          // 这是一个书签
          const bookmark = {
            id: node.id || (Date.now().toString(36) + Math.random().toString(36).substr(2)),
            title: node.title || '无标题',
            url: node.url,
            folder: currentFolder || undefined,
            createdAt: node.dateAdded ? node.dateAdded : Date.now(),
            updatedAt: Date.now(),
            starred: false
          };
          
          bookmarks.push(bookmark);
        } else if (node.children) {
          // 这是一个文件夹
          const folderName = node.title || '未命名文件夹';
          const newFolder = currentFolder ? `${currentFolder}/${folderName}` : folderName;

          // 收集完整路径，避免在顶层再生成一个同名空文件夹
          if (newFolder && !folders.includes(newFolder)) {
            folders.push(newFolder);
          }
          
          processBookmarkTree(node.children, newFolder);
        }
      });
    }
    
    if (typeof chrome !== 'undefined' && chrome.bookmarks) {
      chrome.bookmarks.getTree((tree) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        
        processBookmarkTree(tree);
        resolve({ bookmarks, folders });
      });
    } else if (typeof browser !== 'undefined' && browser.bookmarks) {
      browser.bookmarks.getTree().then((tree) => {
        processBookmarkTree(tree);
        resolve({ bookmarks, folders });
      }).catch(reject);
    } else {
      // 移动端 Firefox 不提供 bookmarks API，改为友好返回
      if (isFirefoxMobile) {
        resolve({
          bookmarks: [],
          folders: [],
          unsupported: true,
          reason: '移动端 Firefox 不支持书签 API，请使用桌面浏览器或导入 HTML 文件'
        });
        return;
      }
      reject(new Error('浏览器书签API不可用'));
    }
  });
}

// 导出函数
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseHtmlBookmarks,
    importFromBrowserBookmarks
  };
}

