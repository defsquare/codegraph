defmodule CodegraphElixir.CLITest do
  use ExUnit.Case, async: true

  import CodegraphElixir.Test.Harness
  alias CodegraphElixir.CLI

  @moduledoc "The extractor command-line contract (schemas/README.md §8)."

  setup_all do
    scratch = Path.join(System.tmp_dir!(), "codegraph-ex-cli-#{System.unique_integer([:positive])}")
    File.mkdir_p!(scratch)
    on_exit(fn -> File.rm_rf!(scratch) end)
    %{scratch: scratch}
  end

  test "prints its version on stdout and nothing else" do
    assert %{code: 0, stdout: stdout, stderr: ""} = invoke(["--version"])
    assert stdout == "#{CLI.version()}\n"
  end

  test "prints usage on --help" do
    assert %{code: 0, stdout: stdout} = invoke(["--help"])
    assert stdout =~ "--src <dir>"
    assert stdout =~ "--deps <dir>"
  end

  test "exits 2 on a bad option, naming it" do
    assert %{code: 2, stderr: stderr, stdout: ""} = invoke(["--bogus"])
    assert stderr =~ "unknown option: --bogus"
  end

  test "exits 2 when the repository flags are incomplete" do
    assert %{code: 2, stderr: stderr} = invoke(["--src", fixture_src(), "--repo-commit", "abc1234"])
    assert stderr =~ "--repo-remote, --repo-commit and --repo-root go together"
  end

  test "exits 1 when a source root does not exist", %{scratch: scratch} do
    assert %{code: 1, stderr: stderr} =
             invoke(["--src", Path.join(scratch, "nowhere"), "--out", Path.join(scratch, "x.jsonl")])

    assert stderr =~ "not a directory"
  end

  test "exits 1 when the trace file cannot be read", %{scratch: scratch} do
    assert %{code: 1, stderr: stderr} =
             invoke(["--src", fixture_src(), "--trace", Path.join(scratch, "t.jsonl")])

    assert stderr =~ "--trace: cannot read"
  end

  test "--explain-dropped names every dropped site", %{scratch: scratch} do
    out = Path.join(scratch, "explained.jsonl")

    assert %{code: 0, stderr: stderr} =
             invoke(["--src", fixture_src(), "--out", out, "--progress", "none", "--explain-dropped"])

    assert stderr =~ "dropped local_injected: lib/acme_order/schema/line.ex:10 field/2"
    assert stderr =~ "dropped map_access: lib/acme_order/order.ex:23"
  end

  test "writes the snapshot, keeps stdout empty, and summarises on stderr", %{scratch: scratch} do
    out = Path.join(scratch, "model.jsonl")

    assert %{code: 0, stdout: "", stderr: stderr} =
             invoke(["--src", fixture_src(), "--out", out, "--progress", "none"])

    assert stderr =~ "RESOLUTION SUMMARY"
    assert stderr =~ "wrote #{out}"
    assert stderr =~ "unparsed (skipped): lib/acme_order/legacy/broken.ex"
    assert File.read!(out) == File.read!(snapshot())
  end

  test "copies the repository facts verbatim into the header", %{scratch: scratch} do
    out = Path.join(scratch, "repo.jsonl")

    assert %{code: 0} =
             invoke([
               "--src",
               fixture_src(),
               "--out",
               out,
               "--progress",
               "none",
               "--repo-remote",
               "https://github.com/acme/order",
               "--repo-commit",
               "0123456789abcdef",
               "--repo-root",
               "fixtures/elixir/src"
             ])

    header = out |> File.read!() |> String.split("\n") |> hd() |> JSON.decode!()

    assert header["repository"] == %{
             "remote" => "https://github.com/acme/order",
             "commit" => "0123456789abcdef",
             "root" => "fixtures/elixir/src"
           }
  end
end
