"""One half of a re-export loop: cycle_b imports the name back from here."""
from .cycle_b import Token


class Spent(Token):
    pass
