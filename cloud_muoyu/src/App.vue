<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick, watch, computed } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { useMouseAutoHide } from "./composables/useMouseAutoHide";
import { useTabsStore } from "./stores/tabs";
import type { PipRatio } from "./stores/tabs";
import { useSitesStore } from "./stores/sites";
import SettingsView from "./views/SettingsView.vue";
import TabBar from "./components/TabBar.vue";

// ────── 窗口 / 全局设置 ──────
const win = getCurrentWindow();
const opacity = ref(1);
const showSettings = ref(false);
const isHidden = ref(false);
const tabs = useTabsStore();
const sitesStore = useSitesStore();

const STORAGE_KEY = "muoyu-settings-v1";
interface Settings {
  autoHide: boolean;
  autoHideDelay: number;
  videoAutoLandscape: boolean;
  bossKey: string;
}
const defaults: Settings = {
  autoHide: false,
  autoHideDelay: 1500,
  videoAutoLandscape: true,
  bossKey: "Ctrl+Alt+KeyQ",
};
const loaded: Settings = (() => {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") };
  } catch {
    return { ...defaults };
  }
})();
const autoHide = ref(loaded.autoHide);
const autoHideDelay = ref(loaded.autoHideDelay);
const videoAutoLandscape = ref(loaded.videoAutoLandscape);
const bossKey = ref(loaded.bossKey);

watch(
  [autoHide, autoHideDelay, videoAutoLandscape, bossKey],
  () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        autoHide: autoHide.value,
        autoHideDelay: autoHideDelay.value,
        videoAutoLandscape: videoAutoLandscape.value,
        bossKey: bossKey.value,
      }),
    );
  },
);

useMouseAutoHide(autoHide, autoHideDelay);

async function minimize() { await win.minimize(); }
async function close() { await win.close(); }

function onOpacityInput(e: Event) {
  const v = Number((e.target as HTMLInputElement).value);
  opacity.value = v;
  document.body.style.setProperty("--shell-alpha", String(v));
  invoke("set_all_web_tabs_opacity", { opacity: v }).catch(() => {});
}
async function triggerBossKey() { await invoke("trigger_boss_key"); }

// 设置打开时全部 tab 隐藏,关闭时按当前活跃恢复
watch(showSettings, async (v) => {
  if (v) {
    for (const t of tabs.tabs) {
      if (t.mode !== "pip") await invoke("set_web_tab_visible", { id: t.id, visible: false }).catch(() => {});
    }
  } else if (tabs.active && tabs.active.mode === "inline") {
    await syncCurrentTab();
    await invoke("set_web_tab_visible", { id: tabs.active.id, visible: true }).catch(() => {});
  }
});

// ────── 内置站点 ──────
// 站点数据已迁到 useSitesStore,支持增删

// ────── WebView 承载 ──────
const address = ref("");
const loading = ref(false);
const holder = ref<HTMLDivElement | null>(null);

const activeTab = computed(() => tabs.active);

/** 把 holder 的屏幕坐标同步给当前活跃 tab(inline 模式) */
async function syncCurrentTab() {
  const t = tabs.active;
  if (!t || t.mode !== "inline" || !holder.value) return;
  const rect = holder.value.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const outer = await win.outerPosition();
  const inner = await win.innerPosition();
  const chromeOffsetX = (outer.x - inner.x) / scale;
  const chromeOffsetY = (outer.y - inner.y) / scale;

  const x = inner.x / scale + rect.left + chromeOffsetX;
  const y = inner.y / scale + rect.top + chromeOffsetY;
  await invoke("resize_web_tab", {
    id: t.id, x, y, width: rect.width, height: rect.height,
  });
}

