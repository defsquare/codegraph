defmodule AcmeOrder.Macros do
  @moduledoc "A `use`-able macro module: injects a `channel/0`."

  defmacro __using__(opts) do
    channel = Keyword.get(opts, :channel, :web)

    quote do
      import AcmeOrder.Macros, only: [assert_channel: 1]
      def channel, do: unquote(channel)
    end
  end

  defmacro assert_channel(value) do
    quote do
      unquote(value) in [:web, :phone, :store] or raise(ArgumentError, "unknown channel")
    end
  end

  defguard is_channel(value) when value in [:web, :phone, :store]
end
