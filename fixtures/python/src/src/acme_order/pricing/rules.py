"""Rules: relative imports one dot and two dots up, a submodule, a module that is not there."""
from . import discounts
from .discounts import Combo
from ..orders import Order
from .missing import Seasonal


class Rule(discounts.Discount):
    def applies_to(self, order: Order):
        return True


class SeasonalRule(Seasonal):
    pass


class ComboRule(Combo, Rule):
    pass
