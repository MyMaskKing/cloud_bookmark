// M1-M3: 单标签 WebView + 老板键 + 自动隐藏
// M2:    多标签 + 画中画 PiP + 视频横屏一体化
// M2 修复: capabilities 覆盖到 web-tab-* + opener scope 放开 http/https
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const DEFAULT_BOSS_KEY: &str = "Ctrl+Alt+KeyQ";

/// 全局隐藏态(老板键切换用)
static HIDDEN: AtomicBool = AtomicBool::new(false);
/// 当前已注册的老板键
static CURRENT_BOSS_KEY: Mutex<Option<Shortcut>> = Mutex::new(None);
/// 记录所有已开启的 web tab label,用于老板键批量隐藏/恢复
static WEB_TABS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn tab_label(id: &str) -> String {
    format!("web-tab-{id}")
}

fn remember_tab(label: String) {
    if let Ok(mut g) = WEB_TABS.lock() {
        if !g.iter().any(|l| l == &label) {
            g.push(label);
        }
    }
}

fn forget_tab(label: &str) {
    if let Ok(mut g) = WEB_TABS.lock() {
        g.retain(|l| l != label);
    }
}

// ────── M2: 多标签 WebView 协调 ──────

#[tauri::command]
async fn open_web_tab(
    app: AppHandle,
    id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let label = tab_label(&id);

    // 已存在 = 只切位置/尺寸并显示(可能是复用同一 tab 的 inline 刷新)
    if let Some(existing) = app.get_webview_window(&label) {
        existing.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
        existing.set_size(LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
        existing.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let main = app.get_webview_window("main").ok_or("main window missing")?;
    let parsed = WebviewUrl::External(url.parse().map_err(|e: url::ParseError| e.to_string())?);

    // 关键:重写 window.open,让点击"新标签"跳转在当前 tab 内进行,而不是系统浏览器
    // 这解决 B站/YouTube 等站点点击视频时 opener.open_url 被拒的问题
    let init_script = r#"
        (function() {
          const nativeOpen = window.open;
          window.open = function(url, target, features) {
            // target=_blank / _self / 空 / 命名窗口——一律当前页跳转
            // 极少数场景(如 OAuth 弹窗)可能因此失效,后续按站点例外
            if (url) {
              try {
                window.location.href = new URL(url, window.location.href).href;
              } catch (e) {
                // URL 解析失败退回原生实现
                return nativeOpen.call(window, url, target, features);
              }
              return window;
            }
            return nativeOpen.call(window, url, target, features);
          };

          // 拦截 <a target="_blank"> 点击
          document.addEventListener('click', function(e) {
            const a = e.target && e.target.closest && e.target.closest('a[href]');
            if (a && a.target === '_blank' && a.href) {
              e.preventDefault();
              e.stopPropagation();
              window.location.href = a.href;
            }
          }, true);
        })();
    "#;

    let win = WebviewWindowBuilder::new(&app, &label, parsed)
        .parent(&main).map_err(|e| e.to_string())?
        .decorations(false)
        .transparent(false)
        .resizable(false)
        .skip_taskbar(true)
        .inner_size(width, height)
        .position(x, y)
        .initialization_script(init_script)
        .build()
        .map_err(|e| e.to_string())?;

    let _ = win.show();
    remember_tab(label);
    Ok(())
}

#[tauri::command]
async fn resize_web_tab(
    app: AppHandle,
    id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&tab_label(&id)) {
        win.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
        win.set_size(LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn close_web_tab(app: AppHandle, id: String) -> Result<(), String> {
    let label = tab_label(&id);
    if let Some(win) = app.get_webview_window(&label) {
        win.close().map_err(|e| e.to_string())?;
    }
    forget_tab(&label);
    Ok(())
}

#[tauri::command]
async fn set_web_tab_visible(app: AppHandle, id: String, visible: bool) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&tab_label(&id)) {
        if visible { win.show().map_err(|e| e.to_string())?; }
        else { win.hide().map_err(|e| e.to_string())?; }
    }
    Ok(())
}

/// 一次性隐藏/显示所有 tab(切换非活跃 tab 时,把上一个隐藏)
#[tauri::command]
async fn set_web_tab_visible_only(app: AppHandle, id: String) -> Result<(), String> {
    let target = tab_label(&id);
    let labels = WEB_TABS.lock().map(|g| g.clone()).unwrap_or_default();
    for l in labels {
        if let Some(win) = app.get_webview_window(&l) {
            if l == target { let _ = win.show(); }
            else { let _ = win.hide(); }
        }
    }
    Ok(())
}

/// 让指定 tab 的子窗口获取键鼠焦点(切换后必调,否则 B 站等站点点击无响应)
#[tauri::command]
async fn focus_web_tab(app: AppHandle, id: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&tab_label(&id)) {
        win.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ────── 透明度 ──────

#[tauri::command]
async fn set_web_tab_opacity(app: AppHandle, id: String, opacity: f64) -> Result<(), String> {
    let win = match app.get_webview_window(&tab_label(&id)) {
        Some(w) => w,
        None => return Ok(()),
    };

    #[cfg(windows)]
    {
        use windows::Win32::Foundation::{COLORREF, HWND};
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetLayeredWindowAttributes, SetWindowLongPtrW,
            GWL_EXSTYLE, LWA_ALPHA, WS_EX_LAYERED,
        };

        let raw = win.hwnd().map_err(|e| e.to_string())?;
        let hwnd = HWND(raw.0 as *mut _);
        let alpha = (opacity.clamp(0.0, 1.0) * 255.0) as u8;

        unsafe {
            let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_style | WS_EX_LAYERED.0 as isize);
            SetLayeredWindowAttributes(hwnd, COLORREF(0), alpha, LWA_ALPHA)
                .map_err(|e| e.to_string())?;
        }
    }

    #[cfg(not(windows))]
    {
        let _ = (win, opacity);
    }

    Ok(())
}

/// 对所有 tab 批量设置透明度
#[tauri::command]
async fn set_all_web_tabs_opacity(app: AppHandle, opacity: f64) -> Result<(), String> {
    let labels = WEB_TABS.lock().map(|g| g.clone()).unwrap_or_default();
    for l in labels {
        if let Some(id) = l.strip_prefix("web-tab-") {
            let _ = set_web_tab_opacity(app.clone(), id.to_string(), opacity).await;
        }
    }
    Ok(())
}

// ────── PiP: 画中画 ──────

/// 进入画中画:切成置顶顶层小窗
#[tauri::command]
async fn enter_pip(
    app: AppHandle,
    id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let label = tab_label(&id);
    let win = app.get_webview_window(&label).ok_or("tab not found")?;

    win.set_always_on_top(true).map_err(|e| e.to_string())?;
    // Tauri v2 目前不允许运行时切父窗口,直接把窗口置顶+定位即可满足 PiP 场景
    win.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    win.set_size(LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
    win.show().map_err(|e| e.to_string())?;

    let _ = app.emit("tab-mode-changed", (id, "pip"));
    Ok(())
}

/// 退出画中画:取消置顶,交给前端重新调 resize_web_tab 摆回 holder 位置
#[tauri::command]
async fn exit_pip(app: AppHandle, id: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&tab_label(&id)) {
        win.set_always_on_top(false).map_err(|e| e.to_string())?;
    }
    let _ = app.emit("tab-mode-changed", (id, "inline"));
    Ok(())
}

// ────── M3: 老板键 ──────

fn toggle_hide(app: &AppHandle) -> bool {
    let now_hidden = !HIDDEN.load(Ordering::Relaxed);
    HIDDEN.store(now_hidden, Ordering::Relaxed);

    if let Some(main) = app.get_webview_window("main") {
        if now_hidden { let _ = main.hide(); }
        else { let _ = main.show(); let _ = main.set_focus(); }
    }
    // 遍历所有 web tab
    let labels = WEB_TABS.lock().map(|g| g.clone()).unwrap_or_default();
    for l in labels {
        if let Some(win) = app.get_webview_window(&l) {
            if now_hidden { let _ = win.hide(); }
            else { let _ = win.show(); }
        }
    }

    let _ = app.emit("boss-key-toggled", now_hidden);
    now_hidden
}

#[tauri::command]
fn is_hidden() -> bool {
    HIDDEN.load(Ordering::Relaxed)
}

#[tauri::command]
fn trigger_boss_key(app: AppHandle) -> bool {
    toggle_hide(&app)
}

#[tauri::command]
fn update_boss_shortcut(app: AppHandle, shortcut: String) -> Result<(), String> {
    let new_sc: Shortcut = shortcut.parse().map_err(|e| format!("invalid shortcut: {e}"))?;

    let gs = app.global_shortcut();
    if let Ok(mut guard) = CURRENT_BOSS_KEY.lock() {
        if let Some(old) = guard.take() {
            let _ = gs.unregister(old);
        }
        gs.register(new_sc.clone()).map_err(|e| e.to_string())?;
        *guard = Some(new_sc);
    }
    Ok(())
}

// ────── 入口 ──────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let default_boss: Shortcut = DEFAULT_BOSS_KEY.parse().expect("bad default shortcut");
    let default_boss_for_handler = default_boss.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        let is_boss = CURRENT_BOSS_KEY
                            .lock()
                            .ok()
                            .and_then(|g| g.clone())
                            .map(|s| &s == shortcut)
                            .unwrap_or_else(|| shortcut == &default_boss_for_handler);
                        if is_boss {
                            toggle_hide(app);
                        }
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            open_web_tab,
            resize_web_tab,
            close_web_tab,
            set_web_tab_visible,
            set_web_tab_visible_only,
            focus_web_tab,
            set_web_tab_opacity,
            set_all_web_tabs_opacity,
            enter_pip,
            exit_pip,
            is_hidden,
            trigger_boss_key,
            update_boss_shortcut,
        ])
        .setup(move |app| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
            app.global_shortcut().register(default_boss.clone())?;
            if let Ok(mut g) = CURRENT_BOSS_KEY.lock() {
                *g = Some(default_boss);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