/** 视觉激活:先把位置摆好、再显示、最后 focus——顺序错任何一个都会有 bug */
async function activateVisual(id: string) {
  const t = tabs.tabs.find((x) => x.id === id);
  if (!t || t.mode === "pip") return;
  // 1) 先把当前 tab 摆到 holder 位置(此时可能还没显示,不影响)
  await syncCurrentTab();
  // 2) 只显示当前 tab,其余 hide
  await invoke("set_web_tab_visible_only", { id });
  // 3) 再 sync 一次,防止 show 触发的 layout 抖动导致位置飘
  await syncCurrentTab();
  // 4) focus 让子窗口接收键鼠事件(Windows 上 show 不自动 focus)
  await invoke("focus_web_tab", { id }).catch(() => {});
}

async function openSite(url: string, hint?: { name: string; icon: string }) {
  if (!holder.value) return;
  const rect = holder.value.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const outer = await win.outerPosition();
  const inner = await win.innerPosition();
  const chromeOffsetX = (outer.x - inner.x) / scale;
  const chromeOffsetY = (outer.y - inner.y) / scale;
  const x = inner.x / scale + rect.left + chromeOffsetX;
  const y = inner.y / scale + rect.top + chromeOffsetY;

  const existed = tabs.tabs.find((t) => t.url === url);
  const id = tabs.openOrFocus(url, hint?.name, hint?.icon, videoAutoLandscape.value);
  address.value = url;

  loading.value = true;
  try {
    if (!existed) {
      await invoke("open_web_tab", { id, url, x, y, width: rect.width, height: rect.height });
      await invoke("set_web_tab_opacity", { id, opacity: opacity.value });
    }
    await activateVisual(id);
  } catch (e) {
    console.error("open_web_tab failed", e);
  } finally {
    loading.value = false;
  }
}

async function go() {
  let url = address.value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  await openSite(url);
}

async function switchTab(id: string) {
  tabs.activate(id);
  address.value = tabs.active?.url ?? "";
  if (tabs.active && tabs.active.mode !== "pip") {
    await activateVisual(id);
  }
}

function closeTabById(id: string) {
  tabs.closeTab(id);
  if (tabs.active) {
    address.value = tabs.active.url;
    activateVisual(tabs.active.id);
  } else {
    address.value = "";
  }
}

// ────── 收藏当前 URL / 删除快捷站点 ──────
const canFav = computed(() => {
  const url = tabs.active?.url || address.value.trim();
  return !!url && !sitesStore.hasUrl(url);
});
function favCurrent() {
  const t = tabs.active;
  const url = t?.url || address.value.trim();
  if (!url) return;
  sitesStore.add({
    name: t?.title || new URL(url.startsWith("http") ? url : "https://" + url).hostname,
    icon: t?.icon || sitesStore.guessIcon(url),
    url: url.startsWith("http") ? url : "https://" + url,
  });
}
function removeSite(url: string, ev: MouseEvent) {
  ev.stopPropagation();
  sitesStore.remove(url);
}

// ────── 导航 ──────
async function goBack() {
  if (!tabs.active) return;
  await invoke("web_tab_go_back", { id: tabs.active.id }).catch(() => {});
}
async function goForward() {
  if (!tabs.active) return;
  await invoke("web_tab_go_forward", { id: tabs.active.id }).catch(() => {});
}
async function reload() {
  if (!tabs.active) return;
  await invoke("web_tab_reload", { id: tabs.active.id }).catch(() => {});
}

// ────── 右键菜单(独立 Tauri 窗口) ──────
interface CtxItem { key: string; label: string; icon?: string; divider?: boolean; disabled?: boolean; }
let pendingCtxTargetId: string | null = null;

