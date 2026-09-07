using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Codegraph.CSharp;

/// <summary>
/// Measures (TMetrics, METAMODEL.md §3.8), the Java extractor's two, computed
/// on syntax so they are immune to the resolution ceiling:
/// <list type="bullet">
/// <item><c>sloc</c> — lines of the node's own span holding at least one token:
/// neither blank nor comment-only. Trivia is not a token, so a line with only
/// a comment does not count; a multi-line literal counts every line it spans.</item>
/// <item><c>cyclomatic</c> — 1 + if / for / foreach / while / do / non-default
/// case label / switch-expression arm (the discard arm is the default) / catch /
/// ternary / <c>&amp;&amp;</c> / <c>||</c> / <c>??</c> / <c>??=</c> / pattern
/// <c>when</c> guard. A nested lambda, anonymous method or local function is its
/// own invocable and does NOT contribute to its enclosing one.</item>
/// </list>
/// </summary>
public static class Measures
{
    public static int Sloc(SyntaxNode node)
    {
        var lines = new HashSet<int>();
        var tree = node.SyntaxTree;
        foreach (var token in node.DescendantTokens())
        {
            if (token.IsMissing || token.Span.IsEmpty) continue;
            var span = tree.GetLineSpan(token.Span);
            for (var line = span.StartLinePosition.Line; line <= span.EndLinePosition.Line; line++) lines.Add(line);
        }
        return lines.Count;
    }

    public static int Cyclomatic(SyntaxNode body)
    {
        var count = 1;
        Count(body, ref count, root: true);
        return count;
    }

    private static void Count(SyntaxNode node, ref int count, bool root)
    {
        if (!root && IsOwnInvocable(node)) return;
        switch (node)
        {
            case IfStatementSyntax:
            case ForStatementSyntax:
            case CommonForEachStatementSyntax:
            case WhileStatementSyntax:
            case DoStatementSyntax:
            case CaseSwitchLabelSyntax:
            case CasePatternSwitchLabelSyntax:
            case CatchClauseSyntax:
            case ConditionalExpressionSyntax:
            case WhenClauseSyntax:
                count++;
                break;
            case SwitchExpressionArmSyntax arm when arm.Pattern is not DiscardPatternSyntax:
                count++;
                break;
            case BinaryExpressionSyntax binary when binary.IsKind(SyntaxKind.LogicalAndExpression)
                                                  || binary.IsKind(SyntaxKind.LogicalOrExpression)
                                                  || binary.IsKind(SyntaxKind.CoalesceExpression):
                count++;
                break;
            case AssignmentExpressionSyntax assignment when assignment.IsKind(SyntaxKind.CoalesceAssignmentExpression):
                count++;
                break;
        }
        foreach (var child in node.ChildNodes()) Count(child, ref count, root: false);
    }

    public static bool IsOwnInvocable(SyntaxNode node) =>
        node is AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax;
}
