"""Aliases: a base that is a name bound once to a class is that class, by flow."""
import unittest

from .orders.base import Auditable

Trail = Auditable
Again = Trail
TestCase = unittest.TestCase
Factory = type("Factory", (), {})
Twice = Auditable
Twice = Trail


class Ledger(Again):
    """Its base is `Auditable`, through two aliases: an inference, `derived`."""

    def close(self):
        return self.audit()


class LedgerTest(TestCase):
    def test_close(self):
        self.assertTrue(Ledger().close())


class Made(Factory):
    """A name bound to a call: still a computed base."""


class Doubled(Twice):
    """A name bound twice: still a computed base."""
