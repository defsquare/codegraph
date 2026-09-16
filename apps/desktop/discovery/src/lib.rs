//! EXTRACTOR DISCOVERY (PLAN.md §15.4).
//!
//! The shell ships a CATALOGUE — one row per extractor codegraph knows:
//! `{ name, extensions[], command, install }` — and turns it into the
//! daemon's REGISTRY by looking each `command` up on `PATH` and in the
//! Homebrew prefixes. Found: `{ name, path, extensions, launch: "exec" }`.
//! Not found: `{ name, extensions, install }` with no `path`, so the daemon
//! can answer a folder of that language with the line that installs it
//! rather than "nothing claims these files".
//!
//! A settings file lets a user point a row at a binary anywhere (a
//! checkout's `bin/codegraph-typescript`, a jar with `launch: java`); an
//! override wins over the lookup.
//!
//! The catalogue is data: a new extractor is one row, no Rust. This crate
//! depends on nothing platform-specific so its tests run wherever `cargo`
//! does — the Tauri crate cannot compile without WebKit's libraries.

use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// One row of `resources/extractors.json`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct CatalogueEntry {
    pub name: String,
    pub extensions: Vec<String>,
    /// The command on PATH: `codegraph-java`.
    pub command: String,
    /// The line that installs it: `brew install defsquare/tap/codegraph-java`.
    pub install: String,
}

/// A user's override for one catalogue row (`settings.json` under the app data dir).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct Override {
    pub name: String,
    pub path: PathBuf,
    /// `exec` (default), `java` for a jar, `node` for a script.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct Settings {
    #[serde(default)]
    pub overrides: Vec<Override>,
}

/// One entry of the registry the daemon reads — exactly the JSON shape
/// `packages/cli/src/app/registry.ts` parses. `untagged`: the presence of
/// `path` is what tells the two apart, on both sides.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RegistryEntry {
    Installed {
        name: String,
        path: PathBuf,
        extensions: Vec<String>,
        launch: String,
    },
    Missing {
        name: String,
        extensions: Vec<String>,
        install: String,
    },
}

impl RegistryEntry {
    pub fn name(&self) -> &str {
        match self {
            RegistryEntry::Installed { name, .. } | RegistryEntry::Missing { name, .. } => name,
        }
    }

    pub fn is_installed(&self) -> bool {
        matches!(self, RegistryEntry::Installed { .. })
    }
}

pub fn parse_catalogue(text: &str) -> serde_json::Result<Vec<CatalogueEntry>> {
    serde_json::from_str(text)
}

pub fn parse_settings(text: &str) -> serde_json::Result<Settings> {
    serde_json::from_str(text)
}

/// Where a command may live: every `PATH` entry, then the Homebrew prefixes
/// a GUI app launched from the Dock does not see on its `PATH` (macOS gives
/// apps `/usr/bin:/bin:/usr/sbin:/sbin`, never `/opt/homebrew/bin`), then
/// Linuxbrew's. Order matters: `PATH` first, so a user's own choice wins.
pub fn search_dirs(
    path_var: Option<&OsStr>,
    home: Option<&Path>,
    homebrew_prefix: Option<&Path>,
) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(path) = path_var {
        dirs.extend(std::env::split_paths(path));
    }
    if let Some(prefix) = homebrew_prefix {
        dirs.push(prefix.join("bin"));
    }
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs.push(PathBuf::from("/home/linuxbrew/.linuxbrew/bin"));
    if let Some(home) = home {
        dirs.push(home.join(".linuxbrew").join("bin"));
    }
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|dir| !dir.as_os_str().is_empty() && seen.insert(dir.clone()));
    dirs
}

