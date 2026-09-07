namespace Acme.Order;

/// <summary>Minor units only; this fixture has no currencies. A positional record struct.</summary>
public readonly record struct Money(long Cents) : IPriceable
{
    public static Money Zero()
    {
        return new Money(0L);
    }

    public Money Times(int factor)
    {
        return new Money(Cents * factor);
    }

    /// <summary>An operator: its symbol is the metadata name `op_Addition`.</summary>
    public static Money operator +(Money left, Money right)
    {
        return new Money(left.Cents + right.Cents);
    }

    public Money Price()
    {
        return this;
    }
}
