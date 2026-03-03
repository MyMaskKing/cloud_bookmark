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

  function getAncestorPaths(path) {
    const n = safeNormalizePath(path);
    if (!n) return [];
    const parts = n.split('/').filter(Boolean);
    const result = [];
    for (let i = 1; i < parts.length; i++) {
      result.push(parts.slice(0, i).join('/'));
    }
    return result;
  }

  // 为避免快速连续点击导致展开过程互相打断，这里串行执行展开任务
  let expandQueue = Promise.resolve();

  function expandFolderIfNeeded(path) {
    const normalized = safeNormalizePath(path);
    if (!normalized) {
      return Promise.resolve(null);
    }
    const ancestors = getAncestorPaths(normalized);
    const allToExpand = [...ancestors, normalized];

    const task = () =>
      new Promise((resolve) => {
        function ensureExpandedAndResolve() {
          const row = findFolderRowByPath(normalized);
          if (!row) {
            console.warn('[弹窗导航] 目标文件夹行缺失:', normalized);
            resolve(null);
            return;
          }
          const block = row.closest('.folder-block');
          const children = block && block.querySelector('.folder-children');
          if (children) {
            resolve(row);
            return;
          }
          // 理论上展开后一定会有 .folder-children；如果没有，再补一次点击重试
          row.click();
          requestAnimationFrame(() => {
            const retryRow = findFolderRowByPath(normalized) || row;
            const retryBlock = retryRow.closest('.folder-block');
            const retryChildren =
              retryBlock && retryBlock.querySelector('.folder-children');
            if (!retryChildren) {
              console.warn(
                '[弹窗导航] 目标文件夹展开重试后仍未出现子内容:',
                normalized
              );
            }
            resolve(retryRow);
          });
        }

        function doExpand(index) {
          if (index >= allToExpand.length) {
            ensureExpandedAndResolve();
            return;
          }
          const p = allToExpand[index];
          const row = findFolderRowByPath(p);
          if (!row) {
            console.warn('[弹窗导航] 未找到文件夹行:', p);
            resolve(null);
            return;
          }
          const block = row.closest('.folder-block');
          const hasChildren = block && block.querySelector('.folder-children');
          if (hasChildren) {
            doExpand(index + 1);
            return;
          }
          row.click();
          requestAnimationFrame(() => {
            doExpand(index + 1);
          });
        }
        doExpand(0);
      });

    // 串行排队执行展开逻辑，避免并发导致 DOM 状态错乱
    expandQueue = expandQueue
      .catch(() => null)
      .then(() => task());
    return expandQueue;
  }

  function scrollToFolder(path) {
    const container = getScrollContainer();
    if (!container) return;

    expandFolderIfNeeded(path).then((targetRow) => {
      if (!targetRow) return;

      const containerRect = container.getBoundingClientRect();
      const rowRect = targetRow.getBoundingClientRect();

      // 粘性条已在滚动容器外部，这里不再扣除粘性条高度，只让目标文件夹靠近容器顶部
      const offset = rowRect.top - containerRect.top;
      const targetTop = container.scrollTop + offset - 8;

      console.log(
        '[弹窗导航] 滚动到文件夹并展开:',
        safeNormalizePath(path),
        'targetTop=',
        targetTop
      );
      container.scrollTo({
        top: Math.max(targetTop, 0),
        behavior: 'smooth',
      });
    });
  }

  // 暴露给其他脚本使用（例如收藏抽屉中“所属目录”跳转）
  window.scrollToFolderInPopup = scrollToFolder;

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

  /**
   * 从树结构递归收集所有文件夹（用于横向标签模式，不依赖 DOM 展开状态）
   */
  function collectFoldersFromTree(tree) {
    const result = [];
    const foldersMap = tree.folders || {};
    const order = tree.order || Object.keys(foldersMap);

    function countTotal(node) {
      const foldersMap = node.folders || {};
      const items = node.items || [];
      let total = items.length;
      Object.keys(foldersMap).forEach((key) => {
        total += countTotal(foldersMap[key]);
      });
      return total;
    }

    order.forEach((key) => {
      const node = foldersMap[key];
      if (!node) return;
      const path = node.path || '';
      const name = node.name || key;
      const depth = path ? path.split('/').filter(Boolean).length : 0;
      const count = countTotal(node);
      result.push({ path, name, depth, count });
      result.push(...collectFoldersFromTree(node));
    });
    return result;
  }

  /**
   * 横向标签模式使用的文件夹列表：从数据源（树）获取，确保所有文件夹都展示
   */
  function getRowsForTabsMode() {
    const bookmarksForTree = Array.isArray(lastRenderedBookmarks)
      ? lastRenderedBookmarks
      : [];
    const foldersForTree =
      (window.__popupFoldersForDrawer && Array.isArray(window.__popupFoldersForDrawer))
        ? window.__popupFoldersForDrawer
        : null;
    const hasData =
      (bookmarksForTree && bookmarksForTree.length) ||
      (foldersForTree && foldersForTree.length);
    if (!hasData || typeof buildFolderTree !== 'function') {
      return [];
    }
    const tree = buildFolderTree(bookmarksForTree, foldersForTree);
    return collectFoldersFromTree(tree);
  }

  function renderFolderDrawerContent() {
    const drawerTree = document.getElementById('folderDrawerTree');
    const drawerTabs = document.getElementById('folderDrawerTabs');
    const modeLabel = document.getElementById('folderDrawerModeLabel');
    const backBtn = document.getElementById('folderDrawerBack');
    if (!drawerTree || !drawerTabs || !modeLabel) return;

    const rows =
      folderNavMode === 'tabs'
        ? getRowsForTabsMode()
        : collectFolderRows();

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
                ${clickable ? '<span class="folder-drawer-item-expand" title="展开子文件夹">›</span>' : ''}
              </div>
            `;
          })
          .join('');

        drawerTree
          .querySelectorAll('.folder-drawer-item')
          .forEach((item) => {
            item.addEventListener('click', (e) => {
              const path = item.dataset.folder || '';
              const normalized = safeNormalizePath(path);
              if (!normalized) return;

              // 点击箭头：在抽屉内展开该文件夹的子文件夹
              if (e.target.classList.contains('folder-drawer-item-expand')) {
                e.preventDefault();
                e.stopPropagation();
                currentFolderPath = normalized;
                currentTabsParentPath = normalized;
                renderFolderDrawerContent();
                return;
              }
              // 点击名称/数量区域：主列表跳转到该文件夹并关闭抽屉
              currentFolderPath = normalized;
              scrollToFolder(normalized);
              closeFolderDrawer();
            });
          });
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

      const bookmarksForTree = Array.isArray(lastRenderedBookmarks)
        ? lastRenderedBookmarks
        : [];
      const foldersForTree =
        (window.__popupFoldersForDrawer && Array.isArray(window.__popupFoldersForDrawer))
          ? window.__popupFoldersForDrawer
          : null;

      if (!bookmarksForTree.length || typeof buildFolderTree !== 'function') {
        drawerTree.innerHTML =
          '<div class="folder-drawer-empty">当前视图中没有可用的文件夹目录。</div>';
      } else {
        const tree = buildFolderTree(bookmarksForTree, foldersForTree);

        function countTotal(node) {
          const foldersMap = node.folders || {};
          const items = node.items || [];
          let total = items.length;
          Object.keys(foldersMap).forEach((key) => {
            total += countTotal(foldersMap[key]);
          });
          return total;
        }

        function renderTree(node, depth) {
          const foldersMap = node.folders || {};
          const order = node.order || Object.keys(foldersMap);
          const entries = order.map((key) => foldersMap[key]).filter(Boolean);

          return entries
            .map((child) => {
              const childDepth = Math.min(Math.max(depth + 1, 1), 5);
              const isActive =
                safeNormalizePath(child.path) === safeNormalizePath(currentFolderPath);
              const totalCount = countTotal(child);
              const childrenHtml = renderTree(child, childDepth);
              return `
                <div class="folder-block">
                  <div
                    class="folder-drawer-item depth-${childDepth} ${
                      isActive ? 'active' : ''
                    } has-children"
                    data-folder="${child.path}"
                    title="${child.path}"
                  >
                    <span class="folder-drawer-item-label">${child.name}</span>
                    <span class="folder-drawer-item-count">${totalCount}</span>
                  </div>
                  ${childrenHtml}
                </div>
              `;
            })
            .join('');
        }

        drawerTree.innerHTML = renderTree(tree, 0);

        drawerTree
          .querySelectorAll('.folder-drawer-item')
          .forEach((item) =>
            item.addEventListener('click', () => {
              const path = item.dataset.folder || '';
              const normalized = safeNormalizePath(path);
              if (!normalized) return;
              currentFolderPath = normalized;
              // 树形目录：点击目录项时，打开/定位并关闭抽屉，方便快速跳转
              scrollToFolder(normalized);
              closeFolderDrawer();
            })
          );
      }
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

  function renderFavoriteDrawer() {
    const listEl = document.getElementById('favoriteDrawerList');
    if (!listEl) return;

    const source = Array.isArray(lastRenderedBookmarks) ? lastRenderedBookmarks : [];
    const favorites = source.filter((b) => b && b.starred);

    if (!favorites.length) {
      listEl.innerHTML =
        '<div class="folder-drawer-empty">暂无收藏书签。可以在弹窗中将删除按钮切换为收藏按钮后，给常用书签加星。</div>';
      return;
    }

    listEl.innerHTML = favorites
      .map((b) => {
        const id = escapeHtml(b.id || '');
        const folder =
          typeof b.folder === 'string' && b.folder.trim()
            ? b.folder.trim()
            : '';
        const folderHtml = folder
          ? `<div class="bookmark-item-folder" data-favorite-folder-link="1" data-folder="${escapeHtml(
              folder
            )}">所在：${escapeHtml(folder)}</div>`
          : '';
        return `
        <div class="bookmark-item" data-url="${escapeHtml(
          b.url || ''
        )}" data-id="${id}">
          <div class="bookmark-item-content">
            <div class="bookmark-item-title">${escapeHtml(
              b.title || '无标题'
            )}</div>
            <div class="bookmark-item-url">${escapeHtml(b.url || '')}</div>
            ${folderHtml}
          </div>
        </div>
      `;
      })
      .join('');
  }

  function openFavoriteDrawer() {
    const drawer = document.getElementById('favoriteDrawer');
    if (!drawer) return;
    const backToTopBtn = document.getElementById('backToTopBtn');
    if (backToTopBtn) {
      backToTopBtn.style.display = 'none';
    }
    renderFavoriteDrawer();
    drawer.style.display = 'flex';
  }

  function closeFavoriteDrawer() {
    const drawer = document.getElementById('favoriteDrawer');
    if (!drawer) return;
    drawer.style.display = 'none';
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

    const folderToggleBtn = document.getElementById('folderDrawerToggle');
    const folderDrawer = document.getElementById('folderDrawer');
    const folderMask = folderDrawer
      ? folderDrawer.querySelector('.folder-drawer-mask')
      : null;
    const folderClose = document.getElementById('folderDrawerClose');

    if (folderToggleBtn) {
      folderToggleBtn.addEventListener('click', () => {
        openFolderDrawer();
      });
    }

    if (folderMask) {
      folderMask.addEventListener('click', () => {
        closeFolderDrawer();
      });
    }

    if (folderClose) {
      folderClose.addEventListener('click', () => {
        closeFolderDrawer();
      });
    }

    const favoriteToggleBtn = document.getElementById('favoriteDrawerToggle');
    const favoriteDrawer = document.getElementById('favoriteDrawer');
    const favoriteMask = favoriteDrawer
      ? favoriteDrawer.querySelector('.folder-drawer-mask')
      : null;
    const favoriteClose = document.getElementById('favoriteDrawerClose');

    if (favoriteToggleBtn) {
      favoriteToggleBtn.addEventListener('click', () => {
        openFavoriteDrawer();
      });
    }

    if (favoriteMask) {
      favoriteMask.addEventListener('click', () => {
        closeFavoriteDrawer();
      });
    }

    if (favoriteClose) {
      favoriteClose.addEventListener('click', () => {
        closeFavoriteDrawer();
      });
    }

    setupScrollListener();
    setupBookmarkObserver();
  });
})();

