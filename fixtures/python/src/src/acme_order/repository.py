"""A repository: the class the services type by flow and by annotation."""


class Repository:
    def save(self, order):
        pass

    def load(self, order):
        pass


class Cursor:
    """A literal `__slots__`: its names are the class's attributes."""

    __slots__ = ("_position", "_rows")

    def __init__(self, rows):
        self._rows = rows

    def position(self):
        return self._position
