//! THE DAEMON'S LIFETIME, from the shell's side (PLAN.md §15.4).
//!
//! Spawn `codegraph serve --app --data-dir … --extractors …` — the sidecar
//! beside this executable — with stdin HELD OPEN, read the one stdout line
//! `{"port","token"}`, and keep the child. Two rules end it: closing stdin
//! (the daemon exits on EOF) and killing it on window close — both, so a
//! shell that crashes cannot leave an orphan holding a model in memory.
//!
//! Everything the shell asks of the daemon is one HTTP call to a route under
//! the token: `POST jobs` for a folder, `GET recent` for the menu. No IPC in
//! the page: the page talks to the same daemon over the same routes.

use serde::Deserialize;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

#[derive(Debug, Deserialize)]
struct Announcement {
    port: u16,
    token: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RecentProject {
    pub src: String,
    pub name: String,
}

#[derive(Debug, Deserialize)]
struct RecentFile {
    projects: Vec<RecentProject>,
}

/// What `POST jobs` said, in the shell's terms (the page shows its own).
#[derive(Debug)]
pub enum OpenOutcome {
    Accepted,
    /// A 4xx with the daemon's message: busy, not-installed, ambiguous, not a folder.
    Refused(String),
    Failed(String),
}

pub struct Daemon {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    pub base_url: String,
}

/// Where the sidecar is: beside this executable, as Tauri places `externalBin`
/// (`Contents/MacOS/codegraph` in a bundle, `target/debug/codegraph` under
/// `tauri dev`).
pub fn sidecar_path(current_exe: &Path) -> PathBuf {
    let name = if cfg!(windows) {
        "codegraph.exe"
    } else {
        "codegraph"
    };
    current_exe
        .parent()
        .map(|dir| dir.join(name))
        .unwrap_or_else(|| PathBuf::from(name))
}

impl Daemon {
    pub fn spawn(sidecar: &Path, data_dir: &Path, registry: &Path) -> Result<Daemon, String> {
        let mut child = Command::new(sidecar)
            .arg("serve")
            .arg("--app")
            .arg("--data-dir")
            .arg(data_dir)
            .arg("--extractors")
            .arg(registry)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| format!("cannot start {}: {error}", sidecar.display()))?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or("the daemon has no stdout")?;
        let mut line = String::new();
        BufReader::new(stdout)
            .read_line(&mut line)
            .map_err(|error| format!("cannot read the daemon's announcement: {error}"))?;
        let announced: Announcement = serde_json::from_str(line.trim()).map_err(|error| {
            format!("the daemon's first line is not {{port, token}}: {error} ({line:?})")
        })?;
        Ok(Daemon {
            child: Mutex::new(Some(child)),
            stdin: Mutex::new(stdin),
            base_url: format!("http://127.0.0.1:{}/{}", announced.port, announced.token),
        })
    }

    /// The page's URL — the token is the capability, so this is never logged.
    pub fn page_url(&self) -> String {
        format!("{}/", self.base_url)
    }

    /// `POST jobs { src }`; the daemon detects the extractor and streams progress to the page.
    pub fn open(&self, src: &Path) -> OpenOutcome {
        let body = serde_json::json!({ "src": src.to_string_lossy() }).to_string();
        match ureq::post(&format!("{}/jobs", self.base_url))
            .set("content-type", "application/json")
            .send_string(&body)
        {
            Ok(_) => OpenOutcome::Accepted,
            Err(ureq::Error::Status(code, response)) => {
                let text = response.into_string().unwrap_or_default();
                OpenOutcome::Refused(describe_refusal(code, &text))
            }
            Err(error) => OpenOutcome::Failed(format!("the daemon could not be reached: {error}")),
        }
    }

    pub fn recent(&self) -> Vec<RecentProject> {
        ureq::get(&format!("{}/recent", self.base_url))
            .call()
            .ok()
            .and_then(|response| {
                serde_json::from_reader::<_, RecentFile>(response.into_reader()).ok()
            })
            .map(|file| file.projects)
            .unwrap_or_default()
    }

    /// Close stdin — the daemon exits on EOF — and kill it anyway.
    pub fn shutdown(&self) {
        if let Ok(mut stdin) = self.stdin.lock() {
            if let Some(mut pipe) = stdin.take() {
                let _ = pipe.flush();
                drop(pipe);
            }
        }
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut process) = child.take() {
                let _ = process.kill();
                let _ = process.wait();
            }
        }
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// The daemon's 4xx answers, as one sentence for a native dialog. The page
/// shows the same facts in its own words; the shell only needs to say why
/// nothing opened.
pub fn describe_refusal(code: u16, body: &str) -> String {
    let parsed: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    let error = parsed["error"].as_str().unwrap_or("");
    match error {
        "busy" => format!(
            "A folder is already being opened ({}). Wait for it to finish.",
            parsed["job"]["src"].as_str().unwrap_or("?")
        ),
        "not-installed" => {
            let lines: Vec<String> = parsed["extractors"]
                .as_array()
                .map(|extractors| {
                    extractors
                        .iter()
                        .map(|extractor| {
                            format!(
                                "{} ({} files): {}",
                                extractor["name"].as_str().unwrap_or("?"),
                                extractor["files"].as_u64().unwrap_or(0),
                                extractor["install"].as_str().unwrap_or("")
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            format!(
                "This folder needs an extractor that is not installed. In a terminal:\n\n{}\n\nThen open the folder again.",
                lines.join("\n")
            )
        }
        "ambiguous" => {
            let names: Vec<String> = parsed["candidates"]
                .as_array()
                .map(|candidates| {
                    candidates
                        .iter()
                        .map(|candidate| {
                            format!(
                                "{} ({} files)",
                                candidate["name"].as_str().unwrap_or("?"),
                                candidate["files"].as_u64().unwrap_or(0)
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            format!(
                "Several extractors claim this folder: {}. Type its path in the page's Open field to choose one.",
                names.join(", ")
            )
        }
        "no-extractor" => "No installed extractor claims any file in this folder.".to_string(),
        "not-found" => "That path is not a folder this machine can see.".to_string(),
        "not-a-model" => "That file is not a model.jsonl; open its folder instead.".to_string(),
        "unknown-extractor" => "No extractor of that name is registered.".to_string(),
        _ => format!("The daemon answered HTTP {code}."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sidecar_sits_beside_the_executable() {
        let path = sidecar_path(Path::new(
            "/Applications/Codegraph.app/Contents/MacOS/codegraph-desktop",
        ));
        let expected = if cfg!(windows) {
            "codegraph.exe"
        } else {
            "codegraph"
        };
        assert_eq!(
            path,
            Path::new("/Applications/Codegraph.app/Contents/MacOS").join(expected)
        );
    }

    #[test]
    fn refusals_become_one_sentence_with_the_install_line() {
        let text = describe_refusal(
            422,
            r#"{"error":"not-installed","extractors":[{"name":"java","files":16,"install":"brew install defsquare/tap/codegraph-java"}]}"#,
        );
        assert!(text.contains("java (16 files): brew install defsquare/tap/codegraph-java"));
        assert!(describe_refusal(409, r#"{"error":"busy","job":{"src":"/p"}}"#).contains("/p"));
        assert!(describe_refusal(422, r#"{"error":"ambiguous","candidates":[{"name":"typescript","files":2},{"name":"java","files":1}]}"#)
            .contains("typescript (2 files), java (1 files)"));
        assert_eq!(
            describe_refusal(500, "not json"),
            "The daemon answered HTTP 500."
        );
    }
}
