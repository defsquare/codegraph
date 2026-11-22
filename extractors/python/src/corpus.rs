//! Pass 0 — the walk. Every Python file under the roots, in ordinal order,
//! read as bytes and decoded as Python decodes it (a BOM, the PEP 263 cookie);
//! then the import roots the layout implies. Nothing is run, nothing installed
//! is read, and what the model writes of a path is `/`-separated and
//! root-relative on every OS.

use codegraph_model::utf16_cmp;
use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

/// Skipped by name: bytecode caches, an installed environment's packages, a
/// JavaScript tree. A virtual environment is skipped by what it IS (`pyvenv.cfg`).
const SKIPPED_DIRECTORIES: &[&str] = &["__pycache__", "site-packages", "node_modules"];
/// A source, a Windows script, a stub. An extensionless script says so in its shebang.
const EXTENSIONS: &[&str] = &["py", "pyw", "pyi"];

/// How a file's bytes became text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decoding {
    Utf8,
    /// UTF-8 behind a byte-order mark, which is not part of the text.
    Bom,
    /// A single-byte encoding the cookie declares, decoded exactly.
    Declared {
        encoding: &'static str,
        non_ascii: usize,
    },
    /// Bytes the declared (or default) encoding could not give: U+FFFD each.
    Lossy {
        encoding: String,
        replaced: usize,
    },
}

pub struct SourceFile {
    /// Root-relative, `/`-separated.
    pub rel: String,
    /// Decoded, without a BOM: the parser's offsets index this.
    pub text: String,
    pub decoding: Decoding,
    /// Byte offset of each line's first character; `\n`, `\r\n` and a lone `\r` end a line.
    pub line_starts: Vec<u32>,
    /// Line count, at least 1: the module's anchor is `[1, lines]`.
    pub lines: u32,
}

impl SourceFile {
    /// The 1-based line holding byte `offset`.
    pub fn line_of(&self, offset: u32) -> u32 {
        self.line_starts.partition_point(|&start| start <= offset) as u32
    }
}

/// A directory a dotted name is looked up below: `import a.b` reads `<dir>/a/b.py`.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Root {
    /// Root-relative, `""` for the corpus root.
    pub dir: String,
    /// Set when the corpus root is itself a package: the root is the directory
    /// above it, which no walk reads, and every name below starts with this one.
    pub prefix: Option<String>,
}

pub struct Corpus {
    /// The header's `root`: the path as typed, or the common ancestor of several roots.
    pub root_display: String,
    /// The corpus root's own directory name, for a corpus root that is a package.
    pub root_name: Option<String>,
    pub files: Vec<SourceFile>,
    /// `--import-root`, root-relative.
    pub import_roots: Vec<String>,
}

impl Corpus {
    /// Every directory a walked file lies below, the corpus root (`""`) included.
    pub fn directories(&self) -> HashSet<String> {
        let mut out = HashSet::new();
        out.insert(String::new());
        for file in &self.files {
            let mut dir = parent_dir(&file.rel);
            while !dir.is_empty() && out.insert(dir.to_owned()) {
                dir = parent_dir(dir);
            }
        }
        out
    }

    /// The directories that hold an `__init__.py`: the regular packages.
    pub fn packages(&self) -> HashSet<String> {
        self.files
            .iter()
            .filter(|file| is_package_init(&file.rel))
            .map(|file| parent_dir(&file.rel).to_owned())
            .collect()
    }

    /// The roots an absolute import is looked up in: each file's package root,
    /// the corpus root and every `--import-root`, in order.
    pub fn roots(&self) -> Vec<Root> {
        let packages = self.packages();
        let mut roots: BTreeSet<Root> = self
            .files
            .iter()
            .map(|file| package_root(&file.rel, &packages, self.root_name.as_deref()))
            .collect();
        roots.insert(Root {
            dir: String::new(),
            prefix: None,
        });
        for dir in &self.import_roots {
            roots.insert(Root {
                dir: dir.clone(),
                prefix: None,
            });
        }
        roots.into_iter().collect()
    }
}

