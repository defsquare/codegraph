"""What differs between platforms and versions, written more than once."""
import sys
from typing import TYPE_CHECKING

try:
    import simplejson as json
except ImportError:
    import json

if TYPE_CHECKING:
    from .orders import Order

if sys.platform == "win32":
    def data_dir():
        return "C:\\acme"
else:
    def data_dir():
        return "/var/lib/acme"

try:
    from simplejson import JSONDecodeError
except ImportError:
    JSONDecodeError = ValueError


class DecodeError(JSONDecodeError):
    pass


def loads(text) -> "Order":
    return json.loads(text)