function ctxItemsForTab(tabId: string | null): CtxItem[] {
  const t = tabId ? tabs.tabs.find((x) => x.id === tabId) : tabs.active;
  if (!t) return [];
  return [
    { key: "back",       label: "◂ 后退" },
    { key: "forward",    label: "▸ 前进" },
    { key: "reload",     label: "⟳ 刷新" },
    { key: "d1",         label: "",  divider: true },
    { key: "popout",     label: t.mode === "popout"     ? "回到摸鱼窗口" : "独立窗口",     icon: "⧉" },
    { key: "pip",        label: t.mode === "pip"        ? "回到摸鱼窗口" : "画中画",       icon: "⛶" },
    { key: "fullscreen", label: t.mode === "fullscreen" ? "退出全屏"     : "应用内全屏",   icon: "⛶" },
    { key: "d2",         label: "",  divider: true },
    { key: "close",      label: "关闭标签",       icon: "✕" },
  ];
}

/** 打开独立菜单窗口(能盖住 web-tab) */
async function openContextMenu(e: MouseEvent, tabId?: string) {
  e.preventDefault();
  const targetId = tabId ?? tabs.active?.id ?? null;
  if (!targetId) return;
  pendingCtxTargetId = targetId;

  const items = ctxItemsForTab(targetId);
  // 尺寸预算:每项 32px + padding 8,菜单宽 180
  const w = 180;
  const h = items.length * 32 + 8;

  // 转成屏幕物理坐标(菜单是独立窗口,坐标以屏幕为基准)
  const scale = window.devicePixelRatio || 1;
  const outer = await win.outerPosition();
  const inner = await win.innerPosition();
  const chromeOffsetX = (outer.x - inner.x) / scale;
  const chromeOffsetY = (outer.y - inner.y) / scale;

  const screenX = inner.x / scale + chromeOffsetX + e.clientX;
  const screenY = inner.y / scale + chromeOffsetY + e.clientY;

  // 边界翻转(菜单不超出屏幕)
  const maxX = window.screen.availWidth - w - 4;
  const maxY = window.screen.availHeight - h - 4;
  const finalX = Math.min(screenX, maxX);
  const finalY = Math.min(screenY, maxY);

  await invoke("show_context_menu", {
    x: finalX,
    y: finalY,
    width: w,
    height: h,
    data: encodeURIComponent(JSON.stringify(items)),
  });
}

/** 标题栏"⋯"按钮:菜单在按钮正下方弹出 */
async function openTitlebarMenu(e: MouseEvent) {
  if (!tabs.active) return;
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  // 构造一个假的 MouseEvent-like,复用 openContextMenu 逻辑
  const fakeE = {
    preventDefault() {},
    clientX: rect.left,
    clientY: rect.bottom + 4,
  } as MouseEvent;
  await openContextMenu(fakeE, tabs.active.id);
}

async function pickContextMenu(key: string) {
  const targetId = pendingCtxTargetId ?? tabs.active?.id ?? null;
  pendingCtxTargetId = null;
  if (!targetId) return;
  const t = tabs.tabs.find((x) => x.id === targetId);
  if (!t) return;

  switch (key) {
    case "back":       return goBack();
    case "forward":    return goForward();
    case "reload":     return reload();
    case "close":      return closeTabById(targetId);
    case "popout":
      if (t.mode === "popout") return restoreInline(targetId);
      return popOut(targetId);
    case "pip":
      if (t.mode === "pip") return restoreInline(targetId);
      { const size = pipDefaultSize(t.pipRatio);
        const x = window.screen.availWidth - size.w - 24;
        const y = window.screen.availHeight - size.h - 24;
        await invoke("enter_pip", { id: targetId, x, y, width: size.w, height: size.h });
        await invoke("set_web_tab_resizable", { id: targetId, resizable: false });
        tabs.setMode(targetId, "pip");
      }
      return;
    case "fullscreen":
      if (t.mode === "fullscreen") return restoreInline(targetId);
      return fullscreenInApp(targetId);
  }
}

// ────── PiP / Popout / Fullscreen 三种脱离 mode ──────

/** 视频站默认 480×270(16:9),其它 400×560(4:3-ish) */
function pipDefaultSize(ratio: PipRatio): { w: number; h: number } {
  if (ratio === "16:9") return { w: 480, h: 270 };
  if (ratio === "4:3") return { w: 400, h: 300 };
  return { w: 420, h: 320 };
}

