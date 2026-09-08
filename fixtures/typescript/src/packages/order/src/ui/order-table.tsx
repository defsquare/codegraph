import type { Order } from "../order.js";

/** A JSX element naming a component is a call of it; intrinsic tags are nothing. */
export function OrderTable({ rows }: { rows: Order[] }): unknown {
  return (
    <table>
      {rows.map((row) => (
        <Row order={row} />
      ))}
    </table>
  );
}

function Row(props: { order: Order }): unknown {
  return (
    <tr>
      <td>{props.order.reference}</td>
    </tr>
  );
}
