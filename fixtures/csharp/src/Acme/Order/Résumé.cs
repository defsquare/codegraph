namespace Acme.Order;

/// <summary>Non-ASCII identifiers and text: the JSON writer must leave them unescaped, as JSON.stringify does — «naïve» — and a tab\tin a comment must be escaped.</summary>
public class Résumé
{
    public string Naïve => "ok";
}