async function togglePip() {
  const t = tabs.active;
  if (!t) return;
  if (t.mode === "pip") {
    await restoreInline(t.id);
  } else {
    const size = pipDefaultSize(t.pipRatio);
    const x = window.screen.availWidth - size.w - 24;
    const y = window.screen.availHeight - size.h - 24;
    await invoke("enter_pip", { id: t.id, x, y, width: size.w, height: size.h });
    await invoke("set_web_tab_resizable", { id: t.id, resizable: false });
    tabs.setMode(t.id, "pip");
  }
}

/** 独立浮窗:大尺寸+可缩放+系统标题栏(可拖可关) */
async function popOut(id?: string) {
  const t = id ? tabs.tabs.find((x) => x.id === id) : tabs.active;
  if (!t) return;
  const w = 900, h = 640;
  const x = Math.round((window.screen.availWidth - w) / 2);
  const y = Math.round((window.screen.availHeight - h) / 2);
  await invoke("enter_pip", { id: t.id, x, y, width: w, height: h });
  await invoke("set_web_tab_resizable", { id: t.id, resizable: true });
  // 开系统标题栏,进任务栏,取消置顶——完全独立可操作
  await invoke("set_web_tab_chrome", {
    id: t.id,
    decorations: true,
    skipTaskbar: false,
    alwaysOnTop: false,
    title: `🐟 ${t.title || t.url}`,
  });
  tabs.setMode(t.id, "popout");
}

/** 应用内全屏:webview 占满整个 shell 位置(把地址栏/tabbar 遮住) */
async function fullscreenInApp(id?: string) {
  const t = id ? tabs.tabs.find((x) => x.id === id) : tabs.active;
  if (!t) return;
  // 先把 mode 改掉,DOM 更新后再 sync 位置(遮住 tabbar/toolbar)
  tabs.setMode(t.id, "fullscreen");
  await nextTick();
  await syncFullscreenTab(t.id);
  await invoke("set_web_tab_visible_only", { id: t.id }).catch(() => {});
  await invoke("focus_web_tab", { id: t.id }).catch(() => {});
}

/** fullscreen 时把子窗口拉满整个 shell 内容区(去掉 titlebar) */
async function syncFullscreenTab(id: string) {
  const scale = window.devicePixelRatio || 1;
  const outer = await win.outerPosition();
  const inner = await win.innerPosition();
  const chromeOffsetX = (outer.x - inner.x) / scale;
  const chromeOffsetY = (outer.y - inner.y) / scale;
  // shell 内容区 = 主窗口内部区域减去 titlebar(36px)
  const size = await win.innerSize();
  const w = size.width / scale;
  const h = size.height / scale - 36;
  const x = inner.x / scale + chromeOffsetX;
  const y = inner.y / scale + chromeOffsetY + 36;
  await invoke("resize_web_tab", { id, x, y, width: w, height: h });
}

/** 回到嵌入模式 */
async function restoreInline(id: string) {
  await invoke("exit_pip", { id }).catch(() => {});
  await invoke("set_web_tab_resizable", { id, resizable: false });
  // 恢复:关系统标题栏,退出任务栏,回到主窗口子级外观
  await invoke("set_web_tab_chrome", {
    id,
    decorations: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    title: null,
  }).catch(() => {});
  tabs.setMode(id, "inline");
  await nextTick();
  await activateVisual(id);
}

// ────── 生命周期 ──────
let unlistenMove: (() => void) | undefined;
let unlistenResize: (() => void) | undefined;
let unlistenBoss: (() => void) | undefined;
let unlistenCtx: (() => void) | undefined;
let unlistenCloseReq: (() => void) | undefined;
let ro: ResizeObserver | undefined;

