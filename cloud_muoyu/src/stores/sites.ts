import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

/** 站点预设(快捷栏) - 支持默认站 + 用户收藏,均可删除 */
export interface Site {
  name: string;
  icon: string;
  url: string;
  builtin?: boolean; // 默认站,可删除;删除后重装可回来
}

const STORAGE_KEY = "muoyu-sites-v1";

const DEFAULT_SITES: Site[] = [
  { name: "微信读书", icon: "📖", url: "https://weread.qq.com", builtin: true },
  { name: "番茄小说", icon: "🍅", url: "https://fanqienovel.com", builtin: true },
  { name: "晋江", icon: "📚", url: "https://m.jjwxc.net", builtin: true },
  { name: "B 站", icon: "🎬", url: "https://www.bilibili.com", builtin: true },
  { name: "小红书", icon: "📕", url: "https://www.xiaohongshu.com", builtin: true },
  { name: "知乎", icon: "💡", url: "https://www.zhihu.com", builtin: true },
];

function loadPersisted(): Site[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [...DEFAULT_SITES];
    const parsed = JSON.parse(raw) as Site[];
    if (!Array.isArray(parsed)) return [...DEFAULT_SITES];
    return parsed;
  } catch {
    return [...DEFAULT_SITES];
  }
}

export const useSitesStore = defineStore("sites", () => {
  const sites = ref<Site[]>(loadPersisted());

  watch(sites, (v) => localStorage.setItem(STORAGE_KEY, JSON.stringify(v)), { deep: true });

  const hasUrl = (url: string) => sites.value.some((s) => s.url === url);

  function add(site: Site) {
    if (hasUrl(site.url)) return;
    sites.value.push({ ...site, builtin: false });
  }

  function remove(url: string) {
    const i = sites.value.findIndex((s) => s.url === url);
    if (i >= 0) sites.value.splice(i, 1);
  }

  function resetDefaults() {
    sites.value = [...DEFAULT_SITES];
  }

  /** 从 URL 猜 icon(域名首字符 emoji fallback) */
  function guessIcon(url: string): string {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (host.includes("bilibili")) return "🎬";
      if (host.includes("douyin") || host.includes("tiktok")) return "🎵";
      if (host.includes("xiaohongshu")) return "📕";
      if (host.includes("weibo")) return "📢";
      if (host.includes("zhihu")) return "💡";
      if (host.includes("weread") || host.includes("book")) return "📖";
      if (host.includes("novel") || host.includes("wxwx") || host.includes("jjwxc")) return "📚";
      if (host.includes("youtube")) return "▶️";
      if (host.includes("github")) return "🐙";
    } catch { /* ignore */ }
    return "🌐";
  }

  const canAddCurrent = computed(() => (url: string) => !!url && !hasUrl(url));

  return { sites, add, remove, resetDefaults, guessIcon, hasUrl, canAddCurrent };
});
