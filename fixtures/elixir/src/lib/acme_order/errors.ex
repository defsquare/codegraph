defmodule AcmeOrder.Errors do
  defmodule TooManyLines do
    defexception [:max, message: "too many lines"]

    @impl true
    def message(%__MODULE__{max: max}), do: "an order holds at most #{max} lines"
  end

  def fail!(reason) do
    raise "unexpected: #{inspect(reason)}"
  end

  def rethrow(fun) do
    fun.()
  rescue
    e in TooManyLines -> reraise e, __STACKTRACE__
    _ -> raise ArgumentError, "wrapped"
  end
end