pub fn slashes(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Absolute and lexically normalised: no symlink is resolved, so the result
/// never depends on what the file system points at.
pub fn absolute(path: &str, cwd: &Path) -> PathBuf {
    let joined = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        cwd.join(path)
    };
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Deepest common ancestor of absolute directories — one root, no absolute anchor.
pub fn common_root(roots: &[PathBuf]) -> PathBuf {
    let mut common = roots[0].clone();
    for root in &roots[1..] {
        while !root.starts_with(&common) {
            if !common.pop() {
                break;
            }
        }
    }
    common
}

/// The typed path with `/` separators and no trailing slash.
fn display(typed: &str) -> String {
    let text = typed.replace('\\', "/");
    let trimmed = text.trim_end_matches('/');
    if trimmed.is_empty() {
        ".".to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// The directory part of a root-relative path; `""` at the root.
pub fn parent_dir(path: &str) -> &str {
    path.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("")
}

/// A package's own file: its `__init__.py`, or the stub of one.
pub fn is_package_init(rel: &str) -> bool {
    let name = rel.rsplit_once('/').map_or(rel, |(_, name)| name);
    name == "__init__.py" || name == "__init__.pyi"
}

/// `#!/usr/bin/env python3`: a script that says it is Python.
fn python_shebang(head: &[u8]) -> bool {
    let line = head.split(|byte| *byte == b'\n').next().unwrap_or(&[]);
    line.starts_with(b"#!") && line.windows(6).any(|window| window == b"python")
}

/// The first bytes of a file with no extension: enough for its shebang.
fn has_python_shebang(path: &Path) -> bool {
    use std::io::Read;
    let mut head = [0u8; 128];
    let Ok(read) = fs::File::open(path).and_then(|mut file| file.read(&mut head)) else {
        return false;
    };
    python_shebang(&head[..read])
}

fn is_python_file(name: &str) -> bool {
    match name.rsplit_once('.') {
        Some((stem, extension)) => !stem.is_empty() && EXTENSIONS.contains(&extension),
        None => false,
    }
}

fn skipped_directory(name: &str) -> bool {
    name.starts_with('.') || SKIPPED_DIRECTORIES.contains(&name)
}

/// Where a file's dotted name starts: climb while the directory holds an
/// `__init__.py`; the first that does not is the root (mypy's rule).
pub fn package_root(rel: &str, packages: &HashSet<String>, root_name: Option<&str>) -> Root {
    let mut dir = parent_dir(rel);
    loop {
        if !packages.contains(dir) {
            return Root {
                dir: dir.to_owned(),
                prefix: None,
            };
        }
        if dir.is_empty() {
            return Root {
                dir: String::new(),
                prefix: root_name.map(str::to_owned),
            };
        }
        dir = parent_dir(dir);
    }
}

/// Byte offsets of line starts: `\n`, `\r\n` and a lone `\r` each end a line.
pub fn line_starts(text: &str) -> Vec<u32> {
    let bytes = text.as_bytes();
    let mut starts = vec![0u32];
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'\n' => starts.push(at as u32 + 1),
            b'\r' => {
                if bytes.get(at + 1) == Some(&b'\n') {
                    at += 1;
                }
                starts.push(at as u32 + 1);
            }
            _ => {}
        }
        at += 1;
    }
    starts
}

/// Lines as an anchor needs them: a last line without a terminator counts.
pub fn line_count(text: &str, starts: &[u32]) -> u32 {
    let terminated = !text.is_empty() && starts.last() == Some(&(text.len() as u32));
    (starts.len() as u32 - u32::from(terminated)).max(1)
}

/// The encodings decoded here; anything else is read as UTF-8, lossily.
enum Codec {
    Utf8,
    Latin1,
    Cp1252,
    Ascii,
    Other(String),
}

/// The aliases `encodings.aliases` gives the four codecs decoded here, normalized.
const UTF8_NAMES: &[&str] = &["utf_8", "u8", "utf", "utf8", "utf8_ucs2", "utf8_ucs4", "cp65001"];
const LATIN1_NAMES: &[&str] = &[
    "latin_1",
    "8859",
    "cp819",
    "csisolatin1",
    "ibm819",
    "iso8859",
    "iso8859_1",
    "iso_8859_1",
    "iso_8859_1_1987",
    "iso_ir_100",
    "l1",
    "latin",
    "latin1",
];
const CP1252_NAMES: &[&str] = &["cp1252", "1252", "windows_1252"];
const ASCII_NAMES: &[&str] = &[
    "ascii",
    "646",
    "ansi_x3.4_1968",
    "ansi_x3_4_1968",
    "ansi_x3.4_1986",
    "cp367",
    "csascii",
    "ibm367",
    "iso646_us",
    "iso_646.irv_1991",
    "iso_ir_6",
    "us",
    "us_ascii",
];

/// `encodings.normalize_encoding`: every run of characters other than an ASCII
/// letter, digit or `.` becomes one `_`, none at either end.
fn normalize_encoding(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut punctuation = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || c == '.' {
            if punctuation && !out.is_empty() {
                out.push('_');
            }
            out.push(c);
            punctuation = false;
        } else {
            punctuation = true;
        }
    }
    out
}