onMounted(async () => {
  await nextTick();
  // 主窗口移动/缩放 → 根据当前 tab mode 同步
  const onWinChange = () => {
    const t = tabs.active;
    if (!t) return;
    if (t.mode === "fullscreen") syncFullscreenTab(t.id);
    else if (t.mode === "inline") syncCurrentTab();
    // pip / popout 独立浮动,不跟主窗口
  };
  unlistenMove = await win.onMoved(onWinChange);
  unlistenResize = await win.onResized(onWinChange);
  if (holder.value) {
    ro = new ResizeObserver(() => {
      if (tabs.active?.mode === "inline") syncCurrentTab();
    });
    ro.observe(holder.value);
  }
  unlistenBoss = await win.listen<boolean>("boss-key-toggled", (evt) => {
    isHidden.value = evt.payload;
  });
  // 独立菜单窗口选中项后广播
  unlistenCtx = await win.listen<string>("ctx-menu-pick", (evt) => {
    pickContextMenu(evt.payload);
  });
  // popout 窗口用户按 ✕:不销毁 tab,切回 inline
  unlistenCloseReq = await win.listen<{ id: string; label: string }>(
    "web-tab-close-requested",
    (evt) => {
      const t = tabs.tabs.find((x) => x.id === evt.payload.id);
      if (!t) return;
      // 独立浮窗/画中画/全屏:按 ✕ 都视为"回到摸鱼窗口"
      if (t.mode !== "inline") {
        restoreInline(t.id);
      } else {
        // inline 状态下用户从任务栏关(理论上不会,skip_taskbar=true)——真关
        tabs.closeTab(t.id);
      }
    },
  );
  isHidden.value = await invoke<boolean>("is_hidden");

  if (tabs.active) address.value = tabs.active.url;
});

onBeforeUnmount(() => {
  unlistenMove?.();
  unlistenResize?.();
  unlistenBoss?.();
  unlistenCtx?.();
  unlistenCloseReq?.();
  ro?.disconnect();
});
</script>

