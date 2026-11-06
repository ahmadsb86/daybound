// Daybound desktop.
//
// Two windows load your deployed site:
//   main   the full planner. Closing it hides it to the tray instead of quitting.
//   quick  a small always-on-top input, toggled from anywhere with Ctrl+Shift+Space
//          (Cmd+Shift+Space on macOS). It hides when it loses focus, and the page hides
//          it after a task is added by navigating to daybound://hide, which is caught here.
//
// The site address is baked in at build time:  DAYBOUND_URL=https://your-app.vercel.app

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const APP_URL: &str = match option_env!("DAYBOUND_URL") {
    Some(url) => url,
    None => "http://localhost:5173",
};

const SHORTCUT: &str = "CommandOrControl+Shift+Space";

#[cfg(target_os = "macos")]
const QUICK_LABEL: &str = "Quick add    ⌘⇧Space";
#[cfg(not(target_os = "macos"))]
const QUICK_LABEL: &str = "Quick add    Ctrl+Shift+Space";

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn toggle_quick(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("quick") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.center();
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

fn with_query(base: &Url, pairs: &[(&str, &str)]) -> Url {
    let mut url = base.clone();
    {
        let mut q = url.query_pairs_mut();
        for (k, v) in pairs {
            q.append_pair(k, v);
        }
    }
    url
}

fn main() {
    // Launch-at-login starts the app with --hidden so it waits quietly in the tray.
    let start_hidden = std::env::args().any(|a| a == "--hidden");

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_quick(app);
                    }
                })
                .build(),
        )
        .setup(move |app| {
            let base: Url = APP_URL
                .parse()
                .expect("DAYBOUND_URL must be a full URL like https://your-app.vercel.app");

            // main window
            let main = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(with_query(&base, &[("shell", "tauri")])),
            )
            .title("Daybound")
            .inner_size(1280.0, 820.0)
            .min_inner_size(420.0, 320.0)
            .visible(!start_hidden)
            .build()?;
            let main_for_close = main.clone();
            main.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = main_for_close.hide();
                }
            });

            // quick-add window
            let nav_handle = app.handle().clone();
            let quick = WebviewWindowBuilder::new(
                app,
                "quick",
                WebviewUrl::External(with_query(&base, &[("quick", "1"), ("shell", "tauri")])),
            )
            .title("Daybound quick add")
            .inner_size(680.0, 320.0)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .center()
            .on_navigation(move |url| {
                if url.scheme() == "daybound" {
                    let h = nav_handle.clone();
                    let _ = nav_handle.run_on_main_thread(move || {
                        if let Some(w) = h.get_webview_window("quick") {
                            let _ = w.hide();
                        }
                    });
                    return false;
                }
                true
            })
            .build()?;
            let quick_for_blur = quick.clone();
            quick.on_window_event(move |event| {
                if let WindowEvent::Focused(false) = event {
                    let _ = quick_for_blur.hide();
                }
            });

            app.global_shortcut().register(SHORTCUT)?;

            // tray
            let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
            let open_item = MenuItem::with_id(app, "open", "Open Daybound", true, None::<&str>)?;
            let quick_item = MenuItem::with_id(app, "quick", QUICK_LABEL, true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let autostart_item = CheckMenuItem::with_id(
                app,
                "autostart",
                "Launch at login",
                true,
                autostart_on,
                None::<&str>,
            )?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit Daybound", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&open_item, &quick_item, &sep1, &autostart_item, &sep2, &quit_item],
            )?;

            let autostart_check = autostart_item.clone();
            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().cloned().expect("missing app icon"))
                .tooltip("Daybound")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "quick" => toggle_quick(app),
                    "autostart" => {
                        let launcher = app.autolaunch();
                        let was_on = launcher.is_enabled().unwrap_or(false);
                        let _ = if was_on { launcher.disable() } else { launcher.enable() };
                        let _ = autostart_check.set_checked(launcher.is_enabled().unwrap_or(!was_on));
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while starting Daybound")
        .run(|app, event| {
            // macOS: clicking the dock icon brings the hidden window back
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show_main(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
