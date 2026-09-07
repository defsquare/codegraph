using MegaCorp.Ledger;

namespace Acme.Order;

/// <summary>The second declaration part of Order: same entity, its own file.</summary>
public partial class Order
{
    [Audited(LedgerClient.AuditTag, Verbose = true)]
    public override Money Discount(int percent)
    {
        // `total` is inherited from AbstractOrder, not declared here.
        return total.Times(100 - percent);
    }
}
