import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";

export type PipRatio = "16:9" | "4:3" | "free";
/** inline=嵌在主窗口；pip=画中画小窗；popout=独立可缩放窗口；fullscreen=应用内全屏 */
export type TabMode = "inline" | "pip" | "popout" | "fullscreen";

export interface Tab {
  id: string;
  url: string;
  title: string;
  icon?: string;
  mode: TabMode;
  pipRatio: PipRatio;
}

const STORAGE_KEY = "muoyu-tabs-v1";

// 视频站点关键字 → PiP 时默认走 16:9 大屏
const VIDEO_HOSTS = /bilibili\.com|youtube\.com|douyin\.com|iqiyi\.com|qq\.com\/tv|v\.qq\.com|youku\.com/i;

function detectPipRatio(url: string, autoLandscape: boolean): PipRatio {
  if (autoLandscape && VIDEO_HOSTS.test(url)) return "16:9";
  return "free";
}

function loadPersisted(): Tab[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Tab[];
    // 载入时统一 mode 为 inline,pip 状态不持久化(窗口坐标依赖运行时)
    return parsed.map((t) => ({ ...t, mode: "inline" as TabMode }));
  } catch {
    return [];
  }
}

export const useTabsStore = defineStore("tabs", () => {
  const tabs = ref<Tab[]>(loadPersisted());
  const activeId = ref<string | null>(tabs.value[0]?.id ?? null);

  const active = computed(() => tabs.value.find((t) => t.id === activeId.value) ?? null);
  const hasAny = computed(() => tabs.value.length > 0);

  watch(
    tabs,
    (v) => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(
          v.map((t) => ({ id: t.id, url: t.url, title: t.title, icon: t.icon, mode: "inline", pipRatio: t.pipRatio })),
        ),
      );
    },
    { deep: true },
  );

  function makeId() {
    return "t" + Math.floor(performance.now() * 1000).toString(36);
  }

  /** 新增或聚焦到已有 tab,返回 tab id */
  function openOrFocus(url: string, title?: string, icon?: string, autoLandscape = false): string {
    let t = tabs.value.find((x) => x.url === url);
    if (!t) {
      t = {
        id: makeId(),
        url,
        title: title ?? new URL(url).hostname,
        icon,
        mode: "inline",
        pipRatio: detectPipRatio(url, autoLandscape),
      };
      tabs.value.push(t);
    }
    activeId.value = t.id;
    return t.id;
  }

  /** 切换到指定 tab(不做窗口协调,交给调用方) */
  function activate(id: string) {
    if (tabs.value.some((t) => t.id === id)) activeId.value = id;
  }

  /** 关闭指定 tab;若关闭的是当前,自动激活相邻 */
  function closeTab(id: string) {
    const idx = tabs.value.findIndex((t) => t.id === id);
    if (idx < 0) return;
    tabs.value.splice(idx, 1);
    if (activeId.value === id) {
      activeId.value = tabs.value[Math.min(idx, tabs.value.length - 1)]?.id ?? null;
    }
    invoke("close_web_tab", { id }).catch(() => {});
  }

  function setMode(id: string, mode: TabMode, pipRatio?: PipRatio) {
    const t = tabs.value.find((x) => x.id === id);
    if (!t) return;
    t.mode = mode;
    if (pipRatio) t.pipRatio = pipRatio;
  }

  return { tabs, activeId, active, hasAny, openOrFocus, activate, closeTab, setMode };
});