/// The first directory holding an executable file of that name (`.exe` too on Windows).
pub fn find_command(command: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    let names: Vec<String> = if cfg!(windows) {
        vec![format!("{command}.exe"), command.to_string()]
    } else {
        vec![command.to_string()]
    };
    dirs.iter()
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|candidate| is_executable_file(candidate))
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// The registry for this catalogue on this machine.
pub fn discover(
    catalogue: &[CatalogueEntry],
    settings: &Settings,
    dirs: &[PathBuf],
) -> Vec<RegistryEntry> {
    catalogue
        .iter()
        .map(|entry| {
            if let Some(over) = settings.overrides.iter().find(|o| o.name == entry.name) {
                return RegistryEntry::Installed {
                    name: entry.name.clone(),
                    path: over.path.clone(),
                    extensions: entry.extensions.clone(),
                    launch: over
                        .launch
                        .clone()
                        .unwrap_or_else(|| infer_launch(&over.path)),
                };
            }
            match find_command(&entry.command, dirs) {
                Some(path) => RegistryEntry::Installed {
                    name: entry.name.clone(),
                    path,
                    extensions: entry.extensions.clone(),
                    launch: "exec".to_string(),
                },
                None => RegistryEntry::Missing {
                    name: entry.name.clone(),
                    extensions: entry.extensions.clone(),
                    install: entry.install.clone(),
                },
            }
        })
        .collect()
}

/// The rule `snapshots --extractor` and the daemon use: a jar runs under java, a script under node.
fn infer_launch(path: &Path) -> String {
    let lower = path.to_string_lossy().to_ascii_lowercase();
    if lower.ends_with(".jar") {
        "java".to_string()
    } else if lower.ends_with(".js") || lower.ends_with(".mjs") || lower.ends_with(".cjs") {
        "node".to_string()
    } else {
        "exec".to_string()
    }
}

pub fn registry_json(entries: &[RegistryEntry]) -> String {
    let mut text = serde_json::to_string_pretty(entries).expect("registry entries serialize");
    text.push('\n');
    text
}

