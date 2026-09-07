using System;
using System.Linq;
using static System.Math;
using Lines = System.Collections.Generic.List<string>;

namespace Acme.Order;

/// <summary>Monthly reporting helpers: LINQ, a using alias, `using static`, generics.</summary>
public class Reporting
{
    public Lines LinesOf(params string[] rows)
    {
        return new Lines(rows);
    }

    public string Join(string[] parts)
    {
        var builder = new System.Text.StringBuilder();
        foreach (string part in parts)
        {
            builder.Append(part);
        }
        return builder.ToString();
    }

    [Audited("monthly")]
    public T? Max<T>(List<T> values)
        where T : class, IComparable<T>
    {
        T? best = null;
        foreach (T value in values)
        {
            if (best == null || value.CompareTo(best) > 0)
            {
                best = value;
            }
        }
        return best;
    }

    public T? First<T>(List<T> values)
        where T : class
    {
        return values.Count == 0 ? null : values[0];
    }

    /// <summary>A switch expression: each arm is a branch.</summary>
    public string Describe(Channel channel)
    {
        return channel switch
        {
            Channel.Web => "web",
            Channel.Phone => "phone",
            _ => "store",
        };
    }

    public long Largest(IEnumerable<Money> amounts)
    {
        return amounts.Select(money => money.Cents).DefaultIfEmpty(0L).Max();
    }

    public double Rounded(double value)
    {
        return Round(value, 2);
    }

    public DateTime Today()
    {
        return DateTime.Today;
    }
}
