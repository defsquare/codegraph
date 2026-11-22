"""What an order refuses."""


class OrderError(Exception):
    """Anything an order refuses."""


class NotFound(OrderError, LookupError):
    """A corpus base and a built-in one."""
