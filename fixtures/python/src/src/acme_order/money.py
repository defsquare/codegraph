"""Money: classes a call makes."""
from collections import namedtuple
from enum import Enum

Amount = namedtuple("Amount", "value currency")
Rounding = Enum("Rounding", "UP DOWN")


class Price(namedtuple("Price", ["net", "tax"])):
    """A named tuple's fields are the class's attributes."""

    def gross(self):
        return self.net + self.tax


def default_rounding():
    return Rounding.UP
