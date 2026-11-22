"""An order, its lines, and what they add up to."""
from .base import Auditable, Base


class Order(Base, Auditable):
    class Line:
        def __init__(self, sku, quantity=1):
            self.sku = sku
            self.quantity = quantity

    def __init__(self, reference, *lines, currency="EUR", **options):
        self.reference = reference
        self.lines = list(lines)
        self.currency = currency

    @property
    def total(self):
        return sum(line.quantity for line in self.lines)

    @total.setter
    def total(self, value):
        raise AttributeError("the total is computed")

    @total.deleter
    def total(self):
        self.lines = []


def quote(order, rate=1, /, rounding=2, *extra, exact, mode="half", **flags):
    return round(order.total * rate, rounding)


def merge(*, first, second):
    return first
