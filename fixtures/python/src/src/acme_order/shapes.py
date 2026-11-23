"""Shapes: `__all__` says what a star import of this module binds."""
__all__ = ["Box"]


class Box:
    pass


# A crate: not in `__all__`.
# noqa: D101
class Crate:
    pass