<template>
  <div class="shell" :class="{ 'is-fullscreen': activeTab?.mode === 'fullscreen' }" @contextmenu="openContextMenu">
    <!-- 顶部自定义标题栏 -->
    <header class="titlebar" data-tauri-drag-region>
      <span class="brand" data-tauri-drag-region>🐟 云摸鱼</span>
      <div class="drag-spacer" data-tauri-drag-region></div>
      <div class="titlebar-actions">
        <label class="opacity" v-if="activeTab?.mode !== 'fullscreen'">
          <span data-tauri-drag-region>透明度</span>
          <input type="range" min="0.2" max="1" step="0.05" :value="opacity" @input="onOpacityInput" />
        </label>
        <button
          class="btn"
          :class="{ toggled: activeTab && activeTab.mode !== 'inline' }"
          :disabled="!activeTab"
          @click="togglePip"
          :title="activeTab?.mode === 'pip' ? '退出画中画' : '画中画(小窗置顶)'"
        >⛶</button>
        <button
          class="btn"
          :disabled="!activeTab"
          @click="openTitlebarMenu"
          title="当前 tab 操作菜单(后退/前进/独立窗口/全屏…)"
        >⋯</button>
        <button class="btn" @click="triggerBossKey" title="老板键">🚨</button>
        <button class="btn" @click="showSettings = !showSettings" title="设置">⚙</button>
        <button class="btn" @click="minimize" title="最小化">—</button>
        <button class="btn close" @click="close" title="关闭">✕</button>
      </div>
    </header>

    <!-- 独立设置视图 -->
    <SettingsView
      v-if="showSettings"
      :auto-hide="autoHide"
      :auto-hide-delay="autoHideDelay"
      :video-auto-landscape="videoAutoLandscape"
      :boss-key="bossKey"
      @update:auto-hide="autoHide = $event"
      @update:auto-hide-delay="autoHideDelay = $event"
      @update:video-auto-landscape="videoAutoLandscape = $event"
      @update:boss-key="bossKey = $event"
      @close="showSettings = false"
    />

    <!-- fullscreen 模式下隐藏地址栏和 tabbar -->
    <template v-if="activeTab?.mode !== 'fullscreen'">
      <!-- 地址栏 + 站点预设 -->
      <div class="toolbar">
        <div class="address">
          <button class="btn" @click="goBack" :disabled="!activeTab" title="后退">◂</button>
          <button class="btn" @click="goForward" :disabled="!activeTab" title="前进">▸</button>
          <button class="btn" @click="reload" :disabled="!activeTab" title="刷新">⟳</button>
          <input v-model="address" placeholder="输入网址或从下方选站点开摸" @keydown.enter="go" />
          <button
            class="btn"
            :disabled="!canFav"
            @click="favCurrent"
            :title="canFav ? '收藏到快捷栏' : '已在快捷栏或无有效网址'"
          >⭐</button>
          <button class="btn primary" @click="go" :disabled="loading">
            {{ loading ? "…" : "打开" }}
          </button>
        </div>
        <div class="sites">
          <div
            v-for="s in sitesStore.sites"
            :key="s.url"
            class="site"
            :class="{ active: activeTab?.url === s.url }"
            @click="openSite(s.url, s)"
            :title="s.url"
          >
            <span class="icon">{{ s.icon }}</span>
            <span class="name">{{ s.name }}</span>
            <span class="site-x" @click="(e) => removeSite(s.url, e)" title="从快捷栏删除">×</span>
          </div>
        </div>
      </div>

      <!-- 多标签栏 -->
      <TabBar @switch="switchTab" @close="closeTabById" @contextmenu="(e, id) => openContextMenu(e, id)" />
    </template>

    <!-- WebView 承载区 -->
    <main class="content" :class="{ 'fs-content': activeTab?.mode === 'fullscreen' }">
      <div ref="holder" class="web-holder">
        <div v-if="!activeTab || activeTab.mode === 'pip' || activeTab.mode === 'popout'" class="hero">
          <h1>🐟 云摸鱼</h1>
          <p v-if="activeTab?.mode === 'pip'" class="tag">当前 tab 已进入画中画,浮在屏幕右下</p>
          <p v-else-if="activeTab?.mode === 'popout'" class="tag">当前 tab 已独立浮窗</p>
          <p v-else class="tag">选一个站点开摸,或粘贴网址到地址栏</p>
          <p class="tip">
            <template v-if="activeTab && activeTab.mode !== 'inline' && activeTab.mode !== 'fullscreen'">
              点下方按钮收回到摸鱼窗口
            </template>
            <template v-else>
              ✨ 提示:右键任何位置打开菜单 · Ctrl+Alt+Q 老板键 · ⚙ 打开设置
            </template>
          </p>
          <button
            v-if="activeTab && (activeTab.mode === 'pip' || activeTab.mode === 'popout')"
            class="btn primary big"
            @click="restoreInline(activeTab.id)"
          >↩ 回到摸鱼窗口</button>
        </div>
      </div>
    </main>

    <!-- Fullscreen 时的浮动返回按钮(右上角,永远置顶) -->
    <button
      v-if="activeTab?.mode === 'fullscreen'"
      class="fs-back"
      @click="restoreInline(activeTab.id)"
      title="退出全屏"
    >↩ 退出全屏</button>

    <!-- 右键菜单已改为独立 Tauri 窗口(能盖住 web-tab),不在 DOM 里渲染 -->
  </div>
</template>

<style>
:root {
  --shell-alpha: 1;
  color-scheme: dark;
}

html, body, #app {
  height: 100%;
  margin: 0;
  padding: 0;
  background: transparent;
  color: #e6edf3;
  font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  overflow: hidden;
  user-select: none;
}

