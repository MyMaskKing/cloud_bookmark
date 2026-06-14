/**
 * 本地密码锁管理器
 *
 * 重要：
 * - 所有数据仅存放在 chrome.storage.local 的独立 key（localPasswordLock）中
 * - 这个 key 不会进入 settings，不会随 syncSettingsToCloud 上传到 WebDAV
 * - 解锁状态用 chrome.storage.session（浏览器关闭即清空）
 *
 * 使用 PBKDF2-SHA256 100k 迭代 + 16 字节随机盐派生 256 位哈希。
 */
(function (root) {
  'use strict';

  const LOCK_CONFIG_KEY = 'localPasswordLock';     // 持久存储（哈希、盐、enabled 等）
  const LOCK_SESSION_KEY = 'localPasswordLockSession'; // 会话解锁标记
  const PBKDF2_ITERATIONS = 100000;
  const SALT_BYTES = 16;
  const HASH_BITS = 256;
  const MIN_PASSWORD_LENGTH = 4;
  const MAX_PASSWORD_LENGTH = 128;

  function getRuntime() {
    return typeof chrome !== 'undefined' && chrome.runtime ? chrome : (typeof browser !== 'undefined' ? browser : null);
  }

  function getLocalStorage() {
    const r = getRuntime();
    return r && r.storage && r.storage.local ? r.storage.local : null;
  }

  function getSessionStorage() {
    // chrome.storage.session：MV3 Chrome 102+ / Edge 102+ / Firefox 115+
    const r = getRuntime();
    if (r && r.storage && r.storage.session) return r.storage.session;
    return null;
  }

  // ----------------- 二进制工具 -----------------
  function bytesToB64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function randomSaltB64() {
    const buf = new Uint8Array(SALT_BYTES);
    (typeof crypto !== 'undefined' && crypto.getRandomValues
      ? crypto
      : self.crypto).getRandomValues(buf);
    return bytesToB64(buf);
  }

  // ----------------- 派生哈希 -----------------
  async function deriveHash(password, saltB64) {
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      throw new Error('当前环境不支持 WebCrypto，无法启用本地密码锁');
    }
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: b64ToBytes(saltB64),
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256'
      },
      key,
      HASH_BITS
    );
    return bytesToB64(new Uint8Array(bits));
  }

  // ----------------- 存储读写 -----------------
  function readConfig() {
    return new Promise((resolve) => {
      const s = getLocalStorage();
      if (!s) return resolve(null);
      s.get([LOCK_CONFIG_KEY], (result) => {
        resolve((result && result[LOCK_CONFIG_KEY]) || null);
      });
    });
  }

  function writeConfig(cfg) {
    return new Promise((resolve, reject) => {
      const s = getLocalStorage();
      if (!s) return reject(new Error('storage.local 不可用'));
      s.set({ [LOCK_CONFIG_KEY]: cfg }, () => {
        const r = getRuntime();
        const err = r && r.runtime && r.runtime.lastError;
        if (err) reject(new Error(err.message || String(err)));
        else resolve();
      });
    });
  }

  function clearConfig() {
    return new Promise((resolve) => {
      const s = getLocalStorage();
      if (!s) return resolve();
      s.remove([LOCK_CONFIG_KEY], () => resolve());
    });
  }

  function readSessionUnlocked() {
    return new Promise((resolve) => {
      const ss = getSessionStorage();
      if (!ss) {
        // 回退：session storage 不可用时退化为内存级，每次重载都视为未解锁
        return resolve(false);
      }
      ss.get([LOCK_SESSION_KEY], (result) => {
        resolve(!!(result && result[LOCK_SESSION_KEY] && result[LOCK_SESSION_KEY].unlocked));
      });
    });
  }

  function writeSessionUnlocked(unlocked) {
    return new Promise((resolve) => {
      const ss = getSessionStorage();
      if (!ss) return resolve();
      ss.set({ [LOCK_SESSION_KEY]: { unlocked: !!unlocked, ts: Date.now() } }, () => resolve());
    });
  }

  function clearSessionUnlocked() {
    return new Promise((resolve) => {
      const ss = getSessionStorage();
      if (!ss) return resolve();
      ss.remove([LOCK_SESSION_KEY], () => resolve());
    });
  }

  // ----------------- 对外 API -----------------

  /** 是否启用了本地密码锁 */
  async function isEnabled() {
    const cfg = await readConfig();
    return !!(cfg && cfg.enabled && cfg.hash && cfg.salt);
  }

  /** 当前会话是否已解锁 */
  async function isUnlocked() {
    if (!(await isEnabled())) return true; // 未启用视为永远解锁
    return await readSessionUnlocked();
  }

  /** 校验密码强度（返回 { ok, message }） */
  function validatePasswordStrength(password) {
    if (typeof password !== 'string') {
      return { ok: false, message: '密码无效' };
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return { ok: false, message: `密码至少需要 ${MIN_PASSWORD_LENGTH} 位` };
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      return { ok: false, message: `密码不能超过 ${MAX_PASSWORD_LENGTH} 位` };
    }
    return { ok: true };
  }

  /**
   * 设置/启用密码（首次启用）。
   * 已存在密码时请改用 changePassword。
   */
  async function setPassword(newPassword) {
    const v = validatePasswordStrength(newPassword);
    if (!v.ok) throw new Error(v.message);
    const salt = randomSaltB64();
    const hash = await deriveHash(newPassword, salt);
    await writeConfig({
      enabled: true,
      salt,
      hash,
      iterations: PBKDF2_ITERATIONS,
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    await writeSessionUnlocked(true); // 设置完毕直接视为已解锁
  }

  /** 校验密码（不改变会话状态） */
  async function verifyPassword(password) {
    const cfg = await readConfig();
    if (!cfg || !cfg.enabled || !cfg.hash || !cfg.salt) return false;
    try {
      const h = await deriveHash(password || '', cfg.salt);
      return constantTimeEqual(h, cfg.hash);
    } catch (_) {
      return false;
    }
  }

  function constantTimeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    let r = 0;
    for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return r === 0;
  }

  /** 输入密码并解锁当前会话 */
  async function unlock(password) {
    const ok = await verifyPassword(password);
    if (!ok) return false;
    await writeSessionUnlocked(true);
    return true;
  }

  /** 修改密码（需提供旧密码） */
  async function changePassword(oldPassword, newPassword) {
    const ok = await verifyPassword(oldPassword);
    if (!ok) throw new Error('当前密码不正确');
    const v = validatePasswordStrength(newPassword);
    if (!v.ok) throw new Error(v.message);
    const salt = randomSaltB64();
    const hash = await deriveHash(newPassword, salt);
    const cur = (await readConfig()) || {};
    await writeConfig({
      ...cur,
      enabled: true,
      salt,
      hash,
      iterations: PBKDF2_ITERATIONS,
      version: 1,
      updatedAt: Date.now()
    });
    await writeSessionUnlocked(true);
  }

  /** 关闭密码锁（需当前密码） */
  async function disableWithPassword(password) {
    const ok = await verifyPassword(password);
    if (!ok) throw new Error('当前密码不正确');
    await clearConfig();
    await clearSessionUnlocked();
  }

  /**
   * 强制重置：直接清除本地密码配置 + 会话解锁标记。
   * 调用方应额外清除本地书签缓存（在 storage 层暴露的方法）。
   */
  async function forceReset() {
    await clearConfig();
    await clearSessionUnlocked();
  }

  /** 锁定当前会话（仅清除 session 标记） */
  async function lockNow() {
    await clearSessionUnlocked();
  }

  const LockManager = {
    KEY: LOCK_CONFIG_KEY,
    SESSION_KEY: LOCK_SESSION_KEY,
    MIN_PASSWORD_LENGTH,
    MAX_PASSWORD_LENGTH,
    isEnabled,
    isUnlocked,
    setPassword,
    verifyPassword,
    unlock,
    changePassword,
    disableWithPassword,
    forceReset,
    lockNow,
    validatePasswordStrength
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = LockManager;
  }
  root.LockManager = LockManager;
})(typeof self !== 'undefined' ? self : this);
