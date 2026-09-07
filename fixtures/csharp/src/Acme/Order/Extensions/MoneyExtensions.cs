namespace Acme.Order.Extensions;

/// <summary>Extension methods: children of this static class, attached to the extended type.</summary>
public static class MoneyExtensions
{
    public static Money Doubled(this Money money)
    {
        return money.Times(2);
    }

    public static bool IsFree(this IPriceable priceable)
    {
        return priceable.Price().Cents == 0;
    }

    /// <summary>A C# 14 extension block: no type of its own; its members belong to this class, attached to Money.</summary>
    extension(Money money)
    {
        public bool IsZero => money.Cents == 0;

        public Money Halved() => money.Times(1) with { Cents = money.Cents / 2 };
    }
}
