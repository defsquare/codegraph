defmodule CodegraphElixir.MixProject do
  use Mix.Project

  # The Elixir extractor (PLAN.md §16): the compiler's parser as a library, a
  # lexical resolver, an embedded OTP module table — and NO runtime dependency,
  # so the escript runs wherever Erlang/OTP does. Test-only dependencies are
  # the fast-check of this side (stream_data).
  def project do
    [
      app: :codegraph_elixir,
      version: "0.1.0",
      elixir: "~> 1.18",
      start_permanent: false,
      deps: deps(),
      escript: escript(),
      elixirc_paths: elixirc_paths(Mix.env()),
      test_coverage: [summary: [threshold: 0]],
      description:
        "codegraph's Elixir extractor: the parser as a library, no compile, no deps — plus `mix codegraph.trace` for the compiler-trace enrichment",
      package: package(),
      source_url: "https://github.com/defsquare/codegraph",
      releases: releases()
    ]
  end

  # The Burrito binary (PLAN.md §16.7): a Mix release plus its ERTS in one
  # executable per target, cross-built from one host through Zig. Built by
  # `build.sh --elixir --native` for the host, `--publish-all` for the five;
  # BURRITO_TARGET picks one. The escript stays the development artifact.
  defp releases do
    [
      codegraph_elixir: [
        steps: [:assemble, &Burrito.wrap/1],
        burrito: [
          targets: [
            linux_x64: [os: :linux, cpu: :x86_64],
            linux_arm64: [os: :linux, cpu: :aarch64],
            osx_x64: [os: :darwin, cpu: :x86_64],
            osx_arm64: [os: :darwin, cpu: :aarch64],
            win_x64: [os: :windows, cpu: :x86_64]
          ]
        ]
      ]
    ]
  end

  # The Hex package exists so a project can `mix codegraph.trace` by adding one
  # dependency; the escript is still the way to run the extractor.
  defp package do
    [
      name: "codegraph_elixir",
      licenses: ["MIT"],
      links: %{"GitHub" => "https://github.com/defsquare/codegraph"},
      files: ["lib", "mix.exs", "README.md"]
    ]
  end

  # `mod`: the release (the Burrito binary) starts the application, which runs
  # the CLI (CodegraphElixir.Application). The escript never starts it.
  def application do
    [extra_applications: [:logger], mod: {CodegraphElixir.Application, []}]
  end

  defp escript do
    [
      main_module: CodegraphElixir.CLI,
      name: "codegraph-elixir",
      path: "dist/codegraph-elixir",
      app: nil,
      # The escript embeds Elixir; the machine needs Erlang/OTP alone.
      embed_elixir: true
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  defp deps do
    [
      {:stream_data, "~> 1.1", only: :test},
      # A build tool, never a runtime dependency: present only where the release is built.
      {:burrito, "~> 1.6", only: :prod, runtime: false}
    ]
  end
end
