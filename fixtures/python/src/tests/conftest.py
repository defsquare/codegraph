"""The tests' conftest: the nearer of the two for every test below."""
from acme_order import Order


def make_order():
    return Order("T-1")
