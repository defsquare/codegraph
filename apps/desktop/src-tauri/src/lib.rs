//! THE SHELL (PLAN.md §15.4): a Tauri 2 window over the codegraph daemon.
//!
//! What it is: discovery of the installed extractors, the daemon's lifetime,
//! a menu (File › Open…, Open Recent, Rescan extractors), the folder dialog
//! and drag-and-drop — each of which is one `POST jobs`. What it is not:
//! anything about the model. The analyzer, the city and the navigator run
//! in the daemon; the page is served by the daemon; this crate never reads
//! a `model.jsonl` and the page never calls into it (no IPC, no
//! `@tauri-apps/*` in the page).
//!
//! On launch: discovery → write the registry → spawn the sidecar → read its
//! one stdout line → navigate the webview to `http://127.0.0.1:<port>/<token>/`.
//! On focus: discovery again (a `brew install` in a terminal is seen on the
//! next open) and the Open Recent submenu refreshed. On close: stdin closed,
//! child killed.

mod daemon;

use codegraph_discovery::{
    discover, parse_catalogue, parse_settings, search_dirs, write_registry, Settings,
};
use daemon::{Daemon, OpenOutcome};
use std::path::{Path, PathBuf};
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, DragDropEvent, Emitter, Manager, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

/// The window's label in tauri.conf.json.
const MAIN: &str = "main";
const MENU_OPEN: &str = "open";
const MENU_RESCAN: &str = "rescan";
const RECENT_PREFIX: &str = "recent:";

struct Shell {
    daemon: Daemon,
    registry_path: PathBuf,
    catalogue_path: PathBuf,
    settings_path: PathBuf,
}

impl Shell {
    /// Discovery, written to the registry the daemon reads on its next request.
    fn rescan(&self) -> Result<usize, String> {
        let entries = discover_now(&self.catalogue_path, &self.settings_path)?;
        write_registry(&self.registry_path, &entries).map_err(|error| error.to_string())?;
        Ok(entries.iter().filter(|entry| entry.is_installed()).count())
    }
}

fn discover_now(
    catalogue_path: &Path,
    settings_path: &Path,
) -> Result<Vec<codegraph_discovery::RegistryEntry>, String> {
    let catalogue = std::fs::read_to_string(catalogue_path).map_err(|error| {
        format!(
            "cannot read the extractor catalogue {}: {error}",
            catalogue_path.display()
        )
    })?;
    let catalogue = parse_catalogue(&catalogue)
        .map_err(|error| format!("the extractor catalogue is not valid: {error}"))?;
    let settings = match std::fs::read_to_string(settings_path) {
        Ok(text) => parse_settings(&text).unwrap_or_else(|error| {
            eprintln!(
                "codegraph: settings {} ignored: {error}",
                settings_path.display()
            );
            Settings::default()
        }),
        Err(_) => Settings::default(),
    };
    let dirs = search_dirs(
        std::env::var_os("PATH").as_deref(),
        std::env::var_os("HOME").map(PathBuf::from).as_deref(),
        std::env::var_os("HOMEBREW_PREFIX")
            .map(PathBuf::from)
            .as_deref(),
    );
    Ok(discover(&catalogue, &settings, &dirs))
}

/// Open a folder (or a model.jsonl): one POST; a refusal is a native dialog,
/// since a folder dropped on the window or picked from the menu may be
/// refused before the page has anything to show.
fn open_path(app: &AppHandle, src: &Path) {
    let shell = app.state::<Shell>();
    match shell.daemon.open(src) {
        OpenOutcome::Accepted => {}
        OpenOutcome::Refused(message) | OpenOutcome::Failed(message) => {
            app.dialog()
                .message(message)
                .kind(MessageDialogKind::Warning)
                .title("Codegraph")
                .blocking_show();
        }
    }
}

fn pick_folder(app: &AppHandle) {
    let handle = app.clone();
    app.dialog().file().pick_folder(move |folder| {
        if let Some(folder) = folder {
            if let Ok(path) = folder.into_path() {
                open_path(&handle, &path);
            }
        }
    });
}

