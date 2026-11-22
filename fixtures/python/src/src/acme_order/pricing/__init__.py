"""Pricing: discounts and the rules that pick one."""
from . import discounts


class DefaultDiscount(discounts.Discount):
    """`discounts` is the submodule this package imports, not a name of the package."""
