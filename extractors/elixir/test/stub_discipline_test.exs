defmodule CodegraphElixir.StubDisciplineTest do
  use ExUnit.Case, async: true

  import CodegraphElixir.Test.Harness

  @moduledoc """
  Membership is the whitelist of declared modules, never a name prefix
  (CLAUDE.md invariant 6): a corpus module named like an OTP one is corpus,
  an OTP module is a stub below `<otp>`, anything else below `<deps>`.
  """

  setup_all do
    scratch = Path.join(System.tmp_dir!(), "codegraph-ex-stubs-#{System.unique_integer([:positive])}")
    File.mkdir_p!(Path.join(scratch, "lib"))

    File.write!(Path.join(scratch, "lib/extra.ex"), """
    defmodule Enum.Extra do
      alias Enum
      alias Enum.Extra.Sub
      alias Foo.Unknown
      @behaviour GenServer
      def x, do: 1
    end
    """)

    File.write!(Path.join(scratch, "lib/sub.ex"), """
    defmodule Enum.Extra.Sub do
    end
    """)

    on_exit(fn -> File.rm_rf!(scratch) end)
    result = extract_fixture(["."], scratch)
    %{model: result.model, stats: result.stats}
  end

  test "a corpus module named below an OTP module is corpus, not a stub", %{model: model} do
    assert edge?(model, "import", "ex:lib%2Fextra.ex", "ex:lib%2Fsub.ex")
    refute "ex:<otp>/Enum%2EExtra%2ESub" in ids(model)
    assert find(model, "ex:lib%2Fsub.ex/Enum%2EExtra%2ESub").is_stub == false
  end

  test "an OTP module is a stub below <otp>, an unknown one below <deps>", %{model: model} do
    assert edge?(model, "import", "ex:lib%2Fextra.ex", "ex:<otp>/Enum")
    assert edge?(model, "import", "ex:lib%2Fextra.ex", "ex:<deps>/Foo%2EUnknown")
    assert edge?(model, "interfaceImplementation", "ex:lib%2Fextra.ex/Enum%2EExtra", "ex:<otp>/GenServer")
    assert find(model, "ex:<otp>/Enum").is_stub == true
    assert find(model, "ex:<deps>/Foo%2EUnknown").is_stub == true
    refute "ex:<deps>/Enum" in ids(model)
  end

  test "the summary counts stubs by origin", %{stats: stats} do
    assert stats.stubs == %{otp: 2, deps: 1}
    assert stats.imports_unresolved == 2
  end
end