/// A codec name as `tokenize` reads it (its UTF-8 and Latin-1 prefixes), then as `codecs` looks it up.
fn codec(declared: &str) -> Codec {
    let lower = declared.to_ascii_lowercase();
    let head: String = lower.chars().take(12).collect::<String>().replace('_', "-");
    let prefixed = |base: &str| head == base || head.starts_with(&format!("{base}-"));
    if prefixed("utf-8") {
        return Codec::Utf8;
    }
    if prefixed("latin-1") || prefixed("iso-8859-1") || prefixed("iso-latin-1") {
        return Codec::Latin1;
    }
    let name = normalize_encoding(&lower);
    let named = |names: &[&str]| names.contains(&name.as_str()) || names.contains(&name.replace('.', "_").as_str());
    if named(UTF8_NAMES) {
        Codec::Utf8
    } else if named(LATIN1_NAMES) {
        Codec::Latin1
    } else if named(CP1252_NAMES) {
        Codec::Cp1252
    } else if named(ASCII_NAMES) {
        Codec::Ascii
    } else {
        Codec::Other(lower)
    }
}

/// `[ \t\f]*#.*?coding[:=][ \t]*([-\w.]+)` — the PEP 263 cookie, on one line.
fn cookie(line: &[u8]) -> Option<String> {
    let start = line.iter().position(|b| !matches!(b, b' ' | b'\t' | b'\x0c'))?;
    if line[start] != b'#' {
        return None;
    }
    let mut at = start;
    while let Some(found) = line[at..].windows(6).position(|window| window == b"coding") {
        let after = at + found + 6;
        if matches!(line.get(after), Some(b':' | b'=')) {
            let rest = &line[after + 1..];
            let skip = rest.iter().take_while(|b| matches!(b, b' ' | b'\t')).count();
            let name: Vec<u8> = rest[skip..]
                .iter()
                .copied()
                .take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
                .collect();
            if !name.is_empty() {
                return Some(String::from_utf8_lossy(&name).into_owned());
            }
        }
        at += found + 1;
    }
    None
}

/// The first two lines as `tokenize` reads them; `\r\n` and a lone `\r` end one too.
fn first_two_lines(bytes: &[u8]) -> (&[u8], &[u8]) {
    let end = |from: usize| -> (usize, usize) {
        match bytes[from..].iter().position(|b| matches!(b, b'\n' | b'\r')) {
            None => (bytes.len(), bytes.len()),
            Some(offset) => {
                let at = from + offset;
                let next = if bytes[at] == b'\r' && bytes.get(at + 1) == Some(&b'\n') {
                    at + 2
                } else {
                    at + 1
                };
                (at, next)
            }
        }
    };
    let (first_end, second_start) = end(0);
    let (second_end, _) = end(second_start);
    (&bytes[..first_end], &bytes[second_start..second_end])
}

