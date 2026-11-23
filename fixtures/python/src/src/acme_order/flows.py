"""Flows: the scopes the compiler makes, and syntax a newer Python writes."""
from .orders.order import Order


def counter():
    """`nonlocal` writes the enclosing function's name; a lambda is no entity, its calls its writer's."""
    count = 0

    def bump():
        nonlocal count
        count += 1
        return count

    make = lambda: Order("A-1")
    return bump, make


def biggest(orders):
    """A comprehension has its own scope; a walrus in it binds in the function."""
    sizes = [size for order in orders if (size := order)]
    return sizes, size


def describe(value):
    """`match` binds its captures; a class pattern reads the class."""
    match value:
        case Order(reference=reference):
            return reference
        case [first, *rest]:
            return first, rest
        case _:
            return None


class Box[T]:
    """A PEP 695 type parameter is bound where the class is: `T` is no unbound name."""

    def put(self, item: T) -> T:
        return item


def first[T](items: list[T]) -> T:
    """…and where a generic function's annotations are read."""
    return items[0]


async def fetch(order: Order) -> Order:
    """`async def` is a function like any other."""
    return order
