"""What every persisted thing is."""


class Base:
    """A record with an identity."""


class Auditable:
    def audit(self):
        return True
