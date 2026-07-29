import { onBeforeUnmount, onMounted, watch, type Ref } from "vue";
import { invoke } from "@tauri-apps/api/core";

/**
 * 鼠标移出主窗口 N 秒后自动隐藏（隐藏 = 主窗口 opacity 极低 + 子 WebView 隐藏）。
 * 鼠标再次进入立即恢复。
 *
 * @param enabled 是否启用
 * @param delayMs 离开多久后触发隐藏
 * @param dim     隐藏时的整体透明度（0-1），默认 0.05——看不见但仍可点击命中
 */
export function useMouseAutoHide(
  enabled: Ref<boolean>,
  delayMs: Ref<number>,
  dim = 0.05,
) {
  let timer: number | undefined;
  let hidden = false;

  function clear() {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
  }

  async function doHide() {
    if (hidden) return;
    hidden = true;
    document.body.style.setProperty("--shell-alpha", String(dim));
    await invoke("set_web_tab_visible", { visible: false }).catch(() => {});
  }

  async function doShow() {
    if (!hidden) return;
    hidden = false;
    document.body.style.setProperty("--shell-alpha", "1");
    await invoke("set_web_tab_visible", { visible: true }).catch(() => {});
  }

  function onLeave() {
    if (!enabled.value) return;
    clear();
    timer = window.setTimeout(doHide, delayMs.value);
  }

  function onEnter() {
    clear();
    if (hidden) doShow();
  }

  onMounted(() => {
    document.documentElement.addEventListener("mouseleave", onLeave);
    document.documentElement.addEventListener("mouseenter", onEnter);
  });

  onBeforeUnmount(() => {
    clear();
    document.documentElement.removeEventListener("mouseleave", onLeave);
    document.documentElement.removeEventListener("mouseenter", onEnter);
  });

  // 关闭开关时立即恢复
  watch(enabled, (v) => {
    if (!v) {
      clear();
      doShow();
    }
  });
}
