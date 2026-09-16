defmodule AcmeOrder.Order do
  @moduledoc "An order: lines, a channel, and a total computed by the pricing behaviour."

  alias AcmeOrder.{Line, Money}
  alias AcmeOrder.Pricing.Standard, as: DefaultPricing

  @max_lines 100
  @enforce_keys [:reference]
  defstruct reference: nil, lines: [], channel: :web, pricing: DefaultPricing

  @type t :: %__MODULE__{reference: String.t(), lines: [Line.t()], channel: atom(), pricing: module()}

  @doc "Builds an order, capping the lines."
  def create(reference, opts \\ []) do
    lines = opts |> Keyword.get(:lines, []) |> Enum.take(@max_lines)
    %__MODULE__{reference: reference, lines: lines, channel: Keyword.get(opts, :channel, :web)}
  end

  def total(%__MODULE__{lines: []}), do: Money.zero()

  def total(%__MODULE__{lines: lines, pricing: pricing} = order) do
    lines
    |> Enum.map(&pricing.price(&1, order.channel))
    |> Enum.reduce(Money.zero(), &Money.add/2)
  end

  def add_line(%__MODULE__{lines: lines} = order, %Line{} = line) when length(lines) < @max_lines do
    %{order | lines: [line | lines]}
  end

  def add_line(%__MODULE__{}, _line), do: raise(AcmeOrder.Errors.TooManyLines, max: @max_lines)

  defdelegate describe(order), to: AcmeOrder.Reporting, as: :describe_order
end
