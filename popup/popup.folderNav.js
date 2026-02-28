(function () {
  const storageForNav = new StorageManager();

  let folderNavMode = 'tree'; // 'tree' | 'tabs'
  let currentFolderPath = '';

  function safeNormalizePath(path) {
    if (typeof normalizeFolderPath === 'function') {
      return normalizeFolderPath(path);
    }
    if (!path) return '';
    return String(path)
      .trim()
      .replace(/\/+/g, '/')
      .replace(/^\/|\/$/g, '');
  }

  async function loadFolderNavMode() {
    try {
      const settings = await storageForNav.getSettings();
      const popup = (settings && settings.popup) || {};
      const mode = popup.folderNavMode;
      folderNavMode = mode === 'tabs' ? 'tabs' : 'tree';
    } catch (e) {
      folderNavMode = 'tree';
    }
  }

  function getScrollContainer() {
    return document.querySelector('.popup-content') || document.body;
  }

  function collectFolderRows() {
    const list = document.getElementById('bookmarkList');
    if (!list) return [];
    const rows = list.querySelectorAll('.folder-row');
    const result = [];
    rows.forEach((row) => {
      const rawPath = row.dataset.folder || '';
      const path = safeNormalizePath(rawPath);
      if (!path) return;
      const nameEl = row.querySelector('.folder-name');
      const countEl = row.querySelector('.folder-count');
      const name = (nameEl && nameEl.textContent.trim()) || path.split('/').pop();
      const depth = path.split('/').filter(Boolean).length;
      const count = countEl ? parseInt(countEl.textContent, 10) || 0 : 0;
      result.push({ path, name, depth, count });
    });
    return result;
  }

  function getFirstLevelFoldersFromRows(rows) {
    const map = new Map();
    rows.forEach((row) => {
      const parts = row.path.split('/');
      if (!parts[0]) return;
      const top = parts[0];
      const topPath = top;
      const prev = map.get(topPath) || { path: topPath, name: top, count: 0 };
      prev.count += row.count || 0;
      map.set(topPath, prev);
    });
    return Array.from(map.values());
  }

  function findFolderRowByPath(path) {
    const list = document.getElementById('bookmarkList');
    if (!list) return null;
    const normalized = safeNormalizePath(path);
    if (!normalized) return null;
    return Array.from(list.querySelectorAll('.folder-row')).find(
      (row) => safeNormalizePath(row.dataset.folder || '') === normalized
    );
  }

  function expandFolderIfNeeded(path, callback) {
    const normalized = safeNormalizePath(path);
    if (!normalized) {
      callback(null);
      return;
    }
    let row = findFolderRowByPath(normalized);
    if (!row) {
      console.warn('[弹窗导航] 未找到目标文件夹行:', normalized);
      callback(null);
      return;
    }

    const block = row.closest('.folder-block');
    const hasChildren = block && block.querySelector('.folder-children');

    if (hasChildren) {
      callback(row);
      return;
    }

    // 当前为折叠状态，模拟点击以展开，等待渲染完成后再滚动
    row.click();
    requestAnimationFrame(() => {
      const newRow = findFolderRowByPath(normalized) || row;
      callback(newRow);
    });
  }

  function scrollToFolder(path) {
    const container = getScrollContainer();
    if (!container) return;

    expandFolderIfNeeded(path, (targetRow) => {
      if (!targetRow) return;

      const containerRect = container.getBoundingClientRect();
      const rowRect = targetRow.getBoundingClientRect();
      const stickyEl = document.getElementById('currentFolderSticky');
      const stickyVisible =
        stickyEl && stickyEl.style.display !== 'none' && stickyEl.offsetHeight > 0;
      const stickyHeight = stickyVisible ? stickyEl.offsetHeight : 0;

      const offset = rowRect.top - containerRect.top;
      const targetTop = container.scrollTop + offset - stickyHeight - 4;

      console.log('[弹窗导航] 滚动到文件夹并展开:', safeNormalizePath(path), 'targetTop=', targetTop);
      container.scrollTo({
        top: Math.max(targetTop, 0),
        behavior: 'smooth',
      });
    });
  }

  function updateCurrentFolderSticky() {
    const sticky = document.getElementById('currentFolderSticky');
    const pathTextEl = document.getElementById('currentFolderPathText');
    if (!sticky || !pathTextEl) return;

    const container = getScrollContainer();
    const list = document.getElementById('bookmarkList');
    if (!container || !list) return;

    const rows = Array.from(list.querySelectorAll('.folder-row'));
    if (!rows.length || container.scrollTop <= 8) {
      sticky.style.display = 'none';
      currentFolderPath = '';
      return;
    }

    const containerRect = container.getBoundingClientRect();
    let bestRow = null;
    let bestTop = -Infinity;

    rows.forEach((row) => {
      const rect = row.getBoundingClientRect();
      const relTop = rect.top - containerRect.top;
      // 选择“出现在视口顶部之前或附近”的最后一个文件夹，
      // 这样在浏览其子书签时仍会显示该文件夹为当前文件夹。
      if (relTop <= 32 && relTop > bestTop) {
        bestTop = relTop;
        bestRow = row;
      }
    });

    if (!bestRow) {
      sticky.style.display = 'none';
      currentFolderPath = '';
      return;
    }

    const rawPath = bestRow.dataset.folder || '';
    const normalized = safeNormalizePath(rawPath);
    if (!normalized) {
      sticky.style.display = 'none';
      currentFolderPath = '';
      return;
    }

    // 展示名称与目录中的文件夹名称保持一致（只显示当前层级），完整路径放在 title 里
    const nameEl = bestRow.querySelector('.folder-name');
    const displayName =
      (nameEl && nameEl.textContent.trim()) || normalized.split('/').pop() || normalized;

    currentFolderPath = normalized;
    pathTextEl.textContent = displayName;
    sticky.title = normalized;
    sticky.style.display = 'block';
  }

  let currentTabsParentPath = '';

  function getParentPath(path) {
    const n = safeNormalizePath(path);
    if (!n) return '';
    const idx = n.lastIndexOf('/');
    if (idx === -1) return '';
    return n.slice(0, idx);
  }

  function getDirectChildren(parentPath, rows) {
    const parentNorm = safeNormalizePath(parentPath);
    return rows.filter((row) => {
      const p = safeNormalizePath(row.path);
      if (!p) return false;
      return getParentPath(p) === parentNorm;
    });
  }

  function hasChildren(path, rows) {
    const n = safeNormalizePath(path);
    if (!n) return false;
    return rows.some((row) => getParentPath(row.path) === n);
  }

  function renderFolderDrawerContent() {
    const drawerTree = document.getElementById('folderDrawerTree');
    const drawerTabs = document.getElementById('folderDrawerTabs');
    const modeLabel = document.getElementById('folderDrawerModeLabel');
    const backBtn = document.getElementById('folderDrawerBack');
    if (!drawerTree || !drawerTabs || !modeLabel) return;

    const rows = collectFolderRows();
    if (!rows.length) {
      drawerTree.innerHTML =
        '<div class="folder-drawer-empty">当前视图中没有可用的文件夹目录。</div>';
      drawerTabs.innerHTML =
        '<div class="folder-drawer-empty">当前视图中没有可用的文件夹目录。</div>';
      modeLabel.textContent = '无可用目录';
      return;
    }

    if (folderNavMode === 'tabs') {
      modeLabel.textContent = '横向标签';
      drawerTree.style.display = 'flex';
      drawerTabs.style.display = 'flex';

      // 初始化当前层级的父节点：优先用已有的，其次用当前文件夹的父级，最后用最浅层的第一个
      const depths = rows.map((r) => r.depth);
      const minDepth = Math.min(...depths);
      const shallowNodes = rows.filter((r) => r.depth === minDepth);

      const normalizedCurrentParent = safeNormalizePath(currentTabsParentPath);
      const hasCurrentParent = rows.some(
        (r) => safeNormalizePath(r.path) === normalizedCurrentParent
      );

      if (!hasCurrentParent) {
        let candidate = '';
        if (currentFolderPath) {
          const fromCurrent = getParentPath(currentFolderPath);
          const hasFromCurrent = rows.some(
            (r) => safeNormalizePath(r.path) === safeNormalizePath(fromCurrent)
          );
          candidate = hasFromCurrent ? fromCurrent : '';
        }
        if (!candidate && shallowNodes.length) {
          candidate = shallowNodes[0].path;
        }
        currentTabsParentPath = candidate;
      }

      const parentPath = currentTabsParentPath;
      const parentNorm = safeNormalizePath(parentPath);
      const parentDepth = parentNorm ? parentNorm.split('/').length : minDepth - 1;

      // 返回上一级按钮：只有在非最顶层时才显示
      if (backBtn) {
        const upper = getParentPath(parentPath);
        const canGoUp = upper && rows.some(
          (r) => safeNormalizePath(r.path) === safeNormalizePath(upper)
        );
        if (canGoUp) {
          backBtn.style.display = 'flex';
          backBtn.onclick = () => {
            currentTabsParentPath = upper;
            currentFolderPath = upper;
            renderFolderDrawerContent();
            scrollToFolder(upper);
          };
        } else {
          backBtn.style.display = 'none';
          backBtn.onclick = null;
        }
      }

      // 同一层级的“兄弟文件夹”作为横向标签（只展示有子文件夹的）
      const siblingCandidates = getDirectChildren(getParentPath(parentPath), rows);
      const siblingTabs = siblingCandidates.filter((row) =>
        hasChildren(row.path, rows)
      );
      const tabsToRender = siblingTabs.length ? siblingTabs : shallowNodes;

      drawerTabs.innerHTML = tabsToRender
        .map((folder) => {
          const isActive =
            safeNormalizePath(folder.path) === safeNormalizePath(parentPath);
          return `
            <div
              class="folder-drawer-tab ${isActive ? 'active' : ''}"
              data-folder="${folder.path}"
              title="${folder.path}"
            >
              <span class="folder-drawer-tab-label">${folder.name}</span>
              <span class="folder-drawer-tab-count">${folder.count}</span>
            </div>
          `;
        })
        .join('');

      // 渲染当前父节点的直接子文件夹列表
      function renderChildrenForParent(path) {
        const norm = safeNormalizePath(path);
        const children = getDirectChildren(norm, rows);

        if (!children.length) {
          drawerTree.innerHTML =
            '<div class="folder-drawer-empty">该文件夹下暂无子文件夹。</div>';
          return;
        }

        drawerTree.innerHTML = children
          .map((row) => {
            const normalized = safeNormalizePath(row.path);
            const isActiveChild =
              normalized === safeNormalizePath(currentFolderPath);
            const depthRel = Math.max(
              1,
              Math.min(5, row.depth - parentDepth)
            );
            const clickable = hasChildren(row.path, rows);
            return `
              <div
                class="folder-drawer-item depth-${depthRel} ${
                  isActiveChild ? 'active' : ''
                } ${clickable ? 'has-children' : ''}"
                data-folder="${row.path}"
                title="${row.path}"
              >
                <span class="folder-drawer-item-label">${row.name}</span>
                <span class="folder-drawer-item-count">${row.count}</span>
              </div>
            `;
          })
          .join('');

        drawerTree
          .querySelectorAll('.folder-drawer-item')
          .forEach((item) =>
            item.addEventListener('click', () => {
              const path = item.dataset.folder || '';
              const normalized = safeNormalizePath(path);
              if (!normalized) return;

              currentFolderPath = normalized;

              if (hasChildren(normalized, rows)) {
                // 继续在抽屉内下钻到下一层级（互斥），不关闭抽屉
                currentTabsParentPath = normalized;
                renderFolderDrawerContent();
              } else {
                // 叶子节点：只做快速定位，并关闭抽屉
                scrollToFolder(normalized);
                closeFolderDrawer();
              }
            })
          );
      }

      renderChildrenForParent(parentPath);

      // 标签点击：在当前层级间互斥切换，并刷新子列表
      drawerTabs
        .querySelectorAll('.folder-drawer-tab')
        .forEach((tab) =>
          tab.addEventListener('click', () => {
            const path = tab.dataset.folder || '';
            const normalized = safeNormalizePath(path);
            if (!normalized) return;

            currentTabsParentPath = normalized;
            currentFolderPath = normalized;

            drawerTabs
              .querySelectorAll('.folder-drawer-tab')
              .forEach((el) => el.classList.remove('active'));
            tab.classList.add('active');

            renderChildrenForParent(normalized);
            scrollToFolder(normalized);
          })
        );
    } else {
      modeLabel.textContent = '树形目录';
      drawerTree.style.display = 'flex';
      drawerTabs.style.display = 'none';

      drawerTree.innerHTML = rows
        .map((row) => {
          const isActive =
            safeNormalizePath(row.path) === safeNormalizePath(currentFolderPath);
          const depth = Math.min(Math.max(row.depth, 1), 5);
          return `
            <div
              class="folder-drawer-item depth-${depth} ${
                isActive ? 'active' : ''
              }"
              data-folder="${row.path}"
              title="${row.path}"
            >
              <span class="folder-drawer-item-label">${row.name}</span>
              <span class="folder-drawer-item-count">${row.count}</span>
            </div>
          `;
        })
        .join('');

      drawerTree
        .querySelectorAll('.folder-drawer-item')
        .forEach((item) =>
          item.addEventListener('click', () => {
            const path = item.dataset.folder || '';
            scrollToFolder(path);
            closeFolderDrawer();
          })
        );
    }

    // 打开时让当前文件夹位置滚动到可见范围
    const activeEl =
      drawerTree.querySelector('.folder-drawer-item.active') ||
      drawerTabs.querySelector('.folder-drawer-tab.active');
    if (activeEl && activeEl.scrollIntoView) {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }

  function openFolderDrawer() {
    const drawer = document.getElementById('folderDrawer');
    if (!drawer) return;

    // 标记目录抽屉已打开，用于隐藏“回到顶部”按钮等
    window.__folderDrawerOpen = true;
    const backToTopBtn = document.getElementById('backToTopBtn');
    if (backToTopBtn) {
      backToTopBtn.style.display = 'none';
    }

    updateCurrentFolderSticky();
    renderFolderDrawerContent();
    drawer.style.display = 'flex';
  }

  function closeFolderDrawer() {
    const drawer = document.getElementById('folderDrawer');
    if (!drawer) return;
    drawer.style.display = 'none';

    // 关闭时清除标记，允许“回到顶部”按钮按滚动规则重新显示
    window.__folderDrawerOpen = false;
  }

  function enhanceTooltips() {
    const list = document.getElementById('bookmarkList');
    if (!list) return;

    list.querySelectorAll('.bookmark-item').forEach((item) => {
      const titleEl = item.querySelector('.bookmark-item-title');
      const urlEl = item.querySelector('.bookmark-item-url');
      const folderEl = item.querySelector('.bookmark-item-folder');

      if (titleEl && !titleEl.hasAttribute('title')) {
        const text = titleEl.textContent.trim();
        if (text) titleEl.setAttribute('title', text);
      }

      if (urlEl && !urlEl.hasAttribute('title')) {
        const text = urlEl.textContent.trim();
        if (text) urlEl.setAttribute('title', text);
      }

      if (folderEl && !folderEl.hasAttribute('title')) {
        let text = folderEl.textContent || '';
        text = text.replace(/^所在[:：]\s*/i, '').trim();
        if (text) folderEl.setAttribute('title', text);
      }
    });
  }

  function setupScrollListener() {
    const container = getScrollContainer();
    if (!container) return;

    container.addEventListener('scroll', () => {
      try {
        updateCurrentFolderSticky();
      } catch (e) {
        console.warn('[弹窗导航] 更新粘性提示条失败:', e);
      }
    });
  }

  function setupBookmarkObserver() {
    const list = document.getElementById('bookmarkList');
    if (!list || typeof MutationObserver === 'undefined') {
      // 初次增强一次
      enhanceTooltips();
      updateCurrentFolderSticky();
      return;
    }

    const observer = new MutationObserver(() => {
      enhanceTooltips();
      // 列表变化后，重新计算当前文件夹
      updateCurrentFolderSticky();
    });

    observer.observe(list, {
      childList: true,
      subtree: true,
    });

    // 初次增强
    enhanceTooltips();
    updateCurrentFolderSticky();
  }

  document.addEventListener('DOMContentLoaded', async () => {
    try {
      await loadFolderNavMode();
    } catch (e) {
      // ignore
    }

    const toggleBtn = document.getElementById('folderDrawerToggle');
    const drawerMask = document.querySelector('.folder-drawer-mask');
    const drawerClose = document.getElementById('folderDrawerClose');

    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        openFolderDrawer();
      });
    }

    if (drawerMask) {
      drawerMask.addEventListener('click', () => {
        closeFolderDrawer();
      });
    }

    if (drawerClose) {
      drawerClose.addEventListener('click', () => {
        closeFolderDrawer();
      });
    }

    setupScrollListener();
    setupBookmarkObserver();
  });
})();

