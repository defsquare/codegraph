"""Payments, through a plugin package that has no __init__.py."""
import acme_plugins.stripe
from acme_plugins import stripe as gateway


class StripeCharge(acme_plugins.stripe.Gateway):
    pass


class Refund(gateway.Gateway):
    pass
