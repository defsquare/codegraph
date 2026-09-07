using System;

namespace Acme.Order;

/// <summary>
/// Array members: `counts.Length` binds to `System.Array.Length`, never to a
/// member of the element type, so no phantom `int` class can be invented here.
/// </summary>
public class Batch
{
    private readonly int[] counts;

    private readonly Money[] prices;

    public Batch(int[] counts, Money[] prices)
    {
        this.counts = counts;
        this.prices = prices;
    }

    /// <summary>`counts.Length` — a property of `System.Array`, not of `int`.</summary>
    public int Size()
    {
        return counts.Length;
    }

    /// <summary>`prices.Length` — a property of `System.Array`, not of `Money`.</summary>
    public int Priced()
    {
        return prices.Length;
    }

    /// <summary>An array allocation expression, and a `Func` from the BCL.</summary>
    public Func<int, int[]> Allocator()
    {
        return size => new int[size];
    }

    /// <summary>A `dynamic` receiver: the call binds to no symbol and is dropped, counted.</summary>
    public object Describe(dynamic anything)
    {
        return anything.ToString();
    }
}
