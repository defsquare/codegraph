"""Bases read through star imports."""
from .shapes import *
from pallets.lib import *


class Parcel(Box):
    """`Box` is in shapes.__all__: the star binds it."""


class Pallet(Crate):
    """`Crate` is not: only pallets.lib, which nothing here answers, could bind it."""