.shell {
  position: relative;
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: rgba(22, 27, 34, calc(var(--shell-alpha) * 0.85));
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.titlebar {
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 0 14px;
  background: rgba(13, 17, 23, calc(var(--shell-alpha) * 0.6));
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  flex-shrink: 0;
}
.brand { font-size: 13px; letter-spacing: 0.5px; opacity: 0.9; }
.titlebar-actions { display: flex; align-items: center; gap: 10px; }
.drag-spacer { flex: 1; height: 100%; min-width: 40px; }
.opacity {
  display: flex; align-items: center; gap: 6px;
  font-size: 11px; opacity: 0.65;
}
.opacity input[type="range"] { width: 90px; accent-color: #58a6ff; }

.btn {
  min-width: 28px;
  height: 26px;
  padding: 0 8px;
  border: none;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  color: #c9d1d9;
  cursor: pointer;
  font-size: 12px;
  transition: background 0.15s, color 0.15s;
}
.btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.12); }
.btn:disabled { opacity: 0.35; cursor: not-allowed; }
.btn.close:hover { background: #da3633; color: #fff; }
.btn.primary { background: #1f6feb; color: #fff; }
.btn.primary:hover:not(:disabled) { background: #388bfd; }
.btn.toggled {
  background: rgba(31, 111, 235, 0.25);
  color: #58a6ff;
  border: 1px solid rgba(88, 166, 255, 0.4);
}

.toolbar {
  padding: 8px 12px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  background: rgba(13, 17, 23, calc(var(--shell-alpha) * 0.4));
  flex-shrink: 0;
}
.address {
  display: flex; gap: 6px; margin-bottom: 8px;
}
.address input {
  flex: 1; height: 30px; padding: 0 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.04);
  color: #e6edf3; font-size: 12px; outline: none;
  transition: border-color 0.15s;
}
.address input:focus { border-color: #58a6ff; }

.sites {
  display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none;
}
.sites::-webkit-scrollbar { display: none; }
.site {
  position: relative;
  display: flex; align-items: center; gap: 5px;
  padding: 5px 22px 5px 10px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.03);
  color: #c9d1d9;
  cursor: pointer;
  font-size: 12px; white-space: nowrap;
  transition: all 0.15s;
}
.site:hover { background: rgba(255, 255, 255, 0.08); }
.site.active {
  background: rgba(31, 111, 235, 0.2);
  border-color: #1f6feb;
  color: #58a6ff;
}
.site .icon { font-size: 14px; }
.site-x {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  width: 14px; height: 14px;
  line-height: 12px;
  text-align: center;
  border-radius: 50%;
  font-size: 12px;
  color: #6e7681;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s;
}
.site:hover .site-x { opacity: 1; }
.site-x:hover {
  background: rgba(255, 100, 100, 0.3);
  color: #f85149;
}

.content {
  flex: 1; padding: 6px 10px 10px; min-height: 0;
}
.content.fs-content {
  padding: 0;
}
.shell.is-fullscreen .web-holder {
  border-radius: 0;
  border: none;
}
.web-holder {
  width: 100%; height: 100%;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(255, 255, 255, 0.04);
  display: flex; align-items: center; justify-content: center;
  overflow: hidden;
}
.hero { text-align: center; }
.hero h1 { margin: 0 0 8px; font-size: 32px; font-weight: 600; }
.tag { margin: 0 0 6px; color: #8b949e; font-size: 13px; }
.tip { margin: 12px 0 16px; color: #6e7681; font-size: 11px; }

.btn.big {
  height: 36px;
  padding: 0 20px;
  font-size: 13px;
  border-radius: 8px;
}

.fs-back {
  position: absolute;
  top: 44px;
  right: 12px;
  z-index: 20;
  height: 30px;
  padding: 0 14px;
  border: none;
  border-radius: 15px;
  background: rgba(31, 111, 235, 0.85);
  color: #fff;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(8px);
  transition: background 0.15s;
}
.fs-back:hover { background: #388bfd; }
</style>
