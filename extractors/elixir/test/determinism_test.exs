defmodule CodegraphElixir.DeterminismTest do
  use ExUnit.Case, async: true

  import CodegraphElixir.Test.Harness
  alias CodegraphElixir.Model.Writer

  @moduledoc """
  Two runs over one unchanged corpus write the same bytes (contract §6) — on
  every OS, whatever the file system enumerates first, whatever the line
  endings a checkout produced. Anchors are line-based, so a CRLF copy of the
  corpus must produce the SAME model.
  """

  setup_all do
    scratch = Path.join(System.tmp_dir!(), "codegraph-ex-determinism-#{System.unique_integer([:positive])}")
    File.mkdir_p!(scratch)
    on_exit(fn -> File.rm_rf!(scratch) end)
    %{scratch: scratch}
  end

  defp bytes(sources, cwd), do: Writer.encode_to_string(extract_fixture(sources, cwd).model)

  test "writes the same bytes twice" do
    assert bytes([fixture_src()], repo_root()) == bytes([fixture_src()], repo_root())
  end

  test "writes the same bytes from a CRLF checkout of the corpus", %{scratch: scratch} do
    copy = Path.join(scratch, "crlf")
    File.mkdir_p!(Path.dirname(Path.join(copy, fixture_src())))
    File.cp_r!(Path.join(repo_root(), fixture_src()), Path.join(copy, fixture_src()))

    for path <- Path.wildcard(Path.join(copy, "**/*.{ex,exs}")) do
      text = path |> File.read!() |> String.replace("\r\n", "\n") |> String.replace("\n", "\r\n")
      File.write!(path, text)
    end

    assert bytes([fixture_src()], copy) == bytes([fixture_src()], repo_root())
  end

  test "keys nothing by walk order: two roots in either order give one model" do
    a = bytes(["#{fixture_src()}/lib", "#{fixture_src()}/test"], repo_root())
    b = bytes(["#{fixture_src()}/test", "#{fixture_src()}/lib"], repo_root())
    assert a == b
    # With several roots the header names their common ancestor.
    header = a |> String.split("\n") |> hd() |> JSON.decode!()
    assert header["root"] == fixture_src()
  end
end
