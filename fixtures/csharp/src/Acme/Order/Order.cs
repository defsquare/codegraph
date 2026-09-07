using MegaCorp.Ledger;

namespace Acme.Order;

/// <summary>A customer order. Partial: the audited half lives in Order.Audit.cs.</summary>
public partial class Order : AbstractOrder
{
    /// <summary>A compile-time constant: the initializer folds across the arithmetic.</summary>
    public const int MaxLines = 4 * 25;

    /// <summary>Readonly, but NOT a constant: an initializer that is code carries no value.</summary>
    private readonly System.Text.StringBuilder trail = new();

    private readonly Channel channel;

    public Order(string reference)
        : this(reference, Channel.Web)
    {
    }

    public Order(string reference, Channel channel)
        : base(reference)
    {
        this.channel = channel;
    }

    public Channel Channel => channel;
}
