using System.Linq;

namespace Acme.Order;

/// <summary>A basket being filled. Declares no constructor of its own.</summary>
public class Basket
{
    private long total;

    private readonly List<Line> lines = new();

    public void Add(Line line)
    {
        lines.Add(line);
        total += line.Amount;
    }

    public long Total => total;

    /// <summary>An indexer: a property whose symbol is `Item(System.Int32)`.</summary>
    public Line this[int index] => lines[index];

    public Cursor GetCursor()
    {
        return new Cursor(this);
    }

    public int Count => lines.Count(line => line.Amount > 0);

    /// <summary>Nested type; C# nesting is always static.</summary>
    public class Line
    {
        public Line(long amount)
        {
            Amount = amount;
        }

        public long Amount { get; }

        /// <summary>Nested inside a nested type.</summary>
        public class Discount
        {
            public long ApplyTo(long amount)
            {
                return amount / 2;
            }
        }
    }

    /// <summary>Reads the enclosing basket's lines through an explicit reference.</summary>
    public class Cursor
    {
        private readonly Basket basket;

        private int index;

        public Cursor(Basket basket)
        {
            this.basket = basket;
        }

        public Line Next()
        {
            return basket.lines[index++];
        }
    }
}
