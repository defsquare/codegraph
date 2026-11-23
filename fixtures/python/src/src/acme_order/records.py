"""Records: classes the standard library's forms make, and a function written as overloads."""
from dataclasses import dataclass, field
from typing import NamedTuple, TypedDict, overload

from .orders.order import Order


@dataclass
class Receipt:
    """A dataclass's written fields are attributes; the `__init__` it makes is not in the model."""

    number: int
    order: "Order"
    lines: list = field(default_factory=list)
    paid: bool = False


class Point(NamedTuple):
    """The class spelling of a named tuple: a class statement with a written base."""

    x: int
    y: int = 0


Pair = NamedTuple("Pair", [("left", int), ("right", int)])
Totals = TypedDict("Totals", {"net": int, "tax": int})


@overload
def total(order: Order) -> int: ...
@overload
def total(order: None) -> None: ...
def total(order=None):
    """Two signatures and the implementation: ONE function, anchored at the implementation."""
    return order.total if order else None
