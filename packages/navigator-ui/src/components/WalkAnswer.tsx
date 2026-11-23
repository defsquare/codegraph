import type { Insight, WalkField, WalkValue } from "../insight.js";

/**
 * A WALK'S ANSWER about the selected node (`codegraph walk`, read by `serve
 * --insights <model>.N.walk.db`), shown GENERICALLY: the page holds no
 * definition, so every field is shown by its name and by what its value is.
 *
 * AN INFERENCE, framed as explain's is (InsightPanel): the inference colour,
 * a badge, which walk asked, which model answered and how sure it claimed to
 * be. The answer leads — it is what the walk asked — then the fields, open,
 * then the description that flowed to the units above.
 */

function ValueView({ value }: { readonly value: WalkValue }) {
  switch (value.kind) {
    case "text":
      return <span>{value.text}</span>;
    case "list":
      return value.items.length === 0 ? (
        <span>—</span>
      ) : (
        <ul className="insight-list">
          {value.items.map((item, index) => (
            // Items have no identity of their own: their place is it.
            <li key={index}>
              <ValueView value={item} />
            </li>
          ))}
        </ul>
      );
    case "fields":
      return value.fields.length === 0 ? <span>—</span> : <FieldList fields={value.fields} className="insight-nested" />;
  }
}

function FieldList({ fields, className }: { readonly fields: readonly WalkField[]; readonly className: string }) {
  return (
    <dl className={className}>
      {fields.map((field) => (
        <div key={field.name}>
          <dt>{field.name}</dt>
          <dd>
            <ValueView value={field.value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function WalkAnswer({ insight }: { readonly insight: Extract<Insight, { status: "answered" }> }) {
  const templated = insight.origin === "template";
  return (
    <section className="insight insight-walk" aria-label={`The walk ${insight.walk}'s answer, a language model's reading`}>
      <p className="insight-byline">
        <span className="insight-badge">{templated ? "templated" : "LLM answer"}</span>
        <span className="insight-walk-name">
          walk <strong>{insight.walk}</strong>
        </span>
        {!templated && insight.model !== undefined && <span>{insight.model}</span>}
        {insight.confidence !== undefined && (
          <span title="The model's own confidence in this answer, 0 to 1 — a hint, not a measurement.">
            confidence <strong>{insight.confidence.toFixed(2)}</strong>
          </span>
        )}
      </p>
      {insight.answer !== undefined && <p className="insight-answer">{insight.answer}</p>}
      {insight.fields.length > 0 && <FieldList fields={insight.fields} className="insight-fields" />}
      <p className="insight-text insight-description">{insight.description}</p>
    </section>
  );
}
