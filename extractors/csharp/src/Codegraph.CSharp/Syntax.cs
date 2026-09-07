using System.Text;
using Codegraph.CSharp.Model;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Codegraph.CSharp;

/// <summary>Anchors and doc comments from syntax; the declaration part chosen for a partial symbol.</summary>
public static class Syntax
{
    /// <summary>
    /// The declaration a partial symbol is anchored at: first by `(file, start)`
    /// in ordinal order, so the choice is the same on every OS and does not
    /// depend on the order the walk happened to visit the parts.
    /// </summary>
    public static IReadOnlyList<SyntaxNode> DeclarationsOf(ISymbol symbol) =>
        symbol.DeclaringSyntaxReferences
            .Select(r => r.GetSyntax())
            .OrderBy(n => n.SyntaxTree.FilePath, StringComparer.Ordinal)
            .ThenBy(n => n.SpanStart)
            .ToList();

    public static SyntaxNode? PrimaryDeclaration(ISymbol symbol) => DeclarationsOf(symbol).FirstOrDefault();

    /// <summary>1-based lines of the node's own span — attributes included, leading trivia (comments) excluded.</summary>
    public static SourceAnchor AnchorOf(SyntaxNode node)
    {
        var span = node.SyntaxTree.GetLineSpan(node.Span);
        return new SourceAnchor(node.SyntaxTree.FilePath, span.StartLinePosition.Line + 1, span.EndLinePosition.Line + 1);
    }

    public static SourceAnchor AnchorOf(SyntaxToken token)
    {
        var span = token.SyntaxTree!.GetLineSpan(token.Span);
        return new SourceAnchor(token.SyntaxTree.FilePath, span.StartLinePosition.Line + 1, span.EndLinePosition.Line + 1);
    }

    /// <summary>`line:column`, both 1-based, of the node's first token — the nameless-entity disambiguator.</summary>
    public static string LineColumn(SyntaxNode node)
    {
        var start = node.SyntaxTree.GetLineSpan(node.Span).StartLinePosition;
        return $"{node.SyntaxTree.FilePath}:{start.Line + 1}:{start.Character + 1}";
    }

    /// <summary>
    /// The XML doc comments written on a declaration, as plain text: `///` markers
    /// stripped, lines trimmed, the `summary` wrapper removed, one string per
    /// declaration part that carries one. Empty when nothing was written.
    /// </summary>
    public static List<string> DocComments(IEnumerable<SyntaxNode> declarations)
    {
        var comments = new List<string>();
        foreach (var node in declarations)
        {
            foreach (var trivia in node.GetLeadingTrivia())
            {
                if (trivia.Kind() is not (SyntaxKind.SingleLineDocumentationCommentTrivia or SyntaxKind.MultiLineDocumentationCommentTrivia)) continue;
                var text = CleanDoc(trivia.ToFullString(), trivia.IsKind(SyntaxKind.MultiLineDocumentationCommentTrivia));
                if (text.Length > 0) comments.Add(text);
            }
        }
        return comments;
    }

    private static string CleanDoc(string raw, bool multiLine)
    {
        var lines = new List<string>();
        foreach (var rawLine in raw.Split('\n'))
        {
            var line = rawLine.TrimEnd('\r').Trim();
            if (multiLine)
            {
                if (line.StartsWith("/**", StringComparison.Ordinal)) line = line[3..];
                if (line.EndsWith("*/", StringComparison.Ordinal)) line = line[..^2];
                line = line.TrimStart('*');
            }
            else if (line.StartsWith("///", StringComparison.Ordinal)) line = line[3..];
            line = line.Trim();
            if (line.Length > 0) lines.Add(line);
        }
        var joined = string.Join('\n', lines);
        joined = joined.Replace("<summary>", "", StringComparison.Ordinal).Replace("</summary>", "", StringComparison.Ordinal);
        return joined.Trim();
    }

    /// <summary>Whether a syntax node sits inside a block-scoped namespace declaration, and which.</summary>
    public static BaseNamespaceDeclarationSyntax? EnclosingNamespace(SyntaxNode node) =>
        node.Ancestors().OfType<BaseNamespaceDeclarationSyntax>().FirstOrDefault();
}
