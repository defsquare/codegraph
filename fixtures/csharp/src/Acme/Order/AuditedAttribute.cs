using System;

namespace Acme.Order;

/// <summary>Marks a method whose calls must reach the audit log.</summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class AuditedAttribute : Attribute
{
    public AuditedAttribute(string tag = "")
    {
        Tag = tag;
    }

    public string Tag { get; }

    /// <summary>A named argument target.</summary>
    public bool Verbose { get; set; }
}
