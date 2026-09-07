namespace Acme.Order;

/// <summary>An order that can be marked down. Extends another corpus interface.</summary>
public interface IDiscountable : IPriceable
{
    Money Discount(int percent);
}