/// Write the registry atomically: the daemon re-reads the file on its next
/// request, and must never see half of it.
pub fn write_registry(path: &Path, entries: &[RegistryEntry]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    fs::write(&temporary, registry_json(entries))?;
    fs::rename(&temporary, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CATALOGUE: &str = r#"[
      { "name": "java", "extensions": [".java"], "command": "codegraph-java", "install": "brew install defsquare/tap/codegraph-java" },
      { "name": "typescript", "extensions": [".ts", ".tsx"], "command": "codegraph-typescript", "install": "brew install defsquare/tap/codegraph-typescript" }
    ]"#;

    fn executable(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    #[test]
    fn parses_the_catalogue() {
        let rows = parse_catalogue(CATALOGUE).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1].command, "codegraph-typescript");
        assert_eq!(rows[1].extensions, vec![".ts", ".tsx"]);
    }

    #[test]
    fn refuses_a_row_without_its_install_line() {
        assert!(parse_catalogue(
            r#"[{ "name": "x", "extensions": [".x"], "command": "codegraph-x" }]"#
        )
        .is_err());
    }

    #[test]
    fn search_dirs_put_path_first_then_the_homebrew_prefixes_without_duplicates() {
        let path = std::env::join_paths(["/usr/local/bin", "/usr/bin"]).unwrap();
        let dirs = search_dirs(
            Some(&path),
            Some(Path::new("/home/me")),
            Some(Path::new("/opt/brew")),
        );
        assert_eq!(
            dirs,
            vec![
                PathBuf::from("/usr/local/bin"),
                PathBuf::from("/usr/bin"),
                PathBuf::from("/opt/brew/bin"),
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/home/linuxbrew/.linuxbrew/bin"),
                PathBuf::from("/home/me/.linuxbrew/bin"),
            ]
        );
    }

    #[test]
    fn finds_an_executable_and_ignores_a_plain_file_or_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        let found = executable(dir.path(), "codegraph-java");
        fs::write(dir.path().join("codegraph-csharp"), "not executable").unwrap();
        fs::create_dir(dir.path().join("codegraph-typescript")).unwrap();
        let dirs = vec![dir.path().to_path_buf()];
        assert_eq!(find_command("codegraph-java", &dirs), Some(found));
        #[cfg(unix)]
        assert_eq!(find_command("codegraph-csharp", &dirs), None);
        assert_eq!(find_command("codegraph-typescript", &dirs), None);
        assert_eq!(find_command("codegraph-elixir", &dirs), None);
    }

    #[test]
    fn discovers_found_missing_and_overridden_entries_in_catalogue_order() {
        let dir = tempfile::tempdir().unwrap();
        let java = executable(dir.path(), "codegraph-java");
        let catalogue = parse_catalogue(CATALOGUE).unwrap();
        let settings = parse_settings(r#"{ "overrides": [{ "name": "typescript", "path": "/src/bin/codegraph-typescript" }] }"#).unwrap();
        let entries = discover(&catalogue, &settings, &[dir.path().to_path_buf()]);
        assert_eq!(
            entries,
            vec![
                RegistryEntry::Installed {
                    name: "java".into(),
                    path: java,
                    extensions: vec![".java".into()],
                    launch: "exec".into(),
                },
                RegistryEntry::Installed {
                    name: "typescript".into(),
                    path: PathBuf::from("/src/bin/codegraph-typescript"),
                    extensions: vec![".ts".into(), ".tsx".into()],
                    launch: "exec".into(),
                },
            ]
        );
        let none = discover(&catalogue, &Settings::default(), &[]);
        assert!(none.iter().all(|entry| !entry.is_installed()));
        assert_eq!(none[0].name(), "java");
    }

    #[test]
    fn an_override_to_a_jar_or_a_script_infers_its_launch() {
        let catalogue = parse_catalogue(CATALOGUE).unwrap();
        let settings = parse_settings(
            r#"{ "overrides": [
              { "name": "java", "path": "/x/codegraph-java.jar" },
              { "name": "typescript", "path": "/x/cli.js" }
            ] }"#,
        )
        .unwrap();
        let entries = discover(&catalogue, &settings, &[]);
        let launches: Vec<&str> = entries
            .iter()
            .map(|entry| match entry {
                RegistryEntry::Installed { launch, .. } => launch.as_str(),
                RegistryEntry::Missing { .. } => "missing",
            })
            .collect();
        assert_eq!(launches, vec!["java", "node"]);
    }

    #[test]
    fn the_registry_json_is_the_daemons_contract() {
        let entries = vec![
            RegistryEntry::Installed {
                name: "java".into(),
                path: PathBuf::from("/opt/homebrew/bin/codegraph-java"),
                extensions: vec![".java".into()],
                launch: "exec".into(),
            },
            RegistryEntry::Missing {
                name: "elixir".into(),
                extensions: vec![".ex".into(), ".exs".into()],
                install: "brew install defsquare/tap/codegraph-elixir".into(),
            },
        ];
        let json: serde_json::Value = serde_json::from_str(&registry_json(&entries)).unwrap();
        assert_eq!(json[0]["path"], "/opt/homebrew/bin/codegraph-java");
        assert_eq!(json[0]["launch"], "exec");
        assert!(json[0].get("install").is_none());
        assert!(json[1].get("path").is_none());
        assert_eq!(
            json[1]["install"],
            "brew install defsquare/tap/codegraph-elixir"
        );
        assert_eq!(json[1]["extensions"][1], ".exs");
        // Round-trips through the same enum, so the shell can read what it wrote.
        let back: Vec<RegistryEntry> = serde_json::from_value(json).unwrap();
        assert_eq!(back, entries);
    }

    #[test]
    fn writes_the_registry_atomically_into_a_directory_it_creates() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("codegraph").join("registry.json");
        let entries = vec![RegistryEntry::Missing {
            name: "java".into(),
            extensions: vec![".java".into()],
            install: "brew install defsquare/tap/codegraph-java".into(),
        }];
        write_registry(&path, &entries).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), registry_json(&entries));
        assert!(
            fs::read_dir(path.parent().unwrap()).unwrap().count() == 1,
            "no temporary file left behind"
        );
    }
}
