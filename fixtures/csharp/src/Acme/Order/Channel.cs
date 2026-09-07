namespace Acme.Order;

/// <summary>Where an order came from. The underlying type is the enum's declared type.</summary>
public enum Channel : byte
{
    Web,
    Phone,
    Store = 10,
}
