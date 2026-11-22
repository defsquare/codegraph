"""A decorator the corpus writes: its parameters name a use's positional arguments."""


def retry(times, backoff=1.0):
    def wrap(function):
        return function

    return wrap
