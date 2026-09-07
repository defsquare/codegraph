// A `global using` is folded to an import edge from the namespaces declared in
// THIS file, anchored here — the directive's effect on every other file is a
// compiler fact, not a written dependency of those files.
global using System.Collections.Generic;

namespace Acme.Order;

/// <summary>Anything the pricing engine can put a number on.</summary>
public interface IPriceable
{
    Money Price();
}
