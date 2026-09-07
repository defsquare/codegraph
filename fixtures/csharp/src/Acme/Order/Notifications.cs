using System;

namespace Acme.Order;

/// <summary>A delegate: a type that is also invocable.</summary>
public delegate void ShipmentHandler(Order order);

/// <summary>Delivery hooks. Nothing invocable in here has a name of its own — except the local function.</summary>
public class Notifications
{
    private readonly Action<Order> onShipped = order => Log("shipped " + order.Reference);

    /// <summary>An event: a value-shaped member; `+=` is a write access.</summary>
    public event ShipmentHandler? Shipped;

    /// <summary>Two lambdas STARTING ON THE SAME LINE — the column keeps their ids apart.</summary>
    public Action Both(Order order)
    {
        return Chain(() => Log("packing " + order.Reference), () => Log("shipping " + order.Reference));
    }

    public Action Chain(Action first, Action second)
    {
        return () =>
        {
            first();
            second();
        };
    }

    /// <summary>An anonymous method and a local function, side by side.</summary>
    public IPriceable FreeOf(Order order)
    {
        Func<Money> free = delegate { Log("free " + order.Reference); return Money.Zero(); };
        Money Zero() => free();
        return new Free(Zero);
    }

    public void NotifyShipped(Order order)
    {
        onShipped(order);
        Shipped?.Invoke(order);
    }

    public void Subscribe(ShipmentHandler handler)
    {
        Shipped += handler;
    }

    internal static void Log(string message)
    {
        Console.WriteLine(message);
    }

    private sealed class Free : IPriceable
    {
        private readonly Func<Money> price;

        public Free(Func<Money> price)
        {
            this.price = price;
        }

        public Money Price() => price();
    }
}
