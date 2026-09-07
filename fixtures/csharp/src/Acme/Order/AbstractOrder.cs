namespace Acme.Order;

/// <summary>Shared state for every kind of order.</summary>
public abstract class AbstractOrder : IDiscountable
{
    protected Money total;

    private readonly string reference;

    protected AbstractOrder(string reference)
    {
        this.reference = reference;
        total = Money.Zero();
    }

    /// <summary>An auto-property: a value holder with no body of its own.</summary>
    public string Reference => reference;

    public Money Price()
    {
        return total;
    }

    public abstract Money Discount(int percent);
}
