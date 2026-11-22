"""Services: every receiver shape the extractor types, and each it cannot."""
import importlib
import json
from typing import Optional

from hooks import register

from . import settings
from .errors import OrderError
from .orders.order import Order
from .pricing import discounts
from .repository import Repository
from .retry import retry


@retry(3, backoff=2.0)
def checkout(order: Order, repository: Optional[Repository] = None) -> Order:
    """An annotation types a parameter; `Optional` is unwrapped."""
    total = order.total
    if repository is not None:
        repository.save(order)
    json.dumps({"total": total, "currency": settings.DEFAULT_CURRENCY})
    print(len(order.lines))
    return order


def build_error(order):
    return OrderError(order)


class Service:
    """Reads through `self`, `cls` and `super()`, and what no reader can type."""

    retries = 3

    def __init__(self, handler):
        self.repository = Repository()
        self.cache = {}
        self.handler = handler

    @classmethod
    def create(cls):
        return cls(None)

    @register(*settings.HOOKS, name="run")
    def run(self, order):
        self.repository.save(order)
        self.audit()
        local = Order("A-1", currency="EUR")
        local.total
        discounts.Percent(10)
        Service.create()
        order.reference
        self.handler.process()
        self.missing()
        local.nothing
        importlib.import_module("acme_order.shipping")
        importlib.import_module(order.reference)
        settings.bump()
        try:
            self.repository.load(order)
        except KeyError as error:
            raise error
        except OrderError:
            raise
        if not order.lines:
            raise OrderError("no lines")
        raise build_error(order)

    def audit(self):
        pass


class AuditedService(Service):
    def __init__(self, handler):
        super().__init__(handler)
        self.audits = []


shipping = importlib.import_module("acme_order.shipping")


def default_carrier():
    """A name bound once to `import_module` with a literal is that module, by flow."""
    return shipping.Carrier.POST
