use codegraph_ruby::cli::{self, Io};
use std::io::IsTerminal;

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let cwd = match std::env::current_dir() {
        Ok(cwd) => cwd,
        Err(error) => {
            eprintln!("error: cannot read the current directory: {error}");
            std::process::exit(cli::EXIT_FAILURE);
        }
    };
    let stdout = std::io::stdout();
    let stderr = std::io::stderr();
    let stderr_terminal = stderr.is_terminal();
    let code = {
        let mut out = stdout.lock();
        let mut err = stderr.lock();
        let mut io = Io {
            stdout: &mut out,
            stderr: &mut err,
            stderr_terminal,
        };
        cli::run(&argv, &mut io, &cwd)
    };
    std::process::exit(code);
}
