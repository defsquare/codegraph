"""Discounts, inherited in a diamond."""


class Discount:
    def apply(self, amount):
        return amount


class Percent(Discount):
    pass


class Fixed(Discount):
    pass


class Combo(Percent, Fixed):
    """Both sides of the diamond, one base each."""
