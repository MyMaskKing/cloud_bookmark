# 云端书签浏览器插件

基于WebDAV的云端书签管理浏览器插件，支持Chrome和Firefox（PC和Android）。

## 功能特性

- ✅ **云端同步**：使用WebDAV协议同步书签到云端
- ✅ **离线支持**：本地优先，离线也能正常使用
- ✅ **书签管理**：添加、编辑、删除、搜索书签
- ✅ **文件夹管理**：支持多级文件夹组织书签
- ✅ **标签系统**：为书签添加标签，方便分类
- ✅ **收藏功能**：星标收藏重要书签
- ✅ **备注笔记**：为书签添加备注和笔记
- ✅ **导入导出**：支持浏览器书签格式导入导出
- ✅ **多视图**：网格视图和列表视图切换
- ✅ **搜索筛选**：强大的搜索和筛选功能

## 安装方法

### Chrome浏览器

1. 打开Chrome浏览器，访问 `chrome://extensions/`
2. 开启"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择项目根目录

### Firefox浏览器

1. 打开Firefox浏览器，访问 `about:debugging`
2. 点击"此Firefox"
3. 点击"临时载入附加组件"
4. 选择项目根目录下的 `manifest.json` 文件

## 使用说明

### 首次配置

1. 点击插件图标，选择"设置"
2. 配置WebDAV服务器信息：
   - 服务器地址（如：`https://example.com/webdav`）
   - 用户名
   - 密码
   - 同步路径（默认：`/bookmarks/`）
   - 同步间隔（默认：5分钟）
3. 点击"测试连接"验证配置
4. 点击"保存配置"

### 添加书签

**方式一：快速添加**
- 点击插件图标，点击"添加当前页面"
- 或使用快捷键 `Ctrl+Shift+B`（Mac: `Command+Shift+B`）
- 或右键点击页面，选择"添加到云端书签"

**方式二：完整添加**
- 打开书签管理界面
- 点击"+"按钮
- 填写书签信息（标题、URL、描述、备注、标签、文件夹等）
- 点击"保存"

### 管理书签

- **查看**：在书签管理界面浏览所有书签
- **搜索**：使用顶部搜索框搜索书签
- **筛选**：按文件夹、标签、收藏状态筛选
- **排序**：按创建时间、标题、收藏状态排序
- **编辑**：点击书签卡片的编辑按钮
- **删除**：点击书签卡片的删除按钮
- **收藏**：点击星标图标收藏/取消收藏

### 同步

- **自动同步**：云端到本地每5分钟自动同步一次（可设置）
- **实时同步**：本地变更（添加/修改/删除）立即同步到云端
- **手动同步**：点击同步按钮立即同步

## 项目结构

```
cloud_bookmark/
├── manifest.json          # 插件配置文件
├── background/            # 后台脚本
│   └── background.js     # 主后台脚本
├── popup/                # 弹出窗口
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── options/              # 设置页面
│   ├── options.html
│   ├── options.js
│   └── options.css
├── pages/                # 完整界面页面
│   ├── bookmarks.html
│   ├── bookmarks.js
│   └── bookmarks.css
├── utils/                # 工具函数
│   ├── webdav.js        # WebDAV客户端
│   ├── storage.js       # 存储管理
│   └── utils.js         # 通用工具
└── assets/               # 静态资源
    └── icons/           # 图标
```

## WebDAV服务器要求

插件支持标准的WebDAV协议，兼容以下服务：

- Nextcloud
- ownCloud
- 坚果云
- 其他标准WebDAV服务器

## 数据格式

书签数据以JSON格式存储在WebDAV服务器上：

```json
{
  "bookmarks": [
    {
      "id": "唯一标识符",
      "title": "书签标题",
      "url": "书签URL",
      "description": "书签描述",
      "notes": "书签备注/笔记",
      "tags": ["标签1", "标签2"],
      "folder": "文件夹路径",
      "starred": false,
      "favicon": "网站图标URL",
      "createdAt": 时间戳,
      "updatedAt": 时间戳
    }
  ],
  "folders": []
}
```

## 开发说明

### 技术栈

- 原生JavaScript（ES6+）
- Chrome Extension API / WebExtensions API
- WebDAV协议（使用fetch API）

### 浏览器API

- `chrome.storage` / `browser.storage`：本地存储
- `chrome.bookmarks` / `browser.bookmarks`：浏览器书签API
- `chrome.tabs` / `browser.tabs`：标签页操作
- `chrome.contextMenus` / `browser.contextMenus`：右键菜单
- `chrome.alarms` / `browser.alarms`：定时任务

### 开发调试

1. 加载插件到浏览器
2. 打开开发者工具查看控制台日志
3. 修改代码后，在扩展程序页面点击"重新加载"

## 图标生成

项目包含一个图标生成工具 `scripts/generate-icons.html`：

1. 在浏览器中打开 `scripts/generate-icons.html`
2. 点击"生成图标"按钮预览图标
3. 点击"下载所有图标"按钮下载PNG文件
4. 将下载的图标文件移动到 `assets/icons/` 目录

## 待完善功能

- [x] HTML格式书签导入解析（已实现）
- [x] 从浏览器书签栏导入（已实现）
- [x] 导出为HTML格式（已实现）
- [ ] 图标资源文件（使用 `scripts/generate-icons.html` 生成）
- [ ] 冲突处理优化
- [ ] 批量操作功能
- [ ] 主题切换
- [ ] 更多视图模式
- [ ] 文件夹创建和管理界面

## 许可证

MIT License

## 贡献

欢迎提交Issue和Pull Request！

