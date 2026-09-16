defmodule CodegraphElixir.Model do
  @moduledoc """
  The extractor's in-memory model: what `schemas/` describes, with natural
  keys where the wire has surrogates. No metamodel intelligence lives here —
  the vocabularies are restated from `schemas/*.schema.json`, and `core`'s
  profile decides in its own tests whether the compositions this extractor
  emits are licensed.
  """

  defstruct lang: "ex", extractor: [], root: ".", repository: nil, entities: [], edges: []

  defmodule Entity do
    @moduledoc """
    One entity; `anchor` is `{file, start_line, end_line}`; `value` a literal
    map (`%{k: "string", v: …}`, a `type` literal's `type` a key); `extra`
    are pass-through keys.
    """
    @enforce_keys [:key, :kind, :traits]
    defstruct [
      :key,
      :kind,
      :traits,
      name: nil,
      signature: nil,
      is_stub: nil,
      parent: nil,
      attached_to: nil,
      parameters: nil,
      defined_in: nil,
      comments: nil,
      metrics: nil,
      value: nil,
      anchor: nil,
      extra: []
    ]
  end

  defmodule Edge do
    @moduledoc "One outgoing edge between two keys, with its evidence and its fact/inference status."
    @enforce_keys [:kind, :from, :to, :provenance, :anchor]
    defstruct [:kind, :from, :to, :provenance, :anchor, candidates: nil, is_read: nil, is_write: nil]
  end
end
