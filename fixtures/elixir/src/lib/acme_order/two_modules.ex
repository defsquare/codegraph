defmodule AcmeOrder.Channel do
  @channels [:web, :phone, :store]
  def all, do: @channels
end

defmodule AcmeOrder.Channel.Names do
  alias AcmeOrder.Channel
  def names, do: Enum.map(Channel.all(), &Atom.to_string/1)
end
