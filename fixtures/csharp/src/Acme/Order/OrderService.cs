using MegaCorp.Ledger;

namespace Acme.Order;

/// <summary>
/// Billing and archival. Both Archive overloads take a parameter whose simple
/// name is `List`; only their namespaces differ — and one is generic.
/// </summary>
public class OrderService
{
    private readonly LedgerClient ledger;

    private readonly Repository plain = new();

    private readonly Repository<Order> typed = new();

    public OrderService(LedgerClient ledger)
    {
        this.ledger = ledger;
    }

    public Invoice Bill(Order order)
    {
        Invoice invoice = new Invoice(order.Reference);
        ledger.Post(invoice);
        return invoice;
    }

    public void Archive(List<Order> orders)
    {
        foreach (Order order in orders)
        {
            ledger.Archive(order.Reference);
        }
    }

    public void Archive(Legacy.List orders)
    {
        ledger.Archive(orders.Head);
    }
}
