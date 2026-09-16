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
      test_coverage: [summary: [threshold: 0]]
    ]
  end

  def application do
    [extra_applications: [:logger]]
  end

  defp escript do
    [
      main_module: CodegraphElixir.CLI,
      name: "codegraph-elixir",
      path: "dist/codegraph-elixir",
      # The escript embeds Elixir; the machine needs Erlang/OTP alone.
      embed_elixir: true
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  defp deps do
    [
      {:stream_data, "~> 1.1", only: :test}
    ]
  end
end
