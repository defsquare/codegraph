//! bca's space tree for one file — the other side of every join, for audits:
//!
//!   cargo run --example spaces -- <java|csharp|ts|ex|rb> <file>

use big_code_analysis::{FuncSpace, LANG, MetricsOptions, Source, analyze};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [lang, path] = args.as_slice() else {
        eprintln!("usage: spaces <java|csharp|ts|ex|rb> <file>");
        std::process::exit(2);
    };
    let lang = match lang.as_str() {
        "java" => LANG::Java,
        "csharp" => LANG::Csharp,
        "ts" if path.ends_with(".tsx") => LANG::Tsx,
        "ts" => LANG::Typescript,
        "ex" => LANG::Elixir,
        "rb" => LANG::Ruby,
        other => panic!("unknown language {other}"),
    };
    let code = std::fs::read(path).expect("readable file");
    let root = analyze(Source::new(lang, &code), MetricsOptions::default()).expect("parses");
    print(&root, 0);
}

fn print(space: &FuncSpace, depth: usize) {
    let m = &space.metrics;
    println!(
        "{:indent$}{:?} {} {}-{}  ploc {} cognitive {} nexits {}",
        "",
        space.kind,
        space.name.as_deref().unwrap_or("?"),
        space.start_line,
        space.end_line,
        m.loc.ploc(),
        m.cognitive.cognitive(),
        m.nexits.nexits(),
        indent = depth * 2
    );
    for child in &space.spaces {
        print(child, depth + 1);
    }
}
