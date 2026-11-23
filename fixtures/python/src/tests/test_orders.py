import unittest

import acme
from acme_order import Order, errors
from conftest import make_order


class SpecialOrder(Order):
    pass


class TestOrder(unittest.TestCase):
    def test_total(self):
        self.assertEqual(make_order().total, 0)


class TestMissing(errors.NotFound):
    pass


class TestAcme(acme.Acme):
    pass
