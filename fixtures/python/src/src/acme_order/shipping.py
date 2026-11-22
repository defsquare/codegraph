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
