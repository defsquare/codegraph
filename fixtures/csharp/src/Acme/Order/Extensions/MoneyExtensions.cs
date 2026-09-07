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
}
