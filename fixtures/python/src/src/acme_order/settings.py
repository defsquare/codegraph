"""Settings: module variables other files read and write."""
DEBUG = False
# The currency an order takes when none is given.
DEFAULT_CURRENCY = "EUR"
HOOKS = ["audit", "notify"]
counter = 0


def bump():
    global counter
    counter += 1
