"""Shipping: what the standard library and third parties give a class."""
import enum
from abc import ABC
from collections import abc
from typing import Generic, TypeVar

import sqlalchemy.orm
from django.db import models

T = TypeVar("T")


class Carrier(enum.Enum):
    POST = "post"
    COURIER = "courier"


class Rate(ABC):
    pass


class Zones(abc.Mapping):
    pass


class Parcel(Generic[T]):
    pass


class Shipment(models.Model):
    pass


class Row(sqlalchemy.orm.DeclarativeBase):
    pass


class Dynamic(make_base()):
    pass


class Orphan(NothingBindsThis):
    pass


class Tracked(Shipment):
    """`objects` is no corpus member: the one library class of the order answers it."""

    def recent(self):
        return Tracked.objects.filter()


class Ledger(Shipment, Row):
    """Two library classes could answer: no guess."""

    def close(self):
        self.flush()


class Proxy:
    """A class that answers any name at run time: nothing declaring one is no evidence."""

    def __getattr__(self, name):
        return name

    def forward(self):
        return self.anything()
