"""Declarations written inside functions."""
from .orders.base import Base


def make(kind):
    class Local(Base):
        def describe(self):
            def label():
                return kind

            return label()

    return Local


def outer():
    def inner():
        return 1

    return inner()


def wrap(Base):
    class Wrapped(Base):
        pass

    return Wrapped
