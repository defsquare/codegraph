namespace Acme.Order;

/// <summary>
/// Throw-site case: a guard clause and a rethrow must each emit a `throws`
/// edge anchored at its own statement.
/// </summary>
public class StockGuard
{
    internal void Ensure(int quantity)
    {
        if (quantity < 0)
        {
            throw new EmptyBasketException("negative quantity");
        }
        try
        {
            Check(quantity);
        }
        catch (EmptyBasketException e)
        {
            throw e;
        }
    }

    internal void Check(int quantity)
    {
    }
}
