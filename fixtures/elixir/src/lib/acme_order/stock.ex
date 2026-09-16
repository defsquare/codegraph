defmodule AcmeOrder.Stock do
  @moduledoc "Reserved quantities per SKU, in an ETS table owned by this server."
  use GenServer

  @table :acme_order_stock

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  def reserve(sku, qty), do: GenServer.call(__MODULE__, {:reserve, sku, qty})

  def release(sku), do: GenServer.cast(__MODULE__, {:release, sku})

  def available?(sku) do
    case :ets.lookup(@table, sku) do
      [{^sku, reserved}] -> reserved == 0
      [] -> true
    end
  end

  def peek(pid), do: GenServer.call(pid, :peek)

  @impl true
  def init(_opts) do
    :ets.new(@table, [:named_table, :public])
    {:ok, %{}}
  end

  @impl true
  def handle_call({:reserve, sku, qty}, _from, state) do
    :ets.update_counter(@table, sku, qty, {sku, 0})
    {:reply, :ok, state}
  end

  def handle_call(:peek, _from, state), do: {:reply, state, state}

  @impl true
  def handle_cast({:release, sku}, state) do
    :ets.delete(@table, sku)
    {:noreply, state}
  end
end