/// `tokenize`'s `blank_re`: nothing but whitespace, or a comment.
fn blank_or_comment(line: &[u8]) -> bool {
    match line.iter().find(|b| !matches!(b, b' ' | b'\t' | b'\x0c')) {
        None => true,
        Some(first) => *first == b'#',
    }
}

/// UTF-8, one U+FFFD per invalid sequence: the text and how many there were.
fn utf8_lossy(bytes: &[u8]) -> (String, usize) {
    let mut text = String::with_capacity(bytes.len());
    let mut replaced = 0;
    for chunk in bytes.utf8_chunks() {
        text.push_str(chunk.valid());
        if !chunk.invalid().is_empty() {
            text.push('\u{fffd}');
            replaced += 1;
        }
    }
    (text, replaced)
}

/// Windows-1252's 0x80–0x9F; `None` where the code page leaves a byte undefined.
const CP1252: [Option<char>; 32] = [
    Some('\u{20ac}'),
    None,
    Some('\u{201a}'),
    Some('\u{0192}'),
    Some('\u{201e}'),
    Some('\u{2026}'),
    Some('\u{2020}'),
    Some('\u{2021}'),
    Some('\u{02c6}'),
    Some('\u{2030}'),
    Some('\u{0160}'),
    Some('\u{2039}'),
    Some('\u{0152}'),
    None,
    Some('\u{017d}'),
    None,
    None,
    Some('\u{2018}'),
    Some('\u{2019}'),
    Some('\u{201c}'),
    Some('\u{201d}'),
    Some('\u{2022}'),
    Some('\u{2013}'),
    Some('\u{2014}'),
    Some('\u{02dc}'),
    Some('\u{2122}'),
    Some('\u{0161}'),
    Some('\u{203a}'),
    Some('\u{0153}'),
    None,
    Some('\u{017e}'),
    Some('\u{0178}'),
];

/// A single-byte code page: each byte one character, `None` an undefined one.
fn single_byte(bytes: &[u8], map: impl Fn(u8) -> Option<char>) -> (String, usize) {
    let mut replaced = 0;
    let text = bytes
        .iter()
        .map(|&byte| {
            map(byte).unwrap_or_else(|| {
                replaced += 1;
                '\u{fffd}'
            })
        })
        .collect();
    (text, replaced)
}

/// Bytes → text, as Python decodes a source (PEP 263, PEP 3120): a BOM, else
/// the cookie of the first two lines, else UTF-8. Never refuses a file.
pub fn decode(bytes: &[u8]) -> (String, Decoding) {
    if let Some(rest) = bytes.strip_prefix(b"\xef\xbb\xbf") {
        let (text, replaced) = utf8_lossy(rest);
        return match replaced {
            0 => (text, Decoding::Bom),
            _ => (
                text,
                Decoding::Lossy {
                    encoding: "utf-8".into(),
                    replaced,
                },
            ),
        };
    }
    let (first, second) = first_two_lines(bytes);
    let declared = cookie(first).or_else(|| if blank_or_comment(first) { cookie(second) } else { None });
    let non_ascii = bytes.iter().filter(|b| !b.is_ascii()).count();
    let codec = match declared {
        // ASCII bytes read the same in every codec this extractor knows of.
        _ if non_ascii == 0 => Codec::Utf8,
        None => Codec::Utf8,
        Some(name) => codec(&name),
    };
    let lossy = |text: String, encoding: &str, replaced: usize| {
        (
            text,
            Decoding::Lossy {
                encoding: encoding.to_owned(),
                replaced,
            },
        )
    };
    match codec {
        Codec::Utf8 => match utf8_lossy(bytes) {
            (text, 0) => (text, Decoding::Utf8),
            (text, replaced) => lossy(text, "utf-8", replaced),
        },
        Codec::Latin1 => (
            single_byte(bytes, |byte| Some(char::from(byte))).0,
            Decoding::Declared {
                encoding: "iso-8859-1",
                non_ascii,
            },
        ),
        Codec::Cp1252 => {
            let (text, replaced) = single_byte(bytes, |byte| match byte {
                0x80..=0x9f => CP1252[usize::from(byte - 0x80)],
                _ => Some(char::from(byte)),
            });
            match replaced {
                0 => (
                    text,
                    Decoding::Declared {
                        encoding: "cp1252",
                        non_ascii,
                    },
                ),
                _ => lossy(text, "cp1252", replaced),
            }
        }
        Codec::Ascii => {
            let (text, replaced) = single_byte(bytes, |byte| byte.is_ascii().then(|| char::from(byte)));
            lossy(text, "ascii", replaced)
        }
        Codec::Other(name) => {
            let (text, replaced) = utf8_lossy(bytes);
            lossy(text, &name, replaced)
        }
    }
}

