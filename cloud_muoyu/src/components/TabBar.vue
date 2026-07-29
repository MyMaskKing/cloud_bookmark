<script setup lang="ts">
import { useTabsStore } from "../stores/tabs";
const store = useTabsStore();

const emit = defineEmits<{
  (e: "switch", id: string): void;
  (e: "close", id: string): void;
}>();

function onSwitch(id: string) {
  emit("switch", id);
}
function onClose(e: MouseEvent, id: string) {
  e.stopPropagation();
  emit("close", id);
}
</script>

<template>
  <nav v-if="store.tabs.length" class="tabbar">
    <button
      v-for="t in store.tabs"
      :key="t.id"
      class="tab"
      :class="{ active: store.activeId === t.id, pip: t.mode === 'pip' }"
      :title="t.url"
      @click="onSwitch(t.id)"
    >
      <span v-if="t.icon" class="ic">{{ t.icon }}</span>
      <span class="ti">{{ t.title }}</span>
      <span v-if="t.mode === 'pip'" class="badge" title="正在画中画">⛶</span>
      <span class="x" @click="(e) => onClose(e, t.id)" title="关闭">×</span>
    </button>
  </nav>
</template>

<style scoped>
.tabbar {
  display: flex;
  gap: 4px;
  padding: 4px 10px 0;
  overflow-x: auto;
  scrollbar-width: none;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  background: rgba(13, 17, 23, calc(var(--shell-alpha) * 0.35));
  flex-shrink: 0;
}
.tabbar::-webkit-scrollbar { display: none; }

.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px 5px 10px;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 6px 6px 0 0;
  background: rgba(255, 255, 255, 0.03);
  color: #8b949e;
  cursor: pointer;
  font-size: 12px;
  max-width: 180px;
  min-width: 100px;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s;
}
.tab:hover {
  background: rgba(255, 255, 255, 0.06);
  color: #c9d1d9;
}
.tab.active {
  background: rgba(22, 27, 34, 0.9);
  color: #e6edf3;
  border-color: rgba(255, 255, 255, 0.08);
  border-bottom: 1px solid rgba(22, 27, 34, 0.9);
  margin-bottom: -1px;
}
.tab.pip {
  color: #58a6ff;
}
.ic {
  font-size: 13px;
  flex-shrink: 0;
}
.ti {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}
.badge {
  font-size: 10px;
  color: #58a6ff;
  flex-shrink: 0;
}
.x {
  width: 16px;
  height: 16px;
  line-height: 14px;
  text-align: center;
  border-radius: 50%;
  font-size: 13px;
  color: #6e7681;
  flex-shrink: 0;
  transition: background 0.15s;
}
.x:hover {
  background: rgba(255, 100, 100, 0.25);
  color: #f85149;
}
</style>
