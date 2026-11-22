"""Refunds: `raise` in the forms the services do not write."""
from .errors import NotFound, OrderError


def lookup(order):
    return order


def refund(order):
    if order is None:
        raise OrderError
    try:
        lookup(order)
    except KeyError as error:
        raise NotFound("no such order") from error