fn walk(directory: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = fs::read_dir(directory).map_err(|e| format!("cannot read {}: {e}", slashes(directory)))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("cannot read {}: {e}", slashes(directory)))?;
        let path = entry.path();
        // A name that is not Unicode cannot enter a model, and no import can spell it.
        let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_owned) else {
            continue;
        };
        let Ok(file_type) = entry.file_type() else { continue };
        if file_type.is_dir() {
            // A virtual environment is known by what it holds, not by what it is called.
            if !skipped_directory(&name) && !path.join("pyvenv.cfg").is_file() {
                walk(&path, out)?;
            }
        } else if is_python_file(&name) || (!name.contains('.') && has_python_shebang(&path)) {
            // A symlinked FILE is read; a symlinked directory is not followed (no cycles).
            if file_type.is_file() || fs::metadata(&path).map(|m| m.is_file()).unwrap_or(false) {
                out.push(path);
            }
        }
    }
    Ok(())
}

pub fn load(sources: &[String], import_roots: &[String], cwd: &Path) -> Result<Corpus, String> {
    let roots: Vec<PathBuf> = sources.iter().map(|source| absolute(source, cwd)).collect();
    for root in &roots {
        if !root.is_dir() {
            return Err(format!("source root is not a directory: {}", slashes(root)));
        }
    }
    let root = common_root(&roots);
    let root_display = match sources {
        [single] => display(single),
        _ => match root.strip_prefix(absolute(".", cwd)) {
            Ok(relative) => display(&slashes(relative)),
            Err(_) => slashes(&root),
        },
    };
    let mut relative_roots = Vec::with_capacity(import_roots.len());
    for typed in import_roots {
        let full = absolute(typed, cwd);
        let inside = full.strip_prefix(&root).ok().filter(|_| full.is_dir());
        let Some(rel) = inside else {
            return Err(format!(
                "--import-root is not a directory under the source root {}: {typed}",
                slashes(&root)
            ));
        };
        relative_roots.push(slashes(rel));
    }

    let mut found = Vec::new();
    for directory in &roots {
        walk(directory, &mut found)?;
    }
    let mut relative: Vec<(String, PathBuf)> = Vec::with_capacity(found.len());
    for full in found {
        let rel = full
            .strip_prefix(&root)
            .map_err(|_| format!("{} is not under the root", slashes(&full)))?;
        relative.push((slashes(rel), full));
    }
    // Ordinal order, never the file system's: the walk order IS the file table.
    relative.sort_by(|(a, _), (b, _)| utf16_cmp(a, b));
    relative.dedup_by(|(a, _), (b, _)| a == b);

    let mut files = Vec::with_capacity(relative.len());
    for (rel, full) in relative {
        let bytes = fs::read(&full).map_err(|e| format!("cannot read {rel}: {e}"))?;
        let (text, decoding) = decode(&bytes);
        let line_starts = line_starts(&text);
        let lines = line_count(&text, &line_starts);
        files.push(SourceFile {
            rel,
            text,
            decoding,
            line_starts,
            lines,
        });
    }
    Ok(Corpus {
        root_display,
        root_name: root.file_name().and_then(|name| name.to_str()).map(str::to_owned),
        files,
        import_roots: relative_roots,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(items: &[&str]) -> HashSet<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn walks_python_sources_and_skips_what_is_installed_or_generated() {
        // A stub is Python as much as its module is.
        for name in ["order.py", "gui.pyw", "order.pyi", "promo#2024.py", "__init__.py"] {
            assert!(is_python_file(name), "{name}");
        }
        for name in ["order.pyc", ".py", "README.md", "order.py.bak", "setup.cfg"] {
            assert!(!is_python_file(name), "{name}");
        }
        for name in [".venv", ".git", ".tox", "__pycache__", "site-packages", "node_modules"] {
            assert!(skipped_directory(name), "{name}");
        }
        // Vendored code is written in the repository: corpus.
        for name in ["_vendor", "vendor", "build", "env", "lib"] {
            assert!(!skipped_directory(name), "{name}");
        }
    }

    #[test]
    fn tells_a_python_script_without_an_extension_by_its_shebang() {
        for line in [
            "#!/usr/bin/env python",
            "#!/usr/bin/python3.12 -u",
            "#! /usr/bin/env python2\n",
        ] {
            assert!(python_shebang(line.as_bytes()), "{line}");
        }
        for line in ["#!/bin/sh", "#!/usr/bin/env ruby", "python", "# python"] {
            assert!(!python_shebang(line.as_bytes()), "{line}");
        }
    }

    #[test]
    fn counts_lines_with_all_three_terminators() {
        assert_eq!(line_starts("a\nb"), vec![0, 2]);
        assert_eq!(line_starts("a\r\nb"), vec![0, 3]);
        assert_eq!(line_starts("a\rb\r\rc"), vec![0, 2, 4, 5]);
        for (text, lines) in [
            ("", 1),
            ("a", 1),
            ("a\n", 1),
            ("a\nb", 2),
            ("a\r\nb\r\n", 2),
            ("a\rb\r", 2),
            ("\n\n", 2),
        ] {
            assert_eq!(line_count(text, &line_starts(text)), lines, "{text:?}");
        }
        let file = SourceFile {
            rel: "m.py".into(),
            text: "x\r\ny\rz".into(),
            decoding: Decoding::Utf8,
            line_starts: line_starts("x\r\ny\rz"),
            lines: 3,
        };
        assert_eq!(
            [0, 1, 2, 3, 4, 5].map(|offset| file.line_of(offset)),
            [1, 1, 1, 2, 2, 3]
        );
    }

    #[test]
    fn decodes_as_python_does_and_never_refuses_a_file() {
        assert_eq!(decode(b"x = 1\n"), ("x = 1\n".to_owned(), Decoding::Utf8));
        assert_eq!(decode("é = 1\n".as_bytes()), ("é = 1\n".to_owned(), Decoding::Utf8));
        // A BOM is not text.
        assert_eq!(decode(b"\xef\xbb\xbfx = 1\n"), ("x = 1\n".to_owned(), Decoding::Bom));
        // The cookie of line 1, and of line 2 behind a shebang.
        let latin = decode(b"# -*- coding: latin-1 -*-\ns = '\xe9'\n");
        assert_eq!(latin.0, "# -*- coding: latin-1 -*-\ns = 'é'\n");
        assert_eq!(
            latin.1,
            Decoding::Declared {
                encoding: "iso-8859-1",
                non_ascii: 1
            }
        );
        let second = decode(b"#!/usr/bin/env python\n# vim: set fileencoding=iso-8859-1 :\n'\xe9'\n");
        assert_eq!(
            second.1,
            Decoding::Declared {
                encoding: "iso-8859-1",
                non_ascii: 1
            }
        );
        // Windows' code page: 0x80 is the euro sign.
        let windows = decode(b"# coding=cp1252\ns = '\x80'\n");
        assert_eq!(windows.0, "# coding=cp1252\ns = '\u{20ac}'\n");
        assert_eq!(
            windows.1,
            Decoding::Declared {
                encoding: "cp1252",
                non_ascii: 1
            }
        );
        // Line 2 is read only when line 1 is blank or a comment.
        let late = decode(b"x = 1\n# coding: latin-1\n'\xe9'\n");
        assert_eq!(
            late.1,
            Decoding::Lossy {
                encoding: "utf-8".into(),
                replaced: 1
            }
        );
        // An encoding this extractor does not decode is read lossily, and says so.
        let japanese = decode(b"# coding: euc-jp\n'\xa4\xa2'\n");
        assert_eq!(
            japanese.1,
            Decoding::Lossy {
                encoding: "euc-jp".into(),
                replaced: 2
            }
        );
        // A cookie over ASCII bytes changes nothing: that is UTF-8.
        assert_eq!(decode(b"# coding: latin-1\nx = 1\n").1, Decoding::Utf8);
        assert_eq!(
            decode(b"# coding: ascii\n'\xe9'\n").1,
            Decoding::Lossy {
                encoding: "ascii".into(),
                replaced: 1
            }
        );
        // A name as `codecs` normalizes it: CPython 2.7's plat-mac/macerrors.py writes `latin1-`.
        for cookie in ["latin1-", "ISO_8859-1", "iso8859_1", "L1", "Latin-1-unix", "latin"] {
            let source = format!("# -*- coding: {cookie} -*-\n'\u{e9}'\n");
            let bytes: Vec<u8> = source.chars().map(|c| c as u32 as u8).collect();
            assert_eq!(
                decode(&bytes).1,
                Decoding::Declared {
                    encoding: "iso-8859-1",
                    non_ascii: 1
                },
                "{cookie}"
            );
        }
        for cookie in ["UTF8", "utf_8", "u8", "utf-8-unix"] {
            assert_eq!(
                decode(format!("# coding={cookie}\n'é'\n").as_bytes()).1,
                Decoding::Utf8,
                "{cookie}"
            );
        }
        assert_eq!(
            decode(b"# coding: windows_1252\n'\x80'\n").1,
            Decoding::Declared {
                encoding: "cp1252",
                non_ascii: 1
            }
        );
        // cp1252 leaves five bytes undefined: Python refuses them, this reads them as U+FFFD.
        assert_eq!(
            decode(b"# coding: cp1252\n'\x81'\n").1,
            Decoding::Lossy {
                encoding: "cp1252".into(),
                replaced: 1
            }
        );
    }

    #[test]
    fn names_a_files_root_after_the_packages_it_climbs() {
        let packages = set(&["src/acme", "src/acme/sub", "lib/pkg"]);
        let root = |dir: &str| Root {
            dir: dir.to_owned(),
            prefix: None,
        };
        assert_eq!(package_root("src/acme/sub/x.py", &packages, None), root("src"));
        assert_eq!(package_root("src/acme/__init__.py", &packages, None), root("src"));
        assert_eq!(package_root("tests/test_a.py", &packages, None), root("tests"));
        assert_eq!(package_root("a.py", &packages, None), root(""));
        // A namespace directory stops the climb: its files are named from it.
        assert_eq!(
            package_root("src/plugins/stripe.py", &packages, None),
            root("src/plugins")
        );
        // A corpus root that is itself a package: the root is above it, named by it.
        let rooted = set(&["", "sub"]);
        assert_eq!(
            package_root("sub/x.py", &rooted, Some("pkg")),
            Root {
                dir: String::new(),
                prefix: Some("pkg".into())
            }
        );
        assert_eq!(package_root("sub/x.py", &rooted, None), root(""));
    }

    #[test]
    fn finds_the_deepest_common_ancestor_without_touching_the_disk() {
        let cwd = Path::new("/work/repo");
        assert_eq!(absolute("src/../lib/./acme", cwd), PathBuf::from("/work/repo/lib/acme"));
        let roots = [
            absolute("src/acme", cwd),
            absolute("src/plugins", cwd),
            absolute("tests", cwd),
        ];
        assert_eq!(common_root(&roots), PathBuf::from("/work/repo"));
        assert_eq!(common_root(&roots[..2]), PathBuf::from("/work/repo/src"));
        assert_eq!(display("fixtures/python/src/"), "fixtures/python/src");
        assert_eq!(display("./"), ".");
        assert_eq!(parent_dir("src/acme/order.py"), "src/acme");
        assert_eq!(parent_dir("conftest.py"), "");
    }
}
