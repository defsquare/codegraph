using System;

namespace Acme.Order;

/// <summary>The corpus-declared exception the throw-site case targets.</summary>
public class EmptyBasketException : Exception
{
    public EmptyBasketException(string message)
        : base(message)
    {
    }
}