/// The menu, rebuilt whenever the recents may have changed (focus, a job).
fn install_menu(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItemBuilder::with_id(MENU_OPEN, "Open Folder…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let rescan = MenuItemBuilder::with_id(MENU_RESCAN, "Rescan Extractors").build(app)?;

    let recents = app.state::<Shell>().daemon.recent();
    let mut recent_menu = SubmenuBuilder::new(app, "Open Recent");
    if recents.is_empty() {
        recent_menu = recent_menu.item(
            &MenuItemBuilder::with_id("recent:none", "No Recent Folders")
                .enabled(false)
                .build(app)?,
        );
    }
    for (index, project) in recents.iter().enumerate() {
        let id = format!("{RECENT_PREFIX}{index}");
        let item = MenuItemBuilder::with_id(id, format!("{} — {}", project.name, project.src))
            .build(app)?;
        recent_menu = recent_menu.item(&item);
    }
    let recent_menu = recent_menu.build()?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&open)
        .item(&recent_menu)
        .separator()
        .item(&rescan)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;

    let mut menu = MenuBuilder::new(app);
    #[cfg(target_os = "macos")]
    {
        let about = SubmenuBuilder::new(app, "Codegraph")
            .item(&PredefinedMenuItem::about(app, None, None)?)
            .separator()
            .item(&PredefinedMenuItem::hide(app, None)?)
            .item(&PredefinedMenuItem::hide_others(app, None)?)
            .separator()
            .item(&PredefinedMenuItem::quit(app, None)?)
            .build()?;
        menu = menu.item(&about);
    }
    let menu = menu.item(&file).build()?;
    app.set_menu(menu)?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = handle.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let catalogue_path = handle
                .path()
                .resolve("resources/extractors.json", BaseDirectory::Resource)?;
            let settings_path = data_dir.join("settings.json");
            let registry_path = data_dir.join("registry.json");

            let entries =
                discover_now(&catalogue_path, &settings_path).map_err(std::io::Error::other)?;
            write_registry(&registry_path, &entries)?;
            eprintln!(
                "codegraph: {} of {} extractors installed",
                entries.iter().filter(|entry| entry.is_installed()).count(),
                entries.len()
            );

            let sidecar = daemon::sidecar_path(&tauri::process::current_binary(&handle.env())?);
            let daemon = Daemon::spawn(&sidecar, &data_dir, &registry_path)
                .map_err(std::io::Error::other)?;
            let page = daemon.page_url();
            app.manage(Shell {
                daemon,
                registry_path,
                catalogue_path,
                settings_path,
            });

            install_menu(&handle)?;

            let window = handle
                .get_webview_window(MAIN)
                .ok_or_else(|| std::io::Error::other("no main window"))?;
            window.navigate(url::Url::parse(&page).map_err(std::io::Error::other)?)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == MENU_OPEN {
                pick_folder(app);
            } else if id == MENU_RESCAN {
                match app.state::<Shell>().rescan() {
                    Ok(installed) => {
                        let _ = app.emit("codegraph://rescanned", installed);
                        let _ = install_menu(app);
                    }
                    Err(message) => eprintln!("codegraph: rescan failed: {message}"),
                }
            } else if let Some(index) = id
                .strip_prefix(RECENT_PREFIX)
                .and_then(|rest| rest.parse::<usize>().ok())
            {
                let recents = app.state::<Shell>().daemon.recent();
                if let Some(project) = recents.get(index) {
                    open_path(app, Path::new(&project.src));
                }
            }
        })
        .on_window_event(|window, event| match event {
            WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
                let app = window.app_handle();
                for path in paths {
                    open_path(app, path);
                }
            }
            WindowEvent::Focused(true) => {
                let app = window.app_handle();
                if let Some(shell) = app.try_state::<Shell>() {
                    if let Err(message) = shell.rescan() {
                        eprintln!("codegraph: rescan failed: {message}");
                    }
                    let _ = install_menu(app);
                }
            }
            WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed => {
                if let Some(shell) = window.app_handle().try_state::<Shell>() {
                    shell.daemon.shutdown();
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running the codegraph desktop shell");
}
