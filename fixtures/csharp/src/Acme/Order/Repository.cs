namespace Acme.Order;

/// <summary>Non-generic `Repository`: legally coexists with `Repository&lt;T&gt;` below.</summary>
public class Repository
{
    private readonly List<object> items = new();

    public int Count => items.Count;
}

/// <summary>Generic arity is part of the symbol: `Repository`1`, never merged with the one above.</summary>
public class Repository<T>
    where T : class
{
    private readonly List<T> items = new();

    public void Save(T item)
    {
        items.Add(item);
    }

    public T? Find(System.Func<T, bool> predicate)
    {
        foreach (T item in items)
        {
            if (predicate(item))
            {
                return item;
            }
        }
        return null;
    }
}
