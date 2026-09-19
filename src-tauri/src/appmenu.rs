//! The application menu bar.
//!
//! The app had a system-tray menu and no application menu at all, which on
//! macOS means no ⌘, for Settings, no Check for Updates where every other Mac
//! app puts it, and no discoverable home for the things a node operator
//! actually does — verify the library, re-test reachability, open the folder
//! where 412 GB of sermons live.
//!
//! Everything here is a thin shell: a menu item emits `menu-action` with its id
//! and the frontend decides what that means. That keeps the routing in one
//! place (App.jsx already owns navigation) instead of splitting it between Rust
//! and React, and it means adding an item later is a one-line change on each
//! side rather than a new Tauri command.

use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Build and install the menu bar. Non-fatal: a failure here logs and leaves
/// the app running without a menu rather than refusing to start.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    if let Err(e) = build(app) {
        log::warn!("[menu] could not install the application menu: {e:#}");
    }
}

fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    // ── SermonIndex ─────────────────────────────────────────────────────────
    let check_update = MenuItemBuilder::with_id("check_update", "Check for Updates…").build(app)?;
    let settings = MenuItemBuilder::with_id("nav:settings", "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;

    let about_meta = AboutMetadataBuilder::new()
        .name(Some("SermonIndex Node Software"))
        .version(Some(env!("CARGO_PKG_VERSION")))
        .comments(Some(
            "Holds and shares the SermonIndex library so it survives \
             anywhere one machine can be switched on.",
        ))
        .website(Some("https://www.sermonindex.net/node-software/"))
        .build();

    let app_menu = SubmenuBuilder::new(app, "SermonIndex")
        .about(Some(about_meta))
        .separator()
        .item(&check_update)
        .separator()
        .item(&settings)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    // ── Library ─────────────────────────────────────────────────────────────
    // "Library" rather than "File": this app has no documents, and a File menu
    // whose contents are all about a sermon folder is a menu named after a
    // convention instead of after what is in it.
    let open_library = MenuItemBuilder::with_id("open_library", "Open Sermon Folder").build(app)?;
    let open_data = MenuItemBuilder::with_id("open_data", "Open Settings Folder").build(app)?;
    let verify = MenuItemBuilder::with_id("verify_library", "Verify Library…").build(app)?;
    let library_menu = SubmenuBuilder::new(app, "Library")
        .item(&open_library)
        .item(&open_data)
        .separator()
        .item(&verify)
        .separator()
        .close_window()
        .build()?;

    // ── Node ────────────────────────────────────────────────────────────────
    let retest = MenuItemBuilder::with_id("retest_reach", "Re-test Reachability")
        .accelerator("CmdOrCtrl+R")
        .build(app)?;
    let dashboard = MenuItemBuilder::with_id("open_dashboard", "Open Node Dashboard").build(app)?;
    let node_menu = SubmenuBuilder::new(app, "Node")
        .item(&retest)
        .item(&dashboard)
        .build()?;

    // ── View ────────────────────────────────────────────────────────────────
    // The seven destinations, with ⌘1–⌘7. A sidebar is discoverable; keyboard
    // shortcuts are what make an app feel quick once you already know it.
    let mut view = SubmenuBuilder::new(app, "View");
    for (i, (id, label)) in [
        ("dashboard", "Dashboard"),
        ("library", "Browse Sermons"),
        ("downloads", "My Downloads"),
        ("network", "Node Map"),
        ("seed", "Seed Node"),
        ("stats", "Your Stats"),
        ("connections", "Connections"),
    ]
    .iter()
    .enumerate()
    {
        let item = MenuItemBuilder::with_id(format!("nav:{id}"), *label)
            .accelerator(format!("CmdOrCtrl+{}", i + 1))
            .build(app)?;
        view = view.item(&item);
    }
    let theme = MenuItemBuilder::with_id("toggle_theme", "Toggle Light / Dark")
        .accelerator("CmdOrCtrl+Shift+L")
        .build(app)?;
    let view_menu = view.separator().item(&theme).separator().fullscreen().build()?;

    // ── Help ────────────────────────────────────────────────────────────────
    let guide = MenuItemBuilder::with_id("help_guide", "Running a Node — Guide").build(app)?;
    let community = MenuItemBuilder::with_id("nav:community", "Community Chat").build(app)?;
    let logs = MenuItemBuilder::with_id("open_logs", "Show Logs").build(app)?;
    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(&guide)
        .item(&community)
        .separator()
        .item(&logs)
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &library_menu, &node_menu, &view_menu, &help_menu])
        .build()?;
    app.set_menu(menu)?;

    // One handler. Anything prefixed `nav:` is a page change and is passed
    // straight through; the rest are named actions. The frontend owns both,
    // because it already owns the router and the update checker.
    app.on_menu_event(move |app, event| {
        let id = event.id().0.clone();
        // Bring the window forward first: a menu item chosen from the menu bar
        // while the window is hidden should show the result, not silently do it.
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.set_focus();
        }
        if let Err(e) = app.emit("menu-action", id.clone()) {
            log::warn!("[menu] could not deliver {id}: {e:#}");
        }
    });

    Ok(())
}
