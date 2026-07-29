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

// ────── PiP 画中画 ──────

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
    // 退出:回到 inline
    await invoke("exit_pip", { id: t.id });
    tabs.setMode(t.id, "inline");
    await syncCurrentTab();
  } else {
    // 进入:置顶到屏幕右下
    const size = pipDefaultSize(t.pipRatio);
    const screenW = window.screen.availWidth;
    const screenH = window.screen.availHeight;
    const x = screenW - size.w - 24;
    const y = screenH - size.h - 24;
    await invoke("enter_pip", { id: t.id, x, y, width: size.w, height: size.h });
    tabs.setMode(t.id, "pip");
  }
}

// ────── 生命周期 ──────
let unlistenMove: (() => void) | undefined;
let unlistenResize: (() => void) | undefined;
let unlistenBoss: (() => void) | undefined;
let ro: ResizeObserver | undefined;

onMounted(async () => {
  await nextTick();
  unlistenMove = await win.onMoved(() => syncCurrentTab());
  unlistenResize = await win.onResized(() => syncCurrentTab());
  if (holder.value) {
    ro = new ResizeObserver(() => syncCurrentTab());
    ro.observe(holder.value);
  }
  unlistenBoss = await win.listen<boolean>("boss-key-toggled", (evt) => {
    isHidden.value = evt.payload;
  });
  isHidden.value = await invoke<boolean>("is_hidden");

  // 若有持久化的 tabs,不自动重开子窗口(等用户点),避免开机弹一堆
  if (tabs.active) address.value = tabs.active.url;
});

onBeforeUnmount(() => {
  unlistenMove?.();
  unlistenResize?.();
  unlistenBoss?.();
  ro?.disconnect();
});
</script>

<template>
  <div class="shell">
    <!-- 顶部自定义标题栏 -->
    <header class="titlebar" data-tauri-drag-region>
      <span class="brand" data-tauri-drag-region>🐟 云摸鱼</span>
      <div class="drag-spacer" data-tauri-drag-region></div>
      <div class="titlebar-actions">
        <label class="opacity">
          <span data-tauri-drag-region>透明度</span>
          <input type="range" min="0.2" max="1" step="0.05" :value="opacity" @input="onOpacityInput" />
        </label>
        <button
          class="btn"
          :class="{ toggled: activeTab?.mode === 'pip' }"
          :disabled="!activeTab"
          @click="togglePip"
          :title="activeTab?.mode === 'pip' ? '退出画中画' : '画中画(小窗置顶)'"
        >⛶</button>
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

    <!-- 地址栏 + 站点预设 -->
    <div class="toolbar">
      <div class="address">
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
    <TabBar @switch="switchTab" @close="closeTabById" />

    <!-- WebView 承载区 -->
    <main class="content">
      <div ref="holder" class="web-holder">
        <div v-if="!activeTab || activeTab.mode === 'pip'" class="hero">
          <h1>🐟 云摸鱼</h1>
          <p v-if="activeTab?.mode === 'pip'" class="tag">当前 tab 已进入画中画,浮在屏幕右下</p>
          <p v-else class="tag">选一个站点开摸,或粘贴网址到地址栏</p>
          <p class="tip">✨ 提示:Ctrl+Alt+Q 老板键 · 点 ⛶ 进画中画 · ⚙ 打开设置</p>
        </div>
      </div>
    </main>
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
.tip { margin: 12px 0 0; color: #6e7681; font-size: 11px; }
</style>
